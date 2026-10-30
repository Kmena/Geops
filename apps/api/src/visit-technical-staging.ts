import type { PoolClient } from 'pg';

// An explicit match to the existing staging origin and cookie scope keeps
// technical evaluations unavailable to production deployments of this image.
export const isTechnicalStagingRuntime = () =>
  process.env.GEOPS_DATA_MODE === 'synthetic' &&
  process.env.GEOPS_ALLOWED_ORIGINS === 'https://geops-staging.duckdns.org' &&
  process.env.GEOPS_ADMIN_COOKIE_NAME === '__Host-geops_stage_admin';

export const isTechnicalStagingDatabase = async (db: PoolClient) => {
  if (!isTechnicalStagingRuntime()) return false;
  const row = await db.query<{ name: string }>('SELECT current_database() AS name');
  return row.rows[0]?.name === 'geops_dev';
};
