// Requires a disposable geops_verify_* database. No tenant or production API calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { applyMigrations } from '../src/db/migration-manager.ts';
import { MdmInventoryService } from '../src/mdm/inventory.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { DeviceRepository } from '../src/device-identity/repository.ts';
import { createApp } from '../src/app.ts';

const url = process.env.DATABASE_URL;
if (!url || !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
    process.env.GEOPS_DATA_MODE !== 'synthetic')
  throw new Error('Disposable synthetic DB required');
const pool = new pg.Pool({ connectionString: url });
try {
  assert.match((await pool.query('SELECT current_database() AS name')).rows[0].name,
    /^geops_verify_[0-9]+$/);
  await applyMigrations(pool);
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 11), csrfKey: Buffer.alloc(32, 12),
    allowedOrigins: ['https://geops.example.invalid'],
  });
  const admin = await auth.bootstrap('mdm@test.invalid', 'synthetic-password-12345678');
  const geopsA = randomUUID();
  const geopsB = randomUUID();
  await pool.query(
    "INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,'gps.installation.manage',$1,'Synthetic MDM integration fixture')",
    [admin]);
  await pool.query(
    "INSERT INTO geops_operating_tenant(tenant_id,established_by,audit_ref) VALUES('synthetic',$1,$2)",
    [admin, randomUUID()]);
  for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
    await pool.query(
      `INSERT INTO ${table}(admin_id,tenant_id,granted_by,reason) VALUES($1,'synthetic',$1,'Synthetic MDM integration fixture')`,
      [admin]);
  await pool.query(
    "INSERT INTO geops_device(id,status,display_label) VALUES($1,'DRAFT','A'),($2,'DRAFT','B')",
    [geopsA, geopsB]);
  const pages = [
    { items: [
      { mdm_device_id: '9007199254740995123', status: 'managed', platform: 'android', model: 'Pixel', removed: false },
      { mdm_device_id: '9007199254740995124', status: 'managed', platform: 'android', model: 'Samsung', removed: false },
      { mdm_device_id: '9007199254740995125', status: 'managed', platform: 'other', removed: false },
    ], next_cursor: 'page-two', source: 'manageengine' },
    { items: [
      { mdm_device_id: '9007199254740995124', status: 'managed', platform: 'android', removed: false },
      { mdm_device_id: '9007199254740995126', status: 'removed', platform: 'android', removed: true },
    ], next_cursor: null, source: 'manageengine' },
  ];
  let calls = 0;
  const provider = {
    listDevices: async (customer, cursor) => {
      assert.equal(customer, '12345');
      assert.equal(cursor, calls === 0 ? undefined : 'page-two');
      return pages[calls++];
    },
    getDevice: async (_customer, id) => ({
      mdm_device_id: id, status: 'managed', platform: 'android', removed: false,
    }),
  };
  const service = new MdmInventoryService(pool, provider, { region: 'com', customerId: '12345' });
  const app = createApp({
    readinessProbe: async () => true, logLevel: 'silent', adminAuth: auth,
    devices: new DeviceRepository(pool), mdm: provider, mdmInventory: service,
  });
  const noSession = await app.inject({ method: 'POST', url: '/v1/admin/mdm/sync' });
  assert.equal(noSession.statusCode, 401);
  const login = await auth.login('mdm@test.invalid', 'synthetic-password-12345678',
    '192.0.2.10', randomUUID());
  const noCsrf = await app.inject({
    method: 'POST', url: '/v1/admin/mdm/sync',
    headers: { cookie: `geops_admin=${login.token}`, origin: 'https://geops.example.invalid' },
  });
  assert.equal(noCsrf.statusCode, 403);
  const first = await service.sync(admin);
  assert.equal(first.device_count, 3);
  assert.equal(calls, 2);
  const items = (await service.list(25)).items;
  assert.equal(items.length, 3);
  assert.equal(items.find((row) => row.mdm_device_id.endsWith('126'))?.removed, true);
  await service.link(geopsA, '9007199254740995123', admin, randomUUID());
  await assert.rejects(
    service.link(geopsB, '9007199254740995123', admin, randomUUID()),
    { code: 'mdm_already_linked' });
  await assert.rejects(
    service.link(geopsA, '9007199254740995124', admin, randomUUID()),
    { code: 'geops_already_linked' });
  await assert.rejects(
    service.link(geopsB, '9007199254740995126', admin, randomUUID()),
    { code: 'mdm_device_unavailable' });
  await service.unlink(geopsA, admin, randomUUID());
  await service.link(geopsB, '9007199254740995123', admin, randomUUID());
  const credentials = await pool.query('SELECT count(*)::int AS total FROM device_key');
  assert.equal(credentials.rows[0].total, 0);
  const audit = await pool.query(
    "SELECT action FROM audit_event WHERE action LIKE 'mdm.%' ORDER BY occurred_at");
  assert.ok(audit.rows.some((row) => row.action === 'mdm.inventory.link'));
  assert.ok(audit.rows.some((row) => row.action === 'mdm.inventory.unlink'));
  // An incomplete later run cannot interpret unseen records as removals.
  const failing = new MdmInventoryService(pool, {
    listDevices: async () => { throw new Error('temporary upstream failure'); },
    getDevice: async () => null,
  }, { region: 'com', customerId: '12345' });
  await assert.rejects(failing.sync(admin));
  const retained = await pool.query(
    "SELECT status,geops_device_id FROM mdm_inventory_device WHERE mdm_device_id='9007199254740995123'");
  assert.equal(retained.rows[0].status, 'managed');
  assert.equal(retained.rows[0].geops_device_id, geopsB);
  const runs = await pool.query('SELECT outcome,error_code FROM mdm_sync_run ORDER BY started_at');
  assert.deepEqual(runs.rows.map((row) => row.outcome), ['SUCCESS', 'FAILED']);
  assert.equal(runs.rows[1].error_code, 'mdm_sync_failure');
  await app.close();
} finally {
  await pool.end();
}
