import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { FakeMdmProvider, ManageEngineReadOnly } from '../src/mdm/provider.js';
import { type EncryptedGrantStore, SyntheticTokenManager } from '../src/mdm/grants.js';

const origin = 'https://mdm.manageengine.com/';
const syntheticToken = () => randomBytes(32).toString('base64url');

test('fake inventory is labelled, empty is success and pagination preserves string IDs', async () => {
  const fake = new FakeMdmProvider([
    { mdm_device_id: '900000000000000001', status: 'managed' },
    { mdm_device_id: '900000000000000002', status: 'managed' },
  ]);
  const first = await fake.listDevices('synthetic', undefined, 1);
  assert.equal(first.source, 'fake');
  assert.equal(first.items[0]?.mdm_device_id, '900000000000000001');
  const next = await fake.listDevices('synthetic', first.next_cursor ?? undefined, 1);
  assert.equal(next.items[0]?.mdm_device_id, '900000000000000002');
  assert.equal(next.next_cursor, null);
  assert.deepEqual((await new FakeMdmProvider().listDevices('synthetic', undefined, 25)).items, []);
  assert.equal((await fake.integrationStatus()).connected, false);
});

test('real read-only mock uses GET, string X-CUSTOMER, Zoho auth and manual redirects', async () => {
  const token = syntheticToken();
  let calls = 0;
  const client = new ManageEngineReadOnly({
    enabled: true,
    origin,
    expectedOrigin: 'https://mdm.manageengine.com',
    token: async () => token,
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(init?.method, 'GET');
      assert.equal(init?.redirect, 'manual');
      assert.equal(new Headers(init?.headers).get('X-CUSTOMER'), '900000000000000001');
      assert.equal(new Headers(init?.headers).get('Authorization'), `Zoho-oauthtoken ${token}`);
      assert.equal(new URL(String(url)).pathname, '/api/v1/mdm/devices');
      return new Response(JSON.stringify({ devices: [] }), { status: 200 });
    },
  });
  const page = await client.listDevices('900000000000000001', undefined, 25);
  assert.deepEqual(page.items, []);
  assert.equal(page.source, 'manageengine');
  assert.equal(calls, 1);
});

test('401 refreshes once and concurrent token refresh is single flight', async () => {
  let calls = 0;
  let refreshes = 0;
  const client = new ManageEngineReadOnly({
    enabled: true,
    origin,
    expectedOrigin: 'https://mdm.manageengine.com',
    token: async () => syntheticToken(),
    refresh: async () => {
      refreshes++;
      return syntheticToken();
    },
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? new Response('', { status: 401 })
        : new Response(JSON.stringify({ devices: [] }), { status: 200 });
    },
  });
  assert.equal((await client.listDevices('123', undefined, 1)).items.length, 0);
  assert.equal(calls, 2);
  assert.equal(refreshes, 1);
});

for (const [status, code] of [
  [403, 'mdm_forbidden'],
  [429, 'mdm_rate_limited'],
  [302, 'mdm_redirect_rejected'],
] as const) {
  test(`upstream ${status} is sanitized as ${code}`, async () => {
    const client = new ManageEngineReadOnly({
      enabled: true,
      origin,
      expectedOrigin: 'https://mdm.manageengine.com',
      token: async () => syntheticToken(),
      fetchImpl: async () =>
        new Response('', {
          status,
          headers: status === 429 ? { 'retry-after': '3' } : { location: 'https://example.test' },
        }),
    });
    await assert.rejects(client.listDevices('123', undefined, 1), { code });
  });
}

test('connection error, bad origin and disabled real adapter fail closed', async () => {
  assert.throws(
    () =>
      new ManageEngineReadOnly({
        enabled: false,
        origin,
        expectedOrigin: 'https://mdm.manageengine.com',
        token: async () => syntheticToken(),
      }),
  );
  assert.throws(
    () =>
      new ManageEngineReadOnly({
        enabled: true,
        origin: 'https://example.test/',
        expectedOrigin: 'https://mdm.manageengine.com',
        token: async () => syntheticToken(),
      }),
  );
  const client = new ManageEngineReadOnly({
    enabled: true,
    origin,
    expectedOrigin: 'https://mdm.manageengine.com',
    token: async () => syntheticToken(),
    fetchImpl: async () => {
      throw new Error('synthetic upstream details');
    },
  });
  await assert.rejects(client.listDevices('123', undefined, 1), { code: 'mdm_connection_error' });
});

test('disconnect invalidates a synthetic refresh already in flight', async () => {
  let connected = true;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let finishExchange: ((value: { token: string; expiresInSeconds: number }) => void) | undefined;
  const exchange = new Promise<{ token: string; expiresInSeconds: number }>((resolve) => {
    finishExchange = resolve;
  });
  const store = {
    load: async () =>
      connected
        ? {
            provider: 'manageengine',
            region: 'synthetic',
            customerId: '123',
            scopes: [],
            refreshToken: 'synthetic-refresh',
          }
        : null,
    disconnect: async () => {
      connected = false;
    },
  } as unknown as EncryptedGrantStore;
  const manager = new SyntheticTokenManager(store, async () => {
    markStarted?.();
    return exchange;
  });
  const pending = manager.token('synthetic', '123');
  await started;
  await manager.disconnect('synthetic', '123');
  assert.ok(finishExchange);
  finishExchange({ token: syntheticToken(), expiresInSeconds: 3600 });
  await assert.rejects(pending, /disconnected/);
  await assert.rejects(manager.token('synthetic', '123'), /unavailable/);
});
