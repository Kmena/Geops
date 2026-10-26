import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from './audit/index.js';
import { catalogLimits, type CatalogLimits } from './client-catalog.js';
import { ApiError } from './errors.js';

type Json = Record<string, unknown>;
export type RouteContext = {
  actorId: string;
  requestId: string;
  key: string;
  method: string;
  path: string;
  ifMatch?: string;
};
type Result = { status: number; body: Json; etag?: string };
type StopInput = {
  stop_id: string;
  site_id: string;
  geofence_revision: number;
  required: boolean;
  suggested_order: number | null;
  min_dwell_s: number | null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;
const invalid = () => new ApiError(422, 'invalid_request', 'Invalid request');
const missing = () => new ApiError(404, 'not_found', 'Not found');
const etag = (n: number) => `"${n}"`;
const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value;
};
const field = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw invalid();
  return value.trim();
};
const object = (value: unknown, keys: string[], required: string[] = []): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const body = value as Json;
  if (
    Object.keys(body).some((key) => !keys.includes(key)) ||
    required.some((key) => !(key in body))
  )
    throw invalid();
  return body;
};
const code = (value: unknown): string => {
  const result = field(value, 40).toUpperCase();
  if (!CODE.test(result)) throw invalid();
  return result;
};
const description = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 1000) throw invalid();
  return value.trim();
};
const precondition = (value: string | undefined, actual: number) => {
  if (!value) throw new ApiError(428, 'precondition_required', 'Precondition required');
  if (value !== etag(actual)) throw new ApiError(412, 'stale_version', 'Precondition failed');
};
const page = (limit: number) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
  return limit;
};
const cursor = <T>(value: string | undefined, check: (item: unknown) => item is T): T | null => {
  if (value === undefined) return null;
  if (value.length > 200) throw invalid();
  try {
    const item: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!check(item)) throw invalid();
    return item;
  } catch {
    throw invalid();
  }
};
const clean = (row: Json): Json => ({
  ...row,
  ...(row.version === undefined ? {} : { version: Number(row.version) }),
  ...(row.published_revision === undefined
    ? {}
    : { published_revision: Number(row.published_revision) }),
  ...(row.revision === undefined ? {} : { revision: Number(row.revision) }),
  ...(row.geofence_revision === undefined
    ? {}
    : { geofence_revision: Number(row.geofence_revision) }),
  ...(row.min_dwell_s === undefined
    ? {}
    : { min_dwell_s: row.min_dwell_s === null ? null : Number(row.min_dwell_s) }),
  ...(row.min_dwell_effective_s === undefined
    ? {}
    : { min_dwell_effective_s: Number(row.min_dwell_effective_s) }),
  ...(row.radius_m === undefined ? {} : { radius_m: Number(row.radius_m) }),
});
const first = (rows: Json[]): Json => {
  if (!rows[0]) throw new Error('Route write returned no row');
  return clean(rows[0]);
};

export class RouteCatalogService {
  constructor(
    private readonly pool: Pool,
    private readonly limits: CatalogLimits = catalogLimits(process.env),
  ) {}

  private async access(db: PoolClient, actor: string, write: boolean): Promise<string> {
    const result = await db.query<{ tenant_id: string }>(
      `SELECT t.tenant_id FROM geops_operating_tenant t
       JOIN admin_user u ON u.id=$1 AND u.state='ACTIVE'
       JOIN gps_data_tenant_access a ON a.admin_id=u.id AND a.tenant_id=t.tenant_id AND a.revoked_at IS NULL
       JOIN admin_permission p ON p.admin_id=u.id AND p.permission=$2 AND p.revoked_at IS NULL
       WHERE t.singleton=true`,
      [actor, write ? 'visit.catalog.write' : 'visit.catalog.read'],
    );
    if (!result.rows[0]) throw new ApiError(403, 'catalog_forbidden', 'Forbidden');
    return result.rows[0].tenant_id;
  }

  private async read<T>(
    actor: string,
    run: (db: PoolClient, tenant: string) => Promise<T>,
  ): Promise<T> {
    const db = await this.pool.connect();
    try {
      return await run(db, await this.access(db, actor, false));
    } finally {
      db.release();
    }
  }

  private async mutate(
    ctx: RouteContext,
    payload: unknown,
    run: (db: PoolClient, tenant: string) => Promise<Result>,
  ): Promise<Result> {
    uuid(ctx.key);
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
        'SELECT method,path,payload_digest,response_status,response_body FROM route_catalog_idempotency WHERE actor_id=$1 AND request_key=$2',
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
        const version = row.response_body.version;
        return {
          status: row.response_status,
          body: row.response_body,
          ...(typeof version === 'number' ? { etag: etag(version) } : {}),
        };
      }
      const result = await run(db, tenant);
      await db.query(
        'INSERT INTO route_catalog_idempotency(actor_id,request_key,method,path,payload_digest,response_status,response_body) VALUES($1,$2,$3,$4,$5,$6,$7)',
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
      const pgCode = (error as { code?: string }).code;
      if (pgCode === '23505') throw new ApiError(409, 'duplicate_code', 'Conflict');
      if (pgCode === '23503' || pgCode === '23514') throw invalid();
      throw error;
    } finally {
      db.release();
    }
  }

  private async locked(db: PoolClient, tenant: string, routeId: string): Promise<Json> {
    const result = await db.query<Json>(
      'SELECT * FROM route_template WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
      [tenant, uuid(routeId)],
    );
    if (!result.rows[0]) throw missing();
    return result.rows[0];
  }

  private async draftStops(db: PoolClient, tenant: string, routeId: string): Promise<Json[]> {
    const result = await db.query<Json>(
      `SELECT d.stop_id,d.site_id,d.client_id,d.geofence_revision,d.required,d.suggested_order,
       d.min_dwell_override_s AS min_dwell_s,COALESCE(d.min_dwell_override_s,g.min_dwell_s) AS min_dwell_effective_s,
       c.code AS client_code,c.name AS client_name,s.code AS site_code,s.name AS site_name,
       ST_Y(g.center::geometry) AS latitude,ST_X(g.center::geometry) AS longitude,g.radius_m,
       c.state AS client_state,s.state AS site_state,g.state AS geofence_state
       FROM route_draft_stop d JOIN client_site s ON s.tenant_id=d.tenant_id AND s.id=d.site_id
       JOIN client c ON c.tenant_id=s.tenant_id AND c.id=s.client_id
       JOIN client_geofence_revision g ON g.site_id=d.site_id AND g.revision=d.geofence_revision
       WHERE d.tenant_id=$1 AND d.route_id=$2 ORDER BY d.suggested_order NULLS LAST,d.stop_id`,
      [tenant, routeId],
    );
    return result.rows.map(clean);
  }

  private async revisionStops(db: PoolClient, routeId: string, revision: number): Promise<Json[]> {
    const result = await db.query<Json>(
      `SELECT stop_id,site_id,client_id,geofence_revision,required,suggested_order,
       min_dwell_override_s AS min_dwell_s,min_dwell_effective_s,client_code,client_name,site_code,site_name,
       latitude,longitude,radius_m FROM route_stop_revision
       WHERE route_id=$1 AND revision=$2 ORDER BY suggested_order NULLS LAST,stop_id`,
      [routeId, revision],
    );
    return result.rows.map(clean);
  }

  async list(actor: string, query: { q?: string; state?: string; cursor?: string; limit: number }) {
    const limit = page(query.limit);
    const after = cursor(query.cursor, (v): v is string => typeof v === 'string' && CODE.test(v));
    const q = query.q === undefined ? null : field(query.q, 160);
    const state = query.state === undefined ? null : query.state;
    if (state !== null && state !== 'ACTIVE' && state !== 'INACTIVE') throw invalid();
    return this.read(actor, async (db, tenant) => {
      const result = await db.query<Json>(
        `SELECT id,code,name,description,state,version,published_revision,has_draft,created_at,updated_at,created_by,updated_by
         FROM route_template WHERE tenant_id=$1 AND ($2::text IS NULL OR code ILIKE '%'||$2||'%' OR name ILIKE '%'||$2||'%')
         AND ($3::text IS NULL OR state=$3) AND ($4::text IS NULL OR code>$4)
         ORDER BY code LIMIT $5`,
        [tenant, q, state, after, limit + 1],
      );
      const items = result.rows.slice(0, limit).map(clean);
      return {
        items,
        next_cursor:
          result.rows.length > limit
            ? Buffer.from(JSON.stringify(items.at(-1)?.code)).toString('base64url')
            : null,
      };
    });
  }

  async get(actor: string, routeId: string): Promise<Json> {
    return this.read(actor, async (db, tenant) => {
      const result = await db.query<Json>(
        'SELECT * FROM route_template WHERE tenant_id=$1 AND id=$2',
        [tenant, uuid(routeId)],
      );
      const route = result.rows[0];
      if (!route) throw missing();
      const revision = Number(route.published_revision);
      const stops = route.has_draft
        ? await this.draftStops(db, tenant, routeId)
        : revision
          ? await this.revisionStops(db, routeId, revision)
          : [];
      return { ...clean(route), stops, content: route.has_draft ? 'DRAFT' : 'PUBLISHED' };
    });
  }

  async create(ctx: RouteContext, input: unknown): Promise<Result> {
    const body = object(input, ['code', 'name', 'description'], ['code', 'name']);
    const fields = {
      code: code(body.code),
      name: field(body.name, 160),
      description: body.description === undefined ? '' : description(body.description),
    };
    return this.mutate(ctx, body, async (db, tenant) => {
      const routeId = randomUUID();
      const row = first(
        (
          await db.query<Json>(
            `INSERT INTO route_template(id,tenant_id,code,name,description,created_by,updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
            [routeId, tenant, fields.code, fields.name, fields.description, ctx.actorId],
          )
        ).rows,
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: ctx.actorId,
        action: 'route.create',
        outcome: 'success',
        correlationId: ctx.requestId,
        metadata: { tenant_id: tenant, route_id: routeId, version: 1 },
      });
      return { status: 201, body: { ...row, stops: [], content: 'DRAFT' }, etag: etag(1) };
    });
  }

  async patch(ctx: RouteContext, routeId: string, input: unknown): Promise<Result> {
    const body = object(input, ['code', 'name', 'description']);
    if (!Object.keys(body).length) throw invalid();
    const changes = {
      ...(body.code === undefined ? {} : { code: code(body.code) }),
      ...(body.name === undefined ? {} : { name: field(body.name, 160) }),
      ...(body.description === undefined ? {} : { description: description(body.description) }),
    };
    return this.mutate(ctx, body, async (db, tenant) => {
      const route = await this.locked(db, tenant, routeId);
      precondition(ctx.ifMatch, Number(route.version));
      if (route.state !== 'ACTIVE') throw new ApiError(409, 'inactive_route', 'Conflict');
      if (!route.has_draft && Number(route.published_revision) > 0)
        await this.copyPublishedToDraft(db, tenant, routeId, Number(route.published_revision));
      const saved = first(
        (
          await db.query<Json>(
            `UPDATE route_template SET code=$3,name=$4,description=$5,has_draft=true,version=version+1,updated_by=$6,updated_at=now()
         WHERE tenant_id=$1 AND id=$2 RETURNING *`,
            [
              tenant,
              routeId,
              changes.code ?? route.code,
              changes.name ?? route.name,
              changes.description ?? route.description,
              ctx.actorId,
            ],
          )
        ).rows,
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: ctx.actorId,
        action: 'route.update',
        outcome: 'success',
        correlationId: ctx.requestId,
        metadata: { tenant_id: tenant, route_id: routeId, version: Number(saved.version) },
      });
      return {
        status: 200,
        body: { ...saved, stops: await this.draftStops(db, tenant, routeId), content: 'DRAFT' },
        etag: etag(Number(saved.version)),
      };
    });
  }

  private async copyPublishedToDraft(
    db: PoolClient,
    tenant: string,
    routeId: string,
    revision: number,
  ) {
    await db.query(
      `INSERT INTO route_draft_stop(tenant_id,route_id,stop_id,client_id,site_id,geofence_revision,required,suggested_order,min_dwell_override_s)
       SELECT tenant_id,route_id,stop_id,client_id,site_id,geofence_revision,required,suggested_order,min_dwell_override_s
       FROM route_stop_revision WHERE tenant_id=$1 AND route_id=$2 AND revision=$3`,
      [tenant, routeId, revision],
    );
  }

  async replaceStops(ctx: RouteContext, routeId: string, input: unknown): Promise<Result> {
    const body = object(input, ['stops'], ['stops']);
    if (!Array.isArray(body.stops) || body.stops.length > 200) throw invalid();
    const stops: StopInput[] = body.stops.map((raw) => {
      const stop = object(
        raw,
        ['stop_id', 'site_id', 'geofence_revision', 'required', 'suggested_order', 'min_dwell_s'],
        ['site_id', 'geofence_revision', 'required'],
      );
      if (
        typeof stop.required !== 'boolean' ||
        !Number.isInteger(stop.geofence_revision) ||
        Number(stop.geofence_revision) < 1
      )
        throw invalid();
      const order =
        stop.suggested_order === undefined || stop.suggested_order === null
          ? null
          : Number(stop.suggested_order);
      const dwell =
        stop.min_dwell_s === undefined || stop.min_dwell_s === null
          ? null
          : Number(stop.min_dwell_s);
      if (order !== null && (!Number.isInteger(order) || order < 1 || order > 200)) throw invalid();
      if (
        dwell !== null &&
        (!Number.isInteger(dwell) || dwell < 1 || dwell > this.limits.max_dwell_s)
      )
        throw invalid();
      return {
        stop_id: stop.stop_id === undefined ? randomUUID() : uuid(stop.stop_id),
        site_id: uuid(stop.site_id),
        geofence_revision: Number(stop.geofence_revision),
        required: stop.required,
        suggested_order: order,
        min_dwell_s: dwell,
      };
    });
    if (
      new Set(stops.map((s) => s.site_id)).size !== stops.length ||
      new Set(stops.map((s) => s.stop_id)).size !== stops.length
    )
      throw invalid();
    return this.mutate(ctx, body, async (db, tenant) => {
      const route = await this.locked(db, tenant, routeId);
      precondition(ctx.ifMatch, Number(route.version));
      if (route.state !== 'ACTIVE') throw new ApiError(409, 'inactive_route', 'Conflict');
      for (const stop of stops) {
        const valid = await db.query(
          `SELECT 1 FROM client_site s JOIN client c ON c.tenant_id=s.tenant_id AND c.id=s.client_id
           JOIN client_geofence_revision g ON g.site_id=s.id AND g.revision=$3
           WHERE s.tenant_id=$1 AND s.id=$2 AND s.state='ACTIVE' AND c.state='ACTIVE' AND g.state='ACTIVE'
           AND g.revision=(SELECT max(revision) FROM client_geofence_revision WHERE site_id=s.id)`,
          [tenant, stop.site_id, stop.geofence_revision],
        );
        if (!valid.rowCount) throw new ApiError(422, 'invalid_stop_reference', 'Invalid request');
      }
      await db.query('DELETE FROM route_draft_stop WHERE tenant_id=$1 AND route_id=$2', [
        tenant,
        routeId,
      ]);
      for (const stop of stops)
        await db.query(
          `INSERT INTO route_draft_stop(tenant_id,route_id,stop_id,client_id,site_id,geofence_revision,required,suggested_order,min_dwell_override_s)
         SELECT $1,$2,$3,s.client_id,s.id,$5,$6,$7,$8 FROM client_site s WHERE s.tenant_id=$1 AND s.id=$4`,
          [
            tenant,
            routeId,
            stop.stop_id,
            stop.site_id,
            stop.geofence_revision,
            stop.required,
            stop.suggested_order,
            stop.min_dwell_s,
          ],
        );
      const saved = first(
        (
          await db.query<Json>(
            'UPDATE route_template SET has_draft=true,version=version+1,updated_by=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',
            [tenant, routeId, ctx.actorId],
          )
        ).rows,
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: ctx.actorId,
        action: 'route.draft.stops.replace',
        outcome: 'success',
        correlationId: ctx.requestId,
        metadata: {
          tenant_id: tenant,
          route_id: routeId,
          stop_count: stops.length,
          version: Number(saved.version),
        },
      });
      return {
        status: 200,
        body: { ...saved, stops: await this.draftStops(db, tenant, routeId), content: 'DRAFT' },
        etag: etag(Number(saved.version)),
      };
    });
  }

  async publish(ctx: RouteContext, routeId: string, input: unknown): Promise<Result> {
    object(input, []);
    return this.mutate(ctx, input, async (db, tenant) => {
      const route = await this.locked(db, tenant, routeId);
      precondition(ctx.ifMatch, Number(route.version));
      if (route.state !== 'ACTIVE' || !route.has_draft)
        throw new ApiError(409, 'no_active_draft', 'Conflict');
      const stops = await this.draftStops(db, tenant, routeId);
      if (!stops.length || !stops.some((s) => s.required))
        throw new ApiError(422, 'empty_route', 'Invalid request');
      for (const stop of stops) {
        if (
          stop.client_state !== 'ACTIVE' ||
          stop.site_state !== 'ACTIVE' ||
          stop.geofence_state !== 'ACTIVE'
        )
          throw new ApiError(422, 'invalid_stop_reference', 'Invalid request');
        const latest = await db.query<{ revision: number }>(
          'SELECT max(revision) AS revision FROM client_geofence_revision WHERE site_id=$1',
          [stop.site_id],
        );
        if (Number(latest.rows[0]?.revision) !== Number(stop.geofence_revision))
          throw new ApiError(409, 'stale_geofence', 'Conflict');
      }
      const revision = Number(route.published_revision) + 1;
      const snapshot = {
        code: route.code,
        name: route.name,
        description: route.description,
        stops: stops.map(({ client_state, site_state, geofence_state, ...stop }) => stop),
      };
      const hash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      await db.query(
        `INSERT INTO route_revision(tenant_id,route_id,revision,code,name,description,content_hash,published_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenant, routeId, revision, route.code, route.name, route.description, hash, ctx.actorId],
      );
      for (const stop of stops)
        await db.query(
          `INSERT INTO route_stop_revision(tenant_id,route_id,revision,stop_id,client_id,site_id,geofence_revision,required,suggested_order,
         min_dwell_override_s,min_dwell_effective_s,client_code,client_name,site_code,site_name,latitude,longitude,radius_m)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [
            tenant,
            routeId,
            revision,
            stop.stop_id,
            stop.client_id,
            stop.site_id,
            stop.geofence_revision,
            stop.required,
            stop.suggested_order,
            stop.min_dwell_s,
            stop.min_dwell_effective_s,
            stop.client_code,
            stop.client_name,
            stop.site_code,
            stop.site_name,
            stop.latitude,
            stop.longitude,
            stop.radius_m,
          ],
        );
      await db.query(
        'UPDATE route_revision SET sealed=true WHERE tenant_id=$1 AND route_id=$2 AND revision=$3',
        [tenant, routeId, revision],
      );
      await db.query('DELETE FROM route_draft_stop WHERE tenant_id=$1 AND route_id=$2', [
        tenant,
        routeId,
      ]);
      const saved = first(
        (
          await db.query<Json>(
            'UPDATE route_template SET published_revision=$3,has_draft=false,version=version+1,updated_by=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',
            [tenant, routeId, revision, ctx.actorId],
          )
        ).rows,
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: ctx.actorId,
        action: 'route.publish',
        outcome: 'success',
        correlationId: ctx.requestId,
        metadata: {
          tenant_id: tenant,
          route_id: routeId,
          revision,
          content_hash: hash,
          stop_count: stops.length,
        },
      });
      return {
        status: 200,
        body: {
          ...saved,
          revision,
          content_hash: hash,
          stops: snapshot.stops,
          content: 'PUBLISHED',
        },
        etag: etag(Number(saved.version)),
      };
    });
  }

  async setState(
    ctx: RouteContext,
    routeId: string,
    input: unknown,
    state: 'ACTIVE' | 'INACTIVE',
  ): Promise<Result> {
    object(input, []);
    return this.mutate(ctx, input, async (db, tenant) => {
      const route = await this.locked(db, tenant, routeId);
      precondition(ctx.ifMatch, Number(route.version));
      const saved = first(
        (
          await db.query<Json>(
            'UPDATE route_template SET state=$3,version=version+1,updated_by=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',
            [tenant, routeId, state, ctx.actorId],
          )
        ).rows,
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: ctx.actorId,
        action: state === 'ACTIVE' ? 'route.activate' : 'route.deactivate',
        outcome: 'success',
        correlationId: ctx.requestId,
        previousState: String(route.state),
        nextState: state,
        metadata: { tenant_id: tenant, route_id: routeId, version: Number(saved.version) },
      });
      return { status: 200, body: saved, etag: etag(Number(saved.version)) };
    });
  }

  async revisions(actor: string, routeId: string, after?: string, requestedLimit = 25) {
    const limit = page(requestedLimit);
    const before = cursor(
      after,
      (v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0,
    );
    return this.read(actor, async (db, tenant) => {
      const route = await db.query('SELECT 1 FROM route_template WHERE tenant_id=$1 AND id=$2', [
        tenant,
        uuid(routeId),
      ]);
      if (!route.rowCount) throw missing();
      const rows = await db.query<Json>(
        `SELECT revision,code,name,description,content_hash,published_by,published_at FROM route_revision
         WHERE tenant_id=$1 AND route_id=$2 AND ($3::integer IS NULL OR revision<$3) ORDER BY revision DESC LIMIT $4`,
        [tenant, routeId, before, limit + 1],
      );
      const items = rows.rows.slice(0, limit).map(clean);
      return {
        items,
        next_cursor:
          rows.rows.length > limit
            ? Buffer.from(JSON.stringify(items.at(-1)?.revision)).toString('base64url')
            : null,
      };
    });
  }

  async revision(actor: string, routeId: string, revision: number): Promise<Json> {
    if (!Number.isInteger(revision) || revision < 1) throw invalid();
    return this.read(actor, async (db, tenant) => {
      const row = await db.query<Json>(
        'SELECT revision,code,name,description,content_hash,published_by,published_at FROM route_revision WHERE tenant_id=$1 AND route_id=$2 AND revision=$3',
        [tenant, uuid(routeId), revision],
      );
      if (!row.rows[0]) throw missing();
      return {
        ...clean(row.rows[0]),
        route_id: routeId,
        stops: await this.revisionStops(db, routeId, revision),
      };
    });
  }
}
