import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdminAuthService } from '../dist/admin-auth/service.js';
import { createApp } from '../dist/app.js';
import { applyMigrations, checkReadiness } from '../dist/db/migration-manager.js';
import { createPool } from '../dist/db/pool.js';
import { quarantineSyntheticRestore } from '../dist/db/restore-quarantine.js';
import {
  closeGate,
  gateAllowsTraffic,
  initializeFreshGate,
  openGateAfterQuarantine,
  readGate,
  recoverMissingGate,
  verifyForReopen,
  writeGate,
} from '../dist/db/restore-gate.js';
import { DeviceRepository } from '../dist/device-identity/repository.js';
import { EnrollmentService } from '../dist/device-identity/enrollment.js';
import { DeviceSessionService } from '../dist/device-identity/session.js';
import { DeviceLifecycleService } from '../dist/device-identity/lifecycle.js';
import { FakeMdmProvider } from '../dist/mdm/provider.js';

let step = 'setup';
async function main() {
  const name = process.env.GEOPS_TEST_DB;
  if (
    !/^geops_verify_[0-9]+_restore$/.test(name ?? '') ||
    process.env.GEOPS_DATA_MODE !== 'synthetic'
  )
    throw new Error('Isolated synthetic restore database required');
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${name}`;
  let pool = createPool(url.toString());
  const dir = await mkdtemp(join(tmpdir(), 'geops-gate-'));
  const path = join(dir, 'security-gate.json');
  const keys = {
    sessionKey: randomBytes(32),
    csrfKey: randomBytes(32),
    allowedOrigins: ['http://localhost:3501'],
  };
  const appFor = (db) => {
    const auth = new AdminAuthService(db, keys);
    const devices = new DeviceRepository(db);
    const gate = () => gateAllowsTraffic(db, path);
    return {
      auth,
      app: createApp({
        readinessProbe: async () => (await gate()) && (await checkReadiness(db)),
        restoreGate: gate,
        logLevel: 'silent',
        adminAuth: auth,
        devices,
        mdm: new FakeMdmProvider(),
        enrollment: new EnrollmentService(db, devices, randomBytes(32)),
        deviceSessions: new DeviceSessionService(db),
        deviceLifecycle: new DeviceLifecycleService(db, devices),
      }),
    };
  };
  try {
    await applyMigrations(pool);
    assert.equal(await gateAllowsTraffic(pool, path), false);
    await initializeFreshGate(pool, path);
    assert.equal(await gateAllowsTraffic(pool, path), true);
    await assert.rejects(initializeFreshGate(pool, path));
    const { app, auth } = appFor(pool);
    let started;
    let release;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    app.get('/synthetic-pending', async () => {
      started();
      await waiting;
      return { status: 'done' };
    });
    const password = randomBytes(24).toString('base64url');
    const adminId = await auth.bootstrap('gate@example.test', password);
    const admin = await auth.login('gate@example.test', password, '192.0.2.10', randomUUID());
    await pool.query(
      "INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,'gps.policy.read',$1,'Synthetic restore grant')",
      [adminId],
    );
    for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
      await pool.query(
        `INSERT INTO ${table}(admin_id,tenant_id,granted_by,reason) VALUES($1,'synthetic',$1,'Synthetic restore grant')`,
        [adminId],
      );
    const invitationId = randomUUID();
    await pool.query(
      "INSERT INTO admin_user_invitation(id,admin_id,token_hash,issued_by,expires_at) VALUES($1,$2,$3,$2,now()+interval '1 day')",
      [invitationId, adminId, randomBytes(32)],
    );
    const repo = new DeviceRepository(pool);
    const device = await repo.createDraft('Synthetic restore gate');
    const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = key.publicKey.export({ type: 'spki', format: 'der' });
    const keyId = randomUUID();
    await pool.query("UPDATE geops_device SET status='ACTIVE' WHERE id=$1", [device.id]);
    await pool.query("UPDATE mdm_binding SET state='ACTIVE' WHERE id=$1", [device.mdm_binding_id]);
    await pool.query(
      "INSERT INTO device_key(id,geops_device_id,public_key_spki_der,public_key_fingerprint,status) VALUES($1,$2,$3,$4,'ACTIVE')",
      [keyId, device.id, spki, createHash('sha256').update(spki).digest()],
    );
    await pool.query(
      "INSERT INTO device_session(id,geops_device_id,key_id,token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,now(),now()+interval '15 minutes')",
      [randomUUID(), device.id, keyId, randomBytes(32)],
    );
    const cookie = `geops_admin=${admin.token}`;
    const challenge = () =>
      app.inject({
        method: 'POST',
        url: '/v1/device/sessions/challenge',
        payload: { geops_device_id: device.id, key_id: keyId },
      });
    assert.equal(
      (await app.inject({ method: 'GET', url: '/v1/admin/auth/me', headers: { cookie } }))
        .statusCode,
      200,
    );
    assert.equal((await challenge()).statusCode, 200);
    step = 'close-and-concurrent-http';

    const pending = app.inject({ method: 'GET', url: '/synthetic-pending' });
    await entered;
    const closed = await closeGate(path);
    assert.equal((await closeGate(path)).epoch, closed.epoch);
    const paths = [
      ['GET', '/v1/admin/auth/me', undefined, { cookie }],
      [
        'POST',
        '/v1/admin/auth/sessions',
        { email: 'gate@example.test', password },
        { origin: 'http://localhost:3501' },
      ],
      ['POST', '/v1/device/sessions/challenge', { geops_device_id: device.id, key_id: keyId }, {}],
      [
        'POST',
        '/v1/device/sessions',
        { geops_device_id: device.id, key_id: keyId, challenge_id: randomUUID(), signature: 'bad' },
        {},
      ],
      ['POST', '/v1/device/keys/rotate/challenge', {}, {}],
      [
        'POST',
        '/v1/admin/devices',
        { display_label: 'blocked' },
        { cookie, origin: 'http://localhost:3501', 'x-csrf-token': admin.csrfToken },
      ],
      ['POST', '/v1/device/locations/batches', {}, {}],
    ];
    const responses = await Promise.all(
      paths.map(([method, route, payload, headers]) =>
        app.inject({ method, url: route, payload, headers }),
      ),
    );
    assert.ok(responses.every((response) => response.statusCode === 503));
    assert.equal((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode, 503);
    assert.equal((await app.inject({ method: 'GET', url: '/health/live' })).statusCode, 200);
    await assert.rejects(openGateAfterQuarantine(pool, path));
    step = 'old-backup-epoch-mismatch';
    await writeGate(path, { ...closed, phase: 'open' });
    assert.equal(
      (await app.inject({ method: 'GET', url: '/v1/admin/auth/me', headers: { cookie } }))
        .statusCode,
      503,
    );
    await writeGate(path, closed);
    const stopping = app.close();
    release();
    assert.equal((await pending).statusCode, 200);
    await stopping;
    const restarted = appFor(pool).app;
    assert.equal(
      (await restarted.inject({ method: 'GET', url: '/v1/admin/auth/me', headers: { cookie } }))
        .statusCode,
      503,
    );
    await restarted.close();
    await pool.end();
    pool = createPool(url.toString());
    step = 'quarantine-failure-and-retry';
    await assert.rejects(quarantineSyntheticRestore(pool, 'geops_dev', path));
    await pool.query(
      "CREATE FUNCTION synthetic_quarantine_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$",
    );
    await pool.query(
      'CREATE TRIGGER synthetic_quarantine_failure BEFORE UPDATE ON device_key FOR EACH ROW EXECUTE FUNCTION synthetic_quarantine_failure()',
    );
    await assert.rejects(quarantineSyntheticRestore(pool, name, path));
    assert.equal((await readGate(path)).phase, 'closed');
    assert.equal(
      (await pool.query('SELECT status FROM device_key WHERE id=$1', [keyId])).rows[0].status,
      'ACTIVE',
    );
    await pool.query('DROP TRIGGER synthetic_quarantine_failure ON device_key');
    await pool.query('DROP FUNCTION synthetic_quarantine_failure()');
    assert.equal((await readGate(path)).phase, 'closed');
    await quarantineSyntheticRestore(pool, name, path);
    await quarantineSyntheticRestore(pool, name, path);
    const access = await pool.query(
      `SELECT
        (SELECT count(*)::int FROM admin_user_invitation WHERE consumed_at IS NULL) AS invitations,
        (SELECT count(*)::int FROM admin_permission WHERE revoked_at IS NULL) AS permissions,
        (SELECT count(*)::int FROM gps_data_tenant_access WHERE revoked_at IS NULL) AS data_grants,
        (SELECT count(*)::int FROM gps_health_tenant_access WHERE revoked_at IS NULL) AS health_grants`,
    );
    assert.deepEqual(access.rows[0], {
      invitations: 0,
      permissions: 0,
      data_grants: 0,
      health_grants: 0,
    });
    assert.equal(await verifyForReopen(pool, path), true);
    await assert.rejects(openGateAfterQuarantine(pool, path));
    await assert.rejects(
      openGateAfterQuarantine(pool, path, { databaseName: name, epoch: randomUUID() }),
    );
    await openGateAfterQuarantine(pool, path, { databaseName: name, epoch: closed.epoch });
    assert.equal(await gateAllowsTraffic(pool, path), true);
    const after = appFor(pool).app;
    assert.equal(
      (await after.inject({ method: 'GET', url: '/v1/admin/auth/me', headers: { cookie } }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await after.inject({
          method: 'POST',
          url: '/v1/device/sessions/challenge',
          payload: { geops_device_id: device.id, key_id: keyId },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await after.inject({
          method: 'POST',
          url: '/v1/admin/auth/sessions',
          payload: { email: 'gate@example.test', password },
          headers: { origin: 'http://localhost:3501' },
        })
      ).statusCode,
      401,
    );
    await after.close();
    const lostDir = await mkdtemp(join(tmpdir(), 'geops-gate-lost-'));
    try {
      const lostPath = join(lostDir, 'security-gate.json');
      await recoverMissingGate(pool, lostPath, name);
      assert.equal((await readGate(lostPath)).phase, 'closed');
      assert.equal(await gateAllowsTraffic(pool, lostPath), false);
      await assert.rejects(recoverMissingGate(pool, lostPath, name));
    } finally {
      await rm(lostDir, { recursive: true, force: true });
    }
    const missing = new URL(url);
    missing.pathname = '/geops_verify_999999999999';
    const failedPool = createPool(missing.toString());
    assert.equal(await gateAllowsTraffic(failedPool, path), false);
    await failedPool.end();
    assert.equal(adminId.length, 36);
    process.stdout.write(
      'GEOPS restore gate: PASS closed HTTP, restart, epoch mismatch, retry, quarantine and old credential rejection\n',
    );
  } finally {
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  }
}
main().catch(() => {
  process.stderr.write(`GEOPS restore gate failed at ${step}; details withheld\n`);
  process.exitCode = 1;
});
