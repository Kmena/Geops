import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from '../audit/index.js';
import { guardClient } from '../db/client-guard.js';
import { ApiError } from '../errors.js';
import { HARD_LIMITS, KmzParseError, parseKmz, type ParseResult } from './parser.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{8,160}$/;
type SessionRow = {
  id: string;
  sha256: string;
  file_name: string;
  state: string;
  created_by: string;
  compressed_bytes: string;
  expanded_bytes: string;
  record_count: number;
  summary: Record<string, number>;
  warnings: string[];
  errors: string[];
  created_at: Date;
  expires_at: Date;
  review_of: string | null;
  processing_token: string | null;
  processing_started_at: Date | null;
  purged_at: Date | null;
};

function assertId(id: string): void {
  if (!UUID.test(id)) throw new ApiError(422, 'invalid_request', 'Invalid request');
}
function parsePage(
  query: Record<string, unknown>,
  allowed: string[],
): { cursor: number; limit: number } {
  if (Object.keys(query).some((key) => !allowed.includes(key)))
    throw new ApiError(422, 'invalid_request', 'Invalid request');
  const limit = query.limit === undefined ? 25 : Number(query.limit);
  const cursor = query.cursor === undefined ? -1 : Number(query.cursor);
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(cursor) ||
    cursor < -1
  )
    throw new ApiError(422, 'invalid_request', 'Invalid request');
  return { cursor, limit };
}
function sessionBody(row: SessionRow): Record<string, unknown> {
  return {
    import_id: row.id,
    state:
      row.purged_at || new Date(row.expires_at).getTime() <= Date.now()
        ? 'EXPIRED'
        : row.state === 'PROCESSING' &&
            (!row.processing_started_at ||
              Date.now() - new Date(row.processing_started_at).getTime() > 5 * 60_000)
          ? 'FAILED'
          : row.state,
    sha256: row.sha256,
    file_name: row.file_name,
    compressed_bytes: Number(row.compressed_bytes),
    expanded_bytes: Number(row.expanded_bytes),
    record_count: row.record_count,
    summary: row.summary,
    warnings: row.warnings,
    errors: row.errors,
    review_of: row.review_of,
    created_at: row.created_at,
    expires_at: row.expires_at,
    status_url: `/v1/admin/kmz-imports/${row.id}`,
  };
}

export class KmzService {
  private active = 0;
  constructor(private readonly pool: Pool) {}

  private assertStagingAvailable(row: SessionRow): void {
    if (row.purged_at || new Date(row.expires_at).getTime() <= Date.now())
      throw new ApiError(410, 'import_expired', 'Import expired');
  }

  async authorize(
    actorId: string,
    capability: 'catalog.import.read' | 'catalog.import.write' | 'catalog.import.confirm',
    requestId: string,
  ): Promise<void> {
    const found = await this.pool.query(
      'SELECT 1 FROM admin_user u JOIN admin_permission p ON p.admin_id=u.id ' +
        'AND p.permission=$2 AND p.revoked_at IS NULL ' +
        'JOIN gps_data_tenant_access a ON a.admin_id=u.id AND a.revoked_at IS NULL ' +
        'JOIN geops_operating_tenant t ON t.singleton=true AND t.tenant_id=a.tenant_id ' +
        'WHERE u.id=$1 AND u.state=$3',
      [actorId, capability, 'ACTIVE'],
    );
    if (found.rowCount) return;
    try {
      await appendAudit(this.pool, {
        actorType: 'ADMIN',
        actorId,
        action: 'kmz.access.denied',
        outcome: 'rejected',
        correlationId: requestId,
        metadata: { capability },
      });
    } catch {
      throw new ApiError(503, 'kmz_audit_unavailable', 'Service unavailable');
    }
    throw new ApiError(403, 'catalog_forbidden', 'Forbidden');
  }

  private async streamedFile(
    stream: Readable,
    path: string,
  ): Promise<{ sha256: string; bytes: number }> {
    const file = await open(path, 'wx', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    const start = Date.now();
    try {
      for await (const item of stream) {
        const chunk = Buffer.isBuffer(item) ? item : Buffer.from(item as Uint8Array);
        bytes += chunk.length;
        if (bytes > HARD_LIMITS.compressedBytes)
          throw new ApiError(413, 'file_too_large', 'File too large');
        if (Date.now() - start > HARD_LIMITS.elapsedMs)
          throw new ApiError(408, 'upload_timeout', 'Upload timeout');
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const written = await file.write(chunk, offset, chunk.length - offset);
          offset += written.bytesWritten;
        }
      }
    } finally {
      await file.close();
    }
    if (bytes < 4) throw new ApiError(400, 'invalid_kmz', 'Invalid KMZ');
    const magic = Buffer.alloc(4);
    const check = await open(path, 'r');
    try {
      await check.read(magic, 0, 4, 0);
    } finally {
      await check.close();
    }
    if (!magic.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
      throw new ApiError(400, 'invalid_kmz', 'Invalid KMZ');
    return { sha256: hash.digest('hex'), bytes };
  }

  private async beginSession(
    actorId: string,
    key: string,
    hash: string,
    name: string,
    bytes: number,
    newReview: boolean,
    content: Buffer,
  ): Promise<{ row: SessionRow; reused: boolean }> {
    const db = await this.pool.connect();
    const release = guardClient(db);
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [actorId, hash]);
      const existingKey = await db.query<SessionRow>(
        'SELECT * FROM kmz_import_session WHERE created_by=$1 AND idempotency_key=$2 FOR UPDATE',
        [actorId, key],
      );
      const keyRow = existingKey.rows[0];
      if (keyRow) {
        if (keyRow.sha256 !== hash) throw new ApiError(409, 'idempotency_conflict', 'Conflict');
        if (keyRow.purged_at || new Date(keyRow.expires_at).getTime() <= Date.now())
          throw new ApiError(410, 'import_expired', 'Import expired');
        if (
          keyRow.state === 'FAILED' ||
          (keyRow.state === 'PROCESSING' &&
            (!keyRow.processing_started_at ||
              Date.now() - new Date(keyRow.processing_started_at).getTime() > 5 * 60_000))
        ) {
          const remaining = await db.query<{ count: number }>(
            'SELECT count(*)::int AS count FROM kmz_import_record WHERE import_id=$1',
            [keyRow.id],
          );
          if (remaining.rows[0]?.count)
            throw new ApiError(409, 'staging_recovery_conflict', 'Conflict');
          const token = randomUUID();
          await db.query('UPDATE kmz_import_file SET content=$2 WHERE import_id=$1', [
            keyRow.id,
            content,
          ]);
          const recovered = await db.query<SessionRow>(
            "UPDATE kmz_import_session SET state='PROCESSING',processing_token=$2,processing_started_at=now(),expanded_bytes=0,record_count=0,summary='{}'::jsonb,errors='[]'::jsonb WHERE id=$1 RETURNING *",
            [keyRow.id, token],
          );
          const recoveredRow = recovered.rows[0];
          if (!recoveredRow) throw new Error('KMZ session recovery failed');
          await db.query('COMMIT');
          return { row: recoveredRow, reused: false };
        }
        await db.query('COMMIT');
        return { row: keyRow, reused: true };
      }
      const previous = await db.query<SessionRow>(
        "SELECT * FROM kmz_import_session WHERE created_by=$1 AND sha256=$2 AND purged_at IS NULL AND expires_at>now() AND (state='READY' OR (state='PROCESSING' AND processing_started_at>now()-interval '5 minutes')) ORDER BY created_at DESC LIMIT 1",
        [actorId, hash],
      );
      const prior = previous.rows[0];
      if (prior && !newReview) {
        await db.query('COMMIT');
        return { row: prior, reused: true };
      }
      const id = randomUUID();
      const inserted = await db.query<SessionRow>(
        "INSERT INTO kmz_import_session(id,created_by,idempotency_key,sha256,file_name,compressed_bytes,state,expires_at,review_of,processing_token,processing_started_at) VALUES($1,$2,$3,$4,$5,$6,'PROCESSING',now()+interval '30 days',$7,$8,now()) RETURNING *",
        [id, actorId, key, hash, name, bytes, prior?.id ?? null, randomUUID()],
      );
      await db.query('INSERT INTO kmz_import_file(import_id,content) VALUES($1,$2)', [id, content]);
      await db.query('COMMIT');
      const row = inserted.rows[0];
      if (!row) throw new Error('KMZ session insert failed');
      return { row, reused: false };
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      release();
    }
  }

  private async finishSession(
    row: SessionRow,
    actorId: string,
    requestId: string,
    parsed: ParseResult | null,
    errorCode: string | null,
  ): Promise<SessionRow> {
    const db: PoolClient = await this.pool.connect();
    const release = guardClient(db);
    try {
      await db.query('BEGIN');
      const current = await db.query<{
        processing_token: string | null;
        state: string;
        purged_at: Date | null;
      }>('SELECT processing_token,state,purged_at FROM kmz_import_session WHERE id=$1 FOR UPDATE', [
        row.id,
      ]);
      if (
        current.rows[0]?.state !== 'PROCESSING' ||
        current.rows[0]?.processing_token !== row.processing_token ||
        current.rows[0]?.purged_at
      )
        throw new ApiError(409, 'staging_attempt_superseded', 'Conflict');
      if (parsed) {
        for (const record of parsed.records) {
          if (record.geometry && record.errors.length === 0) {
            const shapes =
              record.geometry.type === 'MultiGeometry'
                ? (record.geometry.geometries as Record<string, unknown>[])
                : [record.geometry];
            for (const shape of shapes) {
              if (shape.type !== 'Polygon') continue;
              const topology = await db.query<{ valid: boolean }>(
                'SELECT ST_IsValid(ST_GeomFromGeoJSON($1::text)) AS valid',
                [JSON.stringify(shape)],
              );
              if (topology.rows[0]?.valid === false) {
                record.errors.push('INVALID_TOPOLOGY');
                parsed.summary.error_records = (parsed.summary.error_records ?? 0) + 1;
                break;
              }
            }
          }
          await db.query(
            'INSERT INTO kmz_import_record(id,import_id,ordinal,source_path,parent_path,source_kind,week_label,original,normalized,geometry,warnings,errors) ' +
              'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
            [
              randomUUID(),
              row.id,
              record.ordinal,
              record.sourcePath,
              record.parentPath,
              record.sourceKind,
              record.weekLabel,
              JSON.stringify(record.original),
              JSON.stringify(record.normalized),
              JSON.stringify(record.geometry),
              JSON.stringify(record.warnings),
              JSON.stringify(record.errors),
            ],
          );
        }
      }
      const changed = await db.query<SessionRow>(
        'UPDATE kmz_import_session SET state=$2,processing_token=NULL,processing_started_at=NULL,expanded_bytes=$3,record_count=$4,summary=$5,errors=$6 WHERE id=$1 RETURNING *',
        [
          row.id,
          parsed ? 'READY' : 'FAILED',
          parsed?.expandedBytes ?? 0,
          parsed?.records.length ?? 0,
          JSON.stringify(
            parsed
              ? {
                  ...parsed.summary,
                  zip_entries: parsed.entries,
                  parse_cpu_ms: Math.round(parsed.cpuMs),
                  parse_elapsed_ms: Math.round(parsed.elapsedMs),
                  peak_rss_bytes: parsed.peakRssBytes,
                }
              : {},
          ),
          JSON.stringify(errorCode ? [errorCode] : []),
        ],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId,
        action: 'kmz.upload',
        outcome: parsed ? 'success' : 'failure',
        correlationId: requestId,
        metadata: {
          import_id: row.id,
          state: parsed ? 'READY' : 'FAILED',
          record_count: parsed?.records.length ?? 0,
          error_code: errorCode ?? '',
        },
      });
      await db.query('COMMIT');
      const finished = changed.rows[0];
      if (!finished) throw new Error('KMZ session update failed');
      return finished;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      release();
    }
  }

  async upload(
    stream: Readable,
    actorId: string,
    key: string | undefined,
    fileName: string | undefined,
    newReview: boolean,
    requestId: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    if (!key || !KEY.test(key))
      throw new ApiError(422, 'invalid_idempotency_key', 'Invalid request');
    if (!fileName || !/^[^\\/\0]{1,240}\.kmz$/i.test(fileName))
      throw new ApiError(422, 'invalid_file_name', 'Invalid request');
    if (this.active >= 2) throw new ApiError(429, 'kmz_busy', 'Too many uploads');
    this.active++;
    let dir: string;
    try {
      dir = await mkdtemp(join(tmpdir(), 'geops-kmz-'));
    } catch (error) {
      this.active--;
      throw error;
    }
    const path = join(dir, 'upload.kmz');
    try {
      const file = await this.streamedFile(stream, path);
      const pending = await this.beginSession(
        actorId,
        key,
        file.sha256,
        fileName,
        file.bytes,
        newReview,
        await readFile(path),
      );
      if (pending.reused) return { status: 200, body: sessionBody(pending.row) };
      let parsed: ParseResult | null = null;
      let errorCode: string | null = null;
      try {
        parsed = await parseKmz(path);
      } catch (error) {
        errorCode = error instanceof KmzParseError ? error.code : 'INVALID_KMZ';
      }
      let finished: SessionRow;
      try {
        finished = await this.finishSession(pending.row, actorId, requestId, parsed, errorCode);
      } catch {
        if (parsed) {
          try {
            await this.finishSession(pending.row, actorId, requestId, null, 'PERSISTENCE_FAILED');
          } catch {
            // The session remains PROCESSING for recovery if the database itself is unavailable.
          }
        }
        throw new ApiError(503, 'kmz_staging_unavailable', 'Service unavailable');
      }
      return { status: parsed ? 202 : 422, body: sessionBody(finished) };
    } finally {
      this.active--;
      if (dirname(resolve(dir)) === resolve(tmpdir()) && basename(dir).startsWith('geops-kmz-'))
        await rm(dir, { recursive: true, force: true });
      else process.stderr.write('GEOPS KMZ temporary path check failed\n');
    }
  }

  async list(actorId: string, query: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (Object.keys(query).some((key) => !['cursor', 'limit'].includes(key)))
      throw new ApiError(422, 'invalid_request', 'Invalid request');
    const limit = query.limit === undefined ? 25 : Number(query.limit);
    const cursor = query.cursor === undefined ? null : String(query.cursor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor && !UUID.test(cursor)))
      throw new ApiError(422, 'invalid_request', 'Invalid request');
    const result = await this.pool.query<SessionRow>(
      'SELECT * FROM kmz_import_session WHERE created_by=$1 ' +
        'AND ($2::uuid IS NULL OR (created_at,id) < ' +
        '(SELECT created_at,id FROM kmz_import_session WHERE id=$2 AND created_by=$1)) ' +
        'ORDER BY created_at DESC,id DESC LIMIT $3',
      [actorId, cursor, limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map(sessionBody),
      next_cursor: result.rows.length > limit ? rows.at(-1)?.id : null,
    };
  }

  async get(actorId: string, id: string): Promise<SessionRow> {
    assertId(id);
    const found = await this.pool.query<SessionRow>(
      'SELECT * FROM kmz_import_session WHERE id=$1 AND created_by=$2',
      [id, actorId],
    );
    const row = found.rows[0];
    if (!row) throw new ApiError(404, 'import_missing', 'Not found');
    return row;
  }
  async status(actorId: string, id: string): Promise<Record<string, unknown>> {
    return sessionBody(await this.get(actorId, id));
  }
  async records(
    actorId: string,
    id: string,
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.assertStagingAvailable(await this.get(actorId, id));
    const { cursor, limit } = parsePage(query, ['cursor', 'limit', 'kind', 'warning', 'search']);
    const kind = typeof query.kind === 'string' ? query.kind : null;
    const warning = typeof query.warning === 'string' ? query.warning : null;
    const search = typeof query.search === 'string' ? query.search : null;
    if (
      (kind && kind.length > 40) ||
      (warning && warning.length > 60) ||
      (search && search.length > 120)
    )
      throw new ApiError(422, 'invalid_request', 'Invalid request');
    const result = await this.pool.query<{
      id: string;
      ordinal: number;
      source_path: string;
      parent_path: string | null;
      source_kind: string;
      week_label: string | null;
      normalized: Record<string, unknown>;
      warnings: string[];
      errors: string[];
    }>(
      'SELECT id,ordinal,source_path,parent_path,source_kind,week_label,normalized,warnings,errors ' +
        'FROM kmz_import_record WHERE import_id=$1 AND ordinal>$2 ' +
        'AND ($3::text IS NULL OR source_kind=$3) ' +
        'AND ($4::text IS NULL OR warnings ? $4) ' +
        "AND ($5::text IS NULL OR normalized->>'name' ILIKE '%' || $5 || '%' OR normalized->>'code' ILIKE '%' || $5 || '%') " +
        'ORDER BY ordinal LIMIT $6',
      [id, cursor, kind, warning, search, limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    return { items: rows, next_cursor: result.rows.length > limit ? rows.at(-1)?.ordinal : null };
  }
  async record(actorId: string, id: string, recordId: string): Promise<Record<string, unknown>> {
    this.assertStagingAvailable(await this.get(actorId, id));
    assertId(recordId);
    const found = await this.pool.query<Record<string, unknown>>(
      'SELECT id,ordinal,source_path,parent_path,source_kind,week_label,original,normalized,geometry,warnings,errors ' +
        'FROM kmz_import_record WHERE import_id=$1 AND id=$2',
      [id, recordId],
    );
    const row = found.rows[0];
    if (!row) throw new ApiError(404, 'record_missing', 'Not found');
    const original = row.original as Record<string, unknown>;
    return {
      ...row,
      original: {
        ...original,
        description:
          typeof original.description === 'string'
            ? original.description.replace(/<[^>]*>/gu, '').slice(0, 2 * 1024 * 1024)
            : null,
      },
    };
  }
  async diagnostics(
    actorId: string,
    id: string,
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.assertStagingAvailable(await this.get(actorId, id));
    const { cursor, limit } = parsePage(query, ['cursor', 'limit']);
    const result = await this.pool.query<{
      id: string;
      ordinal: number;
      source_path: string;
      warnings: string[];
      errors: string[];
    }>(
      "SELECT id,ordinal,source_path,warnings,errors FROM kmz_import_record WHERE import_id=$1 AND ordinal>$2 AND (warnings <> '[]'::jsonb OR errors <> '[]'::jsonb) ORDER BY ordinal LIMIT $3",
      [id, cursor, limit + 1],
    );
    const rows = result.rows.slice(0, limit);
    return { items: rows, next_cursor: result.rows.length > limit ? rows.at(-1)?.ordinal : null };
  }
}
