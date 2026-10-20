import type { Pool, PoolClient } from 'pg';
import { ApiError } from '../errors.js';

/** Lock grants for the duration of a mutation so a concurrent revocation wins cleanly. */
export async function requireInstallationAccess(
  db: Pool | PoolClient,
  adminId: string,
  tenantId: string,
): Promise<void> {
  const scope = await db.query(
    `SELECT 1 FROM admin_user u
     JOIN admin_permission p ON p.admin_id=u.id AND p.permission='gps.installation.manage'
       AND p.revoked_at IS NULL
     JOIN gps_data_tenant_access d ON d.admin_id=u.id AND d.tenant_id=$2
       AND d.revoked_at IS NULL
     JOIN gps_health_tenant_access h ON h.admin_id=u.id AND h.tenant_id=$2
       AND h.revoked_at IS NULL
     JOIN geops_operating_tenant t ON t.tenant_id=$2 AND t.singleton=true
     WHERE u.id=$1 AND u.state='ACTIVE' FOR SHARE OF u,p,d,h,t`,
    [adminId, tenantId],
  );
  if (!scope.rowCount) throw new ApiError(403, 'gps_forbidden', 'Forbidden', true);
}
