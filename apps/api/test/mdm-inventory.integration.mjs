// Requires a disposable geops_verify_* database. No tenant or production API calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { applyMigrations, checkReadiness } from '../src/db/migration-manager.ts';
import { MdmInventoryService } from '../src/mdm/inventory.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { DeviceRepository } from '../src/device-identity/repository.ts';
import { createApp } from '../src/app.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic DB required');
const pool = new pg.Pool({ connectionString: url });
try {
  assert.match(
    (await pool.query('SELECT current_database() AS name')).rows[0].name,
    /^geops_verify_[0-9]+$/,
  );
  const applied = await applyMigrations(pool);
  assert.equal(applied.length, 27);
  assert.deepEqual(applied.slice(17), [
    '0018_mdm_inventory.sql',
    '0019_mdm_security.sql',
    '0020_gps_mixed_batch_receipt.sql',
    '0021_gps_offline_policy_contract.sql',
    '0022_mdm_web_oauth.sql',
    '0023_mdm_oauth_client.sql',
    '0024_client_geofences.sql',
    '0025_route_catalog.sql',
    '0026_agents_assignments.sql',
    '0027_visit_dwell_engine.sql',
  ]);
  assert.equal(await checkReadiness(pool), true);
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 11),
    csrfKey: Buffer.alloc(32, 12),
    allowedOrigins: ['https://geops.example.invalid'],
  });
  const admin = await auth.bootstrap('mdm@test.invalid', 'synthetic-password-12345678');
  const geopsA = randomUUID();
  const geopsB = randomUUID();
  await pool.query(
    "INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,'gps.installation.manage',$1,'Synthetic MDM integration fixture')",
    [admin],
  );
  await pool.query(
    "INSERT INTO geops_operating_tenant(tenant_id,established_by,audit_ref) VALUES('synthetic',$1,$2)",
    [admin, randomUUID()],
  );
  for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
    await pool.query(
      `INSERT INTO ${table}(admin_id,tenant_id,granted_by,reason) VALUES($1,'synthetic',$1,'Synthetic MDM integration fixture')`,
      [admin],
    );
  await pool.query(
    "INSERT INTO geops_device(id,status,display_label) VALUES($1,'DRAFT','A'),($2,'DRAFT','B')",
    [geopsA, geopsB],
  );
  const pages = [
    {
      items: [
        {
          mdm_device_id: '9007199254740995123',
          status: 'managed',
          platform: 'android',
          model: 'Pixel',
          removed: false,
        },
        {
          mdm_device_id: '9007199254740995125',
          status: 'managed',
          platform: 'other',
          removed: false,
        },
      ],
      next_cursor: 'page-two',
      source: 'manageengine',
    },
    {
      items: [
        {
          mdm_device_id: '9007199254740995124',
          status: 'managed',
          platform: 'android',
          removed: false,
        },
        {
          mdm_device_id: '9007199254740995126',
          status: 'removed',
          platform: 'android',
          removed: true,
        },
      ],
      next_cursor: null,
      source: 'manageengine',
    },
  ];
  let calls = 0;
  const provider = {
    listDevices: async (customer, cursor) => {
      assert.equal(customer, '12345');
      assert.equal(cursor, calls === 0 ? undefined : 'page-two');
      return pages[calls++];
    },
    getDevice: async (_customer, id) => ({
      mdm_device_id: id,
      status: 'managed',
      platform: 'android',
      removed: false,
    }),
  };
  const service = new MdmInventoryService(pool, provider, { region: 'com', customerId: '12345' });
  const app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    devices: new DeviceRepository(pool),
    mdm: provider,
    mdmInventory: service,
  });
  const noSession = await app.inject({ method: 'POST', url: '/v1/admin/mdm/sync' });
  assert.equal(noSession.statusCode, 401);
  const login = await auth.login(
    'mdm@test.invalid',
    'synthetic-password-12345678',
    '192.0.2.10',
    randomUUID(),
  );
  const noCsrf = await app.inject({
    method: 'POST',
    url: '/v1/admin/mdm/sync',
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
  await assert.rejects(service.link(geopsB, '9007199254740995123', admin, randomUUID()), {
    code: 'mdm_already_linked',
  });
  await assert.rejects(service.link(geopsA, '9007199254740995124', admin, randomUUID()), {
    code: 'geops_already_linked',
  });
  await assert.rejects(service.link(geopsB, '9007199254740995126', admin, randomUUID()), {
    code: 'mdm_device_unavailable',
  });
  await service.unlink(geopsA, admin, randomUUID());
  await service.link(geopsB, '9007199254740995123', admin, randomUUID());
  const credentials = await pool.query('SELECT count(*)::int AS total FROM device_key');
  assert.equal(credentials.rows[0].total, 0);
  const audit = await pool.query(
    "SELECT action FROM audit_event WHERE action LIKE 'mdm.%' ORDER BY occurred_at",
  );
  assert.ok(audit.rows.some((row) => row.action === 'mdm.inventory.link'));
  assert.ok(audit.rows.some((row) => row.action === 'mdm.inventory.unlink'));
  // An incomplete later run cannot interpret unseen records as removals.
  const failing = new MdmInventoryService(
    pool,
    {
      listDevices: async () => {
        throw new Error('temporary upstream failure');
      },
      getDevice: async () => null,
    },
    { region: 'com', customerId: '12345' },
  );
  await assert.rejects(failing.sync(admin));
  const retained = await pool.query(
    "SELECT status,geops_device_id FROM mdm_inventory_device WHERE mdm_device_id='9007199254740995123'",
  );
  assert.equal(retained.rows[0].status, 'managed');
  assert.equal(retained.rows[0].geops_device_id, geopsB);
  const runs = await pool.query('SELECT outcome,error_code FROM mdm_sync_run ORDER BY started_at');
  assert.deepEqual(
    runs.rows.map((row) => row.outcome),
    ['SUCCESS', 'FAILED'],
  );
  assert.equal(runs.rows[1].error_code, 'mdm_sync_failure');
  // A later failed page must not publish an earlier removal or metadata change.
  let partialPage = 0;
  const partial = new MdmInventoryService(
    pool,
    {
      listDevices: async () => {
        if (partialPage++ === 0)
          return {
            items: [
              {
                mdm_device_id: '9007199254740995123',
                status: 'removed',
                platform: 'android',
                removed: true,
              },
            ],
            next_cursor: 'missing-page',
            source: 'manageengine',
          };
        throw new Error('synthetic second-page failure');
      },
      getDevice: async () => {
        throw new Error('No detail for removal');
      },
    },
    { region: 'com', customerId: '12345' },
  );
  await assert.rejects(partial.sync(admin));
  const afterPartial = await pool.query(
    "SELECT status,removed,geops_device_id FROM mdm_inventory_device WHERE customer_id='12345' AND mdm_device_id='9007199254740995123'",
  );
  assert.equal(afterPartial.rows[0].status, 'managed');
  assert.equal(afterPartial.rows[0].removed, false);
  assert.equal(afterPartial.rows[0].geops_device_id, geopsB);
  const partialRun = await pool.query(
    'SELECT outcome FROM mdm_sync_run ORDER BY started_at DESC LIMIT 1',
  );
  assert.equal(partialRun.rows[0].outcome, 'PARTIAL');
  // Duplicated IDs across pages are ambiguous; reject the entire run and retain the cache.
  let duplicatePage = 0;
  const duplicate = new MdmInventoryService(
    pool,
    {
      listDevices: async () =>
        duplicatePage++ === 0
          ? {
              items: [
                { mdm_device_id: '9007199254740995123', status: 'managed', platform: 'android' },
              ],
              next_cursor: 'more',
              source: 'manageengine',
            }
          : {
              items: [
                {
                  mdm_device_id: '9007199254740995123',
                  status: 'removed',
                  platform: 'android',
                  removed: true,
                },
              ],
              next_cursor: null,
              source: 'manageengine',
            },
      getDevice: async (_customer, id) => ({
        mdm_device_id: id,
        status: 'managed',
        platform: 'android',
      }),
    },
    { region: 'com', customerId: '12345' },
  );
  await assert.rejects(duplicate.sync(admin), { code: 'mdm_duplicate_device' });
  assert.equal(
    (
      await pool.query(
        "SELECT removed FROM mdm_inventory_device WHERE mdm_device_id='9007199254740995123' AND customer_id='12345'",
      )
    ).rows[0].removed,
    false,
  );
  let releaseDetail;
  let detailStarted;
  const detailSignal = new Promise((resolve) => {
    detailStarted = resolve;
  });
  const concurrentProvider = {
    listDevices: async () => ({
      items: [{ mdm_device_id: '9007199254740995123', status: 'managed', platform: 'android' }],
      next_cursor: null,
      source: 'manageengine',
    }),
    getDevice: async (_customer, id) => {
      detailStarted();
      await new Promise((resolve) => {
        releaseDetail = resolve;
      });
      return { mdm_device_id: id, status: 'managed', platform: 'android' };
    },
  };
  const activeSync = new MdmInventoryService(pool, concurrentProvider, {
    region: 'com',
    customerId: '12345',
  }).sync(admin);
  await detailSignal;
  try {
    await assert.rejects(
      new MdmInventoryService(pool, concurrentProvider, {
        region: 'com',
        customerId: '12345',
      }).sync(admin),
      { code: 'mdm_sync_running' },
    );
  } finally {
    releaseDetail();
  }
  await activeSync;
  // A complete empty inventory is valid and does not remove previously seen records.
  const empty = new MdmInventoryService(
    pool,
    {
      listDevices: async (customer, cursor) => {
        assert.equal(customer, '12345');
        assert.equal(cursor, undefined);
        return { items: [], next_cursor: null, source: 'manageengine' };
      },
      getDevice: async () => {
        throw new Error('Empty inventory must not request details');
      },
    },
    { region: 'com', customerId: '12345' },
  );
  assert.equal((await empty.sync(admin)).device_count, 0);
  assert.equal((await empty.sync(admin)).device_count, 0);
  const afterEmpty = await pool.query(
    "SELECT status,geops_device_id FROM mdm_inventory_device WHERE customer_id='12345' AND mdm_device_id='9007199254740995123'",
  );
  assert.equal(afterEmpty.rows[0].status, 'managed');
  assert.equal(afterEmpty.rows[0].geops_device_id, geopsB);
  assert.equal((await service.list(25)).items.length, 3);

  // MSP customer IDs are part of the inventory key and every admin link lookup.
  const otherCustomer = new MdmInventoryService(
    pool,
    {
      listDevices: async (customer) => {
        assert.equal(customer, '67890');
        return {
          items: [
            {
              mdm_device_id: '9007199254740995123',
              status: 'managed',
              platform: 'android',
              removed: false,
            },
          ],
          next_cursor: null,
          source: 'manageengine',
        };
      },
      getDevice: async (_customer, id) => ({
        mdm_device_id: id,
        status: 'managed',
        platform: 'android',
        removed: false,
      }),
    },
    { region: 'com', customerId: '67890' },
  );
  assert.equal((await otherCustomer.sync(admin)).device_count, 1);
  assert.equal((await otherCustomer.list(25)).items.length, 1);
  await assert.rejects(otherCustomer.link(geopsB, '9007199254740995123', admin, randomUUID()), {
    code: 'geops_already_linked',
  });
  const scoped = await pool.query(
    "SELECT customer_id,geops_device_id FROM mdm_inventory_device WHERE mdm_device_id='9007199254740995123' ORDER BY customer_id",
  );
  assert.deepEqual(
    scoped.rows.map((row) => row.customer_id),
    ['12345', '67890'],
  );
  assert.equal(scoped.rows[0].geops_device_id, geopsB);
  assert.equal(scoped.rows[1].geops_device_id, null);
  await app.close();
} finally {
  await pool.end();
}
