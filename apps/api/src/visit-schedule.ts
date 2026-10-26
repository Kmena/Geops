import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from './audit/index.js';
import { ApiError } from './errors.js';

type Json = Record<string, unknown>;
export type ScheduleContext = {
  actorId: string;
  requestId: string;
  key: string;
  method: string;
  path: string;
  ifMatch?: string;
};
type Result = { status: number; body: Json; etag?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const invalid = () => new ApiError(422, 'invalid_request', 'Invalid request');
const missing = () => new ApiError(404, 'not_found', 'Not found');
const etag = (version: number) => `"${version}"`;
const uuid = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value;
};
const label = (value: unknown, max: number, min = 1): string => {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    throw invalid();
  return value.trim();
};
const code = (value: unknown): string => {
  const result = label(value, 40).toUpperCase();
  if (!CODE.test(result)) throw invalid();
  return result;
};
const object = (value: unknown, allowed: string[], required: string[] = []): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const body = value as Json;
  if (
    Object.keys(body).some((key) => !allowed.includes(key)) ||
    required.some((key) => !(key in body))
  )
    throw invalid();
  return body;
};
const precondition = (value: string | undefined, actual: number) => {
  if (!value) throw new ApiError(428, 'precondition_required', 'Precondition required');
  if (value !== etag(actual)) throw new ApiError(412, 'stale_version', 'Precondition failed');
};
const page = (value: number) => {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw invalid();
  return value;
};
const date = (value: unknown): string => {
  if (typeof value !== 'string' || !DATE.test(value)) throw invalid();
  const [y = 0, m = 0, d = 0] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (y < 2000 || y > 2100 || parsed.toISOString().slice(0, 10) !== value) throw invalid();
  return value;
};
const time = (value: unknown): string => {
  if (typeof value !== 'string' || !TIME.test(value)) throw invalid();
  return value;
};
const zone = (value: unknown): string => {
  const result = label(value, 80);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: result }).format(0);
  } catch {
    throw invalid();
  }
  return result;
};
const days = (value: unknown): number[] => {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 7 ||
    value.some((item) => !Number.isInteger(item) || item < 1 || item > 7) ||
    new Set(value).size !== value.length
  )
    throw invalid();
  return [...value].sort() as number[];
};
const cursor = <T>(value: string | undefined, check: (item: unknown) => item is T): T | null => {
  if (value === undefined) return null;
  if (value.length > 300) throw invalid();
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!check(parsed)) throw invalid();
    return parsed;
  } catch {
    throw invalid();
  }
};
const clean = (row: Json): Json => ({
  ...row,
  ...(row.version === undefined ? {} : { version: Number(row.version) }),
  ...(row.route_revision === undefined ? {} : { route_revision: Number(row.route_revision) }),
  ...(row.applied_version === undefined ? {} : { applied_version: Number(row.applied_version) }),
  ...(row.radius_m === undefined ? {} : { radius_m: Number(row.radius_m) }),
});
const first = (rows: Json[]) => {
  if (!rows[0]) throw new Error('Schedule write returned no row');
  return clean(rows[0]);
};

function parts(formatter: Intl.DateTimeFormat, instant: number) {
  const values = Object.fromEntries(
    formatter.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}
export function resolveLocal(localDate: string, localTime: string, timeZone: string): string {
  const d = date(localDate),
    t = time(localTime),
    z = zone(timeZone);
  const [year = 0, month = 0, day = 0] = d.split('-').map(Number),
    [hour = 0, minute = 0] = t.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: z,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const offsets = new Set<number>();
  for (const sample of [target - 86400000, target, target + 86400000]) {
    const p = parts(formatter, sample);
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - sample);
  }
  const matches = [...offsets]
    .map((offset) => target - offset)
    .filter((instant) => {
      const p = parts(formatter, instant);
      return (
        p.year === year &&
        p.month === month &&
        p.day === day &&
        p.hour === hour &&
        p.minute === minute
      );
    });
  if (matches.length !== 1 || matches[0] === undefined)
    throw new ApiError(422, 'invalid_local_time', 'Invalid request');
  return new Date(matches[0]).toISOString();
}
const isoDay = (localDate: string) => {
  const day = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
  return day === 0 ? 7 : day;
};
const nextDate = (localDate: string) =>
  new Date(Date.parse(`${localDate}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
const todayInZone = (timeZone: string) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const p = Object.fromEntries(
    formatter.formatToParts(new Date()).map((part) => [part.type, part.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
};
const span = (from: string, to: string, max = 31) => {
  const start = date(from),
    end = date(to),
    diff = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000;
  if (diff < 0 || diff >= max) throw invalid();
  return diff + 1;
};

export class VisitScheduleService {
  constructor(private readonly pool: Pool) {}
  private async access(db: PoolClient, actor: string, write: boolean): Promise<string> {
    const result = await db.query<{ tenant_id: string }>(
      `SELECT t.tenant_id FROM geops_operating_tenant t
       JOIN admin_user u ON u.id=$1 AND u.state='ACTIVE'
       JOIN gps_data_tenant_access a ON a.admin_id=u.id AND a.tenant_id=t.tenant_id AND a.revoked_at IS NULL
       JOIN admin_permission p ON p.admin_id=u.id AND p.permission=$2 AND p.revoked_at IS NULL
       WHERE t.singleton=true`,
      [actor, write ? 'visit.schedule.write' : 'visit.schedule.read'],
    );
    if (!result.rows[0]) throw new ApiError(403, 'schedule_forbidden', 'Forbidden');
    return result.rows[0].tenant_id;
  }
  async capabilities(actor: string) {
    const db = await this.pool.connect();
    try {
      const capabilities: string[] = [];
      for (const permission of ['visit.schedule.read', 'visit.schedule.write']) {
        try {
          await this.access(db, actor, permission.endsWith('write'));
          capabilities.push(permission);
        } catch (error) {
          if (!(error instanceof ApiError && error.statusCode === 403)) throw error;
        }
      }
      return { capabilities, materialization_max_days: 31, agent_device_integration: 'PENDING' };
    } finally {
      db.release();
    }
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
    ctx: ScheduleContext,
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
        'SELECT method,path,payload_digest,response_status,response_body FROM visit_schedule_idempotency WHERE actor_id=$1 AND request_key=$2',
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
        'INSERT INTO visit_schedule_idempotency(actor_id,request_key,method,path,payload_digest,response_status,response_body) VALUES($1,$2,$3,$4,$5,$6,$7)',
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
      if (pgCode === '23505' || pgCode === '23P01')
        throw new ApiError(409, 'schedule_conflict', 'Conflict');
      if (pgCode === '23503' || pgCode === '23514') throw invalid();
      throw error;
    } finally {
      db.release();
    }
  }
  private async audit(
    db: PoolClient,
    ctx: ScheduleContext,
    action: string,
    tenant: string,
    metadata: Record<string, string | number | boolean>,
  ) {
    await appendAudit(db, {
      actorType: 'ADMIN',
      actorId: ctx.actorId,
      action,
      outcome: 'success',
      correlationId: ctx.requestId,
      metadata: { tenant_id: tenant, ...metadata },
    });
  }
  async listAgents(
    actor: string,
    query: { q?: string; state?: string; cursor?: string; limit: number },
  ) {
    const limit = page(query.limit),
      after = cursor(query.cursor, (v): v is string => typeof v === 'string' && CODE.test(v));
    const q = query.q === undefined ? null : label(query.q, 160),
      state = query.state ?? null;
    if (state !== null && state !== 'ACTIVE' && state !== 'INACTIVE') throw invalid();
    return this.read(actor, async (db, tenant) => {
      const rows = await db.query<Json>(
        `SELECT id,code,name,state,version,created_at,updated_at FROM agent
        WHERE tenant_id=$1 AND ($2::text IS NULL OR code ILIKE '%'||$2||'%' OR name ILIKE '%'||$2||'%')
        AND ($3::text IS NULL OR state=$3) AND ($4::text IS NULL OR code>$4) ORDER BY code LIMIT $5`,
        [tenant, q, state, after, limit + 1],
      );
      const items = rows.rows.slice(0, limit).map(clean);
      return {
        items,
        next_cursor:
          rows.rows.length > limit
            ? Buffer.from(JSON.stringify(items.at(-1)?.code)).toString('base64url')
            : null,
      };
    });
  }
  async getAgent(actor: string, agentId: string): Promise<Json> {
    return this.read(actor, async (db, tenant) => {
      const rows = await db.query<Json>(
        'SELECT id,code,name,state,version,created_at,updated_at FROM agent WHERE tenant_id=$1 AND id=$2',
        [tenant, uuid(agentId)],
      );
      if (!rows.rows[0]) throw missing();
      return clean(rows.rows[0]);
    });
  }
  async createAgent(ctx: ScheduleContext, input: unknown): Promise<Result> {
    const body = object(input, ['code', 'name'], ['code', 'name']);
    const fields = { code: code(body.code), name: label(body.name, 160) };
    return this.mutate(ctx, body, async (db, tenant) => {
      const agentId = randomUUID();
      const row = first(
        (
          await db.query<Json>(
            `INSERT INTO agent(id,tenant_id,code,name,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$5) RETURNING id,code,name,state,version,created_at,updated_at`,
            [agentId, tenant, fields.code, fields.name, ctx.actorId],
          )
        ).rows,
      );
      await this.audit(db, ctx, 'agent.create', tenant, { agent_id: agentId });
      return { status: 201, body: row, etag: etag(1) };
    });
  }
  async patchAgent(ctx: ScheduleContext, agentId: string, input: unknown): Promise<Result> {
    const body = object(input, ['code', 'name', 'state']);
    if (!Object.keys(body).length) throw invalid();
    const fields = {
      ...(body.code === undefined ? {} : { code: code(body.code) }),
      ...(body.name === undefined ? {} : { name: label(body.name, 160) }),
      ...(body.state === undefined ? {} : { state: body.state }),
    };
    if (fields.state !== undefined && fields.state !== 'ACTIVE' && fields.state !== 'INACTIVE')
      throw invalid();
    return this.mutate(ctx, body, async (db, tenant) => {
      const result = await db.query<Json>(
        'SELECT * FROM agent WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [tenant, uuid(agentId)],
      );
      if (!result.rows[0]) throw missing();
      const agent = result.rows[0];
      precondition(ctx.ifMatch, Number(agent.version));
      const row = first(
        (
          await db.query<Json>(
            `UPDATE agent SET code=$3,name=$4,state=$5,version=version+1,
        updated_by=$6,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,code,name,state,version,created_at,updated_at`,
            [
              tenant,
              agentId,
              fields.code ?? agent.code,
              fields.name ?? agent.name,
              fields.state ?? agent.state,
              ctx.actorId,
            ],
          )
        ).rows,
      );
      await this.audit(db, ctx, 'agent.update', tenant, {
        agent_id: agentId,
        version: Number(row.version),
      });
      return { status: 200, body: row, etag: etag(Number(row.version)) };
    });
  }

  private assignmentInput(input: unknown) {
    const body = object(
      input,
      [
        'agent_id',
        'route_id',
        'route_revision',
        'local_date',
        'time_zone',
        'starts_local',
        'ends_local',
        'reason',
        'origin',
      ],
      [
        'agent_id',
        'route_id',
        'route_revision',
        'local_date',
        'time_zone',
        'starts_local',
        'ends_local',
        'reason',
      ],
    );
    const agentId = uuid(body.agent_id),
      routeId = uuid(body.route_id),
      localDate = date(body.local_date),
      timeZone = zone(body.time_zone);
    const startsLocal = time(body.starts_local),
      endsLocal = time(body.ends_local);
    const routeRevision = Number(body.route_revision);
    if (!Number.isInteger(routeRevision) || routeRevision < 1) throw invalid();
    const startsAt = resolveLocal(localDate, startsLocal, timeZone),
      endsAt = resolveLocal(localDate, endsLocal, timeZone);
    if (endsAt <= startsAt) throw new ApiError(422, 'invalid_work_range', 'Invalid request');
    const reason = label(body.reason, 240, 8),
      origin = body.origin ?? 'MANUAL';
    if (origin !== 'MANUAL' && origin !== 'EXTRAORDINARY') throw invalid();
    return {
      agentId,
      routeId,
      routeRevision,
      localDate,
      timeZone,
      startsAt,
      endsAt,
      reason,
      origin,
    };
  }
  private async insertAssignment(
    db: PoolClient,
    tenant: string,
    actor: string,
    fields: {
      agentId: string;
      routeId: string;
      routeRevision: number;
      localDate: string;
      timeZone: string;
      startsAt: string;
      endsAt: string;
      reason: string;
      origin: string;
      ruleId?: string;
    },
  ): Promise<Json> {
    const agent = await db.query<Json>(
      'SELECT code,name,state FROM agent WHERE tenant_id=$1 AND id=$2',
      [tenant, fields.agentId],
    );
    if (!agent.rows[0]) throw missing();
    if (agent.rows[0].state !== 'ACTIVE') throw new ApiError(409, 'inactive_agent', 'Conflict');
    const route = await db.query<Json>(
      `SELECT r.code,r.name,r.content_hash,t.state AS template_state FROM route_revision r
      JOIN route_template t ON t.tenant_id=r.tenant_id AND t.id=r.route_id
      WHERE r.tenant_id=$1 AND r.route_id=$2 AND r.revision=$3 AND r.sealed=true`,
      [tenant, fields.routeId, fields.routeRevision],
    );
    if (!route.rows[0]) throw missing();
    if (route.rows[0].template_state !== 'ACTIVE')
      throw new ApiError(409, 'inactive_route', 'Conflict');
    const assignmentId = randomUUID();
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          route_hash: route.rows[0].content_hash,
          agent_id: fields.agentId,
          local_date: fields.localDate,
          starts_at: fields.startsAt,
          ends_at: fields.endsAt,
        }),
      )
      .digest('hex');
    const row = first(
      (
        await db.query<Json>(
          `INSERT INTO route_assignment(id,tenant_id,agent_id,agent_code,agent_name,route_id,route_revision,route_code,route_name,
      local_date,time_zone,starts_at,ends_at,origin,rule_id,snapshot_hash,reason,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING id,agent_id,agent_code,agent_name,route_id,route_revision,route_code,route_name,local_date::text AS local_date,
      time_zone,starts_at,ends_at,origin,rule_id,state,version,snapshot_hash,reason,created_at`,
          [
            assignmentId,
            tenant,
            fields.agentId,
            agent.rows[0].code,
            agent.rows[0].name,
            fields.routeId,
            fields.routeRevision,
            route.rows[0].code,
            route.rows[0].name,
            fields.localDate,
            fields.timeZone,
            fields.startsAt,
            fields.endsAt,
            fields.origin,
            fields.ruleId ?? null,
            hash,
            fields.reason,
            actor,
          ],
        )
      ).rows,
    );
    await db.query(
      `INSERT INTO assignment_visit(tenant_id,assignment_id,stop_id,client_id,site_id,geofence_revision,required,suggested_order,
      min_dwell_effective_s,client_code,client_name,site_code,site_name,latitude,longitude,radius_m)
      SELECT tenant_id,$1,stop_id,client_id,site_id,geofence_revision,required,suggested_order,min_dwell_effective_s,
      client_code,client_name,site_code,site_name,latitude,longitude,radius_m FROM route_stop_revision
      WHERE tenant_id=$2 AND route_id=$3 AND revision=$4`,
      [assignmentId, tenant, fields.routeId, fields.routeRevision],
    );
    return row;
  }
  private async visits(db: PoolClient, tenant: string, assignmentId: string) {
    const rows = await db.query<Json>(
      `SELECT stop_id,client_id,site_id,geofence_revision,required,suggested_order,min_dwell_effective_s,
      client_code,client_name,site_code,site_name,latitude,longitude,radius_m FROM assignment_visit
      WHERE tenant_id=$1 AND assignment_id=$2 ORDER BY suggested_order NULLS LAST,stop_id`,
      [tenant, assignmentId],
    );
    return rows.rows.map(clean);
  }
  async createAssignment(ctx: ScheduleContext, input: unknown): Promise<Result> {
    const fields = this.assignmentInput(input);
    return this.mutate(ctx, input, async (db, tenant) => {
      const row = await this.insertAssignment(db, tenant, ctx.actorId, fields);
      await this.audit(db, ctx, 'assignment.create', tenant, {
        assignment_id: String(row.id),
        agent_id: fields.agentId,
        route_id: fields.routeId,
        route_revision: fields.routeRevision,
      });
      return {
        status: 201,
        body: { ...row, visits: await this.visits(db, tenant, String(row.id)) },
        etag: etag(1),
      };
    });
  }
  async getAssignment(actor: string, assignmentId: string): Promise<Json> {
    return this.read(actor, async (db, tenant) => {
      const rows = await db.query<Json>(
        `SELECT id,agent_id,agent_code,agent_name,route_id,route_revision,route_code,route_name,
        local_date::text AS local_date,time_zone,starts_at,ends_at,origin,rule_id,state,version,snapshot_hash,reason,
        cancelled_at,cancel_reason,created_at,updated_at FROM route_assignment WHERE tenant_id=$1 AND id=$2`,
        [tenant, uuid(assignmentId)],
      );
      if (!rows.rows[0]) throw missing();
      return { ...clean(rows.rows[0]), visits: await this.visits(db, tenant, assignmentId) };
    });
  }
  async listAssignments(
    actor: string,
    query: {
      from: string;
      to: string;
      agent_id?: string;
      route_id?: string;
      state?: string;
      cursor?: string;
      limit: number;
    },
  ) {
    const from = date(query.from),
      to = date(query.to),
      limit = page(query.limit);
    span(from, to, 62);
    const agentId = query.agent_id ? uuid(query.agent_id) : null,
      routeId = query.route_id ? uuid(query.route_id) : null;
    const state = query.state ?? null;
    if (state !== null && state !== 'PLANNED' && state !== 'CANCELLED') throw invalid();
    const after = cursor(
      query.cursor,
      (v): v is { date: string; id: string } =>
        !!v &&
        typeof v === 'object' &&
        DATE.test((v as { date?: string }).date ?? '') &&
        UUID.test((v as { id?: string }).id ?? ''),
    );
    return this.read(actor, async (db, tenant) => {
      const rows = await db.query<Json>(
        `SELECT id,agent_id,agent_code,agent_name,route_id,route_revision,route_code,route_name,
        local_date::text AS local_date,time_zone,starts_at,ends_at,origin,rule_id,state,version,snapshot_hash,created_at
        FROM route_assignment WHERE tenant_id=$1 AND local_date BETWEEN $2 AND $3
        AND ($4::uuid IS NULL OR agent_id=$4) AND ($5::uuid IS NULL OR route_id=$5)
        AND ($6::text IS NULL OR state=$6)
        AND ($7::date IS NULL OR (local_date,id)>($7::date,$8::uuid))
        ORDER BY local_date,id LIMIT $9`,
        [
          tenant,
          from,
          to,
          agentId,
          routeId,
          state,
          after?.date ?? null,
          after?.id ?? null,
          limit + 1,
        ],
      );
      const items = rows.rows.slice(0, limit).map(clean);
      const last = items.at(-1);
      return {
        items,
        next_cursor:
          rows.rows.length > limit && last
            ? Buffer.from(JSON.stringify({ date: last.local_date, id: last.id })).toString(
                'base64url',
              )
            : null,
      };
    });
  }
  private async cancelRow(
    db: PoolClient,
    tenant: string,
    assignmentId: string,
    actor: string,
    reason: string,
  ): Promise<Json> {
    return first(
      (
        await db.query<Json>(
          `UPDATE route_assignment SET state='CANCELLED',version=version+1,cancelled_at=now(),cancelled_by=$3,
      cancel_reason=$4,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND state='PLANNED'
      RETURNING id,agent_id,route_id,route_revision,local_date::text AS local_date,state,version,rule_id,origin,cancelled_at,cancel_reason`,
          [tenant, assignmentId, actor, reason],
        )
      ).rows,
    );
  }
  async cancelAssignment(
    ctx: ScheduleContext,
    assignmentId: string,
    input: unknown,
  ): Promise<Result> {
    const body = object(input, ['reason'], ['reason']);
    const reason = label(body.reason, 240, 8);
    return this.mutate(ctx, body, async (db, tenant) => {
      const rows = await db.query<Json>(
        'SELECT * FROM route_assignment WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [tenant, uuid(assignmentId)],
      );
      if (!rows.rows[0]) throw missing();
      const row = rows.rows[0];
      precondition(ctx.ifMatch, Number(row.version));
      if (row.state !== 'PLANNED') throw new ApiError(409, 'already_cancelled', 'Conflict');
      const cancelled = await this.cancelRow(db, tenant, assignmentId, ctx.actorId, reason);
      if (row.rule_id) {
        const ruleId = String(row.rule_id),
          localDate = String(
            row.local_date instanceof Date
              ? row.local_date.toISOString().slice(0, 10)
              : row.local_date,
          );
        await db.query(
          `INSERT INTO route_schedule_exception(tenant_id,rule_id,local_date,action,reason,created_by,updated_by)
          VALUES($1,$2,$3,'CANCEL',$4,$5,$5) ON CONFLICT(rule_id,local_date) DO UPDATE SET action='CANCEL',
          replacement_route_id=NULL,replacement_revision=NULL,reason=EXCLUDED.reason,updated_by=EXCLUDED.updated_by,updated_at=now()`,
          [tenant, ruleId, localDate, reason, ctx.actorId],
        );
        await db.query(
          'UPDATE route_schedule_rule SET version=version+1,updated_by=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2',
          [tenant, ruleId, ctx.actorId],
        );
      }
      await this.audit(db, ctx, 'assignment.cancel', tenant, { assignment_id: assignmentId });
      return { status: 200, body: cancelled, etag: etag(Number(cancelled.version)) };
    });
  }
  private ruleFields(input: unknown, prior?: Json) {
    const allowed = [
      'agent_id',
      'route_id',
      'route_revision',
      'start_date',
      'end_date',
      'days_iso',
      'time_zone',
      'starts_local',
      'ends_local',
      'state',
      'reason',
    ];
    const body = object(
      input,
      allowed,
      prior
        ? ['reason']
        : [
            'agent_id',
            'route_id',
            'route_revision',
            'start_date',
            'days_iso',
            'time_zone',
            'starts_local',
            'ends_local',
            'reason',
          ],
    );
    const agentId = uuid(body.agent_id ?? prior?.agent_id),
      routeId = uuid(body.route_id ?? prior?.route_id);
    const routeRevision = Number(body.route_revision ?? prior?.route_revision);
    if (!Number.isInteger(routeRevision) || routeRevision < 1) throw invalid();
    const startDate = date(
      body.start_date ??
        (prior?.start_date instanceof Date
          ? prior.start_date.toISOString().slice(0, 10)
          : prior?.start_date),
    );
    const rawEnd = body.end_date === undefined ? prior?.end_date : body.end_date;
    const endDate =
      rawEnd === null || rawEnd === undefined
        ? null
        : date(rawEnd instanceof Date ? rawEnd.toISOString().slice(0, 10) : rawEnd);
    if (endDate && endDate < startDate) throw invalid();
    const daysIso = days(body.days_iso ?? prior?.days_iso);
    const timeZone = zone(body.time_zone ?? prior?.time_zone);
    const startsLocal = time(body.starts_local ?? String(prior?.starts_local ?? '').slice(0, 5));
    const endsLocal = time(body.ends_local ?? String(prior?.ends_local ?? '').slice(0, 5));
    if (endsLocal <= startsLocal) throw invalid();
    const state = body.state ?? prior?.state ?? 'ACTIVE';
    if (state !== 'ACTIVE' && state !== 'INACTIVE') throw invalid();
    const reason = label(body.reason, 240, 8);
    return {
      agentId,
      routeId,
      routeRevision,
      startDate,
      endDate,
      daysIso,
      timeZone,
      startsLocal,
      endsLocal,
      state,
      reason,
    };
  }
  private async validateRuleRefs(
    db: PoolClient,
    tenant: string,
    fields: { agentId: string; routeId: string; routeRevision: number },
  ) {
    const agent = await db.query(
      "SELECT 1 FROM agent WHERE tenant_id=$1 AND id=$2 AND state='ACTIVE'",
      [tenant, fields.agentId],
    );
    if (!agent.rowCount) throw new ApiError(422, 'inactive_or_missing_agent', 'Invalid request');
    const route = await db.query(
      `SELECT 1 FROM route_revision r JOIN route_template t ON t.tenant_id=r.tenant_id AND t.id=r.route_id
      WHERE r.tenant_id=$1 AND r.route_id=$2 AND r.revision=$3 AND r.sealed=true AND t.state='ACTIVE'`,
      [tenant, fields.routeId, fields.routeRevision],
    );
    if (!route.rowCount) throw new ApiError(422, 'inactive_or_missing_route', 'Invalid request');
  }
  async createRule(ctx: ScheduleContext, input: unknown): Promise<Result> {
    const fields = this.ruleFields(input);
    return this.mutate(ctx, input, async (db, tenant) => {
      if (fields.state === 'ACTIVE') await this.validateRuleRefs(db, tenant, fields);
      const ruleId = randomUUID();
      const row = first(
        (
          await db.query<Json>(
            `INSERT INTO route_schedule_rule(id,tenant_id,agent_id,route_id,route_revision,start_date,end_date,
        days_iso,time_zone,starts_local,ends_local,state,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
        RETURNING id,agent_id,route_id,route_revision,start_date::text AS start_date,end_date::text AS end_date,
        days_iso,time_zone,starts_local::text AS starts_local,ends_local::text AS ends_local,state,version,created_at,updated_at`,
            [
              ruleId,
              tenant,
              fields.agentId,
              fields.routeId,
              fields.routeRevision,
              fields.startDate,
              fields.endDate,
              fields.daysIso,
              fields.timeZone,
              fields.startsLocal,
              fields.endsLocal,
              fields.state,
              ctx.actorId,
            ],
          )
        ).rows,
      );
      await this.audit(db, ctx, 'schedule.rule.create', tenant, {
        rule_id: ruleId,
        agent_id: fields.agentId,
        route_id: fields.routeId,
      });
      return { status: 201, body: { ...row, exceptions: [] }, etag: etag(1) };
    });
  }
  private async exceptions(db: PoolClient, tenant: string, ruleId: string) {
    const rows = await db.query<Json>(
      `SELECT local_date::text AS local_date,action,replacement_route_id,replacement_revision,reason,created_at,updated_at
      FROM route_schedule_exception WHERE tenant_id=$1 AND rule_id=$2 ORDER BY local_date`,
      [tenant, ruleId],
    );
    return rows.rows.map(clean);
  }
  async getRule(actor: string, ruleId: string): Promise<Json> {
    return this.read(actor, async (db, tenant) => {
      const rows = await db.query<Json>(
        `SELECT id,agent_id,route_id,route_revision,start_date::text AS start_date,end_date::text AS end_date,
        days_iso,time_zone,starts_local::text AS starts_local,ends_local::text AS ends_local,state,version,created_at,updated_at
        FROM route_schedule_rule WHERE tenant_id=$1 AND id=$2`,
        [tenant, uuid(ruleId)],
      );
      if (!rows.rows[0]) throw missing();
      return { ...clean(rows.rows[0]), exceptions: await this.exceptions(db, tenant, ruleId) };
    });
  }
  async listRules(
    actor: string,
    query: { agent_id?: string; route_id?: string; state?: string; cursor?: string; limit: number },
  ) {
    const limit = page(query.limit),
      agentId = query.agent_id ? uuid(query.agent_id) : null,
      routeId = query.route_id ? uuid(query.route_id) : null;
    const state = query.state ?? null;
    if (state !== null && state !== 'ACTIVE' && state !== 'INACTIVE') throw invalid();
    const after = cursor(query.cursor, (v): v is string => typeof v === 'string' && UUID.test(v));
    return this.read(actor, async (db, tenant) => {
      const rows = await db.query<Json>(
        `SELECT id,agent_id,route_id,route_revision,start_date::text AS start_date,end_date::text AS end_date,
        days_iso,time_zone,starts_local::text AS starts_local,ends_local::text AS ends_local,state,version,created_at,updated_at
        FROM route_schedule_rule WHERE tenant_id=$1 AND ($2::uuid IS NULL OR agent_id=$2) AND ($3::uuid IS NULL OR route_id=$3)
        AND ($4::text IS NULL OR state=$4) AND ($5::uuid IS NULL OR id>$5) ORDER BY id LIMIT $6`,
        [tenant, agentId, routeId, state, after, limit + 1],
      );
      const items = rows.rows.slice(0, limit).map(clean);
      return {
        items,
        next_cursor:
          rows.rows.length > limit
            ? Buffer.from(JSON.stringify(items.at(-1)?.id)).toString('base64url')
            : null,
      };
    });
  }
  async patchRule(ctx: ScheduleContext, ruleId: string, input: unknown): Promise<Result> {
    return this.mutate(ctx, input, async (db, tenant) => {
      const rows = await db.query<Json>(
        'SELECT * FROM route_schedule_rule WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [tenant, uuid(ruleId)],
      );
      if (!rows.rows[0]) throw missing();
      const prior = rows.rows[0];
      precondition(ctx.ifMatch, Number(prior.version));
      const fields = this.ruleFields(input, prior);
      if (fields.state === 'ACTIVE') await this.validateRuleRefs(db, tenant, fields);
      const row = first(
        (
          await db.query<Json>(
            `UPDATE route_schedule_rule SET agent_id=$3,route_id=$4,route_revision=$5,start_date=$6,end_date=$7,
        days_iso=$8,time_zone=$9,starts_local=$10,ends_local=$11,state=$12,version=version+1,updated_by=$13,updated_at=now()
        WHERE tenant_id=$1 AND id=$2 RETURNING id,agent_id,route_id,route_revision,start_date::text AS start_date,
        end_date::text AS end_date,days_iso,time_zone,starts_local::text AS starts_local,ends_local::text AS ends_local,state,version,updated_at`,
            [
              tenant,
              ruleId,
              fields.agentId,
              fields.routeId,
              fields.routeRevision,
              fields.startDate,
              fields.endDate,
              fields.daysIso,
              fields.timeZone,
              fields.startsLocal,
              fields.endsLocal,
              fields.state,
              ctx.actorId,
            ],
          )
        ).rows,
      );
      await this.audit(db, ctx, 'schedule.rule.update', tenant, {
        rule_id: ruleId,
        version: Number(row.version),
      });
      return {
        status: 200,
        body: { ...row, exceptions: await this.exceptions(db, tenant, ruleId) },
        etag: etag(Number(row.version)),
      };
    });
  }
  async putException(
    ctx: ScheduleContext,
    ruleId: string,
    localDate: string,
    input: unknown,
  ): Promise<Result> {
    const body = object(
      input,
      ['action', 'replacement_route_id', 'replacement_revision', 'reason'],
      ['action', 'reason'],
    );
    const when = date(localDate),
      reason = label(body.reason, 240, 8),
      action = body.action;
    if (action !== 'SKIP' && action !== 'CANCEL' && action !== 'REPLACE') throw invalid();
    const replacementRouteId = action === 'REPLACE' ? uuid(body.replacement_route_id) : null;
    const replacementRevision = action === 'REPLACE' ? Number(body.replacement_revision) : null;
    if (
      action === 'REPLACE' &&
      (replacementRevision === null ||
        !Number.isInteger(replacementRevision) ||
        replacementRevision < 1)
    )
      throw invalid();
    if (
      action !== 'REPLACE' &&
      (body.replacement_route_id !== undefined || body.replacement_revision !== undefined)
    )
      throw invalid();
    return this.mutate(ctx, body, async (db, tenant) => {
      const rows = await db.query<Json>(
        'SELECT * FROM route_schedule_rule WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [tenant, uuid(ruleId)],
      );
      if (!rows.rows[0]) throw missing();
      const rule = rows.rows[0];
      precondition(ctx.ifMatch, Number(rule.version));
      const start = String(
        rule.start_date instanceof Date
          ? rule.start_date.toISOString().slice(0, 10)
          : rule.start_date,
      );
      const end = rule.end_date
        ? String(
            rule.end_date instanceof Date
              ? rule.end_date.toISOString().slice(0, 10)
              : rule.end_date,
          )
        : null;
      if (
        when < start ||
        (end && when > end) ||
        !(rule.days_iso as number[]).includes(isoDay(when))
      )
        throw invalid();
      if (action === 'REPLACE')
        await this.validateRuleRefs(db, tenant, {
          agentId: String(rule.agent_id),
          routeId: replacementRouteId ?? '',
          routeRevision: replacementRevision ?? 0,
        });
      await db.query(
        `INSERT INTO route_schedule_exception(tenant_id,rule_id,local_date,action,replacement_route_id,replacement_revision,reason,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT(rule_id,local_date) DO UPDATE SET action=EXCLUDED.action,
        replacement_route_id=EXCLUDED.replacement_route_id,replacement_revision=EXCLUDED.replacement_revision,
        reason=EXCLUDED.reason,updated_by=EXCLUDED.updated_by,updated_at=now()`,
        [
          tenant,
          ruleId,
          when,
          action,
          replacementRouteId,
          replacementRevision,
          reason,
          ctx.actorId,
        ],
      );
      const updated = await db.query<{ version: string }>(
        'UPDATE route_schedule_rule SET version=version+1,updated_by=$3,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING version',
        [tenant, ruleId, ctx.actorId],
      );
      await this.audit(db, ctx, 'schedule.exception.upsert', tenant, {
        rule_id: ruleId,
        local_date: when,
        action,
      });
      const version = Number(updated.rows[0]?.version);
      return {
        status: 200,
        body: {
          rule_id: ruleId,
          local_date: when,
          action,
          replacement_route_id: replacementRouteId,
          replacement_revision: replacementRevision,
          reason,
          version,
        },
        etag: etag(version),
      };
    });
  }
  async materialize(ctx: ScheduleContext, ruleId: string, input: unknown): Promise<Result> {
    const body = object(input, ['from', 'to'], ['from', 'to']);
    const from = date(body.from),
      to = date(body.to),
      count = span(from, to);
    return this.mutate(ctx, body, async (db, tenant) => {
      const rows = await db.query<Json>(
        'SELECT * FROM route_schedule_rule WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
        [tenant, uuid(ruleId)],
      );
      if (!rows.rows[0]) throw missing();
      const rule = rows.rows[0];
      precondition(ctx.ifMatch, Number(rule.version));
      if (from < todayInZone(String(rule.time_zone)))
        throw new ApiError(422, 'past_materialization', 'Invalid request');
      const start = String(
        rule.start_date instanceof Date
          ? rule.start_date.toISOString().slice(0, 10)
          : rule.start_date,
      );
      const end = rule.end_date
        ? String(
            rule.end_date instanceof Date
              ? rule.end_date.toISOString().slice(0, 10)
              : rule.end_date,
          )
        : null;
      let generated = 0,
        cancelled = 0,
        skipped = 0,
        unchanged = 0;
      let current = from;
      for (let i = 0; i < count; i++, current = nextDate(current)) {
        if (
          current < start ||
          (end && current > end) ||
          !(rule.days_iso as number[]).includes(isoDay(current))
        )
          continue;
        const exception = await db.query<Json>(
          'SELECT * FROM route_schedule_exception WHERE tenant_id=$1 AND rule_id=$2 AND local_date=$3',
          [tenant, ruleId, current],
        );
        const action = exception.rows[0]?.action;
        const outcome =
          rule.state !== 'ACTIVE' || action === 'SKIP' || action === 'CANCEL'
            ? action === 'CANCEL'
              ? 'CANCELLED'
              : 'SKIPPED'
            : 'GENERATED';
        const prior = await db.query<Json>(
          'SELECT * FROM route_schedule_occurrence WHERE tenant_id=$1 AND rule_id=$2 AND local_date=$3 FOR UPDATE',
          [tenant, ruleId, current],
        );
        if (prior.rows[0] && Number(prior.rows[0].applied_version) === Number(rule.version)) {
          unchanged++;
          continue;
        }
        if (prior.rows[0]?.assignment_id) {
          const previous = await db.query<Json>(
            'SELECT state,starts_at FROM route_assignment WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
            [tenant, prior.rows[0].assignment_id],
          );
          if (previous.rows[0]?.state === 'PLANNED') {
            if (new Date(String(previous.rows[0].starts_at)).getTime() <= Date.now()) {
              unchanged++;
              continue;
            }
            await this.cancelRow(
              db,
              tenant,
              String(prior.rows[0].assignment_id),
              ctx.actorId,
              'Cambio de regla o excepción',
            );
            cancelled++;
          }
        }
        let assignmentId: string | null = null;
        if (outcome === 'GENERATED') {
          const routeId = String(
            action === 'REPLACE' ? exception.rows[0]?.replacement_route_id : rule.route_id,
          );
          const routeRevision = Number(
            action === 'REPLACE' ? exception.rows[0]?.replacement_revision : rule.route_revision,
          );
          const localStart = String(rule.starts_local).slice(0, 5),
            localEnd = String(rule.ends_local).slice(0, 5);
          const startsAt = resolveLocal(current, localStart, String(rule.time_zone)),
            endsAt = resolveLocal(current, localEnd, String(rule.time_zone));
          const created = await this.insertAssignment(db, tenant, ctx.actorId, {
            agentId: String(rule.agent_id),
            routeId,
            routeRevision,
            localDate: current,
            timeZone: String(rule.time_zone),
            startsAt,
            endsAt,
            reason: 'Asignación por regla recurrente',
            origin: 'RECURRENCE',
            ruleId,
          });
          assignmentId = String(created.id);
          generated++;
        } else skipped++;
        await db.query(
          `INSERT INTO route_schedule_occurrence(tenant_id,rule_id,local_date,applied_version,assignment_id,outcome)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(rule_id,local_date) DO UPDATE SET applied_version=EXCLUDED.applied_version,
          assignment_id=EXCLUDED.assignment_id,outcome=EXCLUDED.outcome,updated_at=now()`,
          [tenant, ruleId, current, rule.version, assignmentId, outcome],
        );
      }
      await this.audit(db, ctx, 'schedule.rule.materialize', tenant, {
        rule_id: ruleId,
        generated,
        cancelled,
        skipped,
        unchanged,
      });
      return {
        status: 200,
        body: {
          rule_id: ruleId,
          from,
          to,
          generated,
          cancelled,
          skipped,
          unchanged,
          version: Number(rule.version),
        },
        etag: etag(Number(rule.version)),
      };
    });
  }
}
