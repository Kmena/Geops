// Run only against an explicitly named disposable geops_verify_* PostgreSQL database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { GpsPolicyService } from '../src/gps-policy-service.ts';
import { windowsForRange } from '../src/gps-policy-windows.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+(?:_restore)?$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error(
    'A disposable geops_verify_* database and GEOPS_DATA_MODE=synthetic are required',
  );
const pool = new pg.Pool({ connectionString: url, max: 8 });
const dbName = (await pool.query('SELECT current_database() AS name')).rows[0].name;
assert.match(dbName, /^geops_verify_[0-9]+(?:_restore)?$/);
await pool.query('TRUNCATE admin_user, geops_device, audit_event CASCADE');
const auth = new AdminAuthService(pool, {
  sessionKey: Buffer.alloc(32, 1),
  csrfKey: Buffer.alloc(32, 2),
  allowedOrigins: ['https://geops.example.invalid'],
});
const service = new GpsPolicyService(pool);
const app = createApp({
  readinessProbe: async () => true,
  logLevel: 'silent',
  adminAuth: auth,
  gpsPolicies: service,
  secureCookie: false,
});
let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks++;
}
function iso(offsetDays) {
  return new Date(Date.now() + offsetDays * 86400_000).toISOString();
}
const spec = {
  name: 'Synthetic weekday capture',
  days_iso: [1, 2, 3, 4, 5, 6, 7],
  start_local: '08:00',
  end_local: '17:00',
  time_zone: 'America/Guatemala',
  capture_interval_s: 60,
  sync_interval_s: 300,
  heartbeat_missing_after_s: 900,
  valid_from: iso(-2),
  valid_until: iso(30),
};
let cookie, csrf;
async function call(method, path, body, key = randomUUID(), etag) {
  const result = await app.inject({
    method,
    url: path,
    headers: {
      cookie,
      origin: 'https://geops.example.invalid',
      'x-csrf-token': csrf,
      'idempotency-key': key,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(etag ? { 'if-match': etag } : {}),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return {
    status: result.statusCode,
    body: result.json(),
    etag: result.headers.etag,
    payload: result.payload,
  };
}
try {
  const adminId = await auth.bootstrap('spec02@example.invalid', 'synthetic-password-12345678');
  const caps = [
    'gps.policy.read',
    'gps.policy.write',
    'gps.policy.assign',
    'gps.policy.activate',
    'gps.session.read',
    'gps.location.read',
    'gps.audit.read',
  ];
  for (const cap of caps)
    await pool.query(
      'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
      [adminId, cap, 'Synthetic test grant'],
    );
  const device1 = randomUUID(),
    device2 = randomUUID();
  for (const id of [device1, device2])
    await pool.query(
      "INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','synthetic fixture')",
      [id],
    );
  const login = await app.inject({
    method: 'POST',
    url: '/v1/admin/auth/sessions',
    headers: { origin: 'https://geops.example.invalid' },
    payload: { email: 'spec02@example.invalid', password: 'synthetic-password-12345678' },
  });
  check(login.statusCode === 200, 'admin login');
  cookie = login.headers['set-cookie']?.split(';')[0];
  csrf = login.json().csrf_token;

  const unauth = await app.inject({
    method: 'POST',
    url: '/v1/admin/gps-policies',
    headers: { origin: 'https://geops.example.invalid', 'idempotency-key': randomUUID() },
    payload: spec,
  });
  check(unauth.statusCode === 401, 'anonymous mutation denied');
  const noCsrf = await app.inject({
    method: 'POST',
    url: '/v1/admin/gps-policies',
    headers: { cookie, origin: 'https://geops.example.invalid', 'idempotency-key': randomUUID() },
    payload: spec,
  });
  check(noCsrf.statusCode === 403, 'CSRF required');
  const created = await call('POST', '/v1/admin/gps-policies', spec);
  if (created.status !== 201) console.error('policy create status', created.status, created.body);
  check(created.status === 201 && created.etag, 'policy created');
  const invalidCursor = await call('GET', '/v1/admin/gps-policies?cursor=not-a-cursor');
  check(invalidCursor.status === 422, 'invalid opaque cursor rejected');
  const id = created.body.id;
  await assert.rejects(
    pool.query(
      "INSERT INTO gps_policy_revision(policy_id,revision,days_iso,start_local,end_local,time_zone,capture_interval_s,sync_interval_s,heartbeat_missing_after_s,valid_from,valid_until,created_by,reason) VALUES($1,99,ARRAY[1,1]::smallint[],'08:00','17:00','America/Guatemala',60,300,900,$2,$3,$4,'Synthetic invalid days')",
      [id, spec.valid_from, spec.valid_until, adminId],
    ),
    (e) => e.code === '23514',
  );
  checks++;
  await assert.rejects(
    pool.query(
      "INSERT INTO gps_policy_revision(policy_id,revision,days_iso,start_local,end_local,time_zone,capture_interval_s,sync_interval_s,heartbeat_missing_after_s,valid_from,valid_until,created_by,reason) VALUES($1,98,ARRAY[1,2]::smallint[],'08:00','17:00','Unknown/Zone',60,300,900,$2,$3,$4,'Synthetic invalid zone')",
      [id, spec.valid_from, spec.valid_until, adminId],
    ),
    (e) => e.code === '23514',
  );
  checks++;
  const assignment = {
    assignments: [
      { scope_type: 'DEVICE', scope_id: device1, valid_from: iso(-1), valid_until: iso(20) },
    ],
  };
  const assigned = await call(
    'PUT',
    `/v1/admin/gps-policies/${id}/assignments`,
    assignment,
    randomUUID(),
    created.etag,
  );
  check(assigned.status === 200, 'draft assignment');
  const detailed = await call('GET', `/v1/admin/gps-policies/${id}`);
  check(detailed.status === 200 && detailed.body.assignments?.length === 1 &&
    detailed.body.assignments[0].scope_id === device1, 'policy detail returns draft assignments for safe Web editing');
  const key = randomUUID(),
    reason = { reason: 'Synthetic approval' };
  const path = `/v1/admin/gps-policies/${id}/publish`;
  const published = await call('POST', path, reason, key, assigned.etag);
  check(
    published.status === 200 && published.body.state === 'ACTIVE' && published.body.revision === 1,
    'publish revision',
  );
  const replay = await call('POST', path, reason, key, assigned.etag);
  check(replay.status === 200, 'idempotent replay status');
  assert.deepEqual(replay.body, published.body);
  checks++;
  const changed = await call('POST', path, { reason: 'Different reason' }, key, assigned.etag);
  check(changed.status === 409, 'same key with changed body rejected');
  const changedPrecondition = await call('POST', path, reason, key, published.etag);
  check(changedPrecondition.status === 409, 'same key with changed If-Match rejected');
  const stale = await call('POST', path, reason, randomUUID(), assigned.etag);
  check(stale.status === 409, 'stale ETag rejected');
  const revisions = await pool.query(
    'SELECT revision FROM gps_policy_revision WHERE policy_id=$1',
    [id],
  );
  check(revisions.rowCount === 1, 'one committed immutable revision');
  const projected = await pool.query(
    'SELECT assignment_version FROM gps_effective_assignment WHERE device_id=$1 AND superseded_at IS NULL',
    [device1],
  );
  check(projected.rowCount === 1, 'effective device projection');
  const scheduled = await pool.query(
    "SELECT count(*)::int AS n FROM gps_scheduled_session WHERE device_id=$1 AND state='SCHEDULED'",
    [device1],
  );
  check(scheduled.rows[0].n > 0, 'UTC sessions generated');
  await assert.rejects(
    pool.query('UPDATE gps_policy_revision SET capture_interval_s=70 WHERE policy_id=$1', [id]),
    (e) => e.code === '55000',
  );
  checks++;
  await assert.rejects(
    pool.query('DELETE FROM gps_policy_assignment WHERE policy_id=$1 AND revision=1', [id]),
    (e) => e.code === '55000',
  );
  checks++;

  const other = await call('POST', '/v1/admin/gps-policies', {
    ...spec,
    name: 'Overlap candidate',
  });
  const otherAssign = await call(
    'PUT',
    `/v1/admin/gps-policies/${other.body.id}/assignments`,
    assignment,
    randomUUID(),
    other.etag,
  );
  const overlap = await call(
    'POST',
    `/v1/admin/gps-policies/${other.body.id}/publish`,
    reason,
    randomUUID(),
    otherAssign.etag,
  );
  check(overlap.status === 409, 'GiST overlap rejected');
  const rolled = await pool.query('SELECT state,current_revision FROM gps_policy WHERE id=$1', [
    other.body.id,
  ]);
  check(
    rolled.rows[0].state === 'DRAFT' && rolled.rows[0].current_revision === 0,
    'overlap rolled back',
  );

  const group = await call('POST', '/v1/admin/gps-groups', { name: 'Synthetic group' });
  const members = await call(
    'PUT',
    `/v1/admin/gps-groups/${group.body.id}/members`,
    { device_ids: [device2] },
    randomUUID(),
    group.etag,
  );
  check(members.status === 200, 'group membership');
  const grouped = await call(
    'PUT',
    `/v1/admin/gps-policies/${other.body.id}/assignments`,
    {
      assignments: [
        { scope_type: 'GROUP', scope_id: group.body.id, valid_from: iso(-1), valid_until: iso(20) },
      ],
    },
    randomUUID(),
    otherAssign.etag,
  );
  const groupPublish = await call(
    'POST',
    `/v1/admin/gps-policies/${other.body.id}/publish`,
    reason,
    randomUUID(),
    grouped.etag,
  );
  check(groupPublish.status === 200, 'group resolves for member');
  const collision = await call(
    'PUT',
    `/v1/admin/gps-groups/${group.body.id}/members`,
    { device_ids: [device1, device2] },
    randomUUID(),
    members.etag,
  );
  check(collision.status === 409, 'group member overlap rejected');
  const still = await pool.query(
    'SELECT count(*)::int AS n FROM gps_group_member WHERE group_id=$1 AND valid_until IS NULL',
    [group.body.id],
  );
  check(still.rows[0].n === 1, 'membership rolled back');
  const device3 = randomUUID();
  await pool.query(
    "INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','synthetic fixture')",
    [device3],
  );
  const racePolicies = [];
  for (const name of ['Race candidate A', 'Race candidate B']) {
    const candidate = await call('POST', '/v1/admin/gps-policies', { ...spec, name });
    const scope = await call(
      'PUT',
      `/v1/admin/gps-policies/${candidate.body.id}/assignments`,
      {
        assignments: [
          { scope_type: 'DEVICE', scope_id: device3, valid_from: iso(-1), valid_until: iso(20) },
        ],
      },
      randomUUID(),
      candidate.etag,
    );
    racePolicies.push({ id: candidate.body.id, etag: scope.etag });
  }
  const race = await Promise.all(
    racePolicies.map((candidate) =>
      call(
        'POST',
        `/v1/admin/gps-policies/${candidate.id}/publish`,
        reason,
        randomUUID(),
        candidate.etag,
      ),
    ),
  );
  check(
    race
      .map((x) => x.status)
      .sort()
      .join(',') === '200,409',
    'concurrent policies for same device serialize and reject overlap',
  );
  const oneWinner = await pool.query(
    'SELECT count(*)::int AS n FROM gps_effective_assignment WHERE device_id=$1 AND superseded_at IS NULL',
    [device3],
  );
  check(oneWinner.rows[0].n === 1, 'one effective assignment after concurrent overlap');

  const patch = await call(
    'PATCH',
    `/v1/admin/gps-policies/${id}`,
    { capture_interval_s: 90 },
    randomUUID(),
    published.etag,
  );
  check(patch.status === 200, 'draft frequency edit');
  const concurrent = await Promise.all([
    call('POST', path, reason, randomUUID(), patch.etag),
    call('POST', path, reason, randomUUID(), patch.etag),
  ]);
  check(
    concurrent
      .map((x) => x.status)
      .sort()
      .join(',') === '200,409',
    'CAS concurrent publication',
  );
  const latest = await pool.query('SELECT current_revision FROM gps_policy WHERE id=$1', [id]);
  check(latest.rows[0].current_revision === 2, 'one new revision');
  const sharedKey = randomUUID();
  const sameKey = await Promise.all([
    call(
      'POST',
      '/v1/admin/gps-policies',
      { ...spec, name: 'Concurrent idempotent create' },
      sharedKey,
    ),
    call(
      'POST',
      '/v1/admin/gps-policies',
      { ...spec, name: 'Concurrent idempotent create' },
      sharedKey,
    ),
  ]);
  check(
    sameKey.every((x) => x.status === 201) && sameKey[0].body.id === sameKey[1].body.id,
    'concurrent idempotent create inserts once',
  );
  const firstPage = await call('GET', '/v1/admin/gps-policies?limit=1');
  check(
    firstPage.status === 200 &&
      firstPage.body.items.length === 1 &&
      typeof firstPage.body.next_cursor === 'string',
    'opaque policy pagination',
  );
  const secondPage = await call(
    'GET',
    `/v1/admin/gps-policies?limit=1&cursor=${firstPage.body.next_cursor}`,
  );
  check(
    secondPage.status === 200 && secondPage.body.items[0].id !== firstPage.body.items[0].id,
    'cursor advances without duplicate',
  );
  const receipt = await pool.query(
    'SELECT extract(epoch from expires_at-created_at) AS ttl_s FROM gps_admin_idempotency WHERE key=$1',
    [sharedKey],
  );
  check(
    receipt.rowCount === 1 && Number(receipt.rows[0].ttl_s) === 86400,
    'idempotency receipt retained for 24 hours',
  );
  await pool.query(
    "UPDATE admin_permission SET revoked_at=now() WHERE admin_id=$1 AND permission='gps.policy.assign' AND revoked_at IS NULL",
    [adminId],
  );
  const deniedReplay = await call('POST', path, reason, key, assigned.etag);
  check(deniedReplay.status === 403, 'revoked capability blocks replay');
  const currentEtag = concurrent.find((x) => x.status === 200).etag;
  const frequencyOnly = await call(
    'PATCH',
    `/v1/admin/gps-policies/${id}`,
    { capture_interval_s: 120 },
    randomUUID(),
    currentEtag,
  );
  check(frequencyOnly.status === 200, 'frequency-only edit without assign');
  const frequencyPublish = await call('POST', path, reason, randomUUID(), frequencyOnly.etag);
  check(frequencyPublish.status === 200, 'unchanged scope publication needs no assign capability');
  const deniedAudit = await pool.query(
    "SELECT count(*)::int AS n FROM audit_event WHERE action='gps.policy.publish' AND outcome='rejected'",
  );
  check(deniedAudit.rows[0].n > 0, 'denial audit');
  await pool.query(
    "INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,'gps.policy.assign',$1,'Synthetic regrant')",
    [adminId],
  );
  const tombstone = await call(
    'POST',
    `/v1/admin/gps-policies/${id}/revoke`,
    reason,
    randomUUID(),
    frequencyPublish.etag,
  );
  check(tombstone.status === 200 && tombstone.body.state === 'REVOKED', 'revocation tombstone');
  const noEffective = await pool.query(
    'SELECT count(*)::int AS n FROM gps_effective_assignment WHERE device_id=$1 AND superseded_at IS NULL',
    [device1],
  );
  check(noEffective.rows[0].n === 0, 'revocation clears effective projection');
  const version = await pool.query(
    'SELECT assignment_version FROM gps_device_assignment_state WHERE device_id=$1',
    [device1],
  );
  check(Number(version.rows[0].assignment_version) > 1, 'revocation increases assignment version');
  const future = { ...spec, valid_from: iso(4), valid_until: iso(30) };
  const futureWindows = windowsForRange(future, new Date(), new Date(Date.now() + 3 * 86400_000));
  check(futureWindows.length === 0, 'future policy has no current window');
  const cross = windowsForRange(
    { ...spec, start_local: '22:00', end_local: '02:00' },
    new Date(Date.now() - 86400_000),
    new Date(Date.now() + 3 * 86400_000),
  );
  check(
    cross.some((w) => new Date(w.end_at).getTime() - new Date(w.start_at).getTime() > 0),
    'midnight windows',
  );
  const dst = {
    ...spec,
    time_zone: 'America/New_York',
    days_iso: [7],
    start_local: '01:30',
    end_local: '02:30',
    valid_from: '2026-10-31T00:00:00Z',
    valid_until: '2026-11-03T00:00:00Z',
  };
  const fallback = windowsForRange(dst, new Date(dst.valid_from), new Date(dst.valid_until));
  check(
    fallback.some(
      (w) =>
        w.local_date === '2026-11-01' &&
        w.start_at === '2026-11-01T05:30:00.000Z' &&
        w.end_at === '2026-11-01T07:30:00.000Z',
    ),
    'DST overlap uses early start offset and late end offset',
  );
  console.log(`GPS policy integration PASS: ${checks} assertions; disposable DB ${dbName}`);
} finally {
  await app.close();
  await pool.end();
}
