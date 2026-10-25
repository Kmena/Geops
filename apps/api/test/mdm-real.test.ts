import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManageEngineReadOnly } from '../src/mdm/provider.js';
import { MdmOAuthRuntime } from '../src/mdm/oauth-runtime.js';
import type { RealMdmGrantStore } from '../src/mdm/real-grants.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { MdmInventoryService } from '../src/mdm/inventory.js';
import type { Pool } from 'pg';

test('real adapter configuration is limited to explicit staging test tenants', () => {
  const key = Buffer.alloc(32, 8).toString('base64url');
  const env = {
    GEOPS_DATA_MODE: 'synthetic',
    DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1/geops_dev',
    GEOPS_ADMIN_SESSION_KEY: key,
    GEOPS_ADMIN_CSRF_KEY: key,
    GEOPS_INVITATION_HMAC_KEY: key,
    GEOPS_MDM_GRANT_KEY: key,
    GEOPS_GPS_QUARANTINE_KEY: key,
    GEOPS_ALLOWED_ORIGINS: 'https://geops-staging.duckdns.org',
    GEOPS_ADMIN_COOKIE_NAME: '__Host-geops_stage_admin',
    MDM_ENABLED: 'true',
    GEOPS_MDM_REGION: 'com',
    GEOPS_MDM_CUSTOMER_ID: '12345',
    GEOPS_MDM_EDITION: 'TRIAL',
    GEOPS_MDM_CLIENT_ID: 'synthetic-client',
    GEOPS_MDM_CLIENT_SECRET: 'synthetic-secret',
    GEOPS_MDM_REFRESH_TOKEN: 'synthetic-refresh',
  };
  assert.throws(() => loadConfig(env), /staging test-tenant/);
  assert.equal(loadConfig({ ...env, GEOPS_MDM_TEST_TENANT: '1' }).mdm?.customerId, '12345');
  const discovered = loadConfig({
    ...env,
    GEOPS_MDM_TEST_TENANT: '1',
    GEOPS_MDM_CUSTOMER_ID: undefined,
    GEOPS_MDM_EDITION: undefined,
    GEOPS_MDM_REFRESH_TOKEN: undefined,
  });
  assert.equal(discovered.mdm?.region, 'com');
  assert.equal(discovered.mdm?.customerId, undefined);
  assert.equal(discovered.mdm?.configuredEdition, undefined);
  assert.throws(() => loadConfig({ ...env, MDM_ENABLED: 'false' }), /credentials/);
  assert.throws(() => loadConfig({ ...env, MDM_ENABLED: undefined }), /credentials/);
  assert.throws(
    () => loadConfig({ ...env, GEOPS_MDM_ENABLED: '1', GEOPS_MDM_TEST_TENANT: '1' }),
    /Legacy MDM/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...env,
        GEOPS_MDM_TEST_TENANT: '1',
        GEOPS_ALLOWED_ORIGINS: 'http://localhost:3501',
        GEOPS_ADMIN_COOKIE_NAME: 'geops_admin',
      }),
    /staging test-tenant/,
  );
});

test('OAuth refresh grants inventory access without exposing secrets and caches the access token', async () => {
  let refreshes = 0;
  const token = new MdmOAuthRuntime({
    clientId: 'test-client',
    clientSecret: 'test-secret',
    refreshToken: 'test-refresh',
    region: 'com',
    fetchImpl: async (url, init) => {
      refreshes++;
      assert.equal(String(url), 'https://accounts.zoho.com/oauth/v2/token');
      assert.equal(init?.redirect, 'error');
      assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'), 'test-refresh');
      return new Response(
        JSON.stringify({
          access_token: 'test-access',
          expires_in: 3600,
          scope: 'MDMOnDemand.MDMInventory.READ',
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(await token.token(), 'test-access');
  assert.equal(await token.token(), 'test-access');
  assert.equal(refreshes, 1);
});

test('browser grant rotation is persisted before a refreshed access token is returned', async () => {
  let grant = 'synthetic-old-refresh';
  let rotations = 0;
  const store = {
    load: async () => grant,
    rotate: async (oldValue: string, newValue: string) => {
      assert.equal(oldValue, grant);
      grant = newValue;
      rotations++;
    },
  } as unknown as RealMdmGrantStore;
  const runtime = new MdmOAuthRuntime({
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-secret',
    region: 'com',
    grantStore: store,
    fetchImpl: async () =>
      Response.json({
        access_token: 'synthetic-access',
        refresh_token: 'synthetic-new-refresh',
        expires_in: 3600,
        scope: 'MDMOnDemand.MDMInventory.READ',
      }),
  });
  assert.equal(await runtime.token(), 'synthetic-access');
  assert.equal(grant, 'synthetic-new-refresh');
  assert.equal(rotations, 1);
  assert.equal(await runtime.token(), 'synthetic-access');
  assert.equal(rotations, 1);
});

test('large numeric device IDs, detail attributes and vendor continuation preserve exact identity', async () => {
  const paths: string[] = [];
  const client = new ManageEngineReadOnly({
    enabled: true,
    origin: 'https://mdm.manageengine.com/',
    expectedOrigin: 'https://mdm.manageengine.com',
    token: async () => 'test-access',
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      paths.push(parsed.pathname + parsed.search);
      assert.equal(parsed.origin, 'https://mdm.manageengine.com');
      assert.equal(new Headers(init?.headers).get('X-CUSTOMER'), '9007199254740995123');
      if (parsed.pathname.endsWith('/9007199254740995124')) {
        return new Response(
          '{"device_id":9007199254740995124,"managed_status":2,"model":"Pixel",' +
            '"os":{"platform_type":"android","os_version":"15"},"serial_number":"TEST"}',
        );
      }
      if (parsed.searchParams.has('skip-token'))
        return new Response('{"devices":[],"metadata":{"total_record_count":1}}');
      return new Response(
        '{"devices":[{"device_id":9007199254740995124,"platform_type":"android"}],' +
          '"paging":{"next":"http://localhost:9020/api/v1/mdm/devices?skip-token=abc%3D%3D&offset=1"}}',
      );
    },
  });
  const first = await client.listDevices('9007199254740995123', undefined, 1);
  const mdmId = first.items[0]?.mdm_device_id;
  assert.equal(mdmId, '9007199254740995124');
  assert.ok(mdmId);
  const nextCursor = first.next_cursor;
  assert.ok(nextCursor);
  const detail = await client.getDevice('9007199254740995123', mdmId);
  assert.equal(detail?.status, 'managed');
  assert.equal(detail?.os_version, '15');
  assert.equal(detail?.platform, 'android');
  const second = await client.listDevices('9007199254740995123', nextCursor, 1);
  assert.equal(second.next_cursor, null);
  assert.ok(paths.some((path) => path.includes('skip-token=abc%3D%3D')));
});

test('MDM paging cannot redirect API requests to another path', async () => {
  const client = new ManageEngineReadOnly({
    enabled: true,
    origin: 'https://mdm.manageengine.com/',
    expectedOrigin: 'https://mdm.manageengine.com',
    token: async () => 'test',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          devices: [{ device_id: '123' }],
          paging: { next: 'https://attacker.example/private?skip-token=x&offset=1' },
        }),
      ),
  });
  await assert.rejects(client.listDevices('123', undefined, 1), { code: 'mdm_invalid_paging' });
});

test('invalid OAuth scope fails closed and does not cache access', async () => {
  const token = new MdmOAuthRuntime({
    clientId: 'test-client',
    clientSecret: 'test-secret',
    refreshToken: 'test-refresh',
    region: 'com',
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          access_token: 'test-access',
          expires_in: 3600,
          scope: 'MDMOnDemand.MDMAdmin.READ',
        }),
      ),
  });
  await assert.rejects(token.token(), { code: 'mdm_scope_insufficient' });
});

test('vendor response size and page bounds reject oversized and malformed content', async () => {
  let response: Response = new Response(JSON.stringify({ devices: [] }));
  const client = new ManageEngineReadOnly({
    enabled: true,
    origin: 'https://mdm.manageengine.com/',
    expectedOrigin: 'https://mdm.manageengine.com',
    token: async () => 'synthetic-access',
    fetchImpl: async () => response,
  });
  assert.equal((await client.listDevices('123', undefined, 25)).items.length, 0);
  response = new Response('{bad');
  await assert.rejects(client.listDevices('123', undefined, 25), { code: 'mdm_invalid_shape' });
  response = new Response('{}', { headers: { 'content-length': '2000000' } });
  await assert.rejects(client.listDevices('123', undefined, 25), {
    code: 'mdm_response_too_large',
  });
  response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000));
        controller.enqueue(new Uint8Array(600_000));
        controller.close();
      },
    }),
  );
  await assert.rejects(client.listDevices('123', undefined, 25), {
    code: 'mdm_response_too_large',
  });
  response = new Response(JSON.stringify({ devices: [{ device_id: '1' }, { device_id: '2' }] }));
  await assert.rejects(client.listDevices('123', undefined, 1), { code: 'mdm_invalid_shape' });
  response = new Response(JSON.stringify({ devices: [{ device_id: '1' }, { device_id: '1' }] }));
  await assert.rejects(client.listDevices('123', undefined, 2), { code: 'mdm_duplicate_device' });
});

test('vendor timeout and HTTP 5xx are bounded and sanitized', async () => {
  let timeout = false;
  const client = new ManageEngineReadOnly({
    enabled: true,
    origin: 'https://mdm.manageengine.com/',
    expectedOrigin: 'https://mdm.manageengine.com',
    token: async () => 'synthetic-access',
    timeoutMs: 50,
    fetchImpl: async (_url, init) => {
      if (!timeout) return new Response('synthetic upstream detail', { status: 503 });
      return new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(new Error('synthetic timeout'));
          return;
        }
        init?.signal?.addEventListener('abort', () => reject(new Error('synthetic timeout')), {
          once: true,
        });
      });
    },
  });
  await assert.rejects(client.listDevices('123', undefined, 25), { code: 'mdm_upstream_error' });
  timeout = true;
  await assert.rejects(client.listDevices('123', undefined, 25), { code: 'mdm_connection_error' });
});

test('real provider cannot be wired without persistent connection control', async () => {
  const provider = new ManageEngineReadOnly({
    enabled: true,
    origin: 'https://mdm.manageengine.com/',
    expectedOrigin: 'https://mdm.manageengine.com',
    token: async () => 'synthetic-access',
    fetchImpl: async () => new Response('{"devices":[]}'),
  });
  assert.throws(
    () => createApp({ readinessProbe: async () => true, mdm: provider }),
    /persistent connection control/,
  );
  const inventory = new MdmInventoryService({} as Pool, provider, {
    region: 'com',
    customerId: '12345',
  });
  await assert.rejects(inventory.sync(null), { code: 'mdm_control_unavailable' });
});
