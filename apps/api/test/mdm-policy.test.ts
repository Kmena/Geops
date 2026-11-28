import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ManageEngineReadOnly } from '../src/mdm/provider.js';
import { compareMdm } from '../src/mdm/policy-comparison.js';
import type { MdmDevicePolicyRead } from '../src/mdm/policy-read.js';
import { ManageEngineProfileWriter } from '../src/mdm/profile-writer.js';

const now = new Date('2026-11-27T12:00:00.000Z');

test('reads vendor profiles and apps without promoting assignment to effective permission', async () => {
  const seen: string[] = [];
  const client = new ManageEngineReadOnly({
    enabled: true,
    origin: 'https://mdm.manageengine.com/',
    expectedOrigin: 'https://mdm.manageengine.com',
    token: async () => 'synthetic-token',
    fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname;
      seen.push(path);
      assert.equal(new Headers(init?.headers).get('X-CUSTOMER'), '123');
      assert.equal(init?.method, 'GET');
      if (path.endsWith('/profiles'))
        return new Response(
          '{"profiles":[{"profile_id":9007199254740997,"profile_name":"Lab",' +
            '"status":"SCHEDULED","applied_time":1732700000000,"device_count":2}]}',
        );
      if (path.endsWith('/apps'))
        return Response.json({
          installed_apps: [
            {
              identifier: 'com.geops.corporate',
              app_id: 55,
              app_version: '1.0.1',
              app_version_code: 1,
            },
          ],
          apps: [{ identifier: 'com.geops.corporate', app_id: 55 }],
        });
      if (path.endsWith('/summary')) return Response.json({ last_contact_time: 1732700000000 });
      return Response.json({
        device_id: 456,
        managed_status: 2,
        platform_type: 'android',
        model: 'moto g06',
        os_version: '15',
      });
    },
  });
  const result = await client.readDevicePolicies('123', '456');
  assert.ok(result);
  assert.equal(result.profiles.items[0]?.profile_id, '9007199254740997');
  assert.equal(result.profiles.items[0]?.distribution, 'PENDING');
  assert.equal(result.profiles.items[0]?.applied_at, null);
  assert.equal(result.apps.items[0]?.installed_reported, true);
  assert.equal(result.apps.items[0]?.assigned, true);
  assert.equal(seen.length, 4);
});

test('partial MDM failure preserves other reads and sanitizes scope errors', async () => {
  const client = new ManageEngineReadOnly({
    enabled: true,
    origin: 'https://mdm.manageengine.com/',
    expectedOrigin: 'https://mdm.manageengine.com',
    token: async () => 'synthetic-token',
    fetchImpl: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/profiles')) return new Response('forbidden secret', { status: 403 });
      if (path.endsWith('/apps')) return Response.json({ installed_apps: [], apps: [] });
      if (path.endsWith('/summary')) return Response.json({});
      return Response.json({ device_id: 456, managed_status: 2, platform_type: 'android' });
    },
  });
  const result = await client.readDevicePolicies('123', '456');
  assert.equal(result?.profiles.state, 'SCOPE_DENIED');
  assert.equal(result?.apps.state, 'AVAILABLE');
  assert.equal(JSON.stringify(result).includes('forbidden secret'), false);
  await assert.rejects(client.readDevicePolicies('123', 'fake-456'), { code: 'invalid_mdm_id' });
});

test('comparison distinguishes assigned, pending, applied and Android effective evidence', () => {
  const mdm: MdmDevicePolicyRead = {
    mdm_device_id: '456',
    fetched_at: now.toISOString(),
    device: {
      status: 'managed',
      model: 'moto g06',
      android_version: '15',
      last_contact_at: now.toISOString(),
    },
    profiles: {
      state: 'AVAILABLE',
      items: [
        {
          profile_id: '7',
          name: 'Lab',
          distribution: 'PENDING',
          applied_at: null,
          shared_device_count: 2,
          configured_global_permission: 'UNKNOWN',
        },
      ],
    },
    apps: { state: 'AVAILABLE', items: [] },
  };
  assert.deepEqual(
    compareMdm('VALID', mdm, null, { profile_id: '7' }, now).map((f) => f.code),
    ['MDM_PROFILE_PENDING', 'MDM_DIAGNOSTIC_STALE'],
  );
  assert.deepEqual(
    compareMdm('VALID', mdm, null, { profile_id: '8' }, now).map((f) => f.code),
    ['MDM_PROFILE_NOT_ASSIGNED', 'MDM_DIAGNOSTIC_STALE'],
  );
  assert.deepEqual(
    compareMdm('INVALID', null, null, {}, now).map((f) => f.code),
    ['MDM_DEVICE_ID_INVALID'],
  );
  assert.ok(
    !compareMdm('VALID', mdm, null, {}, now).some((f) => f.code === 'MDM_PERMISSION_MISMATCH'),
  );
});

test('profile association transport is closed without an exact, live laboratory gate', async () => {
  let calls = 0;
  const writer = new ManageEngineProfileWriter({
    origin: 'https://mdm.manageengine.com/',
    expectedOrigin: 'https://mdm.manageengine.com',
    token: async () => 'synthetic-token',
    fetchImpl: async () => {
      calls++;
      return new Response(null, { status: 204 });
    },
  });
  await assert.rejects(writer.associateProfile('123', '456', '789'), {
    code: 'mdm_write_disabled',
  });
  assert.equal(calls, 0);
});

test('gated single-device association uses exact IDs, OAuth and rejects other targets', async () => {
  const seen: string[] = [];
  const writer = new ManageEngineProfileWriter({
    origin: 'https://mdm.manageengine.com/',
    expectedOrigin: 'https://mdm.manageengine.com',
    token: async () => 'synthetic-token',
    authorization: {
      customerId: '123',
      deviceId: '9007199254740997',
      profileId: '9007199254740999',
      expiresAt: new Date(Date.now() + 60_000),
      evidenceRef: 'SYNTHETIC-LAB-GATE',
    },
    fetchImpl: async (url, init) => {
      seen.push(String(url));
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('X-CUSTOMER'), '123');
      assert.equal(
        new Headers(init?.headers).get('Authorization'),
        'Zoho-oauthtoken synthetic-token',
      );
      assert.equal(init?.body, '{"profile_ids":[9007199254740999]}');
      return new Response(null, { status: 204 });
    },
  });
  await assert.rejects(writer.associateProfile('123', '456', '9007199254740999'), {
    code: 'mdm_write_disabled',
  });
  await writer.associateProfile('123', '9007199254740997', '9007199254740999');
  assert.deepEqual(seen, [
    'https://mdm.manageengine.com/api/v1/mdm/devices/9007199254740997/profiles',
  ]);
});

test('vendor detail mismatch and incomplete sections fail closed without leaking body', async () => {
  let subreads = 0;
  const mismatch = new ManageEngineReadOnly({
    enabled: true,
    origin: 'https://mdm.manageengine.com/',
    expectedOrigin: 'https://mdm.manageengine.com',
    token: async () => 'synthetic-token',
    fetchImpl: async () => {
      subreads++;
      return Response.json({ device_id: 999, managed_status: 2 });
    },
  });
  await assert.rejects(mismatch.readDevicePolicies('123', '456'), { code: 'mdm_invalid_shape' });
  assert.equal(subreads, 1);
  const partial = new ManageEngineReadOnly({
    enabled: true,
    origin: 'https://mdm.manageengine.com/',
    expectedOrigin: 'https://mdm.manageengine.com',
    token: async () => 'synthetic-token',
    fetchImpl: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/profiles')) return new Response('rate body secret', { status: 429 });
      if (path.endsWith('/apps'))
        return Response.json({ apps: [{ identifier: 'com.geops.corporate' }] });
      if (path.endsWith('/summary')) return Response.json({});
      return Response.json({ device_id: 456, managed_status: 2 });
    },
  });
  const result = await partial.readDevicePolicies('123', '456');
  assert.equal(result?.profiles.state, 'UNAVAILABLE');
  assert.equal(result?.apps.state, 'UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes('rate body secret'), false);
});

test('writer refreshes once on 401 and keeps rate-limit errors sanitized', async () => {
  let calls = 0,
    refreshes = 0;
  const options = {
    origin: 'https://mdm.manageengine.com/',
    expectedOrigin: 'https://mdm.manageengine.com',
    token: async () => 'expired',
    refresh: async () => {
      refreshes++;
      return 'fresh';
    },
    authorization: {
      customerId: '123',
      deviceId: '456',
      profileId: '789',
      expiresAt: new Date(Date.now() + 60_000),
      evidenceRef: 'SYNTHETIC-LAB-GATE',
    },
  };
  const writer = new ManageEngineProfileWriter({
    ...options,
    fetchImpl: async (_url, init) => {
      calls++;
      return new Response(null, {
        status:
          new Headers(init?.headers).get('Authorization') === 'Zoho-oauthtoken expired' ? 401 : 204,
      });
    },
  });
  await writer.associateProfile('123', '456', '789');
  assert.equal(calls, 2);
  assert.equal(refreshes, 1);
  const throttled = new ManageEngineProfileWriter({
    ...options,
    fetchImpl: async () => new Response('vendor secret', { status: 429 }),
  });
  await assert.rejects(
    throttled.associateProfile('123', '456', '789'),
    (error: unknown) => error instanceof Error && !error.message.includes('vendor secret'),
  );
});
