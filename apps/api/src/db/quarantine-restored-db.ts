import { createPool } from './pool.js';
import { quarantineSyntheticRestore } from './restore-quarantine.js';

async function main(): Promise<void> {
  const name = process.env.GEOPS_TEST_DB ?? '';
  if (
    process.env.GEOPS_DATA_MODE !== 'synthetic' ||
    process.env.GEOPS_CONFIRM_RESTORE_QUARANTINE !== 'YES' ||
    !/^geops_verify_[0-9]+_restore$/.test(name ?? '') ||
    !process.env.GEOPS_SECURITY_GATE_PATH ||
    !process.env.DATABASE_URL
  ) {
    throw new Error('Synthetic restore quarantine preconditions failed');
  }
  const url = new URL(process.env.DATABASE_URL);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('PostgreSQL URL required');
  }
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  try {
    await quarantineSyntheticRestore(pool, name, process.env.GEOPS_SECURITY_GATE_PATH);
    process.stdout.write(
      'GEOPS synthetic restore quarantine completed; all restored credentials invalidated\n',
    );
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write('GEOPS synthetic restore quarantine failed; details withheld\n');
  process.exitCode = 1;
});
