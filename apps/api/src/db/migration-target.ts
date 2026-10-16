/** A migration must name the database in three independent inputs. Never rewrite DATABASE_URL. */
export function resolveMigrationTarget(env: NodeJS.ProcessEnv): { url: string; name: string } {
  if (env.GEOPS_DATA_MODE !== 'synthetic' || !env.DATABASE_URL)
    throw new Error('Synthetic migration configuration required');
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL);
  } catch {
    throw new Error('PostgreSQL migration URL required');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash)
    throw new Error('PostgreSQL migration URL required');
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^(geops_dev|geops_verify_[0-9]+(_restore)?)$/.test(name) || url.pathname !== `/${name}`)
    throw new Error('Unexpected migration database');
  if (env.GEOPS_MIGRATION_TARGET !== name || env.GEOPS_CONFIRM_MIGRATION_TARGET !== name)
    throw new Error('Explicit matching migration target and confirmation required');
  if (env.GEOPS_TEST_DB && env.GEOPS_TEST_DB !== name)
    throw new Error('GEOPS_TEST_DB conflicts with migration target');
  if (name === 'geops_dev' && env.GEOPS_ALLOW_NONDISPOSABLE_MIGRATION !== 'YES')
    throw new Error('Non-disposable database migration requires separate authorization');
  return { url: url.toString(), name };
}
