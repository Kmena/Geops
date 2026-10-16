import { applyMigrations } from './migration-manager.js';
import { resolveMigrationTarget } from './migration-target.js';
import { createPool } from './pool.js';
import { readGate } from './restore-gate.js';

async function main(): Promise<void> {
  const target = resolveMigrationTarget(process.env);
  const pool = createPool(target.url);
  try {
    const observed = await pool.query<{ name: string; others: number }>(
      'SELECT current_database() AS name,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) AS others',
    );
    if (observed.rows[0]?.name !== target.name || observed.rows[0]?.others !== 0)
      throw new Error('Migration destination is not isolated');
    if (target.name === 'geops_dev') {
      const state = await pool.query<{ existing: boolean }>(
        "SELECT to_regclass('geops_schema_migrations') IS NOT NULL AS existing",
      );
      if (state.rows[0]?.existing) {
        const gate = await readGate(process.env.GEOPS_SECURITY_GATE_PATH ?? '');
        if (gate.phase !== 'closed')
          throw new Error('Non-disposable migration requires closed gate');
      }
    }
    process.stdout.write(`GEOPS migration destination verified: ${target.name}\n`);
    const applied = await applyMigrations(pool);
    process.stdout.write(`GEOPS migrations applied: ${applied.length}\n`);
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write('GEOPS migration failed; details withheld\n');
  process.exitCode = 1;
});
