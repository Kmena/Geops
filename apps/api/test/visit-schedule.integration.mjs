// Run after Wave 1/2 fixtures against a fresh disposable geops_verify_* PostGIS database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { RouteCatalogService } from '../src/route-catalog.ts';
import { VisitScheduleService, resolveLocal } from '../src/visit-schedule.ts';
import { applyMigrations } from '../src/db/migration-manager.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic DB required');
const pool = new pg.Pool({ connectionString: url, max: 5 });
const origin = 'https://geops.example.invalid';
let checks = 0;
const check = (condition, label) => {
  assert.ok(condition, label);
  checks++;
};
const status = (response, expected, label) =>
  check(response.statusCode === expected, `${label}: ${response.statusCode} ${response.body}`);
const plus = (date, days) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const dayIso = (date) => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day || 7;
};
const baseDate = plus(new Date().toISOString().slice(0, 10), 32);
let app;
try {
  await applyMigrations(pool);
  check(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM geops_schema_migrations WHERE version='0026_agents_assignments.sql'",
      )
    ).rows[0].n === 1,
    'Wave 3 migration applied',
  );
  check(
    resolveLocal('2026-10-26', '08:00', 'America/Guatemala') === '2026-10-26T14:00:00.000Z',
    'local time resolves to UTC',
  );
  assert.throws(() => resolveLocal('2026-03-08', '02:30', 'America/New_York'), /Invalid request/);
  checks++;
  assert.throws(() => resolveLocal('2026-11-01', '01:30', 'America/New_York'), /Invalid request/);
  checks++;
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 11),
    csrfKey: Buffer.alloc(32, 12),
    allowedOrigins: [origin],
  });
  const owner = (
    await pool.query("SELECT id FROM admin_user WHERE email_normalized='owner@example.invalid'")
  ).rows[0].id;
  const outsider = (
    await pool.query("SELECT id FROM admin_user WHERE email_normalized='outsider@example.invalid'")
  ).rows[0].id;
  app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    routeCatalog: new RouteCatalogService(pool, { max_radius_m: 500, max_dwell_s: 3600 }),
    visitSchedule: new VisitScheduleService(pool),
    secureCookie: false,
  });
  const login = async (email) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/sessions',
      headers: { origin },
      payload: { email, password: 'synthetic-password-12345678' },
    });
    status(response, 200, `login ${email}`);
    return {
      cookie: response.headers['set-cookie'].split(';')[0],
      csrf: response.json().csrf_token,
    };
  };
  const admin = await login('owner@example.invalid'),
    reader = await login('outsider@example.invalid');
  const call = (session, method, path, payload, extra = {}) =>
    app.inject({
      method,
      url: path,
      headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrf, ...extra },
      ...(payload === undefined ? {} : { payload }),
    });
  const mutate = (session, method, path, payload, extra = {}) =>
    call(session, method, path, payload, { 'idempotency-key': randomUUID(), ...extra });
  status(await call(admin, 'GET', '/v1/admin/agents'), 403, 'schedule read denied before grant');
  for (const permission of ['visit.schedule.read', 'visit.schedule.write'])
    await pool.query(
      'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
      [owner, permission, 'Synthetic Wave 3 verification'],
    );
  await pool.query(
    'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$3,$4)',
    [outsider, 'visit.schedule.read', owner, 'Synthetic read only schedule'],
  );
  status(await call(reader, 'GET', '/v1/admin/agents'), 200, 'schedule read grant');
  status(
    await mutate(reader, 'POST', '/v1/admin/agents', { code: 'AGX', name: 'Sin permiso' }),
    403,
    'reader cannot create agent',
  );
  const capabilities = await call(admin, 'GET', '/v1/admin/schedule-capabilities');
  check(
    capabilities.json().capabilities.includes('visit.schedule.write') &&
      capabilities.json().agent_device_integration === 'PENDING',
    'capabilities expose planning only',
  );
  const a = await mutate(admin, 'POST', '/v1/admin/agents', { code: 'AG001', name: 'Agente Uno' });
  status(a, 201, 'create agent');
  const agentId = a.json().id;
  const b = await mutate(admin, 'POST', '/v1/admin/agents', { code: 'AG002', name: 'Agente Dos' });
  status(b, 201, 'create second agent');
  const agentB = b.json().id;
  status(
    await mutate(admin, 'POST', '/v1/admin/agents', { code: 'AG001', name: 'Duplicado' }),
    409,
    'duplicate agent code',
  );
  status(
    await mutate(admin, 'POST', '/v1/admin/agents', { code: '?', name: 'Inválido' }),
    422,
    'invalid agent code',
  );
  check(
    (await call(admin, 'GET', '/v1/admin/agents?q=AG00&state=ACTIVE&limit=1')).json().next_cursor,
    'agent list cursor',
  );
  status(
    await mutate(admin, 'PATCH', `/v1/admin/agents/${agentId}`, { name: 'Agente Uno Editado' }),
    428,
    'agent edit requires ETag',
  );
  status(
    await mutate(
      admin,
      'PATCH',
      `/v1/admin/agents/${agentId}`,
      { name: 'Agente Uno Editado' },
      { 'if-match': '"0"' },
    ),
    412,
    'agent stale ETag',
  );
  status(
    await mutate(
      admin,
      'PATCH',
      `/v1/admin/agents/${agentId}`,
      { name: 'Agente Uno Editado' },
      { 'if-match': '"1"' },
    ),
    200,
    'agent edited',
  );
  const route = (
    await pool.query("SELECT id,published_revision FROM route_template WHERE code='R01'")
  ).rows[0];
  const assignment = (agent, routeId, revision, day, start, end, origin = 'MANUAL') => ({
    agent_id: agent,
    route_id: routeId,
    route_revision: revision,
    local_date: day,
    time_zone: 'America/Guatemala',
    starts_local: start,
    ends_local: end,
    reason: 'Planificación sintética',
    origin,
  });
  const one = await mutate(
    admin,
    'POST',
    '/v1/admin/assignments',
    assignment(agentId, route.id, 2, baseDate, '08:00', '09:00'),
  );
  status(one, 201, 'first assignment');
  const assignmentId = one.json().id;
  check(
    one.json().visits.length === 2 && one.json().agent_name === 'Agente Uno Editado',
    'assignment snapshot includes agent and stops',
  );
  const two = await mutate(
    admin,
    'POST',
    '/v1/admin/assignments',
    assignment(agentId, route.id, 1, baseDate, '09:00', '10:00'),
  );
  status(two, 201, 'second route revision same day adjacent');
  check(two.json().route_revision === 1, 'exact published revision selected');
  status(
    await mutate(
      admin,
      'POST',
      '/v1/admin/assignments',
      assignment(agentId, route.id, 2, baseDate, '08:30', '09:30'),
    ),
    409,
    'overlap rejected but multiple routes per day allowed',
  );
  status(
    await mutate(
      admin,
      'POST',
      '/v1/admin/assignments',
      assignment(agentB, route.id, 2, baseDate, '08:00', '09:00'),
    ),
    201,
    'same route assigned to another agent',
  );
  const calendar = await call(
    admin,
    'GET',
    `/v1/admin/calendar?from=${baseDate}&to=${baseDate}&agent_id=${agentId}`,
  );
  status(calendar, 200, 'calendar read');
  check(calendar.json().items.length === 2, 'calendar shows multiple routes same day');
  status(
    await mutate(admin, 'POST', '/v1/admin/assignments', {
      ...assignment(agentId, route.id, 2, baseDate, '10:00', '11:00'),
      device_id: randomUUID(),
    }),
    422,
    'device injection rejected',
  );
  status(
    await mutate(
      admin,
      'POST',
      '/v1/admin/assignments',
      assignment(agentId, route.id, 999, baseDate, '10:00', '11:00'),
    ),
    404,
    'unpublished revision rejected',
  );
  const agentInactive = await mutate(
    admin,
    'PATCH',
    `/v1/admin/agents/${agentB}`,
    { state: 'INACTIVE' },
    { 'if-match': '"1"' },
  );
  status(agentInactive, 200, 'agent deactivated');
  status(
    await mutate(
      admin,
      'POST',
      '/v1/admin/assignments',
      assignment(agentB, route.id, 2, plus(baseDate, 1), '08:00', '09:00'),
    ),
    409,
    'inactive agent cannot be assigned',
  );
  const historic = await call(admin, 'GET', `/v1/admin/assignments/${assignmentId}`);
  status(historic, 200, 'assignment detail');
  await assert.rejects(
    pool.query('UPDATE assignment_visit SET radius_m=1 WHERE assignment_id=$1', [assignmentId]),
    /immutable/,
  );
  checks++;
  await pool.query("UPDATE route_template SET name='Plantilla cambiada' WHERE id=$1", [route.id]);
  check(
    (await call(admin, 'GET', `/v1/admin/assignments/${assignmentId}`)).json().route_name ===
      historic.json().route_name,
    'assignment route snapshot survives template edit',
  );
  const cancelled = await mutate(
    admin,
    'POST',
    `/v1/admin/assignments/${assignmentId}/cancel`,
    { reason: 'Cancelación sintética' },
    { 'if-match': '"1"' },
  );
  status(cancelled, 200, 'cancel assignment');
  check(
    (await call(admin, 'GET', `/v1/admin/assignments/${assignmentId}`)).json().visits.length === 2,
    'cancel preserves visits',
  );
  status(
    await mutate(
      admin,
      'POST',
      `/v1/admin/assignments/${assignmentId}/cancel`,
      { reason: 'Otra cancelación' },
      { 'if-match': '"2"' },
    ),
    409,
    'double cancellation rejected',
  );
  const client = (await pool.query("SELECT id FROM client WHERE code='RCLIENT'")).rows[0];
  const site = (
    await pool.query("SELECT id FROM client_site WHERE client_id=$1 AND code='MAIN'", [client.id])
  ).rows[0];
  const alternate = await mutate(admin, 'POST', '/v1/admin/routes', {
    code: 'W3ALT',
    name: 'Ruta alterna',
  });
  status(alternate, 201, 'alternate route fixture');
  const altStops = await mutate(
    admin,
    'PUT',
    `/v1/admin/routes/${alternate.json().id}/draft/stops`,
    { stops: [{ site_id: site.id, geofence_revision: 2, required: true, suggested_order: 1 }] },
    { 'if-match': '"1"' },
  );
  status(altStops, 200, 'alternate stop fixture');
  status(
    await mutate(
      admin,
      'POST',
      `/v1/admin/routes/${alternate.json().id}/publish`,
      {},
      { 'if-match': '"2"' },
    ),
    200,
    'alternate published fixture',
  );
  status(
    await mutate(
      admin,
      'POST',
      '/v1/admin/assignments',
      assignment(agentId, alternate.json().id, 1, baseDate, '10:00', '11:00'),
    ),
    201,
    'different published route assigned to same agent and date',
  );
  const ruleBody = {
    agent_id: agentId,
    route_id: route.id,
    route_revision: 2,
    start_date: baseDate,
    end_date: plus(baseDate, 14),
    days_iso: [dayIso(baseDate), dayIso(plus(baseDate, 1))],
    time_zone: 'America/Guatemala',
    starts_local: '11:00',
    ends_local: '12:00',
    reason: 'Regla semanal sintética',
  };
  const rule = await mutate(admin, 'POST', '/v1/admin/schedule-rules', ruleBody);
  status(rule, 201, 'create weekly rule');
  const ruleId = rule.json().id;
  const firstRun = await mutate(
    admin,
    'POST',
    `/v1/admin/schedule-rules/${ruleId}/materialize`,
    { from: baseDate, to: plus(baseDate, 7) },
    { 'if-match': '"1"' },
  );
  status(firstRun, 200, 'materialize bounded window');
  check(firstRun.json().generated >= 2, 'weekly days materialized');
  const replay = await mutate(
    admin,
    'POST',
    `/v1/admin/schedule-rules/${ruleId}/materialize`,
    { from: baseDate, to: plus(baseDate, 7) },
    { 'if-match': '"1"' },
  );
  check(
    replay.json().generated === 0 && replay.json().unchanged === firstRun.json().generated,
    'materializer idempotent with new key',
  );
  status(
    await mutate(
      admin,
      'POST',
      `/v1/admin/schedule-rules/${ruleId}/materialize`,
      { from: baseDate, to: plus(baseDate, 31) },
      { 'if-match': '"1"' },
    ),
    422,
    'materialization horizon bounded',
  );
  const skip = await mutate(
    admin,
    'PUT',
    `/v1/admin/schedule-rules/${ruleId}/exceptions/${plus(baseDate, 7)}`,
    { action: 'SKIP', reason: 'Omitir visita sintética' },
    { 'if-match': '"1"' },
  );
  status(skip, 200, 'skip exception');
  const afterSkip = await mutate(
    admin,
    'POST',
    `/v1/admin/schedule-rules/${ruleId}/materialize`,
    { from: baseDate, to: plus(baseDate, 7) },
    { 'if-match': '"2"' },
  );
  status(afterSkip, 200, 'reconcile skip exception');
  check(
    afterSkip.json().cancelled >= 1 && afterSkip.json().skipped >= 1,
    'skip cancels prior future occurrence',
  );
  const replace = await mutate(
    admin,
    'PUT',
    `/v1/admin/schedule-rules/${ruleId}/exceptions/${baseDate}`,
    {
      action: 'REPLACE',
      replacement_route_id: alternate.json().id,
      replacement_revision: 1,
      reason: 'Ruta alterna sintética',
    },
    { 'if-match': '"2"' },
  );
  status(replace, 200, 'replacement exception');
  status(
    await mutate(
      admin,
      'POST',
      `/v1/admin/schedule-rules/${ruleId}/materialize`,
      { from: baseDate, to: plus(baseDate, 1) },
      { 'if-match': '"3"' },
    ),
    200,
    'materialize replacement',
  );
  const currentOccurrence = await pool.query(
    'SELECT a.route_id,a.route_revision FROM route_schedule_occurrence o JOIN route_assignment a ON a.id=o.assignment_id WHERE o.rule_id=$1 AND o.local_date=$2',
    [ruleId, baseDate],
  );
  check(
    currentOccurrence.rows[0].route_id === alternate.json().id,
    'replacement points to alternate published route',
  );
  const cancelException = await mutate(
    admin,
    'PUT',
    `/v1/admin/schedule-rules/${ruleId}/exceptions/${plus(baseDate, 1)}`,
    { action: 'CANCEL', reason: 'Cancelar ocurrencia sintética' },
    { 'if-match': '"3"' },
  );
  status(cancelException, 200, 'cancel exception');
  status(
    await mutate(
      admin,
      'POST',
      `/v1/admin/schedule-rules/${ruleId}/materialize`,
      { from: baseDate, to: plus(baseDate, 1) },
      { 'if-match': '"4"' },
    ),
    200,
    'materialize cancellation',
  );
  const occurrence = (
    await pool.query(
      'SELECT outcome,assignment_id FROM route_schedule_occurrence WHERE rule_id=$1 AND local_date=$2',
      [ruleId, plus(baseDate, 1)],
    )
  ).rows[0];
  check(
    occurrence.outcome === 'CANCELLED' && occurrence.assignment_id === null,
    'cancelled occurrence is not active',
  );
  const extraordinary = await mutate(
    admin,
    'POST',
    '/v1/admin/assignments',
    assignment(
      agentId,
      alternate.json().id,
      1,
      plus(baseDate, 2),
      '14:00',
      '15:00',
      'EXTRAORDINARY',
    ),
  );
  status(extraordinary, 201, 'extraordinary manual assignment');
  const patchedRule = await mutate(
    admin,
    'PATCH',
    `/v1/admin/schedule-rules/${ruleId}`,
    { time_zone: 'America/Costa_Rica', reason: 'Cambio de zona sintético' },
    { 'if-match': '"4"' },
  );
  status(patchedRule, 200, 'rule time zone updated');
  check(
    (await call(admin, 'GET', `/v1/admin/schedule-rules/${ruleId}`)).json().exceptions.length === 3,
    'exception history visible',
  );
  const repeatKey = randomUUID();
  const same = await call(
    admin,
    'POST',
    '/v1/admin/agents',
    { code: 'AGIDEMP', name: 'Idempotente' },
    { 'idempotency-key': repeatKey },
  );
  status(same, 201, 'idempotent create');
  status(
    await call(
      admin,
      'POST',
      '/v1/admin/agents',
      { code: 'AGIDEMP', name: 'Idempotente' },
      { 'idempotency-key': repeatKey },
    ),
    201,
    'exact agent replay',
  );
  status(
    await call(
      admin,
      'POST',
      '/v1/admin/agents',
      { code: 'AGIDEMP2', name: 'Otro' },
      { 'idempotency-key': repeatKey },
    ),
    409,
    'changed payload conflict',
  );
  status(
    await mutate(admin, 'POST', '/v1/admin/agents', {
      code: 'FORGED',
      name: 'Tenant',
      tenant_id: 'other',
    }),
    422,
    'forged tenant rejected',
  );
  status(
    await call(reader, 'GET', `/v1/admin/assignments/${randomUUID()}`),
    404,
    'unknown assignment hidden',
  );
  const noCsrf = await app.inject({
    method: 'POST',
    url: '/v1/admin/agents',
    headers: { origin, cookie: admin.cookie, 'idempotency-key': randomUUID() },
    payload: { code: 'CSRF', name: 'Denied' },
  });
  status(noCsrf, 403, 'CSRF enforced');
  check(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE action LIKE 'agent.%' OR action LIKE 'assignment.%' OR action LIKE 'schedule.%'",
      )
    ).rows[0].n >= 12,
    'planning changes audited',
  );
  check(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM route_assignment WHERE tenant_id=$1 AND local_date=$2 AND agent_id=$3',
        ['synthetic', baseDate, agentId],
      )
    ).rows[0].n >= 3,
    'multiple historical assignments retained',
  );
  status(
    await mutate(
      admin,
      'POST',
      '/v1/admin/assignments',
      assignment(agentId, route.id, 2, '2027-02-30', '14:00', '15:00'),
    ),
    422,
    'invalid civil date rejected',
  );
  status(
    await mutate(admin, 'POST', '/v1/admin/assignments', {
      ...assignment(agentId, route.id, 2, plus(baseDate, 5), '14:00', '15:00'),
      time_zone: 'Invalid/Zone',
    }),
    422,
    'invalid IANA time zone rejected',
  );
  status(
    await mutate(admin, 'POST', '/v1/admin/assignments', {
      ...assignment(agentId, route.id, 2, '2027-03-14', '02:30', '03:30'),
      time_zone: 'America/New_York',
    }),
    422,
    'nonexistent DST local time rejected',
  );
  status(
    await mutate(admin, 'POST', '/v1/admin/assignments', {
      ...assignment(agentId, route.id, 2, '2027-11-07', '01:30', '02:30'),
      time_zone: 'America/New_York',
    }),
    422,
    'ambiguous DST local time rejected',
  );
  const concurrent = await Promise.all([
    mutate(
      admin,
      'POST',
      '/v1/admin/assignments',
      assignment(agentId, route.id, 2, plus(baseDate, 4), '14:00', '15:00'),
    ),
    mutate(
      admin,
      'POST',
      '/v1/admin/assignments',
      assignment(agentId, route.id, 2, plus(baseDate, 4), '14:00', '15:00'),
    ),
  ]);
  check(
    concurrent
      .map((response) => response.statusCode)
      .sort()
      .join(',') === '201,409',
    'concurrent administrators cannot create duplicate overlapping assignments',
  );
  console.log(`visit schedule integration: ${checks} checks passed`);
} finally {
  await app?.close();
  await pool.end();
}
