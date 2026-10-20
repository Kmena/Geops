// Isolated verification of in-place maintenance gate; never use on shared or Staging databases.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import {
  beginMaintenance,
  finishMaintenance,
  verifyMaintenance,
} from '../src/db/maintenance-gate.ts';
import { gateAllowsTraffic, readGate, writeGate } from '../src/db/restore-gate.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic DB required');
const pool = new pg.Pool({ connectionString: url, max: 1 });
const root = await mkdtemp(join(tmpdir(), 'geops-maintenance-'));
const path = join(root, 'security-gate.json');
let checks = 0;
const check = (value, label) => {
  assert.ok(value, label);
  checks++;
};
try {
  const name = new URL(url).pathname.slice(1);
  const epoch = randomUUID();
  await pool.query(
    'INSERT INTO security_epoch(singleton,epoch) VALUES(true,$1) ON CONFLICT (singleton) DO UPDATE SET epoch=EXCLUDED.epoch',
    [epoch],
  );
  await writeGate(path, { version: 1, phase: 'open', epoch });
  check(await gateAllowsTraffic(pool, path), 'initial matching gate open');
  await assert.rejects(beginMaintenance(pool, path, name, randomUUID()));
  checks++;
  await beginMaintenance(pool, path, name, epoch);
  check(
    (await readGate(path)).phase === 'maintenance' && !(await gateAllowsTraffic(pool, path)),
    'maintenance closes traffic without epoch change',
  );
  check(await verifyMaintenance(pool, path, name, epoch), 'database marker matches gate');
  check(!(await verifyMaintenance(pool, path, name, randomUUID())), 'wrong epoch denied');
  const marker = (
    await pool.query('SELECT nonce FROM geops_maintenance_marker WHERE singleton=true')
  ).rows[0].nonce;
  await pool.query('UPDATE geops_maintenance_marker SET nonce=$1 WHERE singleton=true', [
    randomUUID(),
  ]);
  check(
    !(await verifyMaintenance(pool, path, name, epoch)),
    'older or altered database marker denied',
  );
  await assert.rejects(finishMaintenance(pool, path, name, epoch));
  checks++;
  await pool.query('UPDATE geops_maintenance_marker SET nonce=$1 WHERE singleton=true', [marker]);
  await pool.query(
    "INSERT INTO geops_schema_migrations(version,checksum) VALUES('9999_unknown.sql','unexpected')",
  );
  await assert.rejects(finishMaintenance(pool, path, name, epoch));
  checks++;
  await pool.query("DELETE FROM geops_schema_migrations WHERE version='9999_unknown.sql'");
  await finishMaintenance(pool, path, name, epoch);
  check(
    (await readGate(path)).epoch === epoch && (await gateAllowsTraffic(pool, path)),
    'same epoch reopens after schema verification',
  );
  check((await readGate(path)).nonce === marker, 'open gate retains post-closure marker');
  await pool.query('UPDATE geops_maintenance_marker SET nonce=$1 WHERE singleton=true', [
    randomUUID(),
  ]);
  check(!(await gateAllowsTraffic(pool, path)), 'older or altered database denied after reopen');
  await assert.rejects(beginMaintenance(pool, path, name, epoch));
  checks++;
  await pool.query('UPDATE geops_maintenance_marker SET nonce=$1 WHERE singleton=true', [marker]);
  check(await gateAllowsTraffic(pool, path), 'matching database resumes traffic');
  console.log(`Maintenance upgrade gate integration: ${checks} checks PASS`);
} finally {
  await pool.end();
  await rm(root, { recursive: true, force: true });
}
