import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { checkReadiness } from './migration-manager.js';
import { readGate, recordGateEvent, writeGate } from './restore-gate.js';

const TARGET = /^(geops_dev|geops_verify_[0-9]+)$/;

async function identity(
  db: PoolClient,
  expectedTarget: string,
  expectedEpoch: string,
): Promise<void> {
  if (!TARGET.test(expectedTarget)) throw new Error('Maintenance target invalid');
  const result = await db.query<{ name: string; epoch: string; others: number }>(
    `SELECT current_database() AS name,e.epoch::text,
      (SELECT count(*)::int FROM pg_stat_activity
       WHERE datname=current_database() AND pid<>pg_backend_pid()
         AND backend_type <> 'autovacuum worker') AS others
     FROM security_epoch e WHERE e.singleton=true`,
  );
  const row = result.rows[0];
  if (row?.name !== expectedTarget || row.epoch !== expectedEpoch || row.others !== 0)
    throw new Error('Maintenance database is not isolated or epoch differs');
}

/** Closes traffic without rotating the restore epoch. A marker created after closure prevents reopening an older backup. */
export async function beginMaintenance(
  pool: Pool,
  path: string,
  target: string,
  expectedEpoch: string,
): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(350020)');
    const gate = await readGate(path);
    if (gate.phase !== 'open' || gate.epoch !== expectedEpoch)
      throw new Error('Open gate and exact epoch required');
    await identity(db, target, expectedEpoch);
    if (gate.nonce) {
      const previous = await db.query<{ nonce: string; same_database: boolean }>(
        `SELECT nonce::text,
          database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AS same_database
         FROM geops_maintenance_marker WHERE singleton=true`,
      );
      if (previous.rows[0]?.nonce !== gate.nonce || previous.rows[0]?.same_database !== true)
        throw new Error('Open gate is not bound to this database');
    }
    const nonce = randomUUID();
    await db.query(
      'CREATE TABLE IF NOT EXISTS geops_maintenance_marker (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), epoch uuid NOT NULL, nonce uuid NOT NULL, database_oid oid NOT NULL, started_at timestamptz NOT NULL DEFAULT now())',
    );
    await db.query(
      `INSERT INTO geops_maintenance_marker(singleton,epoch,nonce,database_oid)
       SELECT true,$1,$2,oid FROM pg_database WHERE datname=current_database()
       ON CONFLICT (singleton) DO UPDATE SET epoch=EXCLUDED.epoch,nonce=EXCLUDED.nonce,database_oid=EXCLUDED.database_oid,started_at=now()`,
      [expectedEpoch, nonce],
    );
    await writeGate(path, { version: 1, phase: 'maintenance', epoch: expectedEpoch, nonce });
    await db.query('COMMIT');
    await recordGateEvent(path, 'maintenance.begin', expectedEpoch);
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

export async function verifyMaintenance(
  pool: Pool,
  path: string,
  target: string,
  expectedEpoch: string,
): Promise<boolean> {
  try {
    const gate = await readGate(path);
    if (gate.phase !== 'maintenance' || gate.epoch !== expectedEpoch) return false;
    const db = await pool.connect();
    try {
      await identity(db, target, expectedEpoch);
      const marker = await db.query<{ epoch: string; nonce: string; same_database: boolean }>(
        `SELECT epoch::text,nonce::text,
          database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AS same_database
         FROM geops_maintenance_marker WHERE singleton=true`,
      );
      return (
        marker.rows[0]?.epoch === gate.epoch &&
        marker.rows[0]?.nonce === gate.nonce &&
        marker.rows[0]?.same_database === true
      );
    } finally {
      db.release();
    }
  } catch {
    return false;
  }
}

/** Reopens only the same database/epoch with a matching post-closure marker and all migrations ready. */
export async function finishMaintenance(
  pool: Pool,
  path: string,
  target: string,
  expectedEpoch: string,
): Promise<void> {
  if (
    !(await verifyMaintenance(pool, path, target, expectedEpoch)) ||
    !(await checkReadiness(pool))
  )
    throw new Error('Maintenance verification failed');
  const gate = await readGate(path);
  if (
    gate.phase !== 'maintenance' ||
    gate.epoch !== expectedEpoch ||
    !(await verifyMaintenance(pool, path, target, expectedEpoch))
  )
    throw new Error('Maintenance state changed');
  await recordGateEvent(path, 'maintenance.finish', expectedEpoch);
  await writeGate(path, { version: 1, phase: 'open', epoch: expectedEpoch, nonce: gate.nonce });
}
