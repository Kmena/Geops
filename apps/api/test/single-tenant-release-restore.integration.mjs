// Exercise a pg_dump/pg_restore copy in a separate disposable database. No real credentials.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { checkReadiness } from '../src/db/migration-manager.ts';
import { quarantineSyntheticRestore } from '../src/db/restore-quarantine.ts';
import {
  gateAllowsTraffic,
  openGateAfterQuarantine,
  readGate,
  recoverMissingGate,
  verifyForReopen,
} from '../src/db/restore-gate.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+_restore$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Separate disposable restored database required');

const name = new URL(url).pathname.slice(1);
const pool = new pg.Pool({ connectionString: url, max: 1 });
const root = await mkdtemp(join(tmpdir(), 'geops-release-restore-'));
const gatePath = join(root, 'security-gate.json');
try {
  assert.equal(await checkReadiness(pool), true, '15 checked migrations restored');
  const before = await pool.query(
    `SELECT
      (SELECT count(*)::int FROM admin_user) AS admins,
      (SELECT count(*)::int FROM admin_session WHERE revoked_at IS NULL) AS sessions,
      (SELECT count(*)::int FROM admin_permission WHERE revoked_at IS NULL) AS permissions,
      (SELECT count(*)::int FROM admin_user_invitation WHERE consumed_at IS NULL) AS invitations,
      (SELECT epoch::text FROM security_epoch WHERE singleton=true) AS epoch`,
  );
  assert.ok(before.rows[0].admins > 0, 'representative synthetic administrators restored');
  assert.ok(before.rows[0].epoch, 'source epoch retained in restored copy');
  await recoverMissingGate(pool, gatePath, name);
  const isolatedEpoch = (await readGate(gatePath)).epoch;
  assert.notEqual(isolatedEpoch, before.rows[0].epoch, 'external restore epoch rotated');
  assert.equal(await gateAllowsTraffic(pool, gatePath), false, 'copy starts closed');
  assert.equal(await verifyForReopen(pool, gatePath), false, 'unquarantined copy cannot reopen');
  await assert.rejects(
    openGateAfterQuarantine(pool, gatePath, { databaseName: name, epoch: isolatedEpoch }),
  );
  await quarantineSyntheticRestore(pool, name, gatePath);
  assert.equal(await verifyForReopen(pool, gatePath), true);
  const after = await pool.query(
    `SELECT
      (SELECT count(*)::int FROM admin_user) AS admins,
      (SELECT count(*)::int FROM admin_user WHERE state='ACTIVE') AS active_admins,
      (SELECT count(*)::int FROM admin_session WHERE revoked_at IS NULL) AS sessions,
      (SELECT count(*)::int FROM admin_permission WHERE revoked_at IS NULL) AS permissions,
      (SELECT count(*)::int FROM admin_user_invitation WHERE consumed_at IS NULL) AS invitations,
      (SELECT count(*)::int FROM gps_data_tenant_access WHERE revoked_at IS NULL) AS data_grants,
      (SELECT count(*)::int FROM gps_health_tenant_access WHERE revoked_at IS NULL) AS health_grants,
      (SELECT epoch::text FROM security_epoch WHERE singleton=true) AS epoch`,
  );
  assert.equal(after.rows[0].admins, before.rows[0].admins, 'accounts retained for audit');
  for (const key of [
    'active_admins',
    'sessions',
    'permissions',
    'invitations',
    'data_grants',
    'health_grants',
  ])
    assert.equal(after.rows[0][key], 0, `${key} quarantined`);
  assert.equal(after.rows[0].epoch, isolatedEpoch, 'quarantine binds new external epoch');
  await assert.rejects(
    openGateAfterQuarantine(pool, gatePath, { databaseName: name, epoch: randomUUID() }),
  );
  await openGateAfterQuarantine(pool, gatePath, { databaseName: name, epoch: isolatedEpoch });
  assert.equal(await gateAllowsTraffic(pool, gatePath), true, 'only verified copy reopens');
  console.log('Isolated single-tenant backup/restore and credential quarantine: PASS');
} finally {
  await pool.end();
  await rm(root, { recursive: true, force: true });
}
