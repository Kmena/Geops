import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';

export interface Migration {
  version: string;
  sql: string;
  checksum: string;
}

const migrationsUrl = new URL('./migrations/', import.meta.url);

export async function loadMigrations(): Promise<Migration[]> {
  const files = (await readdir(migrationsUrl))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (files.length === 0) {
    throw new Error('No migrations found');
  }
  return Promise.all(
    files.map(async (version) => {
      const sql = await readFile(new URL(version, migrationsUrl), 'utf8');
      return { version, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    }),
  );
}

async function ensureVersionTable(client: PoolClient): Promise<void> {
  await client.query(
    'CREATE TABLE IF NOT EXISTS geops_schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  );
}

export async function applyMigrations(pool: Pool): Promise<string[]> {
  const migrations = await loadMigrations();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(350001)');
    await ensureVersionTable(client);
    const rows = await client.query<{ version: string; checksum: string }>(
      'SELECT version, checksum FROM geops_schema_migrations',
    );
    const existing = new Map(rows.rows.map((row) => [row.version, row.checksum]));
    if (
      [...existing.keys()].some((version) => !migrations.some((item) => item.version === version))
    )
      throw new Error('Unknown migration version');
    for (const migration of migrations) {
      const checksum = existing.get(migration.version);
      if (checksum !== undefined) {
        if (checksum !== migration.checksum) {
          throw new Error('Migration checksum mismatch');
        }
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO geops_schema_migrations (version, checksum) VALUES ($1, $2)',
        [migration.version, migration.checksum],
      );
      applied.push(migration.version);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function checkReadiness(pool: Pool): Promise<boolean> {
  try {
    const expected = await loadMigrations();
    const result = await pool.query<{ version: string; checksum: string; postgis: string }>(
      'SELECT m.version, m.checksum, PostGIS_Version() AS postgis FROM geops_schema_migrations m',
    );
    const actual = new Map(result.rows.map((row) => [row.version, row.checksum]));
    return (
      actual.size === expected.length &&
      expected.every((migration) => actual.get(migration.version) === migration.checksum)
    );
  } catch {
    return false;
  }
}
