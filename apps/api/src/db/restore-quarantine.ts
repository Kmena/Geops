import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { checkReadiness } from './migration-manager.js';
import { readGate, recordGateEvent } from './restore-gate.js';

/** Invalidates credentials in an isolated synthetic restore before any API can connect. */
export async function quarantineSyntheticRestore(
  pool: Pool,
  databaseName: string,
  gatePath: string,
): Promise<void> {
  if (!/^geops_verify_[0-9]+_restore$/.test(databaseName)) {
    throw new Error('Quarantine requires an isolated synthetic restore database');
  }
  if (!(await checkReadiness(pool))) throw new Error('Restored schema is not ready');
  const gate = await readGate(gatePath);
  if (gate.phase !== 'closed') throw new Error('External gate must be closed');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(350018)');
    if ((await readGate(gatePath)).epoch !== gate.epoch) throw new Error('External epoch changed');
    const database = await client.query<{ current_database: string }>('SELECT current_database()');
    if (database.rows[0]?.current_database !== databaseName)
      throw new Error('Wrong restore database');
    const others = await client.query<{ count: string }>(
      'SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()',
    );
    if (Number(others.rows[0]?.count) !== 0)
      throw new Error('Restore database has other connections');
    await client.query(
      "UPDATE geops_device SET status='REVOKED',version=version+1,updated_at=now() WHERE status<>'REVOKED'",
    );
    await client.query(
      "UPDATE mdm_binding SET state='REVOKED',version=version+1 WHERE state<>'REVOKED'",
    );
    await client.query(
      "UPDATE device_invitation SET status='CANCELLED',version=version+1 WHERE status IN ('ISSUED','CLAIMED')",
    );
    await client.query(
      "UPDATE enrollment_claim SET status='CANCELLED',version=version+1 WHERE status IN ('CLAIMED','PENDING_CONFIRMATION')",
    );
    await client.query(
      "UPDATE device_key SET status='REVOKED',revoked_at=now(),version=version+1 WHERE status<>'REVOKED'",
    );
    await client.query('UPDATE device_session SET revoked_at=now() WHERE revoked_at IS NULL');
    await client.query('UPDATE device_challenge SET consumed_at=now() WHERE consumed_at IS NULL');
    await client.query('UPDATE admin_session SET revoked_at=now() WHERE revoked_at IS NULL');
    await client.query(
      'UPDATE admin_user_invitation SET consumed_at=now() WHERE consumed_at IS NULL',
    );
    await client.query('UPDATE admin_permission SET revoked_at=now() WHERE revoked_at IS NULL');
    await client.query(
      'UPDATE gps_data_tenant_access SET revoked_at=now() WHERE revoked_at IS NULL',
    );
    await client.query(
      'UPDATE gps_health_tenant_access SET revoked_at=now() WHERE revoked_at IS NULL',
    );
    await client.query(
      "UPDATE admin_user SET state='LOCKED',version=version+1,updated_at=now() WHERE state='ACTIVE'",
    );
    await client.query('UPDATE admin_recovery SET consumed_at=now() WHERE consumed_at IS NULL');
    await client.query(
      "UPDATE recovery_request SET status='CANCELLED',code_hash=NULL WHERE status IN ('PENDING','AUTHORIZED')",
    );
    await client.query('UPDATE recovery_approval SET revoked_at=now() WHERE revoked_at IS NULL');
    await client.query(
      "UPDATE recovery_custodian SET state='REVOKED',revoked_at=now() WHERE state='ACTIVE'",
    );
    await client.query(
      "UPDATE mdm_integration SET status='DISCONNECTED',encrypted_refresh_token=NULL,token_iv=NULL,token_tag=NULL,updated_at=now()",
    );
    await client.query(
      'INSERT INTO security_epoch(singleton,epoch,quarantine_id) VALUES(true,$1,$2) ON CONFLICT(singleton) DO UPDATE SET epoch=EXCLUDED.epoch,quarantine_id=EXCLUDED.quarantine_id,updated_at=now()',
      [gate.epoch, randomUUID()],
    );
    await client.query(
      "INSERT INTO audit_event(id,actor_type,action,outcome,correlation_id) VALUES($1,'SYSTEM','restore.quarantine.synthetic','success',$2)",
      [randomUUID(), randomUUID()],
    );
    await client.query('COMMIT');
    await recordGateEvent(gatePath, 'restore.quarantine', gate.epoch);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
