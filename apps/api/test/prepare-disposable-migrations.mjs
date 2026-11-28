import pg from 'pg';
import { applyMigrations } from '../src/db/migration-manager.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable database required');
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const applied = await applyMigrations(pool);
  if (applied.length !== 42) throw new Error('Expected fresh 0042 schema');
  console.log('Disposable GPS regression schema 0042 ready');
} finally {
  await pool.end();
}
