import { createHash, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { Pool, PoolClient } from 'pg';
import { loadMigrations, type Migration } from './migration-manager.js';
import { readGate, recordGateEvent, writeGate } from './restore-gate.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGET = /^(geops_dev|geops_verify_[0-9]+)$/;
const email = (value: string) => value.trim().toLowerCase();
const versions = [
  '0001_postgis.sql',
  '0002_admin.sql',
  '0003_device_identity.sql',
  '0004_mdm.sql',
  '0005_attestation_policy.sql',
  '0006_lifecycle.sql',
  '0007_security_epoch.sql',
  '0008_supervised_recovery.sql',
  '0009_gps_policies.sql',
  '0010_gps_health.sql',
  '0011_gps_published_name.sql',
  '0012_gps_events.sql',
  '0013_gps_operations.sql',
  '0014_gps_installation_binding.sql',
  '0015_single_tenant_admin.sql',
  '0016_gps_continuity_alerts.sql',
  '0017_gps_continuity_evaluated_at.sql',
  '0018_mdm_inventory.sql',
  '0019_mdm_security.sql',
] as const;
type SchemaVersion = 14 | 15 | 16 | 17 | 18 | 19;

async function recoveryCatalog(): Promise<Migration[]> {
  const catalog = await loadMigrations();
  if (
    catalog.length !== versions.length ||
    catalog.some((migration, index) => migration.version !== versions[index])
  )
    throw new Error('Recovery binary has incompatible migration set');
  return catalog;
}

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
      (SELECT count(*)::int FROM pg_stat_activity
       WHERE datname=current_database() AND pid<>pg_backend_pid()
         AND backend_type <> 'autovacuum worker') AS others,
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

async function schemaState(db: PoolClient, expected: Migration[]): Promise<SchemaVersion> {
  const result = await db.query<{ version: string; checksum: string }>(
    'SELECT version,checksum FROM geops_schema_migrations',
  );
  const actual = new Map(result.rows.map((row) => [row.version, row.checksum]));
  if (
    ![14, 15, 16, 17, 18, 19].includes(actual.size) ||
    expected.slice(0, actual.size).some((item) => actual.get(item.version) !== item.checksum)
  )
    throw new Error('Migration ledger or checksum mismatch');
  if (
    [...actual.keys()].some(
      (version) => !expected.slice(0, actual.size).some((item) => item.version === version),
    )
  )
    throw new Error('Unknown or out-of-order migration');
  const state = actual.size as SchemaVersion;
  const objects: Array<[string, SchemaVersion, 'r' | 'i']> = [
    ['geops_operating_tenant', 15, 'r'],
    ['admin_user_invitation', 15, 'r'],
    ['admin_access_change', 15, 'r'],
    ['admin_user_invitation_one_open', 15, 'i'],
    ['admin_user_invitation_expiry', 15, 'i'],
    ['gps_continuity_threshold', 16, 'r'],
    ['gps_continuity_alert', 16, 'r'],
    ['gps_continuity_alert_one_open', 16, 'i'],
    ['gps_continuity_alert_tenant_open', 16, 'i'],
    ['gps_continuity_alert_device_history', 16, 'i'],
    ['gps_continuity_alert_page', 17, 'i'],
    ['gps_continuity_read_quota', 17, 'r'],
    ['mdm_inventory_device', 18, 'r'],
    ['mdm_sync_run', 18, 'r'],
    ['mdm_inventory_one_geops_device', 18, 'i'],
    ['mdm_inventory_customer', 18, 'i'],
    ['mdm_connection_control', 19, 'r'],
    ['admin_login_limit', 19, 'r'],
    ['admin_login_limit_expiry', 19, 'i'],
  ];
  for (const [name, introduced, kind] of objects) {
    const found = await db.query<{ relkind: string }>(
      'SELECT relkind FROM pg_class WHERE oid=to_regclass($1)',
      [`public.${name}`],
    );
    if (
      (state >= introduced && found.rows[0]?.relkind !== kind) ||
      (state < introduced && found.rowCount !== 0)
    )
      throw new Error('Migration structural state mismatch');
  }
  const permission = await db.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conrelid='admin_permission'::regclass AND conname='admin_permission_permission_check'
       AND contype='c'`,
  );
  if (
    !permission.rows[0]?.definition.includes('gps.installation.manage') ||
    permission.rows[0].definition.includes('gps.user.manage') !== state >= 15
  )
    throw new Error('Permission constraint mismatch');
  const columns: Array<[string, string, SchemaVersion, boolean]> = [
    ['geops_operating_tenant', 'tenant_id', 15, true],
    ['geops_operating_tenant', 'audit_ref', 15, true],
    ['admin_user_invitation', 'token_hash', 15, true],
    ['admin_access_change', 'request_id', 15, true],
    ['gps_continuity_threshold', 'warning_after_s', 16, true],
    ['gps_continuity_threshold', 'critical_after_s', 16, true],
    ['gps_continuity_alert', 'tenant_id', 16, true],
    ['gps_continuity_alert', 'reason_code', 16, true],
    ['gps_continuity_alert', 'resolved_at', 16, false],
    ['gps_continuity_alert', 'evaluated_at', 17, false],
    ['gps_continuity_read_quota', 'admin_id', 17, true],
    ['gps_continuity_read_quota', 'request_count', 17, true],
    ['mdm_inventory_device', 'provider', 18, true],
    ['mdm_inventory_device', 'geops_device_id', 18, false],
    ['mdm_inventory_device', 'last_seen_at', 18, true],
    ['mdm_sync_run', 'id', 18, true],
    ['mdm_sync_run', 'outcome', 18, true],
    ['mdm_connection_control', 'credential_digest', 19, true],
    ['mdm_connection_control', 'remote_revoked', 19, true],
    ['admin_login_limit', 'key_digest', 19, true],
    ['admin_login_limit', 'blocked_until', 19, false],
  ];
  for (const [table, column, introduced, notNull] of columns) {
    const found = await db.query<{ attnotnull: boolean; type: string }>(
      `SELECT attnotnull,atttypid::regtype::text AS type FROM pg_attribute
       WHERE attrelid=to_regclass($1) AND attname=$2 AND NOT attisdropped`,
      [`public.${table}`, column],
    );
    if (
      (state >= introduced && (found.rowCount !== 1 || found.rows[0]?.attnotnull !== notNull)) ||
      (state < introduced && found.rowCount !== 0)
    )
      throw new Error('Migration column state mismatch');
    if (
      state >= introduced &&
      column === 'evaluated_at' &&
      found.rows[0]?.type !== 'timestamp with time zone'
    )
      throw new Error('Evaluation timestamp type mismatch');
  }
  if (state >= 16) {
    const constraints = await db.query<{ foreign_keys: number; unique_open: boolean }>(
      `SELECT
        (SELECT count(*)::int FROM pg_constraint WHERE conrelid='gps_continuity_alert'::regclass
          AND contype='f') AS foreign_keys,
        (SELECT indisunique FROM pg_index WHERE indexrelid='gps_continuity_alert_one_open'::regclass)
          AS unique_open`,
    );
    const index = await db.query<{ definition: string }>(
      "SELECT pg_get_indexdef('gps_continuity_alert_one_open'::regclass) AS definition",
    );
    if (
      constraints.rows[0]?.foreign_keys !== 3 ||
      constraints.rows[0].unique_open !== true ||
      !index.rows[0]?.definition.includes('resolved_at IS NULL')
    )
      throw new Error('Continuity alert constraints mismatch');
  }
  if (state >= 17) {
    const constraints = await db.query<{
      primary_key: number;
      foreign_key: number;
      bounded: number;
    }>(
      `SELECT
        count(*) FILTER (WHERE contype='p')::int AS primary_key,
        count(*) FILTER (WHERE contype='f')::int AS foreign_key,
        count(*) FILTER (WHERE contype='c' AND pg_get_constraintdef(oid) LIKE '%60%')::int AS bounded
       FROM pg_constraint WHERE conrelid='gps_continuity_read_quota'::regclass`,
    );
    const page = await db.query<{ definition: string }>(
      "SELECT pg_get_indexdef('gps_continuity_alert_page'::regclass) AS definition",
    );
    if (
      constraints.rows[0]?.primary_key !== 1 ||
      constraints.rows[0].foreign_key !== 1 ||
      constraints.rows[0].bounded !== 1 ||
      !page.rows[0]?.definition.includes('tenant_id, opened_at DESC, id DESC')
    )
      throw new Error('Continuity read constraints mismatch');
  }
  if (state >= 18) {
    const constraints = await db.query<{
      device_primary: number;
      device_foreign: number;
      device_checks: number;
      run_primary: number;
      run_checks: number;
      unique_link: boolean;
      unique_definition: string;
      customer_definition: string;
    }>(`SELECT
      (SELECT count(*)::int FROM pg_constraint WHERE conrelid='mdm_inventory_device'::regclass AND contype='p') AS device_primary,
      (SELECT count(*)::int FROM pg_constraint WHERE conrelid='mdm_inventory_device'::regclass AND contype='f') AS device_foreign,
      (SELECT count(*)::int FROM pg_constraint WHERE conrelid='mdm_inventory_device'::regclass AND contype='c') AS device_checks,
      (SELECT count(*)::int FROM pg_constraint WHERE conrelid='mdm_sync_run'::regclass AND contype='p') AS run_primary,
      (SELECT count(*)::int FROM pg_constraint WHERE conrelid='mdm_sync_run'::regclass AND contype='c') AS run_checks,
      (SELECT indisunique FROM pg_index WHERE indexrelid='mdm_inventory_one_geops_device'::regclass) AS unique_link,
      (SELECT pg_get_indexdef('mdm_inventory_one_geops_device'::regclass)) AS unique_definition,
      (SELECT pg_get_indexdef('mdm_inventory_customer'::regclass)) AS customer_definition`);
    const row = constraints.rows[0];
    if (
      row?.device_primary !== 1 ||
      row.device_foreign !== 1 ||
      row.device_checks !== 1 ||
      row.run_primary !== 1 ||
      row.run_checks !== 1 ||
      row.unique_link !== true ||
      !row.unique_definition.includes('geops_device_id IS NOT NULL') ||
      !row.customer_definition.includes('region, customer_id, mdm_device_id')
    )
      throw new Error('MDM inventory constraints mismatch');
  }
  const outcome = await db.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conrelid=to_regclass('mdm_sync_run') AND conname='mdm_sync_run_outcome_check'`,
  );
  if (
    state >= 18 &&
    (outcome.rowCount !== 1 || outcome.rows[0]?.definition.includes('PARTIAL') !== state >= 19)
  )
    throw new Error('MDM sync outcome constraint mismatch');
  if (state >= 19) {
    const controls = await db.query<{
      connection_primary: number;
      connection_checks: number;
      login_primary: number;
    }>(
      `SELECT
       (SELECT count(*)::int FROM pg_constraint WHERE conrelid='mdm_connection_control'::regclass AND contype='p') AS connection_primary,
       (SELECT count(*)::int FROM pg_constraint WHERE conrelid='mdm_connection_control'::regclass AND contype='c') AS connection_checks,
       (SELECT count(*)::int FROM pg_constraint WHERE conrelid='admin_login_limit'::regclass AND contype='p') AS login_primary`,
    );
    if (
      controls.rows[0]?.connection_primary !== 1 ||
      controls.rows[0].connection_checks !== 4 ||
      controls.rows[0].login_primary !== 1
    )
      throw new Error('MDM security constraints mismatch');
  }
  return state;
}

async function identityFingerprint(db: PoolClient, baseline: SchemaVersion): Promise<string> {
  // These table names are fixed source constants. Values are hashed in memory and never logged.
  const tables = [
    'admin_user',
    'admin_session',
    'device_session',
    'admin_permission',
    'gps_data_tenant_access',
    'gps_health_tenant_access',
    'recovery_custodian',
    'geops_device',
    'mdm_binding',
    'device_key',
    'device_invitation',
    'enrollment_claim',
    ...(baseline >= 15
      ? ['geops_operating_tenant', 'admin_user_invitation', 'admin_access_change']
      : []),
    ...(baseline >= 16 ? ['gps_continuity_threshold', 'gps_continuity_alert'] : []),
    ...(baseline >= 17 ? ['gps_continuity_read_quota'] : []),
    ...(baseline >= 18 ? ['mdm_inventory_device', 'mdm_sync_run'] : []),
    ...(baseline >= 19 ? ['mdm_connection_control', 'admin_login_limit'] : []),
  ];
  const digest = createHash('sha256');
  for (const table of tables) {
    digest.update(`${table}\n`);
    // 0017 adds this column to existing alerts. Compare the exact 0016 row shape
    // across the migration while still rejecting changes to every prior value.
    const projection =
      table === 'gps_continuity_alert' && baseline === 16
        ? "(to_jsonb(t) - 'evaluated_at')"
        : 'to_jsonb(t)';
    const rows = await db.query<{ value: string }>(
      `SELECT ${projection}::text AS value FROM ${table} t ORDER BY ${projection}::text`,
    );
    for (const row of rows.rows) digest.update(`${row.value}\n`);
  }
  return digest.digest('hex');
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
  outcome: 'success' | 'rejected' = 'success',
) {
  await db.query(
    "INSERT INTO audit_event(id,actor_type,action,outcome,correlation_id,metadata_redacted) VALUES($1,'SYSTEM',$2,$3,$4,$5::jsonb)",
    [
      randomUUID(),
      action,
      outcome,
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
  onStage?: (
    stage: 'authorized' | 'before_commit' | 'migrated' | 'audited',
    migration?: string,
  ) => Promise<void>,
): Promise<SchemaVersion> {
  const db = await pool.connect();
  let locked = false;
  try {
    await db.query('SELECT pg_advisory_lock(350021)');
    locked = true;
    const catalog = await recoveryCatalog();
    await checkIdentity(db, path, auth);
    const before = await schemaState(db, catalog);
    const identities = await identityFingerprint(db, before);
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
    for (let next = before + 1; next <= 19; next++) {
      const migration = catalog[next - 1];
      if (!migration) throw new Error('Recovery migration missing');
      await db.query('BEGIN');
      try {
        await db.query('SELECT pg_advisory_xact_lock(350001)');
        await checkIdentity(db, path, auth);
        if ((await schemaState(db, catalog)) !== next - 1)
          throw new Error('Migration state changed');
        await db.query(migration.sql);
        await db.query('INSERT INTO geops_schema_migrations(version,checksum) VALUES($1,$2)', [
          migration.version,
          migration.checksum,
        ]);
        if ((await schemaState(db, catalog)) !== next)
          throw new Error('Migration structure incomplete');
        await onStage?.('before_commit', migration.version);
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        await audit(db, auth, 'maintenance.recovery.migration_failed', next, 'rejected').catch(
          () => {},
        );
        throw error;
      }
      await onStage?.('migrated', migration.version);
      await checkIdentity(db, path, auth);
      if (identities !== (await identityFingerprint(db, before)))
        throw new Error('Identity or permission inventory changed during recovery');
    }
    await checkIdentity(db, path, auth);
    if ((await schemaState(db, catalog)) !== 19) throw new Error('Schema 19 not committed');
    if (identities !== (await identityFingerprint(db, before)))
      throw new Error('Identity or permission inventory changed during recovery');
    await db.query('BEGIN');
    try {
      await audit(db, auth, 'maintenance.recovery.validated', 19);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
    await onStage?.('audited');
    const gate = await checkIdentity(db, path, auth);
    if (
      (await schemaState(db, catalog)) !== 19 ||
      identities !== (await identityFingerprint(db, before))
    )
      throw new Error('Final maintenance integrity check failed');
    await recordGateEvent(path, 'maintenance.recovery.open', auth.epoch);
    await writeGate(path, { version: 1, phase: 'open', epoch: auth.epoch, nonce: gate.nonce });
    return before;
  } finally {
    if (locked) await db.query('SELECT pg_advisory_unlock(350021)').catch(() => {});
    db.release();
  }
}
