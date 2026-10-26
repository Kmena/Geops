import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from './audit/index.js';
import { ApiError } from './errors.js';

type Json = Record<string, unknown>;
export type DeviceLinkMutation = {
  actorId: string;
  requestId: string;
  key: string;
  method: string;
  path: string;
  ifMatch?: string;
};
type Result = { status: number; body: Json; etag?: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid = () => new ApiError(422, 'invalid_request', 'Invalid request');
const missing = () => new ApiError(404, 'not_found', 'Not found');
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value;
};
const reason = (value: unknown): string => {
  if (typeof value !== 'string' || value.trim().length < 8 || value.trim().length > 240)
    throw invalid();
  return value.trim();
};
const instant = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value))
    throw invalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw invalid();
  return parsed.toISOString();
};
const body = (value: unknown, keys: string[], required: string[]): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const result = value as Json;
  if (
    Object.keys(result).some((key) => !keys.includes(key)) ||
    required.some((key) => !(key in result))
  )
    throw invalid();
  return result;
};
const etag = (version: number) => `"${version}"`;
const precondition = (given: string | undefined, version: number) => {
  if (!given) throw new ApiError(428, 'precondition_required', 'Precondition required');
  if (given !== etag(version)) throw new ApiError(412, 'stale_version', 'Precondition failed');
};
const conflict = (error: unknown): never => {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    ['23P01', '23505', '23503', '23514'].includes(String(error.code))
  )
    throw new ApiError(409, 'device_link_conflict', 'Conflict');
  throw error;
};
const first = (rows: Json[]): Json => {
  if (!rows[0]) throw new Error('Device link write returned no row');
  return rows[0];
};

export class AgentDeviceLinkService {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async access(db: PoolClient, actor: string, permission: string): Promise<string> {
    const rows = await db.query<{ tenant_id: string }>(
      `SELECT t.tenant_id FROM geops_operating_tenant t
       JOIN admin_user u ON u.id=$1 AND u.state='ACTIVE'
       JOIN gps_data_tenant_access a ON a.admin_id=u.id AND a.tenant_id=t.tenant_id AND a.revoked_at IS NULL
       JOIN admin_permission p ON p.admin_id=u.id AND p.permission=$2 AND p.revoked_at IS NULL
       WHERE t.singleton=true`,
      [actor, permission],
    );
    if (!rows.rows[0]) throw new ApiError(403, 'device_link_forbidden', 'Forbidden');
    return rows.rows[0].tenant_id;
  }

  private async read<T>(
    actor: string,
    run: (db: PoolClient, tenant: string) => Promise<T>,
  ): Promise<T> {
    const db = await this.pool.connect();
    try {
      return await run(db, await this.access(db, actor, 'visit.device.read'));
    } finally {
      db.release();
    }
  }

  private async mutate(
    ctx: DeviceLinkMutation,
    input: unknown,
    run: (db: PoolClient, tenant: string) => Promise<Result>,
  ): Promise<Result> {
    id(ctx.key);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const tenant = await this.access(db, ctx.actorId, 'visit.device.write');
      const hash = createHash('sha256')
        .update(
          JSON.stringify({
            method: ctx.method,
            path: ctx.path,
            body: input,
            ifMatch: ctx.ifMatch ?? null,
          }),
        )
        .digest();
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${ctx.actorId}:${ctx.key}`]);
      const prior = await db.query<{
        payload_digest: Buffer;
        response_status: number;
        response_body: Json;
      }>(
        'SELECT payload_digest,response_status,response_body FROM visit_schedule_idempotency WHERE actor_id=$1 AND request_key=$2',
        [ctx.actorId, ctx.key],
      );
      if (prior.rows[0]) {
        if (!prior.rows[0].payload_digest.equals(hash))
          throw new ApiError(409, 'idempotency_conflict', 'Conflict');
        await db.query('COMMIT');
        return { status: prior.rows[0].response_status, body: prior.rows[0].response_body };
      }
      const result = await run(db, tenant);
      await db.query(
        `INSERT INTO visit_schedule_idempotency(actor_id,request_key,method,path,payload_digest,response_status,response_body)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          ctx.actorId,
          ctx.key,
          ctx.method,
          ctx.path,
          hash,
          result.status,
          JSON.stringify(result.body),
        ],
      );
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      return conflict(error);
    } finally {
      db.release();
    }
  }

  private async activeAgent(db: PoolClient, tenant: string, agentId: string) {
    const result = await db.query<{ state: string }>(
      'SELECT state FROM agent WHERE tenant_id=$1 AND id=$2 FOR SHARE',
      [tenant, agentId],
    );
    if (!result.rows[0]) throw missing();
    if (result.rows[0].state !== 'ACTIVE') throw new ApiError(409, 'agent_inactive', 'Conflict');
  }

  private async eligibleDevice(db: PoolClient, tenant: string, deviceId: string, actor: string) {
    const device = await db.query<{ status: string }>(
      'SELECT status FROM geops_device WHERE id=$1 FOR UPDATE',
      [deviceId],
    );
    if (!device.rows[0]) throw missing();
    if (device.rows[0].status !== 'ACTIVE') throw new ApiError(409, 'device_inactive', 'Conflict');
    const proof = await db.query(
      `SELECT 1 FROM device_key k JOIN gps_device_installation i ON i.device_id=k.geops_device_id
       AND i.retired_at IS NULL WHERE k.geops_device_id=$1 AND k.status='ACTIVE' LIMIT 1`,
      [deviceId],
    );
    if (!proof.rowCount) throw new ApiError(409, 'device_not_authorized', 'Conflict');
    const owner = await db.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM geops_device_tenant WHERE device_id=$1 FOR SHARE',
      [deviceId],
    );
    if (owner.rows[0]) {
      if (owner.rows[0].tenant_id !== tenant) throw missing();
      return;
    }
    const binding = await db.query<{ id: string }>(
      `SELECT b.id FROM mdm_binding b JOIN gps_device_installation i
       ON i.device_id=b.geops_device_id AND i.activation_binding_id=b.id
       AND i.activation_tenant_id=b.customer_id AND i.retired_at IS NULL
       WHERE b.geops_device_id=$1 AND b.customer_id=$2 AND b.state='ACTIVE'
       AND b.verified_at IS NOT NULL FOR SHARE OF b`,
      [deviceId, tenant],
    );
    const selected = binding.rows[0];
    if (binding.rows.length !== 1 || !selected)
      throw new ApiError(409, 'device_tenant_unverified', 'Conflict');
    await db.query(
      `INSERT INTO geops_device_tenant(device_id,tenant_id,established_by,source,evidence_ref)
       VALUES($1,$2,$3,'VERIFIED_BINDING',$4)`,
      [deviceId, tenant, actor, selected.id],
    );
  }

  /** Activate a pre-enrolled GEOPS key without inventing an MDM identity. */
  async authorizeGeopsDevice(
    ctx: DeviceLinkMutation,
    deviceId: string,
    input: unknown,
  ): Promise<Result> {
    const value = body(input, ['reason'], ['reason']);
    const why = reason(value.reason);
    return this.mutate(ctx, input, async (db, tenant) => {
      const capability = await db.query(
        "SELECT 1 FROM admin_permission WHERE admin_id=$1 AND permission='gps.installation.manage' AND revoked_at IS NULL",
        [ctx.actorId],
      );
      if (!capability.rowCount) throw new ApiError(403, 'device_link_forbidden', 'Forbidden');
      const device = await db.query<{ status: string }>(
        'SELECT status FROM geops_device WHERE id=$1 FOR UPDATE',
        [id(deviceId)],
      );
      if (!device.rows[0]) throw missing();
      if (device.rows[0].status !== 'ACTIVE')
        throw new ApiError(409, 'device_inactive', 'Conflict');
      const key = await db.query<{ id: string }>(
        "SELECT id FROM device_key WHERE geops_device_id=$1 AND status='ACTIVE' FOR SHARE",
        [deviceId],
      );
      if (key.rows.length !== 1 || !key.rows[0])
        throw new ApiError(409, 'device_not_authorized', 'Conflict');
      const bindings = await db.query(
        "SELECT 1 FROM mdm_binding WHERE geops_device_id=$1 AND state='ACTIVE' FOR SHARE",
        [deviceId],
      );
      if (bindings.rowCount) throw new ApiError(409, 'binding_conflict', 'Conflict');
      const owner = await db.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM geops_device_tenant WHERE device_id=$1 FOR SHARE',
        [deviceId],
      );
      if (owner.rows[0] && owner.rows[0].tenant_id !== tenant) throw missing();
      const active = await db.query(
        'SELECT 1 FROM gps_device_installation WHERE device_id=$1 AND retired_at IS NULL FOR UPDATE',
        [deviceId],
      );
      if (active.rowCount) throw new ApiError(409, 'installation_exists', 'Conflict');
      if (!owner.rows[0])
        await db.query(
          `INSERT INTO geops_device_tenant(device_id,tenant_id,established_by,source,evidence_ref)
           VALUES($1,$2,$3,'GEOPS_ENROLLMENT',$4)`,
          [deviceId, tenant, ctx.actorId, key.rows[0].id],
        );
      const installationId = randomUUID();
      await db.query(
        `INSERT INTO gps_device_installation(installation_id,device_id,activated_at,activation_tenant_id)
         VALUES($1,$2,now(),$3)`,
        [installationId, deviceId, tenant],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: ctx.actorId,
        deviceId,
        action: 'gps.installation.authorize_geops',
        outcome: 'success',
        correlationId: ctx.requestId,
        metadata: {
          tenant_id: tenant,
          installation_id: installationId,
          key_id: key.rows[0].id,
          reason: why,
        },
      });
      return {
        status: 201,
        body: {
          device_id: deviceId,
          installation_id: installationId,
          tenant_id: tenant,
          identity: 'GEOPS',
        },
      };
    });
  }

  private async linkRow(db: PoolClient, tenant: string, linkId: string) {
    const rows = await db.query<{
      id: string;
      tenant_id: string;
      agent_id: string;
      device_id: string;
      valid_from: Date;
      valid_to: Date | null;
      state: string;
      version: string;
    }>('SELECT * FROM agent_device_link WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenant, linkId]);
    if (!rows.rows[0]) throw missing();
    return rows.rows[0];
  }

  private async queueAffected(
    db: PoolClient,
    tenant: string,
    agentId: string,
    from: string,
    to: string | null,
    actor: string,
  ) {
    const algorithm = await db.query<{ revision: number }>(
      `SELECT revision FROM visit_algorithm_revision WHERE algorithm_id='dwell-pair-v1'
       AND (scope='APPROVED' OR (scope='TECHNICAL_ONLY' AND $1
         AND current_database() ~ '^geops_verify_[0-9]+$'))
       ORDER BY (scope='APPROVED') DESC,revision DESC LIMIT 1`,
      [process.env.GEOPS_DATA_MODE === 'synthetic'],
    );
    if (!algorithm.rows[0]) return;
    const revision = Number(algorithm.rows[0].revision);
    const assignments = await db.query<{ id: string }>(
      `SELECT id FROM route_assignment WHERE tenant_id=$1 AND agent_id=$2 AND state='PLANNED'
       AND ends_at>$3 AND starts_at<coalesce($4::timestamptz,'infinity'::timestamptz)
       ORDER BY id LIMIT 101`,
      [tenant, agentId, from, to],
    );
    if (assignments.rows.length > 100)
      throw new ApiError(422, 'recompute_window_too_large', 'Invalid request');
    for (const assignment of assignments.rows)
      await db.query(
        `INSERT INTO visit_evaluation_job(tenant_id,assignment_id,algorithm_id,algorithm_revision,
         state,reason,requested_by)
         VALUES($1,$2,'dwell-pair-v1',$4,'PENDING','Agent device link changed',$3)
         ON CONFLICT(tenant_id,assignment_id) DO UPDATE SET state='PENDING',
         algorithm_revision=EXCLUDED.algorithm_revision,
         reason=EXCLUDED.reason,requested_by=EXCLUDED.requested_by,requested_at=now(),
         next_attempt_at=now(),attempts=0,started_at=NULL,finished_at=NULL,last_error_code=NULL
         WHERE visit_evaluation_job.state IN ('DONE','FAILED')`,
        [tenant, assignment.id, actor, revision],
      );
  }

  async link(ctx: DeviceLinkMutation, input: unknown): Promise<Result> {
    const value = body(
      input,
      ['agent_id', 'device_id', 'valid_from', 'reason'],
      ['agent_id', 'device_id', 'reason'],
    );
    const agentId = id(value.agent_id),
      deviceId = id(value.device_id);
    const from =
      value.valid_from === undefined ? this.now().toISOString() : instant(value.valid_from);
    const why = reason(value.reason);
    return this.mutate(ctx, input, async (db, tenant) => {
      await this.activeAgent(db, tenant, agentId);
      await this.eligibleDevice(db, tenant, deviceId, ctx.actorId);
      const linkId = randomUUID();
      const rows = await db.query<Json>(
        `INSERT INTO agent_device_link(id,tenant_id,agent_id,device_id,valid_from,state,created_by,create_reason)
         VALUES($1,$2,$3,$4,$5,'ACTIVE',$6,$7)
         RETURNING id,tenant_id,agent_id,device_id,valid_from,valid_to,state,version`,
        [linkId, tenant, agentId, deviceId, from, ctx.actorId, why],
      );
      await this.queueAffected(db, tenant, agentId, from, null, ctx.actorId);
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: ctx.actorId,
        action: 'visit.device.link',
        outcome: 'success',
        correlationId: ctx.requestId,
        metadata: {
          tenant_id: tenant,
          link_id: linkId,
          agent_id: agentId,
          device_id: deviceId,
          reason: why,
        },
      });
      return { status: 201, body: first(rows.rows), etag: etag(1) };
    });
  }

  async end(ctx: DeviceLinkMutation, linkId: string, input: unknown): Promise<Result> {
    const value = body(input, ['valid_to', 'reason', 'mode'], ['reason']);
    const to = value.valid_to === undefined ? this.now().toISOString() : instant(value.valid_to);
    const why = reason(value.reason);
    const mode = value.mode === undefined ? 'END' : value.mode;
    if (mode !== 'END' && mode !== 'REVOKE') throw invalid();
    return this.mutate(ctx, input, async (db, tenant) => {
      const current = await this.linkRow(db, tenant, id(linkId));
      precondition(ctx.ifMatch, Number(current.version));
      if (current.state !== 'ACTIVE') throw new ApiError(409, 'device_link_inactive', 'Conflict');
      if (Date.parse(to) <= current.valid_from.getTime()) throw invalid();
      const rows = await db.query<Json>(
        `UPDATE agent_device_link SET state=$3,valid_to=$4,ended_by=$5,ended_at=now(),
         end_reason=$6,version=version+1 WHERE tenant_id=$1 AND id=$2
         RETURNING id,tenant_id,agent_id,device_id,valid_from,valid_to,state,version`,
        [tenant, current.id, mode === 'END' ? 'ENDED' : 'REVOKED', to, ctx.actorId, why],
      );
      await this.queueAffected(
        db,
        tenant,
        current.agent_id,
        current.valid_from.toISOString(),
        null,
        ctx.actorId,
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: ctx.actorId,
        action: mode === 'END' ? 'visit.device.end' : 'visit.device.revoke',
        outcome: 'success',
        correlationId: ctx.requestId,
        metadata: { tenant_id: tenant, link_id: current.id, valid_to: to, reason: why },
      });
      return { status: 200, body: first(rows.rows), etag: etag(Number(current.version) + 1) };
    });
  }

  async reassign(ctx: DeviceLinkMutation, linkId: string, input: unknown): Promise<Result> {
    const value = body(input, ['agent_id', 'at', 'reason'], ['agent_id', 'reason']);
    const target = id(value.agent_id);
    const at = value.at === undefined ? this.now().toISOString() : instant(value.at);
    const why = reason(value.reason);
    return this.mutate(ctx, input, async (db, tenant) => {
      const current = await this.linkRow(db, tenant, id(linkId));
      precondition(ctx.ifMatch, Number(current.version));
      if (current.state !== 'ACTIVE' || current.agent_id === target)
        throw new ApiError(409, 'device_link_conflict', 'Conflict');
      if (Date.parse(at) <= current.valid_from.getTime()) throw invalid();
      await this.activeAgent(db, tenant, target);
      await this.eligibleDevice(db, tenant, current.device_id, ctx.actorId);
      await db.query(
        `UPDATE agent_device_link SET state='ENDED',valid_to=$3,ended_by=$4,ended_at=now(),
         end_reason=$5,version=version+1 WHERE tenant_id=$1 AND id=$2`,
        [tenant, current.id, at, ctx.actorId, why],
      );
      const nextId = randomUUID();
      const rows = await db.query<Json>(
        `INSERT INTO agent_device_link(id,tenant_id,agent_id,device_id,valid_from,state,created_by,create_reason)
         VALUES($1,$2,$3,$4,$5,'ACTIVE',$6,$7)
         RETURNING id,tenant_id,agent_id,device_id,valid_from,valid_to,state,version`,
        [nextId, tenant, target, current.device_id, at, ctx.actorId, why],
      );
      await this.queueAffected(
        db,
        tenant,
        current.agent_id,
        current.valid_from.toISOString(),
        null,
        ctx.actorId,
      );
      await this.queueAffected(db, tenant, target, at, null, ctx.actorId);
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: ctx.actorId,
        action: 'visit.device.reassign',
        outcome: 'success',
        correlationId: ctx.requestId,
        metadata: {
          tenant_id: tenant,
          from_link_id: current.id,
          link_id: nextId,
          from_agent_id: current.agent_id,
          agent_id: target,
          device_id: current.device_id,
          at,
          reason: why,
        },
      });
      return { status: 201, body: first(rows.rows), etag: etag(1) };
    });
  }

  async current(actor: string, agentId: string) {
    return this.read(actor, async (db, tenant) => {
      const agent = await db.query('SELECT 1 FROM agent WHERE tenant_id=$1 AND id=$2', [
        tenant,
        id(agentId),
      ]);
      if (!agent.rowCount) throw missing();
      const rows = await db.query<Json>(
        `SELECT id,agent_id,device_id,valid_from,state,version
         FROM agent_device_link WHERE tenant_id=$1 AND agent_id=$2 AND state<>'REVOKED'
         AND valid_from<=now() AND now()<coalesce(valid_to,'infinity'::timestamptz)
         ORDER BY valid_from DESC LIMIT 1`,
        [tenant, agentId],
      );
      return { agent_id: agentId, link: rows.rows[0] ?? null };
    });
  }

  async history(actor: string, agentId: string) {
    return this.read(actor, async (db, tenant) => {
      const agent = await db.query('SELECT 1 FROM agent WHERE tenant_id=$1 AND id=$2', [
        tenant,
        id(agentId),
      ]);
      if (!agent.rowCount) throw missing();
      const rows = await db.query<Json>(
        `SELECT id,agent_id,device_id,valid_from,valid_to,state,version,
         created_by,created_at,create_reason,ended_by,ended_at,end_reason
         FROM agent_device_link WHERE tenant_id=$1 AND agent_id=$2
         ORDER BY valid_from DESC,id LIMIT 100`,
        [tenant, agentId],
      );
      return { agent_id: agentId, items: rows.rows };
    });
  }

  async availableDevices(actor: string) {
    return this.read(actor, async (db, tenant) => {
      const rows = await db.query<Json>(
        `SELECT d.id,d.display_label,d.status
         FROM geops_device d WHERE d.status='ACTIVE'
         AND EXISTS(SELECT 1 FROM device_key k WHERE k.geops_device_id=d.id AND k.status='ACTIVE')
         AND EXISTS(SELECT 1 FROM gps_device_installation i
           WHERE i.device_id=d.id AND i.retired_at IS NULL)
         AND (
           EXISTS(SELECT 1 FROM geops_device_tenant t WHERE t.device_id=d.id AND t.tenant_id=$1)
           OR (
             NOT EXISTS(SELECT 1 FROM geops_device_tenant t WHERE t.device_id=d.id)
             AND (SELECT count(*) FROM mdm_binding b JOIN gps_device_installation i
               ON i.device_id=b.geops_device_id AND i.activation_binding_id=b.id
               AND i.activation_tenant_id=b.customer_id AND i.retired_at IS NULL
               WHERE b.geops_device_id=d.id AND b.customer_id=$1 AND b.state='ACTIVE'
               AND b.verified_at IS NOT NULL)=1
           )
         )
         AND NOT EXISTS(SELECT 1 FROM agent_device_link l WHERE l.device_id=d.id
           AND l.state<>'REVOKED' AND l.valid_from<=now()
           AND now()<coalesce(l.valid_to,'infinity'::timestamptz))
         ORDER BY d.id LIMIT 100`,
        [tenant],
      );
      return { items: rows.rows };
    });
  }

  async unassignedAgents(actor: string) {
    return this.read(actor, async (db, tenant) => {
      const rows = await db.query<Json>(
        `SELECT a.id,a.code,a.name FROM agent a
         WHERE a.tenant_id=$1 AND a.state='ACTIVE'
         AND NOT EXISTS(SELECT 1 FROM agent_device_link l WHERE l.tenant_id=a.tenant_id
           AND l.agent_id=a.id AND l.state<>'REVOKED' AND l.valid_from<=now()
           AND now()<coalesce(l.valid_to,'infinity'::timestamptz))
         ORDER BY a.code,a.id LIMIT 100`,
        [tenant],
      );
      return { items: rows.rows };
    });
  }
}
