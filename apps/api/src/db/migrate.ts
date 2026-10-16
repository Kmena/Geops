import { applyMigrations } from './migration-manager.js';
import { createPool } from './pool.js';

async function main(): Promise<void> {
  if (process.env.GEOPS_DATA_MODE !== 'synthetic' || !process.env.DATABASE_URL) {
    throw new Error('Synthetic migration configuration required');
  }
  const pool = createPool(process.env.DATABASE_URL);
  try {
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
