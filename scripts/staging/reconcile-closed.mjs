// One-shot, supervised forward transition for the specific closed Staging gate incident.
// Run only inside the approved API image with the isolated geops_dev database.
import { randomUUID, createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stdin, stdout, stderr } from 'node:process';
import pg from 'pg';
import argon2 from 'argon2';
import { readGate, writeGate, recordGateEvent } from '../../apps/api/dist/db/restore-gate.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPECTED_DB = 'geops_dev';
const gatePath = '/geops-security/security-gate.json';
const [mode, requestId, adminEmail, firstEmail, secondEmail, ...reasonWords] = process.argv.slice(2);
const reason = reasonWords.join(' ');
const expectedOld = process.env.GEOPS_EXPECT_DB_EPOCH;
const expectedClosed = process.env.GEOPS_EXPECT_CLOSED_EPOCH;
const url = process.env.DATABASE_URL;

function fail(message) { throw new Error(message); }
function email(value) { return value.trim().toLowerCase(); }

async function hidden(label) {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) fail('Interactive terminal required');
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => { stdin.off('data', receive); stdin.setRawMode(false); stdin.pause(); };
    const receive = (data) => {
      for (const code of data) {
        if (code === 3) { cleanup(); reject(new Error('Cancelled')); return; }
        if (code === 13 || code === 10) { cleanup(); stdout.write('\n'); resolve(value); return; }
        if (code === 8 || code === 127) value = value.slice(0, -1);
        else if (code >= 32 && code <= 126 && value.length < 1024) value += String.fromCharCode(code);
      }
    };
    stdin.on('data', receive);
  });
}

async function provenance() {
  const info = await lstat(join(dirname(gatePath), 'security-gate.journal'));
  if (!info.isFile() || info.size > 16384) fail('Gate journal invalid');
  const lines = (await readFile(join(dirname(gatePath), 'security-gate.journal'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  if (lines.length !== 2 || lines[0].event !== 'fresh.initialize' ||
      lines[0].epoch !== expectedOld || lines[1].event !== 'restore.close' ||
      lines[1].epoch !== expectedClosed ||
      !Number.isFinite(Date.parse(lines[0].at)) || !Number.isFinite(Date.parse(lines[1].at)) ||
      Date.parse(lines[0].at) > Date.parse(lines[1].at))
    fail('Gate provenance is not the approved incident history');
}

async function schema(db) {
  const files = (await readdir('/work/apps/api/dist/db/migrations'))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (files.length !== 21 || files[17] !== '0018_mdm_inventory.sql' ||
      files[20] !== '0021_gps_offline_policy_contract.sql') fail('Unexpected migration catalog');
  const ledger = (await db.query('SELECT version,checksum FROM geops_schema_migrations ORDER BY version')).rows;
  if (ledger.length !== 18) fail('Expected exactly 18 migrations');
  for (let index = 0; index < 18; index++) {
    const name = files[index];
    const checksum = createHash('sha256').update(
      await readFile(`/work/apps/api/dist/db/migrations/${name}`)).digest('hex');
    if (ledger[index].version !== name || ledger[index].checksum !== checksum)
      fail('Migration ledger or checksum mismatch');
  }
  const critical = [
    ['security_epoch', 'r'], ['audit_event', 'r'], ['admin_user', 'r'],
    ['recovery_custodian', 'r'], ['geops_device', 'r'], ['device_session', 'r'],
    ['gps_policy_delivery', 'r'], ['position_event', 'r'], ['mdm_inventory_device', 'r'],
    ['mdm_sync_run', 'r'], ['mdm_inventory_one_geops_device', 'i'],
    ['gps_continuity_alert_one_open', 'i'],
  ];
  for (const [name, kind] of critical) {
    const found = await db.query('SELECT relkind FROM pg_class WHERE oid=to_regclass($1)', [`public.${name}`]);
    if (found.rows[0]?.relkind !== kind) fail('Critical schema structure mismatch');
  }
  const extension = await db.query("SELECT 1 FROM pg_extension WHERE extname='postgis'");
  if (extension.rowCount !== 1) fail('PostGIS missing');
}

async function identity(db) {
  const result = await db.query(`SELECT current_database() AS name,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
    e.epoch::text,e.quarantine_id::text,
    (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()
      AND pid<>pg_backend_pid() AND backend_type<>'autovacuum worker') AS others,
    (SELECT count(*)::int FROM admin_user WHERE state='ACTIVE') AS admins,
    (SELECT count(*)::int FROM recovery_custodian WHERE state='ACTIVE') AS custodians
    FROM security_epoch e WHERE e.singleton=true`);
  const row = result.rows[0];
  if (result.rowCount !== 1 || row.name !== EXPECTED_DB || row.quarantine_id !== null ||
      row.others !== 0 || row.admins !== 1 || row.custodians !== 2)
    fail('Database identity, isolation, quarantine or principals mismatch');
  return row;
}

async function authorize(db, passwords) {
  const actors = [adminEmail, firstEmail, secondEmail].map(email);
  if (new Set(actors).size !== 3) fail('Distinct administrator and custodians required');
  const replay = await db.query('SELECT 1 FROM audit_event WHERE correlation_id=$1 LIMIT 1', [requestId]);
  if (replay.rowCount) fail('Authorization request replay');
  const admin = await db.query("SELECT password_hash FROM admin_user WHERE email_normalized=$1 AND state='ACTIVE' FOR SHARE", [actors[0]]);
  if (admin.rowCount !== 1 || !await argon2.verify(admin.rows[0].password_hash, passwords[0]))
    fail('Authorization denied');
  for (let i = 1; i < 3; i++) {
    const custodian = await db.query("SELECT password_hash FROM recovery_custodian WHERE email_normalized=$1 AND state='ACTIVE' FOR SHARE", [actors[i]]);
    if (custodian.rowCount !== 1 || !await argon2.verify(custodian.rows[0].password_hash, passwords[i]))
      fail('Authorization denied');
  }
}

async function audit(db, action, metadata) {
  await db.query(`INSERT INTO audit_event(id,actor_type,action,outcome,correlation_id,metadata_redacted)
    VALUES($1,'SYSTEM',$2,'success',$3,$4::jsonb)`,
  [randomUUID(), action, requestId, JSON.stringify({ ...metadata, reason })]);
}

async function main() {
  if (!['apply', 'retry'].includes(mode) || !UUID.test(requestId ?? '') ||
      !UUID.test(expectedOld ?? '') || !UUID.test(expectedClosed ?? '') ||
      expectedOld === expectedClosed || !adminEmail || !firstEmail || !secondEmail ||
      reason.trim().length < 8 || reason.length > 240 ||
      process.env.GEOPS_DATA_MODE !== 'synthetic' ||
      process.env.GEOPS_CONFIRM_CLOSED_RECONCILIATION !== 'YES' ||
      process.env.GEOPS_SECURITY_GATE_PATH !== gatePath || !url ||
      new URL(url).pathname !== `/${EXPECTED_DB}`)
    fail('Explicit closed-gate recovery configuration required');
  const gate = await readGate(gatePath);
  if (mode === 'apply' && (gate.epoch !== expectedClosed || gate.phase !== 'closed'))
    fail('Expected CLOSED gate and exact external epoch');
  if (mode === 'retry' && gate.phase !== 'closed' && gate.phase !== 'maintenance')
    fail('Expected CLOSED or interrupted maintenance gate');
  await provenance();
  const passwords = [await hidden('Administrator password: '),
    await hidden('First custodian password: '), await hidden('Second custodian password: ')];
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const db = await pool.connect();
  try {
    await db.query('SELECT pg_advisory_lock(350020)');
    await db.query('SELECT pg_advisory_lock(350021)');
    await provenance();
    const current = await identity(db);
    await schema(db);
    let newEpoch, nonce;
    if (mode === 'apply') {
      if (current.epoch !== expectedOld) fail('Original database epoch differs');
      const marker = await db.query("SELECT to_regclass('public.geops_maintenance_marker') AS name");
      if (marker.rows[0].name !== null) fail('Unexpected maintenance marker');
      const prior = await db.query("SELECT 1 FROM audit_event WHERE action LIKE 'maintenance.%' LIMIT 1");
      if (prior.rowCount) fail('Prior maintenance history requires separate review');
      newEpoch = randomUUID();
      nonce = randomUUID();
      await db.query('BEGIN');
      try {
        await authorize(db, passwords);
        const changed = await db.query(`UPDATE security_epoch SET epoch=$1,updated_at=now()
          WHERE singleton=true AND epoch=$2 AND quarantine_id IS NULL`, [newEpoch, expectedOld]);
        if (changed.rowCount !== 1) fail('Security epoch transition raced');
        await db.query(`CREATE TABLE geops_maintenance_marker (
          singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), epoch uuid NOT NULL,
          nonce uuid NOT NULL, database_oid oid NOT NULL,
          started_at timestamptz NOT NULL DEFAULT now())`);
        await db.query(`INSERT INTO geops_maintenance_marker(singleton,epoch,nonce,database_oid)
          VALUES(true,$1,$2,$3::oid)`, [newEpoch, nonce, current.database_oid]);
        await audit(db, 'maintenance.reconcile.committed', {
          target: EXPECTED_DB, database_oid: current.database_oid,
          old_epoch: expectedOld, closed_epoch: expectedClosed, new_epoch: newEpoch,
          schema: 18,
        });
        const beforeCommit = await readGate(gatePath);
        if (beforeCommit.phase !== 'closed' || beforeCommit.epoch !== expectedClosed)
          fail('External gate changed');
        await db.query('COMMIT');
      } catch (error) { await db.query('ROLLBACK'); throw error; }
    } else {
      const committed = await db.query(`SELECT metadata_redacted FROM audit_event
        WHERE action='maintenance.reconcile.committed' AND outcome='success'`);
      if (committed.rowCount !== 1) fail('No unique committed reconciliation to resume');
      const meta = committed.rows[0].metadata_redacted;
      if (meta.target !== EXPECTED_DB || meta.database_oid !== current.database_oid ||
          meta.old_epoch !== expectedOld || meta.closed_epoch !== expectedClosed ||
          meta.new_epoch !== current.epoch || !UUID.test(current.epoch))
        fail('Committed reconciliation identity mismatch');
      const marker = await db.query(`SELECT epoch::text,nonce::text,database_oid::text
        FROM geops_maintenance_marker WHERE singleton=true`);
      if (marker.rowCount !== 1 || marker.rows[0].epoch !== current.epoch ||
          marker.rows[0].database_oid !== current.database_oid)
        fail('Committed reconciliation marker mismatch');
      newEpoch = current.epoch;
      nonce = marker.rows[0].nonce;
      if (gate.phase === 'closed' && gate.epoch !== expectedClosed)
        fail('Closed gate changed during interrupted recovery');
      if (gate.phase === 'maintenance' &&
          (gate.epoch !== newEpoch || gate.nonce !== nonce))
        fail('Interrupted maintenance gate does not match database marker');
      await db.query('BEGIN');
      try {
        await authorize(db, passwords);
        await audit(db, 'maintenance.reconcile.retry_authorized', {
          target: EXPECTED_DB, database_oid: current.database_oid, new_epoch: newEpoch,
          schema: 18,
        });
        await db.query('COMMIT');
      } catch (error) { await db.query('ROLLBACK'); throw error; }
    }
    const finalGate = await readGate(gatePath);
    await provenance();
    if (finalGate.phase === 'closed' && finalGate.epoch === expectedClosed)
      await writeGate(gatePath, { version: 1, phase: 'maintenance', epoch: newEpoch, nonce });
    else if (mode !== 'retry' || finalGate.phase !== 'maintenance' ||
             finalGate.epoch !== newEpoch || finalGate.nonce !== nonce)
      fail('External gate changed before finalization');
    await recordGateEvent(gatePath, 'maintenance.reconcile', newEpoch);
    stdout.write(`Supervised gate reconciliation completed; phase=maintenance; schema=18; epoch=${newEpoch}\n`);
  } finally {
    await db.query('SELECT pg_advisory_unlock(350021)').catch(() => {});
    await db.query('SELECT pg_advisory_unlock(350020)').catch(() => {});
    db.release();
    await pool.end();
  }
}

main().catch(() => {
  stderr.write('Closed-gate reconciliation stopped; preserve database and gate volume. Details withheld.\n');
  process.exitCode = 1;
});
