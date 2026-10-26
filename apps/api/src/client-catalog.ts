import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from './audit/index.js';
import { ApiError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;
type Json = Record<string, unknown>;
type Context = {
  actorId: string;
  requestId: string;
  key: string;
  method: string;
  path: string;
  ifMatch?: string;
};
type Result = { status: number; body: Json; etag?: string };
export type CatalogLimits = { max_radius_m: number; max_dwell_s: number };
export function catalogLimits(env: NodeJS.ProcessEnv): CatalogLimits {
  const radius =
    env.GEOPS_CATALOG_MAX_RADIUS_M === undefined ? 100000 : Number(env.GEOPS_CATALOG_MAX_RADIUS_M);
  const dwell =
    env.GEOPS_CATALOG_MAX_DWELL_S === undefined ? 86400 : Number(env.GEOPS_CATALOG_MAX_DWELL_S);
  if (
    !Number.isFinite(radius) ||
    radius <= 0 ||
    radius > 100000 ||
    !Number.isInteger(dwell) ||
    dwell < 60 ||
    dwell > 86400
  )
    throw new Error('Invalid catalog limits');
  return { max_radius_m: radius, max_dwell_s: dwell };
}
const invalid = () => new ApiError(422, 'invalid_request', 'Invalid request');
const missing = () => new ApiError(404, 'not_found', 'Not found');
const etag = (version: number) => `"${version}"`;

function object(input: unknown, allowed: string[], required: string[] = []): Json {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const value = input as Json;
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    required.some((key) => !(key in value))
  )
    throw invalid();
  return value;
}
function label(input: unknown, max: number): string {
  if (typeof input !== 'string' || !input.trim() || input.trim().length > max) throw invalid();
  return input.trim();
}
function code(input: unknown): string {
  const value = label(input, 40).toUpperCase();
  if (!CODE.test(value)) throw invalid();
  return value;
}
function state(input: unknown): 'ACTIVE' | 'INACTIVE' {
  if (input !== 'ACTIVE' && input !== 'INACTIVE') throw invalid();
  return input;
}
function point(latitude: unknown, longitude: unknown): { latitude: number; longitude: number } {
  if (
    typeof latitude !== 'number' ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== 'number' ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  )
    throw invalid();
  return { latitude, longitude };
}
function id(value: string): string {
  if (!UUID.test(value)) throw invalid();
  return value;
}
function cursor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > 200) throw invalid();
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'string' || !CODE.test(parsed)) throw invalid();
    return parsed;
  } catch {
    throw invalid();
  }
}
function revisionCursor(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value.length > 100) throw invalid();
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 1) throw invalid();
    return parsed;
  } catch {
    throw invalid();
  }
}
function page(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
  return limit;
}
function match(expected: string | undefined, actual: number): void {
  if (!expected) throw new ApiError(428, 'precondition_required', 'Precondition required');
  if (expected !== etag(actual)) throw new ApiError(412, 'stale_version', 'Precondition failed');
}
function siteFields(value: Json): {
  code: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
} {
  const center = point(value.latitude, value.longitude);
  return {
    code: code(value.code),
    name: label(value.name, 160),
    address: label(value.address, 300),
    ...center,
  };
}
function cleanRow(row: Json): Json {
  const coordinate = (value: unknown) =>
    value === null || value === undefined ? null : Number(Number(value).toFixed(6));
  return {
    ...row,
    version: row.version === undefined ? undefined : Number(row.version),
    revision: row.revision === undefined ? undefined : Number(row.revision),
    latitude: coordinate(row.latitude),
    longitude: coordinate(row.longitude),
    radius_m: row.radius_m === undefined ? undefined : Number(row.radius_m),
  };
}
function inserted(rows: Json[]): Json {
  const row = rows[0];
  if (!row) throw new Error('Catalog write did not return a row');
  return row;
}

export class ClientCatalogService {
  constructor(
    private readonly pool: Pool,
    private readonly limits: CatalogLimits = catalogLimits(process.env),
  ) {}

  private async access(db: PoolClient, actorId: string, write: boolean): Promise<string> {
    const result = await db.query<{ tenant_id: string }>(
      `SELECT t.tenant_id FROM geops_operating_tenant t
      JOIN admin_user u ON u.id=$1 AND u.state='ACTIVE'
      JOIN gps_data_tenant_access a ON a.admin_id=u.id AND a.tenant_id=t.tenant_id AND a.revoked_at IS NULL
      JOIN admin_permission p ON p.admin_id=u.id AND p.permission=$2 AND p.revoked_at IS NULL
      WHERE t.singleton=true`,
      [actorId, write ? 'visit.catalog.write' : 'visit.catalog.read'],
    );
    if (!result.rows[0]) throw new ApiError(403, 'catalog_forbidden', 'Forbidden');
    return result.rows[0].tenant_id;
  }

  async capabilities(actorId: string): Promise<{ capabilities: string[]; limits: CatalogLimits }> {
    const db = await this.pool.connect();
    try {
      const permissions: string[] = [];
      for (const permission of ['visit.catalog.read', 'visit.catalog.write']) {
        try {
          await this.access(db, actorId, permission.endsWith('write'));
          permissions.push(permission);
        } catch (error) {
          if (!(error instanceof ApiError && error.statusCode === 403)) throw error;
        }
      }
      return { capabilities: permissions, limits: this.limits };
    } finally {
      db.release();
    }
  }

  private async read<T>(
    actorId: string,
    run: (db: PoolClient, tenant: string) => Promise<T>,
  ): Promise<T> {
    const db = await this.pool.connect();
    try {
      return await run(db, await this.access(db, actorId, false));
    } finally {
      db.release();
    }
  }

  private async mutate(
    ctx: Context,
    payload: unknown,
    run: (db: PoolClient, tenant: string) => Promise<Result>,
  ): Promise<Result> {
    id(ctx.key);
    const db = await this.pool.connect();
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          method: ctx.method,
          path: ctx.path,
          payload,
          ifMatch: ctx.ifMatch ?? null,
        }),
      )
      .digest();
    try {
      await db.query('BEGIN');
      const tenant = await this.access(db, ctx.actorId, true);
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${ctx.actorId}:${ctx.key}`,
      ]);
      const prior = await db.query<{
        method: string;
        path: string;
        payload_digest: Buffer;
        response_status: number;
        response_body: Json;
      }>(
        'SELECT method,path,payload_digest,response_status,response_body FROM client_catalog_idempotency WHERE actor_id=$1 AND request_key=$2',
        [ctx.actorId, ctx.key],
      );
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (
          row.method !== ctx.method ||
          row.path !== ctx.path ||
          !row.payload_digest.equals(digest)
        )
          throw new ApiError(409, 'idempotency_conflict', 'Conflict');
        await db.query('COMMIT');
        const version = row.response_body.version ?? row.response_body.revision;
        return {
          status: row.response_status,
          body: row.response_body,
          ...(typeof version === 'number' ? { etag: etag(version) } : {}),
        };
      }
      const result = await run(db, tenant);
      await db.query(
        `INSERT INTO client_catalog_idempotency(actor_id,request_key,method,path,payload_digest,response_status,response_body)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          ctx.actorId,
          ctx.key,
          ctx.method,
          ctx.path,
          digest,
          result.status,
          JSON.stringify(result.body),
        ],
      );
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505')
        throw new ApiError(409, 'duplicate_code', 'Conflict');
      if ((error as { code?: string }).code === '23514') throw invalid();
      throw error;
    } finally {
      db.release();
    }
  }

  async listClients(
    actorId: string,
    query: { q?: string; state?: string; cursor?: string; limit: number },
  ): Promise<{ items: Json[]; next_cursor: string | null }> {
    const limit = page(query.limit);
    const after = cursor(query.cursor);
    if (query.state && query.state !== 'ACTIVE' && query.state !== 'INACTIVE') throw invalid();
    if (query.q && query.q.length > 120) throw invalid();
    return this.read(actorId, async (db, tenant) => {
      const rows = await db.query<Json>(
        `SELECT c.id,c.tenant_id,c.code,c.name,c.address,c.state,c.version,c.created_at,c.updated_at,
        s.id AS site_id, ST_Y(s.center::geometry) AS latitude, ST_X(s.center::geometry) AS longitude
        FROM client c LEFT JOIN LATERAL (SELECT id,center FROM client_site WHERE tenant_id=c.tenant_id AND client_id=c.id ORDER BY created_at,id LIMIT 1) s ON true
        WHERE c.tenant_id=$1 AND ($2::text IS NULL OR c.state=$2) AND ($3::text IS NULL OR c.code ILIKE '%'||$3||'%' OR c.name ILIKE '%'||$3||'%')
          AND ($4::text IS NULL OR c.code>$4) ORDER BY c.code LIMIT $5`,
        [tenant, query.state ?? null, query.q ?? null, after ?? null, limit + 1],
      );
      const hasMore = rows.rows.length > limit;
      const items = rows.rows.slice(0, limit).map(cleanRow);
      return {
        items,
        next_cursor: hasMore
          ? Buffer.from(JSON.stringify(items.at(-1)?.code)).toString('base64url')
          : null,
      };
    });
  }

  async getClient(actorId: string, clientId: string): Promise<Json> {
    return this.read(actorId, async (db, tenant) => {
      const rows = await db.query<Json>(
        `SELECT c.id,c.tenant_id,c.code,c.name,c.address,c.state,c.version,c.created_at,c.updated_at,
        s.id AS site_id,ST_Y(s.center::geometry) AS latitude,ST_X(s.center::geometry) AS longitude
        FROM client c LEFT JOIN LATERAL (SELECT id,center FROM client_site WHERE tenant_id=c.tenant_id AND client_id=c.id ORDER BY created_at,id LIMIT 1) s ON true
        WHERE c.tenant_id=$1 AND c.id=$2`,
        [tenant, id(clientId)],
      );
      if (!rows.rows[0]) throw missing();
      return cleanRow(rows.rows[0]);
    });
  }

  async createClient(ctx: Context, input: unknown): Promise<Result> {
    const body = object(
      input,
      ['code', 'name', 'address', 'site'],
      ['code', 'name', 'address', 'site'],
    );
    const site = object(
      body.site,
      ['code', 'name', 'address', 'latitude', 'longitude'],
      ['code', 'name', 'address', 'latitude', 'longitude'],
    );
    const clientCode = code(body.code),
      name = label(body.name, 160),
      address = label(body.address, 300),
      fields = siteFields(site);
    return this.mutate(ctx, body, async (db, tenant) => {
      const clientId = randomUUID(),
        siteId = randomUUID();
      await db.query(
        `INSERT INTO client(id,tenant_id,code,name,address,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6)`,
        [clientId, tenant, clientCode, name, address, ctx.actorId],
      );
      await db.query(
        `INSERT INTO client_site(id,tenant_id,client_id,code,name,address,center,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,ST_SetSRID(ST_MakePoint($7,$8),4326)::geography,$9,$9)`,
        [
          siteId,
          tenant,
          clientId,
          fields.code,
          fields.name,
          fields.address,
          fields.longitude,
          fields.latitude,
          ctx.actorId,
        ],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: ctx.actorId,
        action: 'client.create',
        outcome: 'success',
        correlationId: ctx.requestId,
        metadata: { tenant_id: tenant, client_id: clientId, site_id: siteId },
      });
      return {
        status: 201,
        body: {
          id: clientId,
          tenant_id: tenant,
          code: clientCode,
          name,
          address,
          state: 'ACTIVE',
          version: 1,
          site_id: siteId,
          latitude: fields.latitude,
          longitude: fields.longitude,
        },
        etag: etag(1),
      };
    });
  }

  async patchClient(ctx: Context, clientId: string, input: unknown): Promise<Result> {
    const body = object(input, ['code', 'name', 'address', 'state']);
    if (!Object.keys(body).length) throw invalid();
    const changes = {
      ...(body.code === undefined ? {} : { code: code(body.code) }),
      ...(body.name === undefined ? {} : { name: label(body.name, 160) }),
      ...(body.address === undefined ? {} : { address: label(body.address, 300) }),
      ...(body.state === undefined ? {} : { state: state(body.state) }),
    };
    return this.mutate(ctx, body, async (db, tenant) => {
      const rows = await db.query<Json>(
        'SELECT * FROM client WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [tenant, id(clientId)],
      );
      if (!rows.rows[0]) throw missing();
      match(ctx.ifMatch, Number(rows.rows[0].version));
      const row = rows.rows[0];
      const updated = await db.query<Json>(
        `UPDATE client SET code=$3,name=$4,address=$5,state=$6,version=version+1,updated_by=$7,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 RETURNING id,tenant_id,code,name,address,state,version,created_at,updated_at`,
        [
          tenant,
          clientId,
          changes.code ?? row.code,
          changes.name ?? row.name,
          changes.address ?? row.address,
          changes.state ?? row.state,
          ctx.actorId,
        ],
      );
      const saved = inserted(updated.rows);
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: ctx.actorId,
        action: 'client.update',
        outcome: 'success',
        correlationId: ctx.requestId,
        previousState: String(row.state),
        nextState: String(saved.state),
        metadata: { tenant_id: tenant, client_id: clientId, version: Number(saved.version) },
      });
      const result = cleanRow(saved);
      return { status: 200, body: result, etag: etag(Number(result.version)) };
    });
  }

  async listSites(
    actorId: string,
    clientId: string,
    after?: string,
    requestedLimit = 25,
  ): Promise<{ items: Json[]; next_cursor: string | null }> {
    const limit = page(requestedLimit),
      afterCode = cursor(after);
    return this.read(actorId, async (db, tenant) => {
      const client = await db.query('SELECT 1 FROM client WHERE tenant_id=$1 AND id=$2', [
        tenant,
        id(clientId),
      ]);
      if (!client.rowCount) throw missing();
      const rows = await db.query<Json>(
        `SELECT s.id,s.client_id,s.tenant_id,s.code,s.name,s.address,s.state,s.version,s.created_at,s.updated_at,
        ST_Y(s.center::geometry) AS latitude,ST_X(s.center::geometry) AS longitude FROM client_site s
        WHERE s.tenant_id=$1 AND s.client_id=$2 AND ($3::text IS NULL OR s.code>$3)
        ORDER BY s.code LIMIT $4`,
        [tenant, id(clientId), afterCode ?? null, limit + 1],
      );
      const hasMore = rows.rows.length > limit,
        items = rows.rows.slice(0, limit).map(cleanRow);
      return {
        items,
        next_cursor: hasMore
          ? Buffer.from(JSON.stringify(items.at(-1)?.code)).toString('base64url')
          : null,
      };
    });
  }
  async getSite(actorId: string, clientId: string, siteId: string): Promise<Json> {
    return this.read(actorId, async (db, tenant) => {
      const rows = await db.query<Json>(
        `SELECT s.id,s.client_id,s.tenant_id,s.code,s.name,s.address,s.state,s.version,s.created_at,s.updated_at,
        ST_Y(s.center::geometry) AS latitude,ST_X(s.center::geometry) AS longitude FROM client_site s
        WHERE s.tenant_id=$1 AND s.client_id=$2 AND s.id=$3`,
        [tenant, id(clientId), id(siteId)],
      );
      if (!rows.rows[0]) throw missing();
      return cleanRow(rows.rows[0]);
    });
  }
  async createSite(ctx: Context, clientId: string, input: unknown): Promise<Result> {
    const body = object(
      input,
      ['code', 'name', 'address', 'latitude', 'longitude'],
      ['code', 'name', 'address', 'latitude', 'longitude'],
    );
    const fields = siteFields(body);
    return this.mutate(ctx, body, async (db, tenant) => {
      const client = await db.query('SELECT 1 FROM client WHERE tenant_id=$1 AND id=$2', [
        tenant,
        id(clientId),
      ]);
      if (!client.rowCount) throw missing();
      const siteId = randomUUID();
      const rows = await db.query<Json>(
        `INSERT INTO client_site(id,tenant_id,client_id,code,name,address,center,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,ST_SetSRID(ST_MakePoint($7,$8),4326)::geography,$9,$9)
        RETURNING id,tenant_id,client_id,code,name,address,state,version,created_at,updated_at`,
        [
          siteId,
          tenant,
          clientId,
          fields.code,
          fields.name,
          fields.address,
          fields.longitude,
          fields.latitude,
          ctx.actorId,
        ],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: ctx.actorId,
        action: 'client.site.create',
        outcome: 'success',
        correlationId: ctx.requestId,
        metadata: { tenant_id: tenant, client_id: clientId, site_id: siteId },
      });
      return {
        status: 201,
        body: {
          ...cleanRow(inserted(rows.rows)),
          latitude: fields.latitude,
          longitude: fields.longitude,
        },
        etag: etag(1),
      };
    });
  }
  async patchSite(ctx: Context, clientId: string, siteId: string, input: unknown): Promise<Result> {
    const body = object(input, ['code', 'name', 'address', 'latitude', 'longitude', 'state']);
    if (
      !Object.keys(body).length ||
      (body.latitude === undefined) !== (body.longitude === undefined)
    )
      throw invalid();
    const changes = {
      ...(body.code === undefined ? {} : { code: code(body.code) }),
      ...(body.name === undefined ? {} : { name: label(body.name, 160) }),
      ...(body.address === undefined ? {} : { address: label(body.address, 300) }),
      ...(body.state === undefined ? {} : { state: state(body.state) }),
      ...(body.latitude === undefined ? {} : point(body.latitude, body.longitude)),
    };
    return this.mutate(ctx, body, async (db, tenant) => {
      const rows = await db.query<Json>(
        `SELECT *,ST_Y(center::geometry) AS latitude,ST_X(center::geometry) AS longitude FROM client_site
        WHERE tenant_id=$1 AND client_id=$2 AND id=$3 FOR UPDATE`,
        [tenant, id(clientId), id(siteId)],
      );
      if (!rows.rows[0]) throw missing();
      const row = rows.rows[0];
      match(ctx.ifMatch, Number(row.version));
      const latitude = changes.latitude ?? Number(row.latitude),
        longitude = changes.longitude ?? Number(row.longitude);
      const updated = await db.query<Json>(
        `UPDATE client_site SET code=$4,name=$5,address=$6,state=$7,
        center=ST_SetSRID(ST_MakePoint($8,$9),4326)::geography,version=version+1,updated_by=$10,updated_at=now()
        WHERE tenant_id=$1 AND client_id=$2 AND id=$3 RETURNING id,tenant_id,client_id,code,name,address,state,version,created_at,updated_at`,
        [
          tenant,
          clientId,
          siteId,
          changes.code ?? row.code,
          changes.name ?? row.name,
          changes.address ?? row.address,
          changes.state ?? row.state,
          longitude,
          latitude,
          ctx.actorId,
        ],
      );
      const saved = inserted(updated.rows);
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: ctx.actorId,
        action: 'client.site.update',
        outcome: 'success',
        correlationId: ctx.requestId,
        previousState: String(row.state),
        nextState: String(saved.state),
        metadata: {
          tenant_id: tenant,
          client_id: clientId,
          site_id: siteId,
          version: Number(saved.version),
        },
      });
      const result: Json = { ...cleanRow(saved), latitude, longitude };
      return { status: 200, body: result, etag: etag(Number(result.version)) };
    });
  }

  async listGeofences(
    actorId: string,
    clientId: string,
    siteId: string,
    after?: string,
    requestedLimit = 25,
  ): Promise<{ items: Json[]; next_cursor: string | null }> {
    const limit = page(requestedLimit),
      before = revisionCursor(after);
    return this.read(actorId, async (db, tenant) => {
      const site = await db.query(
        'SELECT 1 FROM client_site WHERE tenant_id=$1 AND client_id=$2 AND id=$3',
        [tenant, id(clientId), id(siteId)],
      );
      if (!site.rowCount) throw missing();
      const rows = await db.query<Json>(
        `SELECT revision,site_id,client_id,tenant_id,radius_m,min_dwell_s,state,reason,created_at,
        ST_Y(center::geometry) AS latitude,ST_X(center::geometry) AS longitude FROM client_geofence_revision
        WHERE tenant_id=$1 AND client_id=$2 AND site_id=$3 AND ($4::integer IS NULL OR revision<$4)
        ORDER BY revision DESC LIMIT $5`,
        [tenant, id(clientId), id(siteId), before ?? null, limit + 1],
      );
      const hasMore = rows.rows.length > limit,
        items = rows.rows.slice(0, limit).map(cleanRow);
      return {
        items,
        next_cursor: hasMore
          ? Buffer.from(JSON.stringify(items.at(-1)?.revision)).toString('base64url')
          : null,
      };
    });
  }
  async getGeofence(
    actorId: string,
    clientId: string,
    siteId: string,
    revision: number,
  ): Promise<Json> {
    if (!Number.isInteger(revision) || revision < 1) throw invalid();
    return this.read(actorId, async (db, tenant) => {
      const rows = await db.query<Json>(
        `SELECT revision,site_id,client_id,tenant_id,radius_m,min_dwell_s,state,reason,created_at,
        ST_Y(center::geometry) AS latitude,ST_X(center::geometry) AS longitude FROM client_geofence_revision
        WHERE tenant_id=$1 AND client_id=$2 AND site_id=$3 AND revision=$4`,
        [tenant, id(clientId), id(siteId), revision],
      );
      if (!rows.rows[0]) throw missing();
      return cleanRow(rows.rows[0]);
    });
  }
  async createGeofence(
    ctx: Context,
    clientId: string,
    siteId: string,
    input: unknown,
  ): Promise<Result> {
    const body = object(
      input,
      ['latitude', 'longitude', 'radius_m', 'min_dwell_s', 'state', 'reason'],
      ['latitude', 'longitude', 'radius_m', 'min_dwell_s', 'state', 'reason'],
    );
    const center = point(body.latitude, body.longitude);
    const radius = body.radius_m,
      dwell = body.min_dwell_s;
    if (
      typeof radius !== 'number' ||
      !Number.isFinite(radius) ||
      radius <= 0 ||
      radius > this.limits.max_radius_m ||
      Math.abs(Math.round(radius * 100) - radius * 100) > 1e-8 ||
      typeof dwell !== 'number' ||
      !Number.isInteger(dwell) ||
      dwell < 1 ||
      dwell > this.limits.max_dwell_s
    )
      throw invalid();
    const zoneState = state(body.state),
      reason = label(body.reason, 240);
    if (reason.length < 8) throw invalid();
    return this.mutate(ctx, body, async (db, tenant) => {
      const site = await db.query<{ site_state: string; client_state: string }>(
        `SELECT s.state AS site_state,c.state AS client_state FROM client_site s
        JOIN client c ON c.tenant_id=s.tenant_id AND c.id=s.client_id
        WHERE s.tenant_id=$1 AND s.client_id=$2 AND s.id=$3 FOR UPDATE OF s`,
        [tenant, id(clientId), id(siteId)],
      );
      if (!site.rowCount) throw missing();
      if (
        zoneState === 'ACTIVE' &&
        (site.rows[0]?.site_state !== 'ACTIVE' || site.rows[0]?.client_state !== 'ACTIVE')
      )
        throw new ApiError(409, 'inactive_parent', 'Conflict');
      const latest = await db.query<{ revision: number }>(
        'SELECT revision FROM client_geofence_revision WHERE site_id=$1 ORDER BY revision DESC LIMIT 1',
        [siteId],
      );
      const revision = (latest.rows[0]?.revision ?? 0) + 1;
      match(ctx.ifMatch, revision - 1);
      const rows = await db.query<Json>(
        `INSERT INTO client_geofence_revision(tenant_id,client_id,site_id,revision,center,radius_m,min_dwell_s,state,created_by,reason)
        VALUES($1,$2,$3,$4,ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,$7,$8,$9,$10,$11)
        RETURNING tenant_id,client_id,site_id,revision,radius_m,min_dwell_s,state,reason,created_at`,
        [
          tenant,
          clientId,
          siteId,
          revision,
          center.longitude,
          center.latitude,
          radius,
          dwell,
          zoneState,
          ctx.actorId,
          reason,
        ],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: ctx.actorId,
        action: 'client.geofence.publish',
        outcome: 'success',
        correlationId: ctx.requestId,
        ...(latest.rows[0] ? { previousState: String(revision - 1) } : {}),
        nextState: String(revision),
        metadata: { tenant_id: tenant, client_id: clientId, site_id: siteId, revision },
      });
      return {
        status: 201,
        body: { ...cleanRow(inserted(rows.rows)), ...center },
        etag: etag(revision),
      };
    });
  }
}
