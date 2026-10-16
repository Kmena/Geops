import { loadConfig } from '../config.js';
import { applyMigrations } from './migration-manager.js';
import { createPool } from './pool.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
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
