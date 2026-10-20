// Upgrade 14 -> 15 only in a fresh disposable geops_verify_* database.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { applyMigrations } from '../src/db/migration-manager.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { SupervisedRecoveryService } from '../src/admin-auth/supervised-recovery.ts';
import {
  GpsCapabilityBootstrapService,
  INITIAL_GPS_CAPABILITIES,
} from '../src/admin-auth/gps-capability-bootstrap.ts';
import { AdminUserAdministrationService } from '../src/admin-auth/user-administration.ts';
import { DeviceRepository } from '../src/device-identity/repository.ts';

const url = process.env.DATABASE_URL;
const mode = process.argv[2] ?? 'full';
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic' ||
  !['full', 'prepare-14'].includes(mode)
)
  throw new Error('Fresh disposable synthetic DB required');
const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  const existing = await pool.query(
    "SELECT to_regclass('geops_schema_migrations') AS version_table",
  );
  assert.equal(existing.rows[0].version_table, null, 'requires empty disposable database');
  const files = (await readdir(new URL('../src/db/migrations/', import.meta.url)))
    .filter((name) => /^00(0[1-9]|1[0-4])_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  assert.equal(files.length, 14);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(
      'CREATE TABLE geops_schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const name of files) {
      const sql = await readFile(new URL(`../src/db/migrations/${name}`, import.meta.url), 'utf8');
      await db.query(sql);
      await db.query('INSERT INTO geops_schema_migrations(version,checksum) VALUES($1,$2)', [
        name,
        createHash('sha256').update(sql).digest('hex'),
      ]);
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 81),
    csrfKey: Buffer.alloc(32, 82),
    allowedOrigins: ['https://geops.example.invalid'],
  });
  const adminId = await auth.bootstrap('existing@example.invalid', 'synthetic-password-12345678');
  const session = await auth.login(
    'existing@example.invalid',
    'synthetic-password-12345678',
    '192.0.2.15',
    randomUUID(),
  );
  const epoch = randomUUID();
  await pool.query('INSERT INTO security_epoch(singleton,epoch) VALUES(true,$1)', [epoch]);
  for (const permission of INITIAL_GPS_CAPABILITIES.filter((value) => value !== 'gps.user.manage'))
    await pool.query(
      'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
      [adminId, permission, 'Pre-upgrade permission'],
    );
  const device = await new DeviceRepository(pool).createDraft(
    'Synthetic migration device',
    adminId,
    randomUUID(),
  );
  const publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({
    type: 'spki',
    format: 'der',
  });
  const keyId = randomUUID();
  const deviceSessionId = randomUUID();
  await pool.query("UPDATE geops_device SET status='ACTIVE' WHERE id=$1", [device.id]);
  await pool.query("UPDATE mdm_binding SET state='ACTIVE' WHERE id=$1", [device.mdm_binding_id]);
  await pool.query(
    "INSERT INTO device_key(id,geops_device_id,public_key_spki_der,public_key_fingerprint,status) VALUES($1,$2,$3,$4,'ACTIVE')",
    [keyId, device.id, publicKey, createHash('sha256').update(publicKey).digest()],
  );
  await pool.query(
    "INSERT INTO device_session(id,geops_device_id,key_id,token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,now(),now()+interval '15 minutes')",
    [deviceSessionId, device.id, keyId, randomBytes(32)],
  );
  if (mode === 'prepare-14') {
    console.log('Representative synthetic 0014 snapshot prepared');
  } else {
    // A deterministic schema collision forces 0015 to fail inside the migration transaction.
    await pool.query('CREATE TABLE geops_operating_tenant (collision boolean)');
    await assert.rejects(applyMigrations(pool));
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
      14,
      'failed upgrade leaves 14 migration records',
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,'gps.user.manage',$1,'Rejected before upgrade')",
        [adminId],
      ),
      'failed upgrade rolls back permission constraint change',
    );
    await pool.query('DROP TABLE geops_operating_tenant');
    const applied = await applyMigrations(pool);
    assert.deepEqual(applied, ['0015_single_tenant_admin.sql']);
    const rows = await pool.query(
      'SELECT permission FROM admin_permission WHERE admin_id=$1 AND revoked_at IS NULL',
      [adminId],
    );
    assert.equal(rows.rows.length, 9, 'existing grants retained; no automatic manager grant');
    assert.equal(
      rows.rows.some((row) => row.permission === 'gps.user.manage'),
      false,
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM geops_operating_tenant')).rows[0].n,
      0,
      'tenant not auto-established',
    );
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM geops_schema_migrations')).rows[0].n,
      15,
    );
    assert.equal((await pool.query('SELECT epoch FROM security_epoch')).rows[0].epoch, epoch);
    assert.equal(
      (await pool.query('SELECT state FROM admin_user WHERE id=$1', [adminId])).rows[0].state,
      'ACTIVE',
    );
    assert.equal(
      (await pool.query('SELECT revoked_at FROM admin_session WHERE id=$1', [session.sessionId]))
        .rows[0].revoked_at,
      null,
      'existing admin session retained',
    );
    assert.equal((await auth.authenticate(session.token)).id, adminId);
    assert.equal(
      (await pool.query('SELECT revoked_at FROM device_session WHERE id=$1', [deviceSessionId]))
        .rows[0].revoked_at,
      null,
      'existing device session retained',
    );
    const recovery = new SupervisedRecoveryService(pool, Buffer.alloc(32, 83));
    for (const email of ['first-custodian@example.invalid', 'second-custodian@example.invalid'])
      await recovery.registerSyntheticCustodian(email, 'synthetic-password-12345678');
    const ceremony = new GpsCapabilityBootstrapService(pool, async () => true);
    const input = () => ({
      requestId: randomUUID(),
      adminEmail: 'existing@example.invalid',
      adminPassword: 'synthetic-password-12345678',
      custodians: [
        { email: 'first-custodian@example.invalid', password: 'synthetic-password-12345678' },
        { email: 'second-custodian@example.invalid', password: 'synthetic-password-12345678' },
      ],
      reason: 'Approved legacy principal upgrade',
    });
    await ceremony.upgradeManager(input());
    await ceremony.establishTenant(input());
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM admin_permission WHERE admin_id=$1 AND permission='gps.user.manage' AND revoked_at IS NULL",
          [adminId],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (await pool.query('SELECT tenant_id FROM geops_operating_tenant')).rows[0].tenant_id,
      'synthetic',
    );
    const invited = await new AdminUserAdministrationService(pool).create(
      adminId,
      randomUUID(),
      'invited@example.invalid',
      'Synthetic upgrade invitation',
    );
    assert.equal(
      (
        await pool.query('SELECT consumed_at FROM admin_user_invitation WHERE id=$1', [
          invited.invitation_id,
        ])
      ).rows[0].consumed_at,
      null,
    );
    console.log('Migration 0015 upgrade from populated 14-migration database: PASS');
  }
} finally {
  await pool.end();
}
