// Run only inside the deployed GEOPS staging API container via stdin.
// No credentials are read from or printed to the host terminal.
import { randomUUID } from 'node:crypto';
import { createPool } from '/work/apps/api/dist/db/pool.js';
import { DeviceRepository } from '/work/apps/api/dist/device-identity/repository.js';

const deviceId = 'a5fff5f2-5746-495e-9e6b-e7687104c5ad';
const displayLabel = 'Android_prueba_Poco';
const reason = 'Retiro solicitado por propietario tras revocacion del dispositivo heredado';
const fail = (code) => { throw new Error(code); };

if (process.env.GEOPS_DATA_MODE !== 'synthetic' || !process.env.DATABASE_URL)
  fail('STAGING_ENV_REQUIRED');
const pool = createPool(process.env.DATABASE_URL);
try {
  const target = await pool.query(
    `SELECT current_database() AS db,d.id,d.display_label,d.status,
       (SELECT count(*)::int FROM mdm_binding WHERE geops_device_id=d.id) AS bindings,
       (SELECT bool_and(provider='fake' AND customer_id='synthetic')
        FROM mdm_binding WHERE geops_device_id=d.id) AS valid_bindings
     FROM geops_device d WHERE d.id=$1`, [deviceId],
  );
  const row = target.rows[0];
  if (!row || row.db !== 'geops_dev' || row.display_label !== displayLabel ||
      row.status !== 'REVOKED' || row.bindings < 1 || !row.valid_bindings)
    fail('TARGET_IDENTITY_OR_STATUS_MISMATCH');

  const priorActor = await pool.query(
    `SELECT a.actor_id FROM audit_event a
     JOIN admin_user u ON u.id=a.actor_id AND u.state='ACTIVE'
     WHERE a.device_id=$1 AND a.action='device.revoke' AND a.outcome='success'
     ORDER BY a.occurred_at DESC,a.id DESC LIMIT 1`, [deviceId],
  );
  const adminId = priorActor.rows[0]?.actor_id;
  if (!adminId) fail('REVOKE_ADMIN_AUDIT_REQUIRED');

  const history = async () => (await pool.query(
    `SELECT
      (SELECT count(*)::int FROM position_event WHERE device_id=$1) AS positions,
      (SELECT count(*)::int FROM gps_session_event WHERE device_id=$1) AS session_events,
      (SELECT count(*)::int FROM gps_effective_session WHERE device_id=$1) AS sessions,
      (SELECT count(*)::int FROM gps_policy_delivery WHERE device_id=$1) AS deliveries`,
    [deviceId],
  )).rows[0];
  const before = await history();
  const offline = await new DeviceRepository(pool).decommission(
    deviceId, adminId, randomUUID(), reason,
  );
  const after = await history();
  if (JSON.stringify(before) !== JSON.stringify(after)) fail('HISTORY_COUNT_CHANGED');

  const verified = (await pool.query(
    `SELECT d.status,
      (SELECT count(*)::int FROM device_key WHERE geops_device_id=$1 AND status='ACTIVE') AS active_keys,
      (SELECT count(*)::int FROM device_session WHERE geops_device_id=$1
       AND revoked_at IS NULL AND expires_at>now()) AS live_sessions,
      (SELECT count(*)::int FROM gps_device_installation WHERE device_id=$1
       AND retired_at IS NULL) AS active_installations,
      (SELECT count(*)::int FROM gps_mdm_continuous_authorization WHERE device_id=$1
       AND revoked_at IS NULL) AS continuous_grants,
      (SELECT count(*)::int FROM gps_effective_assignment WHERE device_id=$1
       AND superseded_at IS NULL) AS effective_assignments,
      (SELECT count(*)::int FROM gps_device_ownership WHERE device_id=$1
       AND tracking_authorized) AS tracking_grants,
      (SELECT count(*)::int FROM agent_device_link WHERE device_id=$1
       AND state='ACTIVE') AS active_agent_links,
      (SELECT count(*)::int FROM audit_event WHERE device_id=$1
       AND action='device.decommission' AND outcome='success') AS decommission_audits
     FROM geops_device d WHERE d.id=$1`, [deviceId],
  )).rows[0];
  if (verified?.status !== 'DECOMMISSIONED' || verified.decommission_audits !== 1 ||
      ['active_keys','live_sessions','active_installations','continuous_grants',
       'effective_assignments','tracking_grants','active_agent_links']
        .some((key) => verified[key] !== 0)) fail('POSTCONDITION_FAILED');
  console.log(JSON.stringify({ device_id: deviceId, status: verified.status,
    gps_authorization: 'REVOKED_SERVER_SIDE', ...offline,
    active_inventory: 'EXCLUDED', history_preserved: before,
    audit_events: verified.decommission_audits }));
} catch (error) {
  console.error('SPEC04_DECOMMISSION_FAILED', error.code ?? error.message ?? 'UNKNOWN');
  process.exitCode = 1;
} finally {
  await pool.end();
}
