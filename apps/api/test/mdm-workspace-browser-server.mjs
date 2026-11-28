// SPEC-05 Wave 5 browser fixture. Disposable loopback PostGIS and mock MDM only.
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { applyMigrations, checkReadiness } from '../src/db/migration-manager.ts';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { requireAdmin } from '../src/admin-auth/routes.ts';
import { DeviceSessionService } from '../src/device-identity/session.ts';
import { DeviceDiagnosticsService } from '../src/device-diagnostics-service.ts';
import { evaluateDiagnostic } from '../src/device-diagnostics-rules.ts';
import { MdmPolicyService } from '../src/mdm/policy-service.ts';
import { GpsPolicyService } from '../src/gps-policy-service.ts';
import { GpsDeviceConfigService } from '../src/gps-device-config.ts';
import { GpsEventService } from '../src/gps-event-service.ts';

const url = process.env.DATABASE_URL;
if (!url || !['127.0.0.1', 'localhost'].includes(new URL(url).hostname) ||
    !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
    process.env.GEOPS_DATA_MODE !== 'synthetic')
  throw new Error('Disposable synthetic database required');
const pool = new pg.Pool({ connectionString: url, max: 8 });
await applyMigrations(pool);
const auth = new AdminAuthService(pool, {
  sessionKey: Buffer.alloc(32, 151), csrfKey: Buffer.alloc(32, 152),
  allowedOrigins: ['http://127.0.0.1:3501', 'http://localhost:3501'],
});
const owner = await auth.bootstrap('wave5-admin@example.invalid', 'synthetic-password-12345678');
const ownerHash = (await pool.query('SELECT password_hash FROM admin_user WHERE id=$1', [owner])).rows[0].password_hash;
const limited = randomUUID();
await pool.query("INSERT INTO admin_user(id,email_normalized,password_hash,state) VALUES($1,'wave5-limited@example.invalid',$2,'ACTIVE')", [limited, ownerHash]);
for (const permission of ['mdm.diagnostics.view','mdm.diagnostics.export','mdm.policies.view',
  'mdm.permissions.remediate','mdm.audit.view'])
  await pool.query('INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
    [owner, permission, 'Synthetic Wave 5 browser fixture']);
for (const table of ['gps_data_tenant_access','gps_health_tenant_access'])
  await pool.query(`INSERT INTO ${table}(admin_id,tenant_id,granted_by,reason) VALUES($1,'tenant-a',$1,$2)`,
    [owner, 'Synthetic Wave 5 browser fixture']);

const now = new Date();
const ago = (minutes) => new Date(now.getTime() - minutes * 60_000).toISOString();
const devices = [
  { label: 'Equipo sin hallazgos', ownership: 'CORPORATE_MANAGED', mdm: '101', mode: 'healthy' },
  { label: 'Moto G06 permiso faltante', ownership: 'CORPORATE_MANAGED', mdm: '102', mode: 'permission' },
  { label: 'Equipo batería restringida', ownership: 'CORPORATE_MANAGED', mdm: '103', mode: 'battery' },
  { label: 'Equipo captura sin ACK', ownership: 'CORPORATE_MANAGED', mdm: '104', mode: 'transmission' },
  { label: 'Equipo sin comunicación', ownership: 'PERSONAL_BYOD', mode: 'offline' },
  { label: 'Equipo diagnóstico antiguo', ownership: 'CORPORATE_MANAGED', mode: 'stale' },
  { label: 'Equipo tenant MDM desconocido', ownership: 'UNVERIFIED', mode: 'unknown' },
  { label: 'Equipo sin diagnóstico', ownership: 'UNVERIFIED', mode: 'none' },
];
const diagnostics = new DeviceDiagnosticsService(pool);
for (const [index, item] of devices.entries()) {
  const id = randomUUID();
  item.id = id;
  await pool.query("INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE',$2)", [id, `SINTÉTICO · ${item.label}`]);
  await pool.query("INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake','tenant-a',$3,'ACTIVE')",
    [randomUUID(), id, `fake-${id}`]);
  if (item.mdm) await pool.query(`INSERT INTO mdm_inventory_device
    (provider,region,customer_id,mdm_device_id,platform,status,geops_device_id,last_seen_at)
    VALUES('manageengine','com','tenant-a',$1,'android','managed',$2,now())`, [item.mdm,id]);
  if (item.mode === 'none') continue;
  const observed = item.mode === 'stale' || item.mode === 'offline' ? ago(65) : ago(2);
  const snapshot = {
    schema_version: 1, installation_id: randomUUID(), boot_id: `wave5-synthetic-${index}`,
    sequence: 1, observed_at: observed, app_version: '1.0.3-spec05-wave4',
    manufacturer: 'Motorola', model: item.mode === 'permission' ? 'moto g06' : 'lab model',
    android_release: '15', android_api: 35,
    permissions: { fine: 'GRANTED', coarse: 'GRANTED',
      background: item.mode === 'permission' ? 'DENIED' : 'GRANTED', notifications: 'GRANTED' },
    execution: { location_enabled: true, gps_provider_enabled: true,
      battery_exempt: item.mode !== 'battery', power_save: false,
      background_restricted: item.mode === 'battery', data_saver: 'DISABLED',
      internet: item.mode === 'offline' ? 'OFFLINE' : 'VALIDATED' },
    gps: { service: 'RUNNING_OBSERVED', last_callback_at: observed,
      last_capture_at: observed, last_ack_at: item.mode === 'transmission' ? ago(50) : observed,
      pending_positions: item.mode === 'transmission' ? 11 : 0,
      upload_auth_blocked: false, capture_interval_s: 60, sync_interval_s: 60,
      policy_revision: 1, tracking_mode: 'CONTINUOUS' }, errors: [],
  };
  const received = item.mode === 'stale' || item.mode === 'offline' ? ago(65) : ago(1);
  const findings = evaluateDiagnostic(snapshot, new Date(received), new Date(received));
  await pool.query(`INSERT INTO device_diagnostic_snapshot
    (id,device_id,installation_id,tenant_id,boot_id,sequence,schema_version,observed_at,
     received_at,app_version,manufacturer,model,android_release,android_api,payload_digest,payload,findings)
    VALUES($1,$2,$3,'tenant-a',$4,1,1,$5,$6,$7,$8,$9,$10,35,$11,$12,$13)`,
    [randomUUID(),id,snapshot.installation_id,snapshot.boot_id,observed,received,
      snapshot.app_version,snapshot.manufacturer,snapshot.model,snapshot.android_release,
      'b'.repeat(64),JSON.stringify(snapshot),JSON.stringify(findings)]);
}
const outsider = randomUUID();
await pool.query("INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','SINTÉTICO · Tenant B oculto')", [outsider]);
await pool.query("INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake','tenant-b',$3,'ACTIVE')",
  [randomUUID(),outsider,`fake-${outsider}`]);
const vendor = {
  status: async () => ({ authorized: true, region: 'com', customer_id: 'tenant-a' }),
  devicePolicies: async (id) => ({ mdm_device_id: id, fetched_at: new Date().toISOString(),
    device: { status: 'managed', model: 'lab model', android_version: '15', last_contact_at: now.toISOString() },
    profiles: { state: 'AVAILABLE', items: [] }, apps: { state: 'AVAILABLE', items: [] } }),
  profileDetail: async (id) => ({ profile_id: id, platform: 'ANDROID', version: 1, published: true, trashed: false }),
};
const gpsPolicies = new GpsPolicyService(pool);
const app = createApp({ readinessProbe: () => checkReadiness(pool), logLevel: 'silent',
  adminAuth: auth, deviceDiagnostics: diagnostics, deviceSessions: new DeviceSessionService(pool),
  mdmPolicies: new MdmPolicyService(pool, diagnostics, vendor),
  gpsPolicies, gpsDeviceConfig: new GpsDeviceConfigService(pool),
  gpsEvents: new GpsEventService(pool, gpsPolicies, Buffer.alloc(32, 153)),
  secureCookie: false });
app.get('/v1/admin/mdm/status', async (request) => {
  await requireAdmin(request, auth);
  return { provider: 'manageengine', connected: false, authorized: false,
    oauth_configured: false, authorization_state: 'never', edition_evidence: 'UNVERIFIED',
    last_checked_at: null, last_http_status: null, sanitized_error_code: 'mdm_disconnected' };
});
app.addHook('onClose', async () => pool.end());
await app.listen({ host: '127.0.0.1', port: 3500 });
process.once('SIGINT', () => void app.close());
