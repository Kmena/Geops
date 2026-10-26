import type { PoolClient } from 'pg';
import { ApiError } from './errors.js';

export interface GpsDeviceScope {
  bindingId: string | null;
  tenantId: string;
  installationId: string;
}

/** Resolve one authenticated GEOPS device to an explicitly activated installation. */
export async function resolveGpsDeviceScope(
  db: PoolClient,
  deviceId: string,
  installationId?: string,
): Promise<GpsDeviceScope> {
  const device = await db.query<{ status: string }>(
    'SELECT status FROM geops_device WHERE id=$1 FOR UPDATE',
    [deviceId],
  );
  if (device.rows[0]?.status !== 'ACTIVE')
    throw new ApiError(403, 'device_inactive', 'Forbidden', true);
  const bindings = await db.query<{ id: string; customer_id: string }>(
    "SELECT id,customer_id FROM mdm_binding WHERE geops_device_id=$1 AND state='ACTIVE' FOR SHARE",
    [deviceId],
  );
  if (bindings.rows.length > 1) throw new ApiError(403, 'binding_ambiguous', 'Forbidden', true);
  const binding = bindings.rows[0];
  if (binding) {
    const rows = await db.query<{ installation_id: string }>(
      `SELECT installation_id FROM gps_device_installation
       WHERE device_id=$1 AND ($2::uuid IS NULL OR installation_id=$2)
         AND activation_binding_id=$3 AND activation_tenant_id=$4
         AND retired_at IS NULL FOR SHARE`,
      [deviceId, installationId ?? null, binding.id, binding.customer_id],
    );
    if (rows.rows.length !== 1 || !rows.rows[0])
      throw new ApiError(403, 'installation_inactive', 'Forbidden', true);
    return {
      bindingId: binding.id,
      tenantId: binding.customer_id,
      installationId: rows.rows[0].installation_id,
    };
  }
  const rows = await db.query<{ installation_id: string; tenant_id: string }>(
    `SELECT i.installation_id,t.tenant_id FROM gps_device_installation i
     JOIN geops_device_tenant t ON t.device_id=i.device_id
       AND t.tenant_id=i.activation_tenant_id
     WHERE i.device_id=$1 AND ($2::uuid IS NULL OR i.installation_id=$2)
       AND i.activation_binding_id IS NULL AND i.retired_at IS NULL FOR SHARE OF i,t`,
    [deviceId, installationId ?? null],
  );
  if (rows.rows.length !== 1 || !rows.rows[0])
    throw new ApiError(403, 'installation_inactive', 'Forbidden', true);
  return {
    bindingId: null,
    tenantId: rows.rows[0].tenant_id,
    installationId: rows.rows[0].installation_id,
  };
}
