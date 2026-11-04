import { Pool } from 'pg';
import { checkReadiness } from '../db/migration-manager.js';
import { KmzRetentionService } from './retention.js';

const args = process.argv.slice(2);
const mode = args.filter((arg) => arg === '--dry-run' || arg === '--execute');
const actor = args.find((arg) => arg.startsWith('--actor='))?.slice('--actor='.length);
const limitText = args.find((arg) => arg.startsWith('--limit='))?.slice('--limit='.length);
const allowed = args.every(
  (arg) =>
    arg === '--dry-run' ||
    arg === '--execute' ||
    arg.startsWith('--actor=') ||
    arg.startsWith('--limit='),
);
if (
  !allowed ||
  mode.length !== 1 ||
  !actor ||
  (limitText !== undefined && !/^[1-9][0-9]{0,2}$/.test(limitText)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic' ||
  !process.env.DATABASE_URL
)
  throw new Error('Use --dry-run or --execute, --actor=UUID, optional --limit=1..100');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on('error', () => {
  process.stderr.write('GEOPS database connection interrupted\n');
});
try {
  if (!(await checkReadiness(pool))) throw new Error('Migration readiness failed');
  const result = await new KmzRetentionService(pool).run(actor, {
    dryRun: mode[0] === '--dry-run',
    limit: limitText === undefined ? 100 : Number(limitText),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await pool.end();
}
