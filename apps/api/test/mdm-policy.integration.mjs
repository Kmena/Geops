// SPEC-05 Wave 3 synthetic only: disposable geops_verify_* database and stub vendor tenant.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { applyMigrations } from '../src/db/migration-manager.ts';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { DeviceDiagnosticsService } from '../src/device-diagnostics-service.ts';
import { MdmPolicyService } from '../src/mdm/policy-service.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !['localhost', '127.0.0.1'].includes(new URL(url).hostname) ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic database required');
const pool = new pg.Pool({ connectionString: url, max: 8 });
let app;
try {
  assert.equal((await applyMigrations(pool)).length, 42);
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 111),
    csrfKey: Buffer.alloc(32, 112),
    allowedOrigins: ['https://geops.example.invalid'],
  });
  const adminId = await auth.bootstrap('mdm-policy@example.invalid', 'synthetic-password-12345678');
  const a = randomUUID(),
    b = randomUUID();
  for (const [deviceId, tenantId] of [
    [a, 'tenant-a'],
    [b, 'tenant-b'],
  ]) {
    await pool.query(
      "INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','Synthetic')",
      [deviceId],
    );
    await pool.query(
      "INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake',$3,$4,'ACTIVE')",
      [randomUUID(), deviceId, tenantId, `fake-${deviceId}`],
    );
    await pool.query(
      `INSERT INTO mdm_inventory_device
       (provider,region,customer_id,mdm_device_id,platform,status,geops_device_id,last_seen_at)
       VALUES('manageengine','com','123',$1,'android','managed',$2,now())`,
      [deviceId === a ? '456' : '457', deviceId],
    );
  }
  const diagnostics = new DeviceDiagnosticsService(pool);
  const vendor = {
    status: async () => ({ authorized: true, region: 'com', customer_id: '123' }),
    devicePolicies: async (mdmId) => ({
      mdm_device_id: mdmId,
      fetched_at: new Date().toISOString(),
      device: {
        status: 'managed',
        model: 'moto g06',
        android_version: '15',
        last_contact_at: new Date().toISOString(),
      },
      profiles: { state: 'AVAILABLE', items: [] },
      apps: { state: 'AVAILABLE', items: [] },
    }),
    profileDetail: async (profileId) => ({
      profile_id: profileId,
      platform: 'ANDROID',
      version: 2,
      published: true,
      trashed: false,
    }),
  };
  const policy = new MdmPolicyService(pool, diagnostics, vendor);
  app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    deviceDiagnostics: diagnostics,
    mdmPolicies: policy,
    secureCookie: false,
  });
  const login = await app.inject({
    method: 'POST',
    url: '/v1/admin/auth/sessions',
    headers: { origin: 'https://geops.example.invalid' },
    payload: { email: 'mdm-policy@example.invalid', password: 'synthetic-password-12345678' },
  });
  assert.equal(login.statusCode, 200);
  let cookie = login.headers['set-cookie'].split(';')[0];
  let csrf = login.json().csrf_token;
  const get = (path) => app.inject({ method: 'GET', url: path, headers: { cookie } });
  const post = (path, payload) =>
    app.inject({
      method: 'POST',
      url: path,
      headers: { cookie, origin: 'https://geops.example.invalid', 'x-csrf-token': csrf },
      payload,
    });
  assert.equal((await get(`/v1/admin/mdm/devices/${a}/configuration`)).statusCode, 403);
  assert.equal((await get('/v1/admin/mdm/workspace/summary')).statusCode, 403);
  for (const permission of [
    'mdm.diagnostics.view',
    'mdm.policies.view',
    'mdm.permissions.remediate',
    'mdm.audit.view',
    'mdm.diagnostics.export',
  ])
    await pool.query(
      'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
      [adminId, permission, 'Synthetic Wave 3 permission'],
    );
  for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
    await pool.query(
      `INSERT INTO ${table}(admin_id,tenant_id,granted_by,reason) VALUES($1,'tenant-a',$1,$2)`,
      [adminId, 'Synthetic tenant grant'],
    );
  const me = await get('/v1/admin/auth/permissions');
  assert.equal(me.statusCode, 200);
  assert.ok(me.json().permissions.includes('mdm.permissions.remediate'));
  const unreported = randomUUID();
  await pool.query("INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','Synthetic no report')", [unreported]);
  await pool.query("INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake','tenant-a',$3,'ACTIVE')",
    [randomUUID(), unreported, `fake-${unreported}`]);
  const observed = new Date().toISOString();
  const snapshot = {
    schema_version: 1, installation_id: randomUUID(), boot_id: 'synthetic-wave5-boot',
    sequence: 1, observed_at: observed, app_version: '1.0.3-spec05-wave4',
    manufacturer: 'Motorola', model: 'moto g06', android_release: '15', android_api: 35,
    permissions: { fine: 'GRANTED', coarse: 'GRANTED', background: 'DENIED', notifications: 'GRANTED' },
    execution: { location_enabled: true, gps_provider_enabled: true, battery_exempt: false,
      power_save: false, background_restricted: true, data_saver: 'DISABLED', internet: 'VALIDATED' },
    gps: { service: 'RUNNING_OBSERVED', last_callback_at: observed, last_capture_at: observed,
      last_ack_at: null, pending_positions: 11, upload_auth_blocked: false,
      capture_interval_s: 60, sync_interval_s: 60, policy_revision: 1, tracking_mode: 'CONTINUOUS' },
    errors: [],
  };
  await pool.query(`INSERT INTO device_diagnostic_snapshot
    (id,device_id,installation_id,tenant_id,boot_id,sequence,schema_version,observed_at,
     app_version,manufacturer,model,android_release,android_api,payload_digest,payload,findings)
    VALUES($1,$2,$3,'tenant-a',$4,1,1,$5,$6,$7,$8,$9,35,$10,$11,$12)`,
    [randomUUID(), a, snapshot.installation_id, snapshot.boot_id, observed, snapshot.app_version,
      snapshot.manufacturer, snapshot.model, snapshot.android_release, 'a'.repeat(64), JSON.stringify(snapshot),
      JSON.stringify([{ code: 'GPS_TRANSMISSION_STALE', classification: 'CONFIRMED', source: 'GPS_V2_LOCAL' }])]);
  const workspaceSummary = await get('/v1/admin/mdm/workspace/summary');
  assert.equal(workspaceSummary.statusCode, 200, workspaceSummary.body);
  assert.equal(workspaceSummary.json().registered, 2);
  assert.equal(workspaceSummary.json().linked, 1);
  assert.equal(workspaceSummary.json().no_data, 1);
  assert.equal(workspaceSummary.json().permission, 1);
  assert.equal(workspaceSummary.json().battery, 1);
  assert.equal(workspaceSummary.json().transmission, 1);
  assert.equal(workspaceSummary.json().compliance, null);
  const workspaceList = await get('/v1/admin/mdm/workspace/devices?limit=1&page=1&sort=name');
  assert.equal(workspaceList.statusCode, 200, workspaceList.body);
  assert.equal(workspaceList.json().total, 2);
  assert.equal(workspaceList.json().items.length, 1);
  assert.equal((await get('/v1/admin/mdm/workspace/devices?limit=1&page=2')).json().items.length, 1);
  const beyond = await get('/v1/admin/mdm/workspace/devices?limit=1&page=3');
  assert.equal(beyond.json().total, 2);
  assert.equal(beyond.json().items.length, 0);
  const missing = await get('/v1/admin/mdm/workspace/devices?issue=permission');
  assert.equal(missing.statusCode, 200, missing.body);
  assert.deepEqual(missing.json().items.map((item) => item.device_id), [a]);
  assert.equal((await get('/v1/admin/mdm/workspace/devices?age=none')).json().total, 1);
  assert.equal((await get('/v1/admin/mdm/workspace/devices?android=15&issue=battery')).json().total, 1);
  assert.equal((await get('/v1/admin/mdm/workspace/devices?ids=' + b)).json().total, 0);
  assert.equal((await get('/v1/admin/mdm/workspace/devices?sort=malicious')).statusCode, 422);
  assert.equal((await get('/v1/admin/mdm/workspace/devices?q=one&q=two')).statusCode, 422);
  const timeline = await get(`/v1/admin/mdm/workspace/devices/${a}/timeline`);
  assert.equal(timeline.statusCode, 200, timeline.body);
  assert.ok(timeline.json().items.some((item) => item.type === 'DIAGNOSTIC'));
  assert.equal((await get(`/v1/admin/mdm/workspace/devices/${b}/timeline`)).statusCode, 403);
  const report = await get('/v1/admin/mdm/workspace/report?issue=permission');
  assert.equal(report.statusCode, 200, report.body);
  assert.equal(report.json().items.length, 1);
  assert.ok(!report.body.includes('token_hash'));
  assert.ok(!report.body.includes('coordinates'));
  assert.ok((await pool.query("SELECT count(*)::int AS n FROM audit_event WHERE action LIKE 'mdm.workspace.%' AND actor_id=$1", [adminId])).rows[0].n >= 4);
  await pool.query(
    "UPDATE admin_session SET issued_at=now()-interval '6 minutes' WHERE admin_id=$1",
    [adminId],
  );
  const staleLogin = await post('/v1/admin/mdm/remediations/preview', {
    device_id: a,
    profile_id: '789',
  });
  assert.equal(staleLogin.statusCode, 403);
  assert.equal(staleLogin.json().error.code, 'recent_login_required');
  const freshLogin = await app.inject({
    method: 'POST',
    url: '/v1/admin/auth/sessions',
    headers: { origin: 'https://geops.example.invalid' },
    payload: { email: 'mdm-policy@example.invalid', password: 'synthetic-password-12345678' },
  });
  assert.equal(freshLogin.statusCode, 200);
  cookie = freshLogin.headers['set-cookie'].split(';')[0];
  csrf = freshLogin.json().csrf_token;
  assert.equal((await get(`/v1/admin/mdm/devices/${b}/configuration`)).statusCode, 403);
  const configuration = await get(`/v1/admin/mdm/devices/${a}/configuration`);
  assert.equal(configuration.statusCode, 200);
  assert.equal(configuration.json().mdm_device_id, '456');
  assert.equal(configuration.json().link_state, 'VALID');
  assert.equal(configuration.json().effective_android.background, 'DENIED');
  const capabilities = await get('/v1/admin/mdm/capabilities');
  assert.equal(capabilities.statusCode, 200);
  assert.equal(capabilities.json().write_enabled, false);
  const preview = await post('/v1/admin/mdm/remediations/preview', {
    device_id: a,
    profile_id: '789',
  });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().eligible, true);
  assert.equal(preview.json().impact_device_count, 1);
  assert.equal(preview.json().write_enabled, false);
  const body = {
    device_id: a,
    profile_id: '789',
    preview_digest: preview.json().preview_digest,
    idempotency_key: 'wave3syntheticrequest01',
    reason: 'Synthetic lab review only',
  };
  const first = await post('/v1/admin/mdm/remediations/requests', body);
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().state, 'AWAITING_APPROVAL');
  const reportWithCorrection = await get(`/v1/admin/mdm/workspace/report?ids=${a}`);
  assert.equal(reportWithCorrection.statusCode, 200, reportWithCorrection.body);
  assert.equal(reportWithCorrection.json().corrections[0].state, 'AWAITING_APPROVAL');
  assert.equal(reportWithCorrection.json().corrections_truncated, false);
  await pool.query("UPDATE admin_permission SET revoked_at=now() WHERE admin_id=$1 AND permission='mdm.audit.view'", [adminId]);
  assert.equal((await get(`/v1/admin/mdm/workspace/report?ids=${a}`)).json().corrections, null);
  await pool.query("UPDATE admin_permission SET revoked_at=NULL WHERE admin_id=$1 AND permission='mdm.audit.view'", [adminId]);
  assert.equal((await post('/v1/admin/mdm/remediations/requests', body)).json().duplicate, true);
  assert.equal(
    (await post('/v1/admin/mdm/remediations/requests', { ...body, preview_digest: 'a'.repeat(64) }))
      .statusCode,
    409,
  );
  const history = await get(`/v1/admin/mdm/devices/${a}/remediations`);
  assert.equal(history.statusCode, 200);
  assert.equal(history.json().items.length, 1);
  assert.equal(
    (await post(`/v1/admin/mdm/remediations/requests/${first.json().request_id}/submit`, {}))
      .statusCode,
    503,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM mdm_remediation_event WHERE state='AWAITING_APPROVAL'",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE action='mdm.remediation.submit' AND outcome='rejected'",
      )
    ).rows[0].n,
    1,
  );
  await pool.query("UPDATE admin_permission SET revoked_at=now() WHERE admin_id=$1 AND permission='mdm.diagnostics.export'", [adminId]);
  assert.equal((await get('/v1/admin/mdm/workspace/report')).statusCode, 403);
  await pool.query(
    "UPDATE gps_health_tenant_access SET revoked_at=now() WHERE admin_id=$1 AND tenant_id='tenant-a'",
    [adminId],
  );
  assert.equal((await post('/v1/admin/mdm/remediations/requests', body)).statusCode, 403);
  assert.equal((await get('/v1/admin/mdm/workspace/summary')).json().registered, 0);
  const logout = await app.inject({
    method: 'DELETE',
    url: '/v1/admin/auth/sessions/current',
    headers: { cookie, origin: 'https://geops.example.invalid', 'x-csrf-token': csrf },
  });
  assert.equal(logout.statusCode, 204);
  assert.equal((await get('/v1/admin/auth/permissions')).statusCode, 401);
  console.log(
    'mdm-policy integration PASS: RBAC, tenant isolation, revoked grants, read, preview, idempotency, write gate, audit',
  );
} finally {
  if (app) await app.close();
  await pool.end();
}
