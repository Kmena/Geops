// Run after Waves 1-3 fixtures, only against a disposable synthetic PostGIS database.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
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
const sha = (value) => createHash('sha256').update(value).digest();
let app;
try {
  const migration = await pool.query(
    "SELECT 1 FROM geops_schema_migrations WHERE version='0027_visit_dwell_engine.sql'",
  );
  check(migration.rowCount === 1, 'Wave 4A migration and checksum registered');
  const owner = (
    await pool.query("SELECT id FROM admin_user WHERE email_normalized='owner@example.invalid'")
  ).rows[0].id;
  const assignment = (
    await pool.query(`SELECT a.* FROM route_assignment a
    JOIN agent g ON g.id=a.agent_id WHERE g.code='AG001' AND a.route_code='R01'
    AND a.route_revision=1 AND a.state='PLANNED' ORDER BY a.starts_at LIMIT 1`)
  ).rows[0];
  check(Boolean(assignment), 'published historical snapshot assignment available');
  const visits = (
    await pool.query(
      'SELECT * FROM assignment_visit WHERE assignment_id=$1 ORDER BY suggested_order NULLS LAST,stop_id',
      [assignment.id],
    )
  ).rows;
  check(visits.length >= 2, 'snapshot has independent visit requirements');
  for (const permission of [
    'visit.result.read',
    'visit.evidence.read',
    'visit.evaluation.recompute',
  ])
    await pool.query(
      'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
      [owner, permission, 'Synthetic Wave 4A verification'],
    );
  const after = new Date(new Date(assignment.ends_at).getTime() + 86_400_000);
  const service = new VisitEvaluationService(pool, () => after);
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 11),
    csrfKey: Buffer.alloc(32, 12),
    allowedOrigins: [origin],
  });
  app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    visitEvaluation: service,
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
  const reader = await login('outsider@example.invalid');
  const call = (session, method, path, payload, extra = {}) =>
    app.inject({
      method,
      url: path,
      headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrf, ...extra },
      ...(payload === undefined ? {} : { payload }),
    });
  const endpoint = `/v1/admin/assignments/${assignment.id}/evaluations`;
  check(
    (await call(reader, 'GET', endpoint)).statusCode === 403,
    'permission denies evaluation read',
  );
  check(
    (
      await call(
        reader,
        'POST',
        endpoint,
        { reason: 'Synthetic replay' },
        { 'idempotency-key': randomUUID() },
      )
    ).statusCode === 403,
    'permission denies recompute',
  );
  const key = randomUUID();
  const queue = await call(
    admin,
    'POST',
    endpoint,
    { reason: 'Synthetic missing identity' },
    { 'idempotency-key': key },
  );
  check(queue.statusCode === 202, 'recompute queued');
  check(
    (
      await call(
        admin,
        'POST',
        endpoint,
        { reason: 'Synthetic missing identity' },
        { 'idempotency-key': key },
      )
    ).statusCode === 202,
    'HTTP retry idempotent',
  );
  check(
    (
      await call(
        admin,
        'POST',
        endpoint,
        { reason: 'Different synthetic input' },
        { 'idempotency-key': key },
      )
    ).statusCode === 409,
    'idempotency key conflict',
  );
  const firstRun = await service.drain();
  check(
    firstRun.length === 1 && firstRun[0].created === visits.length,
    'bounded worker created visit evaluations',
  );
  let current = (await call(admin, 'GET', endpoint)).json();
  check(
    current.visits.every((v) => v.status === 'UNATTRIBUTABLE'),
    'no link means unattributable',
  );
  check(current.agent_device_integration === 'PENDING', 'physical integration remains pending');

  const device = randomUUID(),
    binding = randomUUID(),
    installation = randomUUID(),
    policy = randomUUID(),
    schedule = randomUUID(),
    session = randomUUID(),
    anchor = randomUUID(),
    boot = randomUUID(),
    link = randomUUID();
  const start = new Date(assignment.starts_at),
    end = new Date(assignment.ends_at);
  const at = (minute) => new Date(start.getTime() + minute * 60_000).toISOString();
  await pool.query(
    "INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','Wave 4A synthetic device')",
    [device],
  );
  await pool.query(
    "INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake',$3,$4,'ACTIVE')",
    [binding, device, assignment.tenant_id, `wave4a-${device}`],
  );
  await pool.query(
    'INSERT INTO gps_device_installation(installation_id,device_id,activated_at) VALUES($1,$2,$3)',
    [installation, device, new Date(start.getTime() - 60_000)],
  );
  await pool.query(
    "INSERT INTO gps_policy(id,name,state,current_revision,draft_config,created_by) VALUES($1,'Synthetic Wave 4A','ACTIVE',1,'{}',$2)",
    [policy, owner],
  );
  await pool.query(
    `INSERT INTO gps_policy_revision(policy_id,revision,days_iso,start_local,end_local,time_zone,capture_interval_s,sync_interval_s,heartbeat_missing_after_s,valid_from,valid_until,created_by,reason)
    VALUES($1,1,ARRAY[1,2,3,4,5,6,7],'00:00','23:59','UTC',60,300,900,$2,$3,$4,'Synthetic evaluation policy')`,
    [policy, new Date(start.getTime() - 86_400_000), new Date(end.getTime() + 86_400_000), owner],
  );
  await pool.query(
    'INSERT INTO gps_policy_delivery(capture_anchor_id,device_id,installation_id,assignment_version,server_time,offline_not_after) VALUES($1,$2,$3,1,$4,$5)',
    [anchor, device, installation, start, new Date(start.getTime() + 12 * 3600_000)],
  );
  await pool.query(
    "INSERT INTO gps_scheduled_session(id,device_id,policy_id,revision,assignment_version,local_date,start_at,end_at,state) VALUES($1,$2,$3,1,1,$4,$5,$6,'SCHEDULED')",
    [schedule, device, policy, assignment.local_date, start, end],
  );
  await pool.query(
    `INSERT INTO gps_effective_session(id,device_id,installation_id,client_session_id,scheduled_session_id,assignment_version,started_at,start_event_id,state,evidence_state,tenant_id,mdm_binding_id,start_boot_id,start_anchor_id)
    VALUES($1,$2,$3,$4,$5,1,$6,$7,'OPEN','DEVICE_REPORTED',$8,$9,$10,$11)`,
    [
      session,
      device,
      installation,
      randomUUID(),
      schedule,
      start,
      randomUUID(),
      assignment.tenant_id,
      binding,
      boot,
      anchor,
    ],
  );
  await pool.query(
    'INSERT INTO visit_lab_agent_device_link(id,tenant_id,agent_id,device_id,valid_from,valid_to) VALUES($1,$2,$3,$4,$5,$6)',
    [link, assignment.tenant_id, assignment.agent_id, device, start, end],
  );
  await assert.rejects(
    pool.query(
      'INSERT INTO visit_lab_agent_device_link(id,tenant_id,agent_id,device_id,valid_from,valid_to) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(), assignment.tenant_id, assignment.agent_id, device, start, end],
    ),
    /conflicting key value|exclusion constraint/,
  );
  checks++;
  const stop = visits[0];
  const insertPosition = async (
    minute,
    accuracy = 5,
    latitude = stop.latitude,
    longitude = stop.longitude,
  ) => {
    const event = randomUUID();
    await pool.query(
      `INSERT INTO position_event(device_id,event_id,session_id,assignment_version,captured_at,received_at,capture_anchor_id,boot_id,anchor_elapsed_realtime_ms,elapsed_realtime_ms,geom,accuracy_m,payload_digest,quality_state,tenant_id,mdm_binding_id,installation_id)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,0,$8,ST_SetSRID(ST_MakePoint($9,$10),4326)::geography,$11,$12,'DEVICE_REPORTED',$13,$14,$15)`,
      [
        device,
        event,
        session,
        at(minute),
        after,
        anchor,
        boot,
        minute * 60_000,
        longitude,
        latitude,
        accuracy,
        sha(event),
        assignment.tenant_id,
        binding,
        installation,
      ],
    );
    return event;
  };
  const reprocess = async (why) => {
    const response = await call(
      admin,
      'POST',
      endpoint,
      { reason: why },
      { 'idempotency-key': randomUUID() },
    );
    check(response.statusCode === 202, `queue ${why}`);
    return service.drain();
  };
  await insertPosition(0);
  await insertPosition(4);
  check((await service.reconcileSynthetic()) === 1, 'synthetic poller queues new evidence');
  let run = await service.drain();
  check(run[0].created === visits.length, 'new identity/evidence creates history');
  current = (await call(admin, 'GET', endpoint)).json();
  const first = current.visits.find((v) => v.stop_id === stop.stop_id);
  check(
    first.credited_s === 240 && first.status === 'INCOMPLETE',
    'one evidenced pair credits four minutes',
  );
  check(
    current.physical_credited_s <= current.visit_credited_sum_s,
    'physical aggregate never exceeds visit sum',
  );
  run = await reprocess('Synthetic exact replay');
  check(run[0].unchanged === visits.length, 'same inputs do not duplicate history');
  await insertPosition(12);
  await insertPosition(8);
  await insertPosition(20);
  await insertPosition(16);
  check((await service.reconcileSynthetic()) === 1, 'synthetic poller queues late evidence');
  run = await service.drain();
  check(run[0].created === visits.length, 'late out-of-order evidence causes new revision');
  current = (await call(admin, 'GET', endpoint)).json();
  const completed = current.visits.find((v) => v.stop_id === stop.stop_id);
  check(
    completed.status === 'COMPLETED' && completed.credited_s === 1200 && completed.completed_at,
    'five bounded pairs complete required dwell',
  );
  const historyPath = `/v1/admin/assignments/${assignment.id}/visits/${stop.stop_id}/evaluations`;
  const history = (await call(admin, 'GET', historyPath)).json().items;
  check(
    history.length === 3 &&
      history[0].evaluation_no === 3 &&
      history[2].status === 'UNATTRIBUTABLE',
    'immutable revision history retained',
  );
  const evidencePath = `${historyPath}/${completed.evaluation_id}/evidence`;
  check(
    (await call(admin, 'GET', evidencePath)).statusCode === 422,
    'evidence read requires reason',
  );
  const evidence = await call(admin, 'GET', evidencePath, undefined, {
    'x-geops-access-reason': 'Synthetic audit review',
  });
  check(
    evidence.statusCode === 200 &&
      evidence.json().items.length === 5 &&
      evidence.json().coordinates_included === false,
    'evidence lists bounded pairs without coordinates',
  );
  check(
    !JSON.stringify(evidence.json()).includes(String(stop.latitude)),
    'evidence omits raw location',
  );
  check(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE action='visit.evidence.read' AND metadata_redacted->>'assignment_id'=$1",
        [assignment.id],
      )
    ).rows[0].n === 1,
    'evidence access audited',
  );
  await assert.rejects(
    pool.query('UPDATE visit_evaluation SET credited_s=0 WHERE id=$1', [completed.evaluation_id]),
    /immutable/,
  );
  checks++;
  await assert.rejects(
    pool.query(
      "UPDATE visit_lab_agent_device_link SET valid_to=valid_to+interval '1 minute' WHERE id=$1",
      [link],
    ),
    /immutable/,
  );
  checks++;
  await assert.rejects(
    pool.query(
      "UPDATE visit_algorithm_revision SET scope='APPROVED' WHERE algorithm_id='dwell-pair-v1' AND revision=1",
    ),
    /immutable/,
  );
  checks++;
  check(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM visit_evaluation_job WHERE state='DONE' AND assignment_id=$1",
        [assignment.id],
      )
    ).rows[0].n === 1,
    'worker finishes job',
  );
  check((await service.reconcileSynthetic()) === 0, 'unchanged evidence is not queued again');
  const cancelled = (
    await pool.query("SELECT id FROM route_assignment WHERE state='CANCELLED' LIMIT 1")
  ).rows[0];
  if (cancelled) {
    check(
      (
        await call(
          admin,
          'POST',
          `/v1/admin/assignments/${cancelled.id}/evaluations`,
          { reason: 'Synthetic cancelled assignment' },
          { 'idempotency-key': randomUUID() },
        )
      ).statusCode === 404,
      'cancelled assignment cannot be queued',
    );
  }
  check(
    (await call(admin, 'GET', `/v1/admin/assignments/${randomUUID()}/evaluations`)).statusCode ===
      404,
    'unknown assignment concealed',
  );
  const concurrentKey = randomUUID();
  check(
    (
      await call(
        admin,
        'POST',
        endpoint,
        { reason: 'Synthetic concurrent workers' },
        { 'idempotency-key': concurrentKey },
      )
    ).statusCode === 202,
    'one job queued for worker concurrency',
  );
  const claimed = await Promise.all([service.processNext(), service.processNext()]);
  check(claimed.filter(Boolean).length === 1, 'SKIP LOCKED permits one worker claim');
  check(
    (await call(admin, 'GET', historyPath)).json().items.length === 3,
    'concurrent replay preserves revision count',
  );
  const dayResponse = await call(
    admin,
    'POST',
    `/v1/admin/evaluation-days/${new Date(assignment.local_date).toISOString().slice(0, 10)}/reprocess`,
    { agent_id: assignment.agent_id, reason: 'Synthetic day reprocess' },
    { 'idempotency-key': randomUUID() },
  );
  check(
    dayResponse.statusCode === 202 && dayResponse.json().queued >= 1,
    'bounded civil-day reprocess queues assignments',
  );
  check(
    (await service.drain()).length === dayResponse.json().queued,
    'day reprocess drains exactly queued jobs',
  );
  console.log(`SPEC-03 Wave 4A integration: ${checks} checks passed (synthetic PostGIS)`);
} finally {
  if (app) await app.close();
  await pool.end();
}
