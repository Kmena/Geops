import { Pool } from 'pg';

export function createPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 2000,
    query_timeout: 2000,
    max: 5,
  });
  pool.on('error', () => {
    process.stderr.write('GEOPS database connection interrupted\n');
  });
  return pool;
}
