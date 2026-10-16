import assert from 'node:assert/strict';
import { createPool } from '../dist/db/pool.js';
import { DeviceSessionService } from '../dist/device-identity/session.js';
import { checkReadiness } from '../dist/db/migration-manager.js';

async function main() {
  const db = process.env.GEOPS_TEST_DB;
  if (!/^geops_verify_[0-9]+_restore$/.test(db ?? '')) throw new Error('Invalid restore DB');
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${db}`;
  const pool = createPool(url.toString());
  try {
    assert.equal(await checkReadiness(pool), true);
    const result = await pool.query(
      "SELECT d.id AS device_id,k.id AS key_id FROM geops_device d JOIN device_key k ON k.geops_device_id=d.id WHERE d.status='REVOKED' AND k.status='REVOKED' LIMIT 1",
    );
    assert.equal(result.rowCount, 1);
    const service = new DeviceSessionService(pool);
    await assert.rejects(service.challenge(result.rows[0].device_id, result.rows[0].key_id), {
      code: 'device_inactive',
    });
    const summary = await pool.query(
      "SELECT (SELECT count(*) FROM device_key WHERE status='ACTIVE') AS active_keys,(SELECT count(*) FROM device_session WHERE revoked_at IS NULL) AS live_sessions",
    );
    assert.equal(Number(summary.rows[0].active_keys), 0);
    assert.equal(Number(summary.rows[0].live_sessions), 0);
    console.log(
      'GEOPS synthetic restore: PASS revoked identity rejects new session; zero active keys/sessions',
    );
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error('GEOPS synthetic restore check failed; details withheld');
  process.exitCode = 1;
});
