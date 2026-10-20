// Design-only reference vectors. This is not the GEOPS backend or Android agent.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { requestProofBytes } from '../../packages/api-contracts/src/identity.ts';

const spec = JSON.parse(readFileSync(new URL('./openapi.design.yaml', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validate = (name) =>
  ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });

const ids = {
  device: '11111111-1111-4111-8111-111111111111',
  installation: '22222222-2222-4222-8222-222222222222',
  policy: '33333333-3333-4333-8333-333333333333',
  anchor: '44444444-4444-4444-8444-444444444444',
  scheduled: '55555555-5555-4555-8555-555555555555',
  boot: '66666666-6666-4666-8666-666666666666',
  client: '77777777-7777-4777-8777-777777777777',
  event: '88888888-8888-4888-8888-888888888888',
};
const iso = (ms) => new Date(ms).toISOString();
const ms = (value) => Date.parse(value);
const within = (at, start, end) => ms(start) <= at && at < ms(end);
const overlap = (a, b) => ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end);

function captureDecision({ snapshot, monotonicNow, monotonicAnchor, boot, civilNow, maxSeenVersion }) {
  if (!snapshot.active || snapshot.assignment_version < maxSeenVersion || boot !== snapshot.boot_id)
    return 'DENY';
  const now = ms(snapshot.server_time) + monotonicNow - monotonicAnchor;
  if (Math.abs(civilNow - now) > 300_000) return 'DENY';
  if (now >= Math.min(ms(snapshot.offline_not_after), ms(snapshot.verified_at) + 12 * 3600_000))
    return 'DENY';
  if (!within(now, snapshot.policy.valid_from, snapshot.policy.valid_until)) return 'DENY';
  return snapshot.window_instances.some((w) => within(now, w.start_at, w.end_at))
    ? 'ALLOW'
    : 'DENY';
}

function localParts(at, zone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function resolveLocal(date, time, zone, boundary) {
  const target = `${date}T${time}`;
  const start = ms(`${date}T00:00:00Z`) - 18 * 3600_000;
  const matches = [];
  let nextValid;
  for (let at = start; at <= start + 60 * 3600_000; at += 60_000) {
    const local = localParts(at, zone);
    if (local === target) matches.push(at);
    if (local > target && local.startsWith(date) && nextValid === undefined) nextValid = at;
  }
  if (matches.length) return boundary === 'end' ? matches.at(-1) : matches[0];
  return nextValid; // DST gap: first valid instant after the requested local time.
}

function snapshot(overrides = {}) {
  return {
    schema_version: 1, capture_anchor_id: ids.anchor, device_id: ids.device,
    installation_id: ids.installation, assignment_version: 7, active: true,
    policy_id: ids.policy, policy_revision: 2, tzdb_version: 'synthetic-2026a',
    policy: {
      name: 'Synthetic', days_iso: [1], start_local: '22:00', end_local: '06:00',
      time_zone: 'America/Guatemala', capture_interval_s: 60, sync_interval_s: 300,
      heartbeat_missing_after_s: 900, valid_from: '2026-10-19T00:00:00Z',
      valid_until: '2026-10-21T00:00:00Z',
    },
    server_time: '2026-10-20T04:00:00Z', verified_at: '2026-10-20T04:00:00Z',
    offline_not_after: '2026-10-20T12:00:00Z', boot_id: ids.boot,
    window_instances: [{ scheduled_session_id: ids.scheduled,
      start_at: '2026-10-20T04:00:00Z', end_at: '2026-10-20T12:00:00Z' }],
    ...overrides,
  };
}
const gate = (s, at, extra = {}) => captureDecision({
  snapshot: s, monotonicAnchor: 1000, monotonicNow: 1000 + at - ms(s.server_time),
  boot: ids.boot, civilNow: at, maxSeenVersion: 7, ...extra,
});

test('V01 policy valid: overnight UTC instance and half-open end', () => {
  const start = resolveLocal('2026-10-19', '22:00', 'America/Guatemala', 'start');
  const end = resolveLocal('2026-10-20', '06:00', 'America/Guatemala', 'end');
  assert.equal(iso(start), '2026-10-20T04:00:00.000Z');
  assert.equal(iso(end), '2026-10-20T12:00:00.000Z');
  const s = snapshot();
  assert.equal(gate(s, ms('2026-10-20T05:00:00Z')), 'ALLOW');
  assert.equal(gate(s, end), 'DENY');
});

test('V02 expired policy fails closed', () => {
  const s = snapshot({ policy: { ...snapshot().policy, valid_until: '2026-10-20T05:00:00Z' } });
  assert.equal(gate(s, ms('2026-10-20T05:00:00Z')), 'DENY');
});

test('V03 future policy is not activated from offline cache', () => {
  const s = snapshot({ active: false, policy_id: undefined, policy_revision: undefined,
    policy: undefined, tzdb_version: undefined, window_instances: [] });
  assert.equal(gate(s, ms('2026-10-20T05:00:00Z')), 'DENY');
  const wire = Object.fromEntries(Object.entries(s).filter(([, value]) => value !== undefined && value !== ids.boot));
  assert.equal(validate('ConfigSnapshot')(wire), true, JSON.stringify(validate('ConfigSnapshot').errors));
});

test('V04 overlapping direct/group assignments are rejected at boundary', () => {
  const direct = { start: '2026-10-20T04:00:00Z', end: '2026-10-20T12:00:00Z' };
  assert.equal(overlap(direct, { start: '2026-10-20T11:00:00Z', end: '2026-10-20T13:00:00Z' }), true);
  assert.equal(overlap(direct, { start: direct.end, end: '2026-10-20T13:00:00Z' }), false);
});

test('V05 capture frequency change requires a new revision and session correlation', () => {
  const old = snapshot();
  const next = snapshot({ policy_revision: 3, assignment_version: 8,
    policy: { ...old.policy, capture_interval_s: 120 } });
  assert.equal(validate('ConfigSnapshot')(Object.fromEntries(Object.entries(next).filter(([k]) => k !== 'boot_id'))), true);
  assert.equal(next.policy.capture_interval_s, 120);
  assert.notEqual(`${old.policy_id}:${old.policy_revision}`, `${next.policy_id}:${next.policy_revision}`);
  assert.equal(gate(old, ms('2026-10-20T05:00:00Z'), { maxSeenVersion: 8 }), 'DENY');
});

test('V06 schedule change invalidates old window and opens only the new UTC interval', () => {
  const changed = snapshot({ assignment_version: 8, policy_revision: 3,
    policy: { ...snapshot().policy, start_local: '23:00', end_local: '06:00' },
    window_instances: [{ scheduled_session_id: ids.scheduled,
      start_at: '2026-10-20T05:00:00Z', end_at: '2026-10-20T12:00:00Z' }] });
  assert.equal(gate(changed, ms('2026-10-20T04:30:00Z'), { maxSeenVersion: 8 }), 'DENY');
  assert.equal(gate(changed, ms('2026-10-20T05:30:00Z'), { maxSeenVersion: 8 }), 'ALLOW');
});

test('V07 offline revocation is not instant, but expires by TTL and window end', () => {
  const s = snapshot();
  assert.equal(gate(s, ms('2026-10-20T06:00:00Z')), 'ALLOW');
  assert.equal(gate(s, ms('2026-10-20T12:00:00Z')), 'DENY');
  assert.equal(gate(snapshot({ active: false }), ms('2026-10-20T06:00:00Z')), 'DENY');
});

test('V08 clock skew, reboot and downgrade fail closed', () => {
  const s = snapshot();
  const at = ms('2026-10-20T05:00:00Z');
  assert.equal(gate(s, at, { civilNow: at + 300_001 }), 'DENY');
  assert.equal(gate(s, at, { boot: '99999999-9999-4999-8999-999999999999' }), 'DENY');
  assert.equal(gate(s, at, { maxSeenVersion: 8 }), 'DENY');
  assert.equal(ms(s.server_time) + (3_601_000 - 1_000), at);
});

function sessionStore() {
  const sessions = new Map();
  const pending = new Map();
  return {
    ingest(event) {
      const key = `${event.device_id}:${event.installation_id}:${event.client_session_id}`;
      const digest = createHash('sha256').update(JSON.stringify(event)).digest('hex');
      const current = sessions.get(key);
      if (event.type === 'STARTED') {
        if (current) return current.digest === digest ? { status: 200, session_id: current.id, duplicate: true } : { status: 409 };
        const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        sessions.set(key, { id, digest });
        pending.delete(key);
        return { status: 200, session_id: id, duplicate: false };
      }
      if (!current) { pending.set(key, event); return { status: 202, ack: false }; }
      return { status: 200, session_id: current.id, ack: true };
    },
    pendingCount() { return pending.size; },
  };
}
const started = { type: 'STARTED', device_id: ids.device, installation_id: ids.installation,
  client_session_id: ids.client, event_id: ids.event, occurred_at: '2026-10-20T04:00:00Z' };

test('V09 duplicate session has one canonical mapping; changed digest conflicts', () => {
  const store = sessionStore();
  const first = store.ingest(started);
  assert.equal(first.status, 200);
  assert.deepEqual(store.ingest(started), { ...first, duplicate: true });
  assert.equal(store.ingest({ ...started, occurred_at: '2026-10-20T04:01:00Z' }).status, 409);
});

test('V10 out-of-order event returns 202 without terminal ACK, then resolves', () => {
  const store = sessionStore();
  assert.deepEqual(store.ingest({ ...started, type: 'STOPPED' }), { status: 202, ack: false });
  assert.equal(store.pendingCount(), 1);
  assert.equal(store.ingest(started).status, 200);
  assert.equal(store.pendingCount(), 0);
});

test('V11 idempotent admin retry rechecks authorization and If-Match fingerprint', () => {
  const receipts = new Map();
  function attempt({ allowed, csrf, key, body, etag }) {
    if (!allowed || !csrf) return 403;
    const fingerprint = createHash('sha256').update(`${body}\n${etag}`).digest('hex');
    const prior = receipts.get(key);
    if (prior) return prior === fingerprint ? 200 : 409;
    receipts.set(key, fingerprint);
    return 200;
  }
  const req = { allowed: true, csrf: true, key: ids.event, body: '{}', etag: '"v1"' };
  assert.equal(attempt(req), 200);
  assert.equal(attempt(req), 200);
  assert.equal(attempt({ ...req, etag: '"v2"' }), 409);
  assert.equal(attempt({ ...req, allowed: false }), 403);
  assert.equal(attempt({ ...req, csrf: false }), 403);
});

test('V12 end of shift without Internet stops capture and retains unacknowledged buffer', () => {
  const s = snapshot();
  const pending = [ids.event];
  assert.equal(gate(s, ms('2026-10-20T11:59:59Z')), 'ALLOW');
  assert.equal(gate(s, ms('2026-10-20T12:00:00Z')), 'DENY');
  assert.deepEqual(pending, [ids.event]);
});

test('DST gap and overlap resolve to fixed UTC windows', () => {
  assert.equal(iso(resolveLocal('2026-03-08', '02:30', 'America/New_York', 'start')), '2026-03-08T07:00:00.000Z');
  assert.equal(iso(resolveLocal('2026-11-01', '01:30', 'America/New_York', 'start')), '2026-11-01T05:30:00.000Z');
  assert.equal(iso(resolveLocal('2026-11-01', '01:30', 'America/New_York', 'end')), '2026-11-01T06:30:00.000Z');
});

test('OpenAPI rejects incomplete active snapshot and requires session anchor only for effective events', () => {
  const config = validate('ConfigSnapshot');
  const active = Object.fromEntries(Object.entries(snapshot()).filter(([k]) => k !== 'boot_id'));
  assert.equal(config(active), true, JSON.stringify(config.errors));
  assert.equal(config({ ...active, policy: undefined }), false);
  assert.equal(config({ ...active, active: false }), false);
  const event = validate('SessionEvent');
  const common = { event_id: ids.event, occurred_at: '2026-10-20T04:00:00Z',
    assignment_version: 7, boot_id: ids.boot, elapsed_realtime_ms: 1000 };
  assert.equal(event({ ...common, type: 'MISSED_START', reason_code: 'FGS_START_BLOCKED' }), true);
  assert.equal(event({ ...common, type: 'STARTED', client_session_id: ids.client,
    scheduled_session_id: ids.scheduled }), false);
  assert.equal(event({ ...common, type: 'STARTED', client_session_id: ids.client,
    scheduled_session_id: ids.scheduled, capture_anchor_id: ids.anchor,
    anchor_elapsed_realtime_ms: 1000 }), true);
  assert.equal(event({ ...common, type: 'MISSED_START', reason_code: 'personal note' }), false);
});

test('existing TypeScript PoP bytes and OpenAPI authentication remain aligned', () => {
  const fields = { method: 'GET', absolutePath: '/v1/device/config', bodySha256: 'body',
    tokenSha256: 'token', timestamp: '1792440000', nonce: 'nonce', keyId: ids.device };
  assert.equal(new TextDecoder().decode(requestProofBytes(fields)),
    ['GEOPS-REQ-V1', 'GET', '/v1/device/config', 'body', 'token',
      '1792440000', 'nonce', ids.device].join('\n'));
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (path.startsWith('/v1/device/')) {
        assert.deepEqual(operation.security, [{ deviceBearer: [], deviceProof: [] }]);
        assert.equal(operation.parameters?.some((p) => p.in === 'query'), false);
      } else if (path === '/v1/admin/users/invitations/accept' && method === 'post') {
        assert.deepEqual(operation.security, [], 'one-time invitation activation has no admin session');
      } else if (path.startsWith('/v1/admin/')) {
        assert.equal(operation.security[0].adminCookie?.length, 0);
        if (method !== 'get') assert.equal(operation.security[0].csrfHeader?.length, 0);
      }
    }
  }
});
