// Runs after Wave 4B fixtures against a disposable synthetic PostGIS database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import {
  ComplianceDashboardService,
  gpsSyncState,
  normalizeVisit,
  summarizeVisits,
} from '../src/compliance-dashboard.ts';
import { VisitEvaluationService } from '../src/visit-evaluation.ts';

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
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};
let app;
try {
  const owner = (
    await pool.query("SELECT id FROM admin_user WHERE email_normalized='owner@example.invalid'")
  ).rows[0].id;
  const day = (
    await pool.query(
      'SELECT local_date::text AS day FROM route_assignment ORDER BY local_date LIMIT 1',
    )
  ).rows[0].day;
  const sample = (
    await pool.query(
      `SELECT a.id,a.agent_id,a.route_id,v.client_id,v.stop_id FROM route_assignment a
    JOIN assignment_visit v ON v.tenant_id=a.tenant_id AND v.assignment_id=a.id
    WHERE a.local_date=$1 ORDER BY a.id,v.stop_id LIMIT 1`,
      [day],
    )
  ).rows[0];
  check(Boolean(sample), 'historical assignment snapshot available');
  const service = new ComplianceDashboardService(pool, () => new Date('2030-01-01T00:00:00Z'));
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 11),
    csrfKey: Buffer.alloc(32, 12),
    allowedOrigins: [origin],
  });
  app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    complianceDashboard: service,
    secureCookie: false,
  });
  const login = async (email) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/sessions',
      headers: { origin },
      payload: { email, password: 'synthetic-password-12345678' },
    });
    check(response.statusCode === 200, `login ${email}`);
    return response.headers['set-cookie'].split(';')[0];
  };
  const cookie = await login('owner@example.invalid');
  const outsider = await login('outsider@example.invalid');
  const urlFor = (extra = '') => `/v1/admin/compliance?from=${day}&to=${day}${extra}`;
  const call = (session, path) =>
    app.inject({ method: 'GET', url: path, headers: { origin, cookie: session } });
  check(
    (await call(outsider, urlFor())).statusCode === 403,
    'permission and tenant access enforced',
  );
  check((await call(cookie, '/v1/admin/compliance')).statusCode === 422, 'date range required');
  check(
    (await call(cookie, '/v1/admin/compliance?from=2026-99-99&to=2026-99-99')).statusCode === 422,
    'invalid civil dates rejected',
  );
  check(
    (await call(cookie, `/v1/admin/compliance?from=${day}&to=2030-12-31`)).statusCode === 422,
    'range bounded',
  );
  const result = await call(cookie, urlFor());
  check(result.statusCode === 200, 'dashboard endpoint accessible');
  const page = result.json();
  const count = (
    await pool.query(
      `SELECT count(*)::int AS count FROM route_assignment a JOIN assignment_visit v
    ON v.tenant_id=a.tenant_id AND v.assignment_id=a.id WHERE a.local_date=$1`,
      [day],
    )
  ).rows[0].count;
  check(page.total_visits === count, 'visit count matches persisted snapshots');
  check(
    page.items.every((item) => item.local_date === day),
    'date filter applies to visits',
  );
  check(
    page.indicators.required_visits <= page.indicators.scheduled_visits,
    'required denominator excludes optional visits',
  );
  check(
    page.indicators.accredited_compliance_percent === null ||
      (page.indicators.accredited_compliance_percent >= 0 &&
        page.indicators.accredited_compliance_percent <= 100),
    'accredited percentage bounded',
  );
  check(
    page.indicators.provisional && page.reconciliation_policy === 'PENDING_APPROVAL',
    'no final compliance inferred before policy approval',
  );
  check(
    page.routes.every(
      (route) =>
        route.status !== 'COMPLETED' ||
        (route.required_visits > 0 && route.completed_required_visits === route.required_visits),
    ),
    'route completion depends on mandatory visits only',
  );
  const evaluated = page.items.find((item) => item.evaluation_id);
  if (evaluated) {
    const evaluation = new VisitEvaluationService(pool);
    const history = await evaluation.history(owner, evaluated.assignment_id, evaluated.stop_id);
    check(history.items.length >= 1, 'historical evaluations remain accessible');
    check(
      history.items.some((entry) => typeof entry.trigger_reason === 'string'),
      'reprocessing reason is traced through append-only audit',
    );
    const evidence = await evaluation.evidence(
      owner,
      randomUUID(),
      evaluated.assignment_id,
      evaluated.stop_id,
      evaluated.evaluation_id,
      'Synthetic dashboard evidence inspection',
    );
    check(
      evidence.items.every((item) => 'event_a_available' in item && 'event_b_available' in item),
      'evidence reports raw GPS availability after retention',
    );
  }
  for (const [filter, value, key] of [
    ['agent_id', sample.agent_id, 'agent_id'],
    ['route_id', sample.route_id, 'route_id'],
    ['assignment_id', sample.id, 'assignment_id'],
    ['client_id', sample.client_id, 'client_id'],
  ]) {
    const response = await call(cookie, urlFor(`&${filter}=${value}`));
    check(response.statusCode === 200, `${filter} accepted`);
    check(
      response.json().items.every((item) => item[key] === value),
      `${filter} consistent`,
    );
  }
  const assignmentPage = (await call(cookie, urlFor(`&assignment_id=${sample.id}`))).json();
  const clientPage = (await call(cookie, urlFor(`&assignment_id=${sample.id}&client_id=${sample.client_id}`))).json();
  check(
    JSON.stringify(clientPage.routes) === JSON.stringify(assignmentPage.routes),
    'client filter cannot change the complete assignment route verdict',
  );
  const statusPage = (await call(cookie, urlFor(`&assignment_id=${sample.id}&status=${page.items[0].status}`))).json();
  check(
    JSON.stringify(statusPage.routes) === JSON.stringify(assignmentPage.routes),
    'status filter cannot change the complete assignment route verdict',
  );
  const one = await call(cookie, urlFor('&limit=1'));
  check(one.statusCode === 200 && one.json().items.length === 1, 'pagination limit');
  if (count > 1) check(one.json().next_offset === 1, 'pagination continuation');
  for (const status of [
    'PENDING',
    'COMPLETED',
    'IN_PROGRESS',
    'INCOMPLETE',
    'NOT_VISITED',
    'INSUFFICIENT_EVIDENCE',
    'UNATTRIBUTABLE',
    'CANCELLED',
  ]) {
    const filtered = await call(cookie, urlFor(`&status=${status}`));
    check(
      filtered.statusCode === 200 && filtered.json().items.every((item) => item.status === status),
      `status filter ${status}`,
    );
  }
  for (const sync of ['UNKNOWN', 'BACKLOG_REPORTED', 'ACK_RECENT', 'NO_RECENT_ACK']) {
    const filtered = await call(cookie, urlFor(`&sync_state=${sync}`));
    check(
      filtered.statusCode === 200 &&
        filtered.json().items.every((item) => item.sync_state === sync),
      `sync filter ${sync}`,
    );
  }
  check(
    page.items.every((item) =>
      ['PENDING', 'RUNNING', 'DONE', 'FAILED', 'NOT_QUEUED'].includes(item.processing_state),
    ),
    'worker processing remains separate from GPS sync',
  );
  const clock = new Date('2026-10-26T14:00:00Z');
  check(gpsSyncState(null, null, clock) === 'UNKNOWN', 'no ACK report stays unknown');
  check(
    gpsSyncState(new Date('2026-10-26T13:59:00Z'), 2, clock) === 'BACKLOG_REPORTED',
    'reported backlog cannot be called synced',
  );
  check(
    gpsSyncState(new Date('2026-10-26T13:59:00Z'), 0, clock) === 'ACK_RECENT',
    'recent ACK with zero reported backlog',
  );
  check(
    gpsSyncState(new Date('2026-10-26T13:00:00Z'), 0, clock) === 'NO_RECENT_ACK',
    'old ACK is stale, not a visit failure',
  );
  check(
    (await call(cookie, urlFor('&status=UNKNOWN'))).statusCode === 422,
    'unknown status rejected',
  );
  check(
    (await call(cookie, urlFor(`&agent_id=${randomUUID()}`))).json().total_visits === 0,
    'empty result has no fabricated visits',
  );
  const pending = normalizeVisit(
    {
      ...page.items[0],
      assignment_state: 'PLANNED',
      evaluation_status: null,
      job_state: null,
      starts_at: '2026-01-01T08:00:00Z',
      ends_at: '2026-01-01T10:00:00Z',
    },
    new Date('2026-01-01T09:00:00Z'),
  );
  check(pending.status === 'PENDING', 'no evidence during active shift stays pending');
  const absent = normalizeVisit(
    {
      ...page.items[0],
      assignment_state: 'PLANNED',
      evaluation_status: null,
      job_state: null,
      starts_at: '2026-01-01T08:00:00Z',
      ends_at: '2026-01-01T10:00:00Z',
    },
    new Date('2026-01-02T09:00:00Z'),
  );
  check(
    absent.status === 'INSUFFICIENT_EVIDENCE' && absent.provisional,
    'absence remains provisional and never becomes NOT_VISITED',
  );
  const optional = { ...page.items[0], required: false, status: 'PENDING' };
  const mandatory = {
    ...page.items[0],
    stop_id: randomUUID(),
    required: true,
    status: 'COMPLETED',
  };
  check(
    summarizeVisits([optional, mandatory]).routes[0].status === 'COMPLETED',
    'optional visit does not block route completion',
  );
  const cancelled = { ...mandatory, assignment_id: randomUUID(), status: 'CANCELLED' };
  check(
    summarizeVisits([cancelled]).indicators.compliance_denominator === 0,
    'cancelled visits excluded from denominator',
  );
  const audit = await pool.query(
    "SELECT 1 FROM audit_event WHERE action='visit.dashboard.read' AND actor_id=$1 LIMIT 1",
    [owner],
  );
  check(audit.rowCount === 1, 'dashboard read audited');
  const outsiderId = (
    await pool.query("SELECT id FROM admin_user WHERE email_normalized='outsider@example.invalid'")
  ).rows[0].id;
  const tenant = (
    await pool.query('SELECT tenant_id FROM geops_operating_tenant WHERE singleton=true')
  ).rows[0].tenant_id;
  await pool.query(
    `INSERT INTO gps_data_tenant_access(admin_id,tenant_id,granted_by,reason)
     VALUES($1,$2,$3,'Synthetic dashboard access separation') ON CONFLICT DO NOTHING`,
    [outsiderId, tenant, owner],
  );
  await pool.query(
    `INSERT INTO admin_permission(admin_id,permission,granted_by,reason)
     VALUES($1,'visit.result.read',$2,'Synthetic dashboard access separation') ON CONFLICT DO NOTHING`,
    [outsiderId, owner],
  );
  const restricted = await call(outsider, urlFor());
  check(
    restricted.statusCode === 200 && restricted.json().location_access === false,
    'result reader does not gain GPS location access',
  );
  check(
    restricted.json().items.every((item) => item.device_id === null) &&
      restricted.json().locations.length === 0,
    'device identifiers hidden without link permission',
  );
  await pool.query(
    `INSERT INTO admin_permission(admin_id,permission,granted_by,reason)
     VALUES($1,'visit.device.read',$2,'Synthetic dashboard access separation') ON CONFLICT DO NOTHING`,
    [outsiderId, owner],
  );
  check(
    (await call(outsider, urlFor())).json().location_access === false,
    'link permission alone does not expose GPS location',
  );
  await pool.query(
    `INSERT INTO admin_permission(admin_id,permission,granted_by,reason)
     VALUES($1,'gps.location.read',$2,'Synthetic dashboard access separation') ON CONFLICT DO NOTHING`,
    [outsiderId, owner],
  );
  check(
    (await call(outsider, urlFor())).json().location_access === true,
    'GPS location requires both permissions',
  );
  // Build a bounded 25-agent / 31-day synthetic schedule. The dashboard reads
  // assignment snapshots and evaluations; no position_event scan is required.
  await pool.query(
    `INSERT INTO agent(id,tenant_id,code,name,state,version,created_by,updated_by)
     SELECT gen_random_uuid(),t.tenant_id,'W5PERF'||lpad(n::text,2,'0'),
       'Synthetic performance agent '||n,'ACTIVE',1,$2,$2
     FROM route_assignment t CROSS JOIN generate_series(1,25) AS n WHERE t.id=$1`,
    [sample.id, owner],
  );
  await pool.query(
    `INSERT INTO route_assignment(id,tenant_id,agent_id,agent_code,agent_name,
       route_id,route_revision,route_code,route_name,local_date,time_zone,starts_at,ends_at,
       origin,state,snapshot_hash,reason,created_by)
     SELECT gen_random_uuid(),t.tenant_id,g.id,g.code,g.name,t.route_id,t.route_revision,
       t.route_code,t.route_name,t.local_date+d.day,t.time_zone,
       t.starts_at+(d.day||' days')::interval,t.ends_at+(d.day||' days')::interval,
       'MANUAL','PLANNED',t.snapshot_hash,'Synthetic performance fixture',$2
     FROM route_assignment t JOIN agent g ON g.tenant_id=t.tenant_id AND g.code LIKE 'W5PERF%'
       CROSS JOIN generate_series(0,30) AS d(day) WHERE t.id=$1`,
    [sample.id, owner],
  );
  await pool.query(
    `INSERT INTO assignment_visit(tenant_id,assignment_id,stop_id,client_id,site_id,
       geofence_revision,required,suggested_order,min_dwell_effective_s,client_code,client_name,
       site_code,site_name,latitude,longitude,radius_m)
     SELECT a.tenant_id,a.id,v.stop_id,v.client_id,v.site_id,v.geofence_revision,v.required,
       v.suggested_order,v.min_dwell_effective_s,v.client_code,v.client_name,v.site_code,
       v.site_name,v.latitude,v.longitude,v.radius_m
     FROM route_assignment a JOIN assignment_visit v ON v.assignment_id=$1
     WHERE a.agent_code LIKE 'W5PERF%'`,
    [sample.id],
  );
  const historicalGps = await pool.query(
    `INSERT INTO position_event(device_id,event_id,session_id,assignment_version,
       captured_at,received_at,capture_anchor_id,boot_id,anchor_elapsed_realtime_ms,
       elapsed_realtime_ms,geom,accuracy_m,payload_digest,quality_state,tenant_id,
       mdm_binding_id,installation_id,time_evidence)
     SELECT p.device_id,gen_random_uuid(),p.session_id,p.assignment_version,
       p.captured_at-interval '365 days'+s.n*interval '1 second',p.received_at,
       p.capture_anchor_id,p.boot_id,p.anchor_elapsed_realtime_ms,p.elapsed_realtime_ms,
       p.geom,p.accuracy_m,p.payload_digest,p.quality_state,p.tenant_id,
       p.mdm_binding_id,p.installation_id,p.time_evidence
     FROM (SELECT * FROM position_event ORDER BY captured_at LIMIT 1) p
       CROSS JOIN generate_series(1,10000) AS s(n)`,
  );
  check(historicalGps.rowCount === 10000, '10 000 synthetic historical GPS rows seeded');
  const plus = (days) =>
    new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const samples = [];
  for (const span of [0, 6, 30]) {
    const timings = [];
    let size = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      const start = performance.now();
      const response = await call(cookie, `/v1/admin/compliance?from=${day}&to=${plus(span)}`);
      timings.push(performance.now() - start);
      check(response.statusCode === 200, `${span + 1}-day performance request`);
      size = response.json().total_visits;
    }
    timings.sort((a, b) => a - b);
    const p95 = Math.round(timings[4]);
    samples.push(`${span + 1}d: ${size} visits, p95 ${p95}ms`);
    check(p95 < 1500, `${span + 1}-day p95 under 1500ms on local synthetic fixture`);
  }
  console.log(`SPEC-03 Wave 5 performance: ${samples.join('; ')}`);
  console.log(`SPEC-03 Wave 5 dashboard integration: ${checks} checks passed`);
} finally {
  if (app) await app.close();
  await pool.end();
}
