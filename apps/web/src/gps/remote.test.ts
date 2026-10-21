import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiClientError } from '../api/client.js';
import { GpsRemote } from './remote.js';

const id = '11111111-1111-4111-8111-111111111111';

test('continuity client validates versioned alerts and preserves reason, filters and errors', async () => {
  const calls: Array<{ path: string; headers: HeadersInit | undefined }> = [];
  let response: unknown = {
    schema_version: 1,
    items: [
      {
        alert_id: id,
        device_id: id,
        scheduled_session_id: id,
        status: 'OPEN',
        reason_code: 'CAPTURE_STALE',
        severity: 'WARNING',
        source: 'SERVER_INFERENCE',
        observed: {
          tracking_state: 'RUNNING',
          last_position_captured_at: null,
          last_position_received_at: null,
          last_health_observed_at: null,
          last_health_received_at: null,
        },
        inference: { evidence_at: null, age_s: 300, threshold_s: 300, evaluated_at: null },
        opened_at: '2026-10-20T15:00:00Z',
        updated_at: '2026-10-20T15:00:00Z',
        resolved_at: null,
        resolution_reason: null,
      },
    ],
    next_cursor: null,
  };
  let status = 200;
  const remote = new GpsRemote(async (path, init) => {
    calls.push({ path: String(path), headers: init?.headers });
    return new Response(JSON.stringify(response), { status });
  });
  const page = await remote.continuityAlerts(
    { device_id: id, status: 'OPEN', limit: 25 },
    'Consulta operativa de alertas',
  );
  assert.equal(page.items.length, 1);
  assert.match(calls[0]?.path ?? '', /gps-continuity\/alerts\?device_id=/);
  assert.equal(
    (calls[0]?.headers as Record<string, string> | undefined)?.['x-geops-access-reason'],
    'Consulta operativa de alertas',
  );
  response = { schema_version: 2, items: [], next_cursor: null };
  await assert.rejects(
    remote.continuityAlerts({}, 'Consulta operativa de alertas'),
    (error: unknown) => error instanceof ApiClientError && error.code === 'invalid_response',
  );
  status = 403;
  response = { error: { code: 'gps_forbidden' } };
  await assert.rejects(
    remote.continuityAlerts({}, 'Consulta operativa de alertas'),
    (error: unknown) => error instanceof ApiClientError && error.status === 403,
  );
});

test('read-only remote carries session cookie, reason, cursor, and cancellation', async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const transport: typeof fetch = async (path, init) => {
    calls.push({ path: String(path), init: init ?? {} });
    return new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200 });
  };
  const remote = new GpsRemote(transport);
  const controller = new AbortController();
  await remote.session(controller.signal);
  await remote.policies('a+/=');
  await remote.health(id, 'Synthetic review', 'page+/=', controller.signal);
  assert.equal(calls[0]?.path, '/v1/admin/auth/me');
  assert.equal(calls[1]?.path, '/v1/admin/gps-policies?cursor=a%2B%2F%3D');
  assert.equal(calls[2]?.path, `/v1/admin/devices/${id}/health?cursor=page%2B%2F%3D`);
  const healthCall = calls[2];
  assert.ok(healthCall);
  assert.equal(healthCall.init.credentials, 'same-origin');
  assert.equal(healthCall.init.cache, 'no-store');
  assert.equal(
    (healthCall.init.headers as Record<string, string>)['x-geops-access-reason'],
    'Synthetic review',
  );
  assert.equal(healthCall.init.signal, controller.signal);
  assert.equal(
    calls.every((call) => call.init.method === 'GET'),
    true,
  );
});

test('read-only remote preserves 401/403/409/429 and rejects invalid reason locally', async () => {
  let status = 401;
  const remote = new GpsRemote(
    async () =>
      new Response(JSON.stringify({ error: { code: `synthetic_${status}` } }), { status }),
  );
  for (const code of [401, 403, 409, 429]) {
    status = code;
    await assert.rejects(
      remote.health(id, 'Synthetic review'),
      (error: unknown) =>
        error instanceof ApiClientError &&
        error.status === code &&
        error.code === `synthetic_${code}`,
    );
  }
  assert.throws(
    () => remote.health(id, 'short'),
    (error: unknown) => error instanceof ApiClientError && error.status === 422,
  );
  assert.throws(
    () => remote.health('not-an-id', 'Synthetic review'),
    (error: unknown) => error instanceof ApiClientError && error.status === 422,
  );
});

test('Corte 3 remote uses authorized device, session and bounded position routes', async () => {
  const paths: string[] = [];
  const headers: HeadersInit[] = [];
  const remote = new GpsRemote(async (path, init) => {
    paths.push(String(path));
    headers.push(init?.headers ?? {});
    return new Response(JSON.stringify({ items: [], next_cursor: null, capabilities: [] }), {
      status: 200,
    });
  });
  await remote.capabilities();
  await remote.devices();
  await remote.sessions(id, 'cursor+/=');
  await remote.positions(
    id,
    'Synthetic review',
    '2026-10-19T00:00:00.000Z',
    '2026-10-19T12:00:00.000Z',
    'more+/=',
    undefined,
    id,
  );
  assert.equal(paths[0], '/v1/admin/gps-capabilities');
  assert.equal(paths[1], '/v1/admin/gps-devices');
  assert.equal(paths[2], `/v1/admin/devices/${id}/gps-sessions?cursor=cursor%2B%2F%3D`);
  assert.match(paths[3] ?? '', /from=2026-10-19T00%3A00%3A00.000Z/);
  assert.match(paths[3] ?? '', /session_id=11111111-1111-4111-8111-111111111111/);
  assert.equal((headers[3] as Record<string, string>)['x-geops-access-reason'], 'Synthetic review');
  assert.throws(
    () => remote.positions(id, 'Synthetic review', '2026-10-19T00:00:00Z', '2026-10-21T00:00:00Z'),
    (error: unknown) => error instanceof ApiClientError && error.status === 422,
  );
});

test('policy mutations send CSRF, unique idempotency keys and ETag without bypassing API', async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const remote = new GpsRemote(async (path, init) => {
    calls.push({ path: String(path), init: init ?? {} });
    return new Response(JSON.stringify({ id, state: 'DRAFT', etag: `"gps-policy:${id}:2"` }), {
      status: 200,
    });
  });
  const spec = {
    name: 'Prueba',
    days_iso: [1, 2, 3],
    start_local: '08:00',
    end_local: '17:00',
    time_zone: 'America/Guatemala',
    capture_interval_s: 60,
    sync_interval_s: 300,
    heartbeat_missing_after_s: 900,
    health_interval_s: 300,
    valid_from: '2026-10-19T00:00:00.000Z',
    valid_until: '2026-11-19T00:00:00.000Z',
  };
  const etag = `"gps-policy:${id}:1"`;
  await remote.createPolicy(spec, 'csrf-test');
  await remote.editPolicy(id, spec, etag, 'csrf-test');
  await remote.assignPolicy(
    id,
    [
      {
        scope_type: 'DEVICE',
        scope_id: id,
        valid_from: spec.valid_from,
        valid_until: spec.valid_until,
      },
    ],
    etag,
    'csrf-test',
  );
  await remote.transitionPolicy(id, 'publish', 'Prueba sintética', etag, 'csrf-test');
  assert.deepEqual(
    calls.map((call) => call.init.method),
    ['POST', 'PATCH', 'PUT', 'POST'],
  );
  assert.equal(calls[0]?.path, '/v1/admin/gps-policies');
  assert.equal(calls[2]?.path, `/v1/admin/gps-policies/${id}/assignments`);
  assert.equal(calls[3]?.path, `/v1/admin/gps-policies/${id}/publish`);
  const keys = calls.map(
    (call) => (call.init.headers as Record<string, string>)['idempotency-key'],
  );
  assert.equal(new Set(keys).size, 4);
  for (const call of calls) {
    const headers = call.init.headers as Record<string, string>;
    assert.equal(call.init.credentials, 'same-origin');
    assert.equal(headers['x-csrf-token'], 'csrf-test');
    assert.match(headers['idempotency-key'] ?? '', /^[0-9a-f-]{36}$/);
  }
  assert.equal(((calls[1]?.init.headers ?? {}) as Record<string, string>)['if-match'], etag);
  assert.equal(((calls[2]?.init.headers ?? {}) as Record<string, string>)['if-match'], etag);
  assert.equal(((calls[3]?.init.headers ?? {}) as Record<string, string>)['if-match'], etag);
});
