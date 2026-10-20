import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { Pool, PoolClient } from 'pg';
import { loadMigrations } from './migration-manager.js';
import { readGate, recordGateEvent, writeGate } from './restore-gate.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET = /^(geops_dev|geops_verify_[0-9]+)$/;
const email = (value: string) => value.trim().toLowerCase();

export interface MaintenanceRecoveryAuthorization {
  target: string;
  epoch: string;
  requestId: string;
  reason: string;
  adminEmail: string;
  adminPassword: string;
  custodians: readonly [{ email: string; password: string }, { email: string; password: string }];
  compatibleReleaseConfirmed: boolean;
}

async function checkIdentity(db: PoolClient, path: string, auth: MaintenanceRecoveryAuthorization) {
  const gate = await readGate(path);
  if (gate.phase !== 'maintenance' || gate.epoch !== auth.epoch)
    throw new Error('Maintenance gate mismatch');
  const result = await db.query<{
    name: string;
    epoch: string;
    quarantine_id: string | null;
    others: number;
    nonce: string;
    marker_epoch: string;
    same_database: boolean;
  }>(`SELECT current_database() AS name,e.epoch::text,e.quarantine_id,
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) AS others,
      m.nonce::text,m.epoch::text AS marker_epoch,
      m.database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AS same_database
    FROM security_epoch e JOIN geops_maintenance_marker m ON m.singleton=true
    WHERE e.singleton=true`);
  const row = result.rows[0];
  if (
    row?.name !== auth.target ||
    row.epoch !== auth.epoch ||
    row.others !== 0 ||
    row.quarantine_id !== null ||
    row.marker_epoch !== gate.epoch ||
    row.nonce !== gate.nonce ||
    !row.same_database
  )
    throw new Error('Maintenance identity, isolation or marker mismatch');
  return gate;
}

async function schemaState(db: PoolClient): Promise<14 | 15> {
  const expected = await loadMigrations();
  if (expected.length !== 15 || !expected[14]?.version.startsWith('0015_'))
    throw new Error('Recovery binary has incompatible migration set');
  const result = await db.query<{ version: string; checksum: string }>(
    'SELECT version,checksum FROM geops_schema_migrations',
  );
  const actual = new Map(result.rows.map((row) => [row.version, row.checksum]));
  if (
    ![14, 15].includes(actual.size) ||
    [...actual].some(
      ([version, checksum]) =>
        expected.find((item) => item.version === version)?.checksum !== checksum,
    ) ||
    expected.slice(0, actual.size).some((item) => actual.get(item.version) !== item.checksum)
  )
    throw new Error('Migration ledger or checksum mismatch');
  const objects = await db.query<{
    tenant: string | null;
    invitation: string | null;
    change: string | null;
    manager_allowed: boolean;
  }>(
    `SELECT to_regclass('geops_operating_tenant')::text AS tenant,
      to_regclass('admin_user_invitation')::text AS invitation,
      to_regclass('admin_access_change')::text AS change,
      EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='admin_permission'::regclass
        AND conname='admin_permission_permission_check'
        AND pg_get_constraintdef(oid) LIKE '%gps.user.manage%') AS manager_allowed`,
  );
  const row = objects.rows[0];
  if (actual.size === 14 && (row?.tenant || row?.invitation || row?.change || row?.manager_allowed))
    throw new Error('Uncommitted or untracked 0015 objects detected');
  if (
    actual.size === 15 &&
    (!row?.tenant || !row.invitation || !row.change || !row.manager_allowed)
  )
    throw new Error('Committed 0015 objects missing');
  return actual.size as 14 | 15;
}

async function identityCounts(db: PoolClient): Promise<Record<string, number>> {
  const result = await db.query<Record<string, number>>(`SELECT
    (SELECT count(*)::int FROM admin_user) AS admins,
    (SELECT count(*)::int FROM admin_session WHERE revoked_at IS NULL) AS admin_sessions,
    (SELECT count(*)::int FROM device_session WHERE revoked_at IS NULL) AS device_sessions,
    (SELECT count(*)::int FROM admin_permission WHERE revoked_at IS NULL) AS permissions,
    (SELECT count(*)::int FROM gps_data_tenant_access WHERE revoked_at IS NULL) AS data_grants,
    (SELECT count(*)::int FROM gps_health_tenant_access WHERE revoked_at IS NULL) AS health_grants,
    (SELECT count(*)::int FROM recovery_custodian WHERE state='ACTIVE') AS custodians`);
  const row = result.rows[0];
  if (!row) throw new Error('Identity inventory unavailable');
  return row;
}

async function authorize(db: PoolClient, auth: MaintenanceRecoveryAuthorization): Promise<void> {
  const admin = email(auth.adminEmail);
  const custodians = auth.custodians.map((item) => email(item.email));
  if (
    !TARGET.test(auth.target) ||
    !UUID.test(auth.epoch) ||
    !UUID.test(auth.requestId) ||
    !auth.compatibleReleaseConfirmed ||
    auth.reason.trim().length < 8 ||
    auth.reason.length > 240 ||
    custodians[0] === custodians[1] ||
    custodians.includes(admin)
  )
    throw new Error('Explicit recovery authorization required');
  const previous = await db.query(
    "SELECT 1 FROM audit_event WHERE correlation_id=$1 AND action LIKE 'maintenance.recovery.%' LIMIT 1",
    [auth.requestId],
  );
  if (previous.rowCount) throw new Error('Recovery request replay');
  const principal = (
    await db.query<{ password_hash: string }>(
      "SELECT password_hash FROM admin_user WHERE email_normalized=$1 AND state='ACTIVE' FOR SHARE",
      [admin],
    )
  ).rows[0];
  if (
    !principal ||
    !auth.adminPassword ||
    !(await argon2.verify(principal.password_hash, auth.adminPassword))
  )
    throw new Error('Recovery authorization denied');
  for (const custodianEmail of [...custodians].sort()) {
    const actor = (
      await db.query<{ password_hash: string }>(
        "SELECT password_hash FROM recovery_custodian WHERE email_normalized=$1 AND state='ACTIVE' FOR SHARE",
        [custodianEmail],
      )
    ).rows[0];
    const password = auth.custodians.find((item) => email(item.email) === custodianEmail)?.password;
    if (!actor || !password || !(await argon2.verify(actor.password_hash, password)))
      throw new Error('Recovery authorization denied');
  }
}

async function audit(
  db: PoolClient,
  auth: MaintenanceRecoveryAuthorization,
  action: string,
  state: number,
) {
  await db.query(
    "INSERT INTO audit_event(id,actor_type,action,outcome,correlation_id,metadata_redacted) VALUES($1,'SYSTEM',$2,'success',$3,$4::jsonb)",
    [
      randomUUID(),
      action,
      auth.requestId,
      JSON.stringify({ target: auth.target, schema: state, reason: auth.reason.trim() }),
    ],
  );
}

/** Forward-only, supervised recovery. A restored database or missing marker is never repaired here. */
export async function recoverMaintenance(
  pool: Pool,
  path: string,
  auth: MaintenanceRecoveryAuthorization,
  onStage?: (stage: 'authorized' | 'migrated' | 'audited') => Promise<void>,
): Promise<14 | 15> {
  const db = await pool.connect();
  let locked = false;
  try {
    await db.query('SELECT pg_advisory_lock(350021)');
    locked = true;
    await checkIdentity(db, path, auth);
    const before = await schemaState(db);
    const identities = await identityCounts(db);
    await db.query('BEGIN');
    try {
      await authorize(db, auth);
      await audit(db, auth, 'maintenance.recovery.authorized', before);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
    await onStage?.('authorized');
    if (before === 14) {
      await db.query('BEGIN');
      try {
        await db.query('SELECT pg_advisory_xact_lock(350001)');
        await checkIdentity(db, path, auth);
        if ((await schemaState(db)) !== 14) throw new Error('Migration state changed');
        const migration = (await loadMigrations())[14];
        if (!migration) throw new Error('Migration 0015 missing');
        await db.query(migration.sql);
        await db.query('INSERT INTO geops_schema_migrations(version,checksum) VALUES($1,$2)', [
          migration.version,
          migration.checksum,
        ]);
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    }
    await onStage?.('migrated');
    await checkIdentity(db, path, auth);
    if ((await schemaState(db)) !== 15) throw new Error('0015 not committed');
    if (JSON.stringify(await identityCounts(db)) !== JSON.stringify(identities))
      throw new Error('Identity or permission inventory changed during recovery');
    await db.query('BEGIN');
    try {
      await audit(db, auth, 'maintenance.recovery.validated', 15);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
    await onStage?.('audited');
    const gate = await checkIdentity(db, path, auth);
    await recordGateEvent(path, 'maintenance.recovery.open', auth.epoch);
    await writeGate(path, { version: 1, phase: 'open', epoch: auth.epoch, nonce: gate.nonce });
    return before;
  } finally {
    if (locked) await db.query('SELECT pg_advisory_unlock(350021)').catch(() => {});
    db.release();
  }
}
