import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { Pool } from 'pg';
import { checkReadiness } from './migration-manager.js';

export type GateState =
  | { version: 1; phase: 'closed'; epoch: string }
  | { version: 1; phase: 'open'; epoch: string; nonce?: string }
  | { version: 1; phase: 'maintenance'; epoch: string; nonce: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function gatePath(path: string): void {
  if (!isAbsolute(path) || basename(path) !== 'security-gate.json')
    throw new Error('External security gate path is invalid');
}

export async function recordGateEvent(path: string, event: string, epoch: string): Promise<void> {
  gatePath(path);
  const journal = join(dirname(path), 'security-gate.journal');
  const file = await open(journal, 'a', 0o600);
  try {
    await file.writeFile(`${JSON.stringify({ at: new Date().toISOString(), event, epoch })}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function readGate(path: string): Promise<GateState> {
  gatePath(path);
  const info = await lstat(path);
  if (!info.isFile() || info.size > 256) throw new Error('External security gate is invalid');
  const state: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!state || typeof state !== 'object') throw new Error('External security gate is invalid');
  const value = state as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',') !==
      (value.phase === 'maintenance' || (value.phase === 'open' && 'nonce' in value)
        ? 'epoch,nonce,phase,version'
        : 'epoch,phase,version') ||
    value.version !== 1 ||
    (value.phase !== 'open' && value.phase !== 'closed' && value.phase !== 'maintenance') ||
    typeof value.epoch !== 'string' ||
    !UUID.test(value.epoch) ||
    ((value.phase === 'maintenance' || 'nonce' in value) &&
      (typeof value.nonce !== 'string' || !UUID.test(value.nonce)))
  )
    throw new Error('External security gate is invalid');
  return value as unknown as GateState;
}

export async function writeGate(path: string, state: GateState): Promise<void> {
  gatePath(path);
  const tmp = join(dirname(path), `.security-gate-${randomUUID()}.tmp`);
  const file = await open(tmp, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(state)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tmp, path);
}

export async function epochMatches(pool: Pool, expected: string): Promise<boolean> {
  try {
    const result = await pool.query<{ epoch: string }>(
      'SELECT epoch FROM security_epoch WHERE singleton=true',
    );
    return result.rows.length === 1 && result.rows[0]?.epoch === expected;
  } catch {
    return false;
  }
}

export async function gateAllowsTraffic(pool: Pool, path: string): Promise<boolean> {
  try {
    const state = await readGate(path);
    if (state.phase !== 'open' || !(await epochMatches(pool, state.epoch))) return false;
    if (!state.nonce) return true;
    const result = await pool.query<{ epoch: string; nonce: string; same_database: boolean }>(
      `SELECT epoch::text,nonce::text,
        database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AS same_database
       FROM geops_maintenance_marker WHERE singleton=true`,
    );
    return (
      result.rows[0]?.epoch === state.epoch &&
      result.rows[0]?.nonce === state.nonce &&
      result.rows[0]?.same_database === true
    );
  } catch {
    return false;
  }
}

/** Closing advances the external epoch first; old backups can no longer match it. */
export async function closeGate(path: string): Promise<GateState> {
  const previous = await readGate(path);
  if (previous.phase === 'closed') return previous;
  const next: GateState = { version: 1, phase: 'closed', epoch: randomUUID() };
  await writeGate(path, next);
  await recordGateEvent(path, 'restore.close', next.epoch);
  return next;
}

/** Recreates only a CLOSED gate when the independent volume was lost. Never opens traffic. */
export async function recoverMissingGate(
  pool: Pool,
  path: string,
  databaseName: string,
): Promise<void> {
  gatePath(path);
  if (!/^geops_verify_[0-9]+_restore$/.test(databaseName) || !(await checkReadiness(pool)))
    throw new Error('Isolated synthetic restore required');
  try {
    await lstat(path);
    throw new Error('External gate already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const result = await pool.query<{ current_database: string; others: number }>(
    'SELECT current_database(),(SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) AS others',
  );
  if (result.rows[0]?.current_database !== databaseName || result.rows[0]?.others !== 0)
    throw new Error('Restored database must be isolated');
  const state: GateState = { version: 1, phase: 'closed', epoch: randomUUID() };
  await writeGate(path, state);
  await recordGateEvent(path, 'restore.recover_missing_gate', state.epoch);
}
export async function initializeFreshGate(pool: Pool, path: string): Promise<void> {
  gatePath(path);
  if (!(await checkReadiness(pool))) throw new Error('Migrations are not ready');
  try {
    await lstat(path);
    throw new Error('External gate already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(350019)');
    const result = await client.query<{ n: number }>(
      'SELECT (SELECT count(*)::int FROM admin_user)+(SELECT count(*)::int FROM geops_device)+(SELECT count(*)::int FROM security_epoch) AS n',
    );
    if (result.rows[0]?.n !== 0) throw new Error('Fresh gate requires empty identity database');
    const state: GateState = { version: 1, phase: 'closed', epoch: randomUUID() };
    await writeGate(path, state);
    await client.query('INSERT INTO security_epoch(singleton,epoch) VALUES(true,$1)', [
      state.epoch,
    ]);
    await client.query('COMMIT');
    await recordGateEvent(path, 'fresh.initialize', state.epoch);
    await writeGate(path, { ...state, phase: 'open' });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function verifyForReopen(pool: Pool, path: string): Promise<boolean> {
  try {
    const gate = await readGate(path);
    if (gate.phase !== 'closed' || !(await checkReadiness(pool))) return false;
    const result = await pool.query<{
      epoch: string;
      quarantine_id: string | null;
      active_devices: number;
      active_keys: number;
      active_sessions: number;
      active_bindings: number;
      active_claims: number;
      pending_challenges: number;
      legacy_recovery: number;
      quarantine_events: number;
      active_admins: number;
      active_admin_sessions: number;
      pending_invites: number;
      active_grants: number;
      active_custodians: number;
      pending_recovery: number;
      pending_admin_invitations: number;
      active_admin_permissions: number;
      active_data_grants: number;
      active_health_grants: number;
      other_connections: number;
    }>(`SELECT e.epoch,e.quarantine_id,
      (SELECT count(*)::int FROM geops_device WHERE status='ACTIVE') AS active_devices,
      (SELECT count(*)::int FROM device_key WHERE status='ACTIVE') AS active_keys,
      (SELECT count(*)::int FROM device_session WHERE revoked_at IS NULL) AS active_sessions,
      (SELECT count(*)::int FROM mdm_binding WHERE state='ACTIVE') AS active_bindings,
      (SELECT count(*)::int FROM enrollment_claim WHERE status IN ('CLAIMED','PENDING_CONFIRMATION')) AS active_claims,
      (SELECT count(*)::int FROM device_challenge WHERE consumed_at IS NULL AND expires_at>now()) AS pending_challenges,
      (SELECT count(*)::int FROM admin_recovery WHERE consumed_at IS NULL AND expires_at>now()) AS legacy_recovery,
      (SELECT count(*)::int FROM audit_event WHERE action='restore.quarantine.synthetic') AS quarantine_events,
      (SELECT count(*)::int FROM admin_user WHERE state='ACTIVE') AS active_admins,
      (SELECT count(*)::int FROM admin_session WHERE revoked_at IS NULL) AS active_admin_sessions,
      (SELECT count(*)::int FROM device_invitation WHERE status IN ('ISSUED','CLAIMED')) AS pending_invites,
      (SELECT count(*)::int FROM mdm_integration WHERE status<>'DISCONNECTED') AS active_grants,
      (SELECT count(*)::int FROM recovery_custodian WHERE state='ACTIVE') AS active_custodians,
      (SELECT count(*)::int FROM recovery_request WHERE status IN ('PENDING','AUTHORIZED')) AS pending_recovery,
      (SELECT count(*)::int FROM admin_user_invitation WHERE consumed_at IS NULL AND expires_at>now()) AS pending_admin_invitations,
      (SELECT count(*)::int FROM admin_permission WHERE revoked_at IS NULL) AS active_admin_permissions,
      (SELECT count(*)::int FROM gps_data_tenant_access WHERE revoked_at IS NULL) AS active_data_grants,
      (SELECT count(*)::int FROM gps_health_tenant_access WHERE revoked_at IS NULL) AS active_health_grants,
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) AS other_connections
      FROM security_epoch e WHERE e.singleton=true`);
    const row = result.rows[0];
    return (
      !!row &&
      row.epoch === gate.epoch &&
      row.quarantine_id !== null &&
      row.active_devices === 0 &&
      row.active_keys === 0 &&
      row.active_sessions === 0 &&
      row.active_bindings === 0 &&
      row.active_claims === 0 &&
      row.pending_challenges === 0 &&
      row.legacy_recovery === 0 &&
      row.quarantine_events > 0 &&
      row.active_admins === 0 &&
      row.active_admin_sessions === 0 &&
      row.pending_invites === 0 &&
      row.active_grants === 0 &&
      row.active_custodians === 0 &&
      row.pending_recovery === 0 &&
      row.pending_admin_invitations === 0 &&
      row.active_admin_permissions === 0 &&
      row.active_data_grants === 0 &&
      row.active_health_grants === 0 &&
      row.other_connections === 0
    );
  } catch {
    return false;
  }
}

export interface ReopenAuthorization {
  databaseName: string;
  epoch: string;
}

/** A human must authorize the exact isolated destination and external epoch after verification. */
export async function openGateAfterQuarantine(
  pool: Pool,
  path: string,
  authorization?: ReopenAuthorization,
): Promise<void> {
  const state = await readGate(path);
  if (
    !authorization ||
    !/^geops_verify_[0-9]+_restore$/.test(authorization.databaseName) ||
    authorization.epoch !== state.epoch ||
    state.phase !== 'closed'
  )
    throw new Error('Explicit restore reopen authorization required');
  const target = await pool.query<{ name: string }>('SELECT current_database() AS name');
  if (target.rows[0]?.name !== authorization.databaseName || !(await verifyForReopen(pool, path)))
    throw new Error('Restore verification failed');
  const latest = await readGate(path);
  if (latest.phase !== 'closed' || latest.epoch !== authorization.epoch)
    throw new Error('External security epoch changed');
  await recordGateEvent(path, 'restore.reopen_authorized', state.epoch);
  await writeGate(path, { ...state, phase: 'open' });
}
