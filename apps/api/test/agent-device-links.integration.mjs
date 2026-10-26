// Run after Waves 1–4A fixtures in an isolated synthetic geops_verify_* PostGIS database.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { AgentDeviceLinkService } from '../src/agent-device-links.ts';
import { resolveGpsDeviceScope } from '../src/gps-device-scope.ts';
import { GpsDeviceConfigService } from '../src/gps-device-config.ts';
import { GpsEventService } from '../src/gps-event-service.ts';
import { GpsHealthService } from '../src/gps-health-service.ts';
import { GpsPolicyService } from '../src/gps-policy-service.ts';
import { VisitEvaluationService } from '../src/visit-evaluation.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic PostGIS database required');
const pool = new pg.Pool({ connectionString: url, max: 8 });
const origin = 'https://geops.example.invalid';
let checks = 0;
const check = (condition, label) => {
  assert.ok(condition, label);
  checks++;
};
let app;
try {
  check(
    (
      await pool.query(
        "SELECT 1 FROM geops_schema_migrations WHERE version='0028_agent_device_links.sql'",
      )
    ).rowCount === 1,
    'Wave 4B migration registered',
  );
  const owner = (
    await pool.query("SELECT id FROM admin_user WHERE email_normalized='owner@example.invalid'")
  ).rows[0].id;
  const assignment = (
    await pool.query(
      "SELECT * FROM route_assignment WHERE agent_code='AG001' AND route_code='R01' AND state='PLANNED' ORDER BY starts_at LIMIT 1",
    )
  ).rows[0];
  const agentA = assignment.agent_id;
  const device = (
    await pool.query("SELECT id FROM geops_device WHERE display_label='Wave 4A synthetic device'")
  ).rows[0].id;
  const binding = (
    await pool.query('SELECT id FROM mdm_binding WHERE geops_device_id=$1', [device])
  ).rows[0].id;
  await pool.query('UPDATE mdm_binding SET verified_at=now() WHERE id=$1', [binding]);
  await pool.query(
    'UPDATE gps_device_installation SET activation_binding_id=$2,activation_tenant_id=$3 WHERE device_id=$1',
    [device, binding, assignment.tenant_id],
  );
  await pool.query(
    "INSERT INTO device_key(id,geops_device_id,public_key_spki_der,public_key_fingerprint,status) VALUES($1,$2,$3,$4,'ACTIVE')",
    [randomUUID(), device, randomBytes(64), randomBytes(32)],
  );
  for (const permission of ['visit.device.read', 'visit.device.write', 'gps.installation.manage'])
    await pool.query(
      'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
      [owner, permission, 'Synthetic Wave 4B verification'],
    );
  const agentB = randomUUID();
  await pool.query(
    "INSERT INTO agent(id,tenant_id,code,name,created_by,updated_by) VALUES($1,$2,'AG_W4B','Second synthetic agent',$3,$3)",
    [agentB, assignment.tenant_id, owner],
  );
  const inactiveAgent = randomUUID();
  await pool.query(
    "INSERT INTO agent(id,tenant_id,code,name,state,created_by,updated_by) VALUES($1,$2,'AG_W4B_OFF','Inactive synthetic agent','INACTIVE',$3,$3)",
    [inactiveAgent, assignment.tenant_id, owner],
  );
  const unauthorizedDevice = randomUUID();
  await pool.query(
    "INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','No active key')",
    [unauthorizedDevice],
  );
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 11),
    csrfKey: Buffer.alloc(32, 12),
    allowedOrigins: [origin],
  });
  const clock = new Date(new Date(assignment.ends_at).getTime() + 86400000);
  const evaluation = new VisitEvaluationService(pool, () => clock);
  const links = new AgentDeviceLinkService(pool, () => clock);
  app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    agentDeviceLinks: links,
    visitEvaluation: evaluation,
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
    return {
      cookie: response.headers['set-cookie'].split(';')[0],
      csrf: response.json().csrf_token,
    };
  };
  const admin = await login('owner@example.invalid');
  const outsider = await login('outsider@example.invalid');
  const call = (session, method, path, payload, extra = {}) =>
    app.inject({
      method,
      url: path,
      headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrf, ...extra },
      ...(payload === undefined ? {} : { payload }),
    });
  const from = new Date(new Date(assignment.starts_at).getTime() - 60000).toISOString();
  const at = (minute) =>
    new Date(new Date(assignment.starts_at).getTime() + minute * 60000).toISOString();
  const create = {
    agent_id: agentA,
    device_id: device,
    valid_from: from,
    reason: 'Synthetic physical identity authorization',
  };
  const path = '/v1/admin/agent-device-links';
  check(
    (await call(outsider, 'POST', path, create, { 'idempotency-key': randomUUID() })).statusCode ===
      403,
    'write permission denied',
  );
  check(
    (
      await call(
        admin,
        'POST',
        path,
        { ...create, agent_id: randomUUID() },
        { 'idempotency-key': randomUUID() },
      )
    ).statusCode === 404,
    'unknown or foreign agent concealed',
  );
  check(
    (
      await call(
        admin,
        'POST',
        path,
        { ...create, agent_id: inactiveAgent },
        { 'idempotency-key': randomUUID() },
      )
    ).statusCode === 409,
    'inactive agent rejected',
  );
  check(
    (
      await call(
        admin,
        'POST',
        path,
        { ...create, device_id: randomUUID() },
        { 'idempotency-key': randomUUID() },
      )
    ).statusCode === 404,
    'unknown device concealed',
  );
  check(
    (
      await call(
        admin,
        'POST',
        path,
        { ...create, device_id: unauthorizedDevice },
        { 'idempotency-key': randomUUID() },
      )
    ).statusCode === 409,
    'device without GEOPS key and installation rejected',
  );
  const key = randomUUID();
  const alternateKey = randomUUID();
  const contenders = await Promise.all([
    call(admin, 'POST', path, create, { 'idempotency-key': key }),
    call(admin, 'POST', path, create, { 'idempotency-key': alternateKey }),
  ]);
  check(
    contenders.filter((response) => response.statusCode === 201).length === 1 &&
      contenders.filter((response) => response.statusCode === 409).length === 1,
    'concurrent administrators cannot create overlapping links',
  );
  const linked = contenders.find((response) => response.statusCode === 201);
  const successfulKey = contenders[0].statusCode === 201 ? key : alternateKey;
  check(linked.statusCode === 201, `operational link created: ${linked.body}`);
  const linkA = linked.json().id;
  check(
    (await call(admin, 'POST', path, create, { 'idempotency-key': successfulKey })).json().id ===
      linkA,
    'HTTP retry is idempotent',
  );
  check(
    (
      await call(
        admin,
        'POST',
        path,
        { ...create, agent_id: agentB },
        { 'idempotency-key': successfulKey },
      )
    ).statusCode === 409,
    'key cannot be reused for another agent',
  );
  check(
    (
      await call(
        admin,
        'POST',
        path,
        { ...create, agent_id: agentB },
        { 'idempotency-key': randomUUID() },
      )
    ).statusCode === 409,
    'overlap rejects another agent',
  );
  check(
    (await call(admin, 'GET', `/v1/admin/agents/${agentA}/device-links`)).json().items.length === 1,
    'history reads the authorized tenant',
  );
  check(
    (await call(outsider, 'GET', `/v1/admin/agents/${agentA}/device-links`)).statusCode === 403,
    'read permission denied',
  );
  check(
    (await pool.query('SELECT tenant_id FROM geops_device_tenant WHERE device_id=$1', [device]))
      .rows[0].tenant_id === assignment.tenant_id,
    'canonical device tenant established',
  );
  check(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE action='visit.device.link'",
      )
    ).rows[0].n >= 1,
    'link creation audited',
  );
  check(
    (await evaluation.drain()).some((result) => result.assignment_id === assignment.id),
    'link change queued bounded evaluation',
  );
  const endpoint = `/v1/admin/assignments/${assignment.id}/evaluations`;
  const before = (await call(admin, 'GET', endpoint)).json();
  const completed = before.visits.find((visit) => visit.status === 'COMPLETED');
  check(Boolean(completed), 'persisted GPS evidence completes visit through operational link');
  check(before.agent_device_integration === 'TECHNICAL_ONLY', 'result labels technical scope');
  check(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM visit_evaluation_interval WHERE evaluation_id=$1 AND operational_link_id=$2 AND link_id IS NULL',
        [completed.evaluation_id, linkA],
      )
    ).rows[0].n > 0,
    'intervals retain operational link provenance',
  );
  const reassign = await call(
    admin,
    'POST',
    `${path}/${linkA}/reassign`,
    { agent_id: agentB, at: at(10), reason: 'Synthetic handover at ten minutes' },
    { 'idempotency-key': randomUUID(), 'if-match': '"1"' },
  );
  check(reassign.statusCode === 201, `device reassigned: ${reassign.body}`);
  const linkB = reassign.json().id;
  const captured = await pool.query(
    `SELECT l.agent_id,count(*)::int AS n FROM position_event p JOIN agent_device_link l
     ON l.tenant_id=p.tenant_id AND l.device_id=p.device_id AND l.state<>'REVOKED'
     AND p.captured_at>=l.valid_from AND p.captured_at<coalesce(l.valid_to,'infinity'::timestamptz)
     WHERE p.device_id=$1 GROUP BY l.agent_id`,
    [device],
  );
  check(
    captured.rows.find((row) => row.agent_id === agentA)?.n === 3 &&
      captured.rows.find((row) => row.agent_id === agentB)?.n === 3,
    'capture time attributes old and new halves across late synchronization',
  );
  check(
    (await evaluation.drain()).some((result) => result.assignment_id === assignment.id),
    'handover queues previous agent for recompute',
  );
  const after = (await call(admin, 'GET', endpoint)).json();
  check(
    after.visits.find((visit) => visit.stop_id === completed.stop_id).status === 'INCOMPLETE',
    'old agent loses later physical intervals after handover',
  );
  check(
    (
      await call(
        admin,
        'GET',
        `/v1/admin/assignments/${assignment.id}/visits/${completed.stop_id}/evaluations`,
      )
    )
      .json()
      .items.some((item) => item.id === completed.evaluation_id),
    'previous completed result remains immutable in history',
  );
  const lateId = randomUUID();
  await pool.query(
    `INSERT INTO position_event(device_id,event_id,session_id,assignment_version,captured_at,received_at,
     capture_anchor_id,boot_id,anchor_elapsed_realtime_ms,elapsed_realtime_ms,geom,accuracy_m,
     payload_digest,quality_state,tenant_id,mdm_binding_id,installation_id)
     SELECT device_id,$2,session_id,assignment_version,$3,$4,capture_anchor_id,boot_id,
     anchor_elapsed_realtime_ms,360000,geom,accuracy_m,$5,quality_state,tenant_id,mdm_binding_id,installation_id
     FROM position_event WHERE device_id=$1 ORDER BY captured_at LIMIT 1`,
    [device, lateId, at(6), clock, randomBytes(32)],
  );
  check((await evaluation.reconcileOperational()) === 1, 'late accepted position queues replay');
  check(
    (await evaluation.drain()).some((result) => result.assignment_id === assignment.id),
    'late position reprocessed',
  );
  check((await evaluation.reconcileOperational()) === 0, 'replay does not queue duplicate work');
  const revoked = await call(
    admin,
    'POST',
    `${path}/${linkB}/end`,
    { valid_to: at(25), mode: 'REVOKE', reason: 'Synthetic invalid binding correction' },
    { 'idempotency-key': randomUUID(), 'if-match': '"1"' },
  );
  check(revoked.statusCode === 200, 'revocation preserves a reason and history');
  check(
    (await pool.query('SELECT state FROM agent_device_link WHERE id=$1', [linkB])).rows[0].state ===
      'REVOKED',
    'revoked link remains recorded',
  );
  check(
    (await call(admin, 'GET', `/v1/admin/agents/${agentB}/device-links`)).json().items[0].state ===
      'REVOKED',
    'history includes revoked link',
  );
  const queue = async (why) =>
    call(admin, 'POST', endpoint, { reason: why }, { 'idempotency-key': randomUUID() });
  check(
    (await queue('Synthetic worker retry rehearsal')).statusCode === 202,
    'admin can request bounded replay',
  );
  const priorMode = process.env.GEOPS_DATA_MODE;
  process.env.GEOPS_DATA_MODE = 'production';
  try {
    await assert.rejects(evaluation.processNext(), /Conflict/);
    checks++;
    check(
      (await queue('Unapproved production attempt')).statusCode === 409,
      'technical-only algorithm cannot be queued as production approved',
    );
  } finally {
    process.env.GEOPS_DATA_MODE = priorMode;
  }
  check(
    (
      await pool.query('SELECT state,attempts FROM visit_evaluation_job WHERE assignment_id=$1', [
        assignment.id,
      ])
    ).rows[0].state === 'PENDING',
    'failed worker keeps evidence job retryable',
  );
  await pool.query('UPDATE visit_evaluation_job SET next_attempt_at=now() WHERE assignment_id=$1', [
    assignment.id,
  ]);
  check(
    (await evaluation.drain()).some((result) => result.assignment_id === assignment.id),
    'retry after gate restoration completes without losing evidence',
  );
  check(
    (await queue('Synthetic concurrent retry')).statusCode === 202,
    'concurrency test job queued',
  );
  const concurrent = await Promise.all([evaluation.processNext(), evaluation.processNext()]);
  check(concurrent.filter(Boolean).length === 1, 'SKIP LOCKED claims operational job once');

  const geopsOnly = randomUUID();
  await pool.query(
    "INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','GEOPS-only synthetic device')",
    [geopsOnly],
  );
  await pool.query(
    "INSERT INTO device_key(id,geops_device_id,public_key_spki_der,public_key_fingerprint,status) VALUES($1,$2,$3,$4,'ACTIVE')",
    [randomUUID(), geopsOnly, randomBytes(64), randomBytes(32)],
  );
  check(
    (
      await call(
        admin,
        'POST',
        `/v1/admin/agent-devices/${device}/authorize-geops`,
        { reason: 'Reject MDM device bypass' },
        { 'idempotency-key': randomUUID() },
      )
    ).statusCode === 409,
    'active MDM device cannot bypass binding',
  );
  const geopsAuthorization = await call(
    admin,
    'POST',
    `/v1/admin/agent-devices/${geopsOnly}/authorize-geops`,
    { reason: 'Synthetic GEOPS-owned installation' },
    { 'idempotency-key': randomUUID() },
  );
  check(
    geopsAuthorization.statusCode === 201,
    `GEOPS-only installation authorized: ${geopsAuthorization.body}`,
  );
  const geopsInstallation = geopsAuthorization.json().installation_id;
  const client = await pool.connect();
  try {
    const resolved = await resolveGpsDeviceScope(client, geopsOnly, geopsInstallation);
    check(
      resolved.bindingId === null && resolved.tenantId === assignment.tenant_id,
      'GEOPS-only scope resolves canonical tenant without MDM',
    );
    await assert.rejects(resolveGpsDeviceScope(client, geopsOnly, randomUUID()));
    checks++;
  } finally {
    client.release();
  }
  const config = new GpsDeviceConfigService(pool, () => clock);
  const snapshot = await config.snapshot(
    { deviceId: geopsOnly, keyId: randomUUID(), sessionId: randomUUID() },
    randomUUID(),
  );
  check(
    snapshot.installation_id === geopsInstallation && snapshot.active === false,
    'GEOPS-only authenticated device receives scoped inactive configuration',
  );
  check(
    (
      await pool.query(
        'SELECT health_mdm_binding_id,health_tenant_id FROM gps_policy_delivery WHERE capture_anchor_id=$1',
        [snapshot.capture_anchor_id],
      )
    ).rows[0].health_mdm_binding_id === null,
    'GEOPS-only anchor has no invented MDM binding',
  );
  const beforeGeopsCount = Number(
    (
      await pool.query('SELECT position_count FROM visit_evaluation_job WHERE assignment_id=$1', [
        assignment.id,
      ])
    ).rows[0].position_count,
  );
  const geopsLink = await call(
    admin,
    'POST',
    path,
    {
      agent_id: agentA,
      device_id: geopsOnly,
      valid_from: at(10),
      reason: 'Synthetic agent on GEOPS-only device',
    },
    { 'idempotency-key': randomUUID() },
  );
  check(geopsLink.statusCode === 201, 'agent linked to GEOPS-only device without MDM');
  const policyWindow = (
    await pool.query('SELECT * FROM gps_scheduled_session WHERE device_id=$1 LIMIT 1', [device])
  ).rows[0];
  await pool.query(
    'INSERT INTO gps_device_assignment_state(device_id,assignment_version,changed_at) VALUES($1,1,$2)',
    [geopsOnly, assignment.starts_at],
  );
  const geopsWindow = randomUUID();
  await pool.query(
    `INSERT INTO gps_scheduled_session(id,device_id,policy_id,revision,assignment_version,
      local_date,start_at,end_at,state)
      VALUES($1,$2,$3,$4,1,$5,$6,$7,'SCHEDULED')`,
    [
      geopsWindow,
      geopsOnly,
      policyWindow.policy_id,
      policyWindow.revision,
      policyWindow.local_date,
      policyWindow.start_at,
      policyWindow.end_at,
    ],
  );
  const eventClock = new Date(new Date(assignment.starts_at).getTime() + 11 * 60000);
  const geopsConfig = new GpsDeviceConfigService(pool, () => eventClock);
  const geopsSnapshot = await geopsConfig.snapshot(
    { deviceId: geopsOnly, keyId: randomUUID(), sessionId: randomUUID() },
    randomUUID(),
  );
  const gps = new GpsEventService(
    pool,
    new GpsPolicyService(pool),
    Buffer.alloc(32, 77),
    () => eventClock,
  );
  const principal = { deviceId: geopsOnly, keyId: randomUUID(), sessionId: randomUUID() };
  const bootId = randomUUID(),
    clientSessionId = randomUUID();
  const startedAt = new Date(eventClock.getTime() + 1000).toISOString();
  const capturedAt = new Date(eventClock.getTime() + 2000).toISOString();
  const sessionEvent = {
    event_id: randomUUID(),
    client_session_id: clientSessionId,
    scheduled_session_id: geopsWindow,
    type: 'STARTED',
    occurred_at: startedAt,
    assignment_version: 1,
    boot_id: bootId,
    capture_anchor_id: geopsSnapshot.capture_anchor_id,
    anchor_elapsed_realtime_ms: 1000,
    elapsed_realtime_ms: 2000,
    reason_code: null,
  };
  const sessionAck = await gps.ingestSessions(
    principal,
    {
      schema_version: 1,
      batch_id: randomUUID(),
      device_id: geopsOnly,
      installation_id: geopsInstallation,
      events: [sessionEvent],
    },
    randomUUID(),
  );
  check(
    sessionAck.accepted_event_ids?.includes(sessionEvent.event_id),
    'GEOPS-only session accepted with unchanged GPS ACK',
  );
  const position = {
    event_id: randomUUID(),
    client_session_id: clientSessionId,
    assignment_version: 1,
    captured_at: capturedAt,
    latitude: 14.61,
    longitude: -90.52,
    accuracy_m: 8.5,
    boot_id: bootId,
    anchor_elapsed_realtime_ms: 1000,
    elapsed_realtime_ms: 3000,
    capture_anchor_id: geopsSnapshot.capture_anchor_id,
  };
  const positionAck = await gps.ingestPositions(
    principal,
    {
      schema_version: 1,
      batch_id: randomUUID(),
      device_id: geopsOnly,
      installation_id: geopsInstallation,
      events: [position],
    },
    randomUUID(),
  );
  check(
    positionAck.accepted_event_ids?.includes(position.event_id),
    'GEOPS-only position accepted with unchanged GPS ACK',
  );
  check(
    (
      await pool.query('SELECT tenant_id,mdm_binding_id FROM position_event WHERE event_id=$1', [
        position.event_id,
      ])
    ).rows[0]?.tenant_id === assignment.tenant_id,
    'GEOPS-only persisted position uses canonical tenant',
  );
  check(
    (
      await pool.query('SELECT mdm_binding_id FROM position_event WHERE event_id=$1', [
        position.event_id,
      ])
    ).rows[0]?.mdm_binding_id === null,
    'GEOPS-only persisted position keeps MDM binding null',
  );
  await evaluation.drain();
  check(
    Number(
      (
        await pool.query('SELECT position_count FROM visit_evaluation_job WHERE assignment_id=$1', [
          assignment.id,
        ])
      ).rows[0].position_count,
    ) > beforeGeopsCount,
    'Wave 4A evaluator consumes accepted GEOPS-only position through agent link',
  );
  const health = new GpsHealthService(pool, new GpsPolicyService(pool), () => eventClock);
  const healthEvent = {
    event_id: randomUUID(),
    device_id: geopsOnly,
    installation_id: geopsInstallation,
    assignment_version: 1,
    policy_revision: policyWindow.revision,
    due_at: new Date(eventClock.getTime() + 2000).toISOString(),
    observed_at: new Date(eventClock.getTime() + 3000).toISOString(),
    boot_id: bootId,
    capture_anchor_id: geopsSnapshot.capture_anchor_id,
    anchor_elapsed_realtime_ms: 1000,
    elapsed_realtime_ms: 4000,
    battery_percent: 80,
    charging: false,
    plugged: false,
    power_save: false,
    provider_available: true,
    network_available: true,
    tracking_state: 'RUNNING',
    observed_states: ['ONLINE'],
  };
  const healthAck = await health.ingest(
    principal,
    {
      schema_version: 1,
      batch_id: randomUUID(),
      device_id: geopsOnly,
      installation_id: geopsInstallation,
      events: [healthEvent],
    },
    randomUUID(),
  );
  check(
    healthAck.accepted_event_ids.includes(healthEvent.event_id),
    'GEOPS-only health event receives unchanged ACK',
  );
  check(
    (
      await pool.query(
        'SELECT tenant_id,mdm_binding_id FROM gps_device_health_event WHERE event_id=$1',
        [healthEvent.event_id],
      )
    ).rows[0]?.mdm_binding_id === null,
    'GEOPS-only health evidence persists without invented MDM binding',
  );
  console.log(`Wave 4B agent/device and persisted-GPS integration: ${checks} checks passed`);
} finally {
  if (app) await app.close();
  await pool.end();
}
