import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiClientError } from '../api/client.js';
import { gpsReadErrorMessage, loadGpsOverview } from './load.js';
import { GpsRemote } from './remote.js';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const failure = (status: number) =>
  new Response(JSON.stringify({ error: { code: `synthetic_${status}` } }), { status });

test('Staging capability response loads GPS policies with the browser fetch receiver', async () => {
  const capabilities = [
    'gps.audit.read',
    'gps.installation.manage',
    'gps.location.read',
    'gps.policy.activate',
    'gps.policy.assign',
    'gps.policy.read',
    'gps.policy.write',
    'gps.session.read',
    'gps.tenant.grant',
    'gps.user.manage',
  ];
  const paths: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (this: typeof globalThis, path, init) {
    assert.equal(this, globalThis);
    assert.equal(init?.credentials, 'same-origin');
    paths.push(String(path));
    if (String(path).endsWith('/gps-capabilities'))
      return Promise.resolve(ok({ capabilities, tenant_ids: ['synthetic'] }));
    return Promise.resolve(ok({ items: [], next_cursor: null }));
  };
  try {
    const remote = new GpsRemote();
    const observed: Array<{ rights: string[]; tenants: string[] }> = [];
    const overview = await loadGpsOverview(
      remote,
      new AbortController().signal,
      (rights, tenants) => observed.push({ rights, tenants }),
    );
    assert.deepEqual(observed, [{ rights: capabilities, tenants: ['synthetic'] }]);
    assert.deepEqual(overview.capabilities, capabilities);
    assert.deepEqual(overview.policies, []);
    assert.deepEqual(paths, [
      '/v1/admin/gps-capabilities',
      '/v1/admin/gps-policies',
      '/v1/admin/gps-devices',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('authenticated admin without capabilities gets a confirmed empty state without policy reads', async () => {
  const paths: string[] = [];
  const remote = new GpsRemote(async (path) => {
    paths.push(String(path));
    return ok({ capabilities: [] });
  });
  const observed: string[][] = [];
  const result = await loadGpsOverview(remote, new AbortController().signal, (rights) =>
    observed.push(rights),
  );
  assert.deepEqual(paths, ['/v1/admin/gps-capabilities']);
  assert.deepEqual(observed, [[]]);
  assert.deepEqual(result, { capabilities: [], policies: [], devices: [] });
});

test('valid capabilities load policies and authorized devices after capability discovery', async () => {
  const paths: string[] = [];
  const remote = new GpsRemote(async (path) => {
    paths.push(String(path));
    if (String(path).endsWith('/gps-capabilities'))
      return ok({ capabilities: ['gps.policy.read', 'gps.session.read'] });
    if (String(path).endsWith('/gps-policies'))
      return ok({ items: [{ id: 'policy-1' }], next_cursor: null });
    return ok({ items: [{ device_id: 'device-1' }] });
  });
  const result = await loadGpsOverview(remote, new AbortController().signal, () => {});
  assert.deepEqual(paths, [
    '/v1/admin/gps-capabilities',
    '/v1/admin/gps-policies',
    '/v1/admin/gps-devices',
  ]);
  assert.equal(result.policies[0]?.id, 'policy-1');
  assert.equal(result.devices[0]?.device_id, 'device-1');
});

test('effective permissions include independently granted tenant access', async () => {
  const remote = new GpsRemote(async () =>
    ok({ capabilities: ['gps.location.read', 'gps.policy.read'], tenant_ids: ['synthetic'] }),
  );
  const observed: Array<{ rights: string[]; tenants: string[] }> = [];
  await loadGpsOverview(remote, new AbortController().signal, (rights, tenants) =>
    observed.push({ rights, tenants }),
  );
  assert.deepEqual(observed, [
    { rights: ['gps.location.read', 'gps.policy.read'], tenants: ['synthetic'] },
  ]);
});

test('capability endpoint error stops policy loading and stays distinct from 403', async () => {
  const paths: string[] = [];
  const remote = new GpsRemote(async (path) => {
    paths.push(String(path));
    return failure(500);
  });
  await assert.rejects(
    loadGpsOverview(remote, new AbortController().signal, () => {}),
    (error: unknown) => error instanceof ApiClientError && error.status === 500,
  );
  assert.deepEqual(paths, ['/v1/admin/gps-capabilities']);
  assert.notEqual(
    gpsReadErrorMessage(new ApiClientError(500, 'synthetic_500')),
    gpsReadErrorMessage(new ApiClientError(403, 'gps_forbidden')),
  );
});

test('invalid location period explains the 24-hour limit', () => {
  assert.match(gpsReadErrorMessage(new ApiClientError(422, 'invalid_period')), /24 horas/);
});

test('capability endpoint 403 is not treated as an empty permission list', async () => {
  const remote = new GpsRemote(async () => failure(403));
  let confirmed = false;
  await assert.rejects(
    loadGpsOverview(remote, new AbortController().signal, () => {
      confirmed = true;
    }),
    (error: unknown) => error instanceof ApiClientError && error.status === 403,
  );
  assert.equal(confirmed, false);
});

test('network failure is explicit and refresh retries capability discovery', async () => {
  const paths: string[] = [];
  let fail = true;
  const remote = new GpsRemote(async (path) => {
    paths.push(String(path));
    if (fail) throw new TypeError('Synthetic network failure');
    if (String(path).endsWith('/gps-capabilities'))
      return ok({ capabilities: ['gps.policy.read'] });
    return ok({ items: [], next_cursor: null });
  });
  await assert.rejects(
    loadGpsOverview(remote, new AbortController().signal, () => {}),
    (error: unknown) => error instanceof ApiClientError && error.code === 'network_error',
  );
  fail = false;
  const recovered = await loadGpsOverview(remote, new AbortController().signal, () => {});
  assert.deepEqual(paths, [
    '/v1/admin/gps-capabilities',
    '/v1/admin/gps-capabilities',
    '/v1/admin/gps-policies',
  ]);
  assert.deepEqual(recovered.policies, []);
  assert.match(gpsReadErrorMessage(new ApiClientError(0, 'network_error')), /conexión/);
});

test('policy 403 remains a denial after capabilities were confirmed', async () => {
  const observed: string[][] = [];
  const remote = new GpsRemote(async (path) =>
    String(path).endsWith('/gps-capabilities')
      ? ok({ capabilities: ['gps.policy.read'] })
      : failure(403),
  );
  await assert.rejects(
    loadGpsOverview(remote, new AbortController().signal, (rights) => observed.push(rights)),
    (error: unknown) => error instanceof ApiClientError && error.status === 403,
  );
  assert.deepEqual(observed, [['gps.policy.read']]);
  assert.match(gpsReadErrorMessage(new ApiClientError(403, 'gps_forbidden')), /capacidad/);
});

test('malformed capability response does not masquerade as an empty grant list', async () => {
  const remote = new GpsRemote(async () => ok({ capabilities: null }));
  await assert.rejects(
    loadGpsOverview(remote, new AbortController().signal, () => {}),
    (error: unknown) => error instanceof ApiClientError && error.code === 'invalid_response',
  );
});

test('malformed tenant_ids does not trigger policy or device reads', async () => {
  const paths: string[] = [];
  const remote = new GpsRemote(async (path) => {
    paths.push(String(path));
    return ok({ capabilities: ['gps.policy.read', 'gps.session.read'], tenant_ids: 'synthetic' });
  });
  await assert.rejects(
    loadGpsOverview(remote, new AbortController().signal, () => {}),
    (error: unknown) => error instanceof ApiClientError && error.code === 'invalid_response',
  );
  assert.deepEqual(paths, ['/v1/admin/gps-capabilities']);
});
