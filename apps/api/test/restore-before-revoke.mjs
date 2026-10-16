import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from 'node:crypto';
import { createPool } from '../dist/db/pool.js';
import { applyMigrations, checkReadiness } from '../dist/db/migration-manager.js';
import { DeviceRepository } from '../dist/device-identity/repository.js';
import { AdminAuthService } from '../dist/admin-auth/service.js';
import { DeviceSessionService } from '../dist/device-identity/session.js';

async function main() {
  const mode = process.argv[2];
  const name = process.env.GEOPS_TEST_DB;
  if (!['seed', 'revoke', 'old', 'quarantined'].includes(mode))
    throw new Error('Invalid test mode');
  if (
    !/^geops_verify_[0-9]+(_restore)?$/.test(name ?? '') ||
    process.env.GEOPS_DATA_MODE !== 'synthetic'
  ) {
    throw new Error('Invalid synthetic test database');
  }
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  try {
    if (mode === 'seed') {
      await applyMigrations(pool);
      const auth = new AdminAuthService(pool, {
        sessionKey: randomBytes(32),
        csrfKey: randomBytes(32),
        allowedOrigins: ['http://localhost:3501'],
      });
      await auth.bootstrap('restore@example.test', randomBytes(24).toString('base64url'));
      const repo = new DeviceRepository(pool);
      const device = await repo.createDraft('Synthetic pre-revocation restore');
      const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const spki = keys.publicKey.export({ type: 'spki', format: 'der' });
      const keyId = randomUUID();
      const token = randomBytes(32);
      await pool.query("UPDATE geops_device SET status='ACTIVE' WHERE id=$1", [device.id]);
      await pool.query("UPDATE mdm_binding SET state='ACTIVE' WHERE id=$1", [
        device.mdm_binding_id,
      ]);
      await pool.query(
        "INSERT INTO device_key(id,geops_device_id,public_key_spki_der,public_key_fingerprint,status) VALUES($1,$2,$3,$4,'ACTIVE')",
        [keyId, device.id, spki, createHash('sha256').update(spki).digest()],
      );
      await pool.query(
        "INSERT INTO device_session(id,geops_device_id,key_id,token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,now(),now()+interval '15 minutes')",
        [randomUUID(), device.id, keyId, createHash('sha256').update(token).digest()],
      );
      process.stdout.write('Synthetic active identity seeded\n');
    } else if (mode === 'revoke') {
      const row = await pool.query("SELECT id FROM geops_device WHERE status='ACTIVE' LIMIT 1");
      assert.equal(row.rowCount, 1);
      await new DeviceRepository(pool).revoke(row.rows[0].id);
      process.stdout.write('Synthetic identity revoked in source database\n');
    } else {
      assert.equal(await checkReadiness(pool), true);
      const row = await pool.query(
        'SELECT d.id AS device_id,k.id AS key_id,d.status,k.status AS key_status FROM geops_device d JOIN device_key k ON k.geops_device_id=d.id LIMIT 1',
      );
      assert.equal(row.rowCount, 1);
      const session = new DeviceSessionService(pool);
      if (mode === 'old') {
        assert.equal(row.rows[0].status, 'ACTIVE');
        assert.equal(
          (await pool.query("SELECT count(*)::int AS n FROM admin_user WHERE state='ACTIVE'"))
            .rows[0].n,
          1,
        );
        assert.equal(row.rows[0].key_status, 'ACTIVE');
        await session.challenge(row.rows[0].device_id, row.rows[0].key_id);
        const counts = await pool.query(
          'SELECT count(*)::int AS n FROM device_session WHERE revoked_at IS NULL',
        );
        assert.equal(counts.rows[0].n, 1);
        process.stdout.write(
          'Old backup demonstrably reactivates synthetic identity before quarantine\n',
        );
      } else {
        assert.equal(row.rows[0].status, 'REVOKED');
        assert.equal(
          (await pool.query("SELECT count(*)::int AS n FROM admin_user WHERE state='ACTIVE'"))
            .rows[0].n,
          0,
        );
        assert.equal(row.rows[0].key_status, 'REVOKED');
        await assert.rejects(session.challenge(row.rows[0].device_id, row.rows[0].key_id), {
          code: 'device_inactive',
        });
        const counts = await pool.query(
          "SELECT (SELECT count(*)::int FROM device_session WHERE revoked_at IS NULL) AS device_sessions,(SELECT count(*)::int FROM admin_session WHERE revoked_at IS NULL) AS admin_sessions,(SELECT count(*)::int FROM device_key WHERE status='ACTIVE') AS active_keys",
        );
        assert.deepEqual(counts.rows[0], { device_sessions: 0, admin_sessions: 0, active_keys: 0 });
        process.stdout.write(
          'Pre-revocation restore quarantined: all synthetic credentials inactive\n',
        );
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write('Pre-revocation restore test failed; details withheld\n');
  process.exitCode = 1;
});
