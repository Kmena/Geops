import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from './audit/index.js';
import { ApiError } from './errors.js';
import { validatePolicy, windowsForRange, type GpsPolicySpec } from './gps-policy-windows.js';

export type GpsCapability =
  | 'gps.policy.read'
  | 'gps.policy.write'
  | 'gps.policy.assign'
  | 'gps.policy.activate'
  | 'gps.session.read'
  | 'gps.location.read'
  | 'gps.audit.read'
  | 'gps.installation.manage'
  | 'gps.tenant.grant';
export interface MutationContext {
  adminId: string;
  requestId: string;
  method: string;
  path: string;
  key: string;
  ifMatch?: string;
  rawBody: Buffer;
}
export interface MutationResult {
  status: number;
  body: Record<string, unknown>;
  etag?: string;
  additionalCapabilities?: GpsCapability[];
}
interface PolicyRow {
  id: string;
  name: string;
  state: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'REVOKED';
  version: string;
  current_revision: number;
  draft_config: GpsPolicySpec;
}
interface AssignmentInput {
  scope_type: 'DEVICE' | 'GROUP';
  scope_id: string;
  valid_from: string;
  valid_until: string;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const reasonOk = (reason: unknown): reason is string =>
  typeof reason === 'string' && reason.length >= 8 && reason.length <= 240;
const asIso = (value: Date | string): string => new Date(value).toISOString();
const policyEtag = (row: Pick<PolicyRow, 'id' | 'version'>): string =>
  `"gps-policy:${row.id}:${row.version}"`;
const groupEtag = (id: string, version: string): string => `"gps-group:${id}:${version}"`;
const invalid = (): never => {
  throw new ApiError(422, 'invalid_request', 'Invalid request');
};
const conflict = (code = 'version_conflict'): never => {
  throw new ApiError(409, code, 'Conflict');
};
function decodeCursor(cursor: string | undefined, kind: 'p' | 'g'): string | null {
  if (cursor === undefined) return null;
  if (cursor.length > 128) return invalid();
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const id = decoded.slice(2);
  if (
    decoded !== `${kind}:${id}` ||
    !uuid.test(id) ||
    Buffer.from(decoded).toString('base64url') !== cursor
  )
    return invalid();
  return id;
}
const encodeCursor = (id: string, kind: 'p' | 'g'): string =>
  Buffer.from(`${kind}:${id}`).toString('base64url');

function assignments(input: unknown): AssignmentInput[] {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== 'assignments')
  )
    return invalid();
  const items = (input as { assignments?: unknown }).assignments;
  if (!Array.isArray(items) || items.length > 500) return invalid();
  return items.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return invalid();
    const a = item as Record<string, unknown>;
    if (
      Object.keys(a).some(
        (key) => !['scope_type', 'scope_id', 'valid_from', 'valid_until'].includes(key),
      ) ||
      (a.scope_type !== 'DEVICE' && a.scope_type !== 'GROUP') ||
      typeof a.scope_id !== 'string' ||
      !uuid.test(a.scope_id) ||
      typeof a.valid_from !== 'string' ||
      typeof a.valid_until !== 'string' ||
      !utc.test(a.valid_from) ||
      !utc.test(a.valid_until) ||
      !Number.isFinite(Date.parse(a.valid_from)) ||
      !Number.isFinite(Date.parse(a.valid_until)) ||
      Date.parse(a.valid_from) >= Date.parse(a.valid_until)
    )
      return invalid();
    return a as unknown as AssignmentInput;
  });
}

export class GpsPolicyService {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async requireCapability(
    adminId: string,
    capability: GpsCapability,
    requestId: string,
    db: Pool | PoolClient = this.pool,
  ): Promise<void> {
    const result = await db.query(
      'SELECT 1 FROM admin_permission WHERE admin_id=$1 AND permission=$2 AND revoked_at IS NULL',
      [adminId, capability],
    );
    if (result.rowCount) return;
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'gps.permission.denied',
      outcome: 'rejected',
      correlationId: requestId,
      metadata: { permission: capability },
    });
    throw new ApiError(403, 'gps_forbidden', 'Forbidden');
  }

  private async requireLockedCapabilities(
    db: PoolClient,
    ctx: MutationContext,
    capabilities: GpsCapability[],
  ): Promise<void> {
    for (const capability of capabilities) {
      const found = await db.query(
        'SELECT 1 FROM admin_permission WHERE admin_id=$1 AND permission=$2 AND revoked_at IS NULL FOR SHARE',
        [ctx.adminId, capability],
      );
      if (!found.rowCount) throw new ApiError(403, 'gps_forbidden', 'Forbidden');
    }
  }

  private async mutate(
    ctx: MutationContext,
    capabilities: GpsCapability[],
    action: string,
    work: (db: PoolClient) => Promise<MutationResult>,
  ): Promise<MutationResult> {
    if (!uuid.test(ctx.key) || (ctx.ifMatch !== undefined && ctx.ifMatch.length > 200))
      return invalid();
    const digest = createHash('sha256')
      .update(ctx.rawBody)
      .update('\0')
      .update(ctx.ifMatch ?? '')
      .digest();
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      // Lock capability rows before reading receipts: revocation cannot race with a replay.
      await this.requireLockedCapabilities(db, ctx, capabilities);
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `gps-idem:${ctx.adminId}:${ctx.method}:${ctx.path}:${ctx.key}`,
      ]);
      const prior = await db.query<{
        body_precondition_digest: Buffer;
        response_status: number;
        response_body: Record<string, unknown>;
        response_etag: string | null;
        additional_capabilities: GpsCapability[];
        expires_at: Date;
      }>(
        'SELECT body_precondition_digest,response_status,response_body,response_etag,additional_capabilities,expires_at FROM gps_admin_idempotency WHERE admin_id=$1 AND method=$2 AND path=$3 AND key=$4 FOR UPDATE',
        [ctx.adminId, ctx.method, ctx.path, ctx.key],
      );
      const receipt = prior.rows[0];
      if (receipt && receipt.expires_at > this.now()) {
        if (!receipt.body_precondition_digest.equals(digest))
          return conflict('idempotency_conflict');
        await this.requireLockedCapabilities(db, ctx, receipt.additional_capabilities);
        await db.query('COMMIT');
        return {
          status: receipt.response_status,
          body: receipt.response_body,
          ...(receipt.response_etag ? { etag: receipt.response_etag } : {}),
        };
      }
      if (receipt)
        await db.query(
          'DELETE FROM gps_admin_idempotency WHERE admin_id=$1 AND method=$2 AND path=$3 AND key=$4',
          [ctx.adminId, ctx.method, ctx.path, ctx.key],
        );
      const result = await work(db);
      const created = this.now();
      await db.query(
        'INSERT INTO gps_admin_idempotency(admin_id,method,path,key,body_precondition_digest,response_status,response_body,response_etag,additional_capabilities,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          ctx.adminId,
          ctx.method,
          ctx.path,
          ctx.key,
          digest,
          result.status,
          JSON.stringify(result.body),
          result.etag ?? null,
          result.additionalCapabilities ?? [],
          created,
          new Date(created.getTime() + 24 * 3600_000),
        ],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: ctx.adminId,
        action,
        outcome: 'success',
        correlationId: ctx.requestId,
        metadata: { path: ctx.path },
      });
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      const pgCode = (error as { code?: string }).code;
      const mapped =
        pgCode === '23P01' || pgCode === '23505' || pgCode === '40P01' || pgCode === '40001'
          ? new ApiError(409, 'gps_conflict', 'Conflict')
          : error;
      if (mapped instanceof ApiError && (mapped.statusCode === 403 || mapped.statusCode === 409)) {
        await appendAudit(this.pool, {
          actorType: 'ADMIN',
          actorId: ctx.adminId,
          action,
          outcome: 'rejected',
          correlationId: ctx.requestId,
          metadata: { code: mapped.code },
        });
      }
      throw mapped;
    } finally {
      db.release();
    }
  }

  private async lockResources(db: PoolClient, values: string[]): Promise<void> {
    for (const value of [...new Set(values)].sort())
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gps-resource:${value}`]);
  }

  private async lockDevices(db: PoolClient, deviceIds: string[]): Promise<void> {
    for (const id of [...new Set(deviceIds)].sort()) {
      const result = await db.query('SELECT id FROM geops_device WHERE id=$1 FOR UPDATE', [id]);
      if (!result.rowCount) return invalid();
    }
  }

  private async policyForUpdate(
    db: PoolClient,
    id: string,
    etag: string | undefined,
  ): Promise<PolicyRow> {
    if (!uuid.test(id) || !etag) return invalid();
    const result = await db.query<PolicyRow>(
      'SELECT id,name,state,version,current_revision,draft_config FROM gps_policy WHERE id=$1 FOR UPDATE',
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, 'not_found', 'Not found');
    if (policyEtag(row) !== etag) return conflict();
    return row;
  }

  private view(row: PolicyRow): Record<string, unknown> {
    return {
      id: row.id,
      state: row.state,
      revision: row.current_revision,
      etag: policyEtag(row),
      policy: row.draft_config,
    };
  }

  async createPolicy(ctx: MutationContext, input: unknown): Promise<MutationResult> {
    let spec: GpsPolicySpec;
    try {
      spec = validatePolicy(input);
    } catch {
      return invalid();
    }
    return this.mutate(ctx, ['gps.policy.write'], 'gps.policy.create', async (db) => {
      const id = randomUUID();
      const row = (
        await db.query<PolicyRow>(
          "INSERT INTO gps_policy(id,name,state,draft_config,created_by) VALUES($1,$2,'DRAFT',$3,$4) RETURNING id,name,state,version,current_revision,draft_config",
          [id, spec.name, JSON.stringify(spec), ctx.adminId],
        )
      ).rows[0]!;
      return { status: 201, body: this.view(row), etag: policyEtag(row) };
    });
  }

  async patchPolicy(ctx: MutationContext, id: string, patch: unknown): Promise<MutationResult> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length)
      return invalid();
    return this.mutate(ctx, ['gps.policy.write'], 'gps.policy.edit', async (db) => {
      await this.lockResources(db, [`p:${id}`]);
      const row = await this.policyForUpdate(db, id, ctx.ifMatch);
      if (row.state === 'REVOKED') return conflict('policy_revoked');
      let spec: GpsPolicySpec;
      try {
        spec = validatePolicy({ ...row.draft_config, ...patch });
      } catch {
        return invalid();
      }
      const updated = (
        await db.query<PolicyRow>(
          'UPDATE gps_policy SET name=$2,draft_config=$3,version=version+1,updated_at=now() WHERE id=$1 RETURNING id,name,state,version,current_revision,draft_config',
          [id, spec.name, JSON.stringify(spec)],
        )
      ).rows[0]!;
      return { status: 200, body: this.view(updated), etag: policyEtag(updated) };
    });
  }

  async replaceAssignments(
    ctx: MutationContext,
    id: string,
    input: unknown,
  ): Promise<MutationResult> {
    const items = assignments(input);
    return this.mutate(ctx, ['gps.policy.assign'], 'gps.policy.assign', async (db) => {
      await this.lockResources(db, [`p:${id}`]);
      const row = await this.policyForUpdate(db, id, ctx.ifMatch);
      if (row.state === 'REVOKED') return conflict('policy_revoked');
      await db.query('DELETE FROM gps_policy_assignment WHERE policy_id=$1 AND revision IS NULL', [
        id,
      ]);
      for (const item of items) {
        await db.query(
          'INSERT INTO gps_policy_assignment(id,policy_id,revision,scope_type,device_id,group_id,valid_from,valid_until) VALUES($1,$2,NULL,$3,$4,$5,$6,$7)',
          [
            randomUUID(),
            id,
            item.scope_type,
            item.scope_type === 'DEVICE' ? item.scope_id : null,
            item.scope_type === 'GROUP' ? item.scope_id : null,
            item.valid_from,
            item.valid_until,
          ],
        );
      }
      const updated = (
        await db.query<PolicyRow>(
          'UPDATE gps_policy SET version=version+1,updated_at=now() WHERE id=$1 RETURNING id,name,state,version,current_revision,draft_config',
          [id],
        )
      ).rows[0]!;
      return { status: 200, body: this.view(updated), etag: policyEtag(updated) };
    });
  }

  async createGroup(ctx: MutationContext, input: unknown): Promise<MutationResult> {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== 'name')
    )
      return invalid();
    const name = (input as { name?: unknown }).name;
    if (typeof name !== 'string' || name.trim().length < 1 || name.length > 120) return invalid();
    return this.mutate(ctx, ['gps.policy.assign'], 'gps.group.create', async (db) => {
      const id = randomUUID();
      await db.query('INSERT INTO gps_device_group(id,name,created_by) VALUES($1,$2,$3)', [
        id,
        name,
        ctx.adminId,
      ]);
      const body = { id, name, etag: groupEtag(id, '1') };
      return { status: 201, body, etag: body.etag };
    });
  }

  async replaceMembers(ctx: MutationContext, id: string, input: unknown): Promise<MutationResult> {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== 'device_ids')
    )
      return invalid();
    const deviceIds = (input as { device_ids?: unknown }).device_ids;
    if (
      !Array.isArray(deviceIds) ||
      deviceIds.length > 500 ||
      deviceIds.some((d) => typeof d !== 'string' || !uuid.test(d)) ||
      new Set(deviceIds).size !== deviceIds.length
    )
      return invalid();
    return this.mutate(ctx, ['gps.policy.assign'], 'gps.group.members', async (db) => {
      if (!uuid.test(id) || !ctx.ifMatch) return invalid();
      await db.query("SELECT pg_advisory_xact_lock(hashtext('gps-policy-graph'))");
      await this.lockResources(db, [`g:${id}`]);
      const group = (
        await db.query<{ id: string; version: string }>(
          'SELECT id,version FROM gps_device_group WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!group) throw new ApiError(404, 'not_found', 'Not found');
      if (groupEtag(id, group.version) !== ctx.ifMatch) return conflict();
      const old = (
        await db.query<{ device_id: string }>(
          'SELECT device_id FROM gps_group_member WHERE group_id=$1 AND valid_until IS NULL',
          [id],
        )
      ).rows.map((r) => r.device_id);
      const affected = [...new Set([...old, ...deviceIds])];
      await this.lockDevices(db, affected);
      const at = this.now();
      for (const device of old.filter((d) => !deviceIds.includes(d)))
        await db.query(
          'UPDATE gps_group_member SET valid_until=$3 WHERE group_id=$1 AND device_id=$2 AND valid_until IS NULL',
          [id, device, at],
        );
      for (const device of deviceIds.filter((d) => !old.includes(d)))
        await db.query(
          'INSERT INTO gps_group_member(id,group_id,device_id,valid_from) VALUES($1,$2,$3,$4)',
          [randomUUID(), id, device, at],
        );
      for (const device of affected) await this.rebuildDevice(db, device, at);
      const updated = (
        await db.query<{ version: string }>(
          'UPDATE gps_device_group SET version=version+1,updated_at=now() WHERE id=$1 RETURNING version',
          [id],
        )
      ).rows[0]!;
      const body = { id, device_ids: deviceIds, etag: groupEtag(id, updated.version) };
      return { status: 200, body, etag: body.etag };
    });
  }

  private async affectedDevices(
    db: PoolClient,
    policyId: string,
    draft: AssignmentInput[],
  ): Promise<string[]> {
    const previous = (
      await db.query<{ device_id: string }>(
        'SELECT DISTINCT device_id FROM gps_effective_assignment WHERE policy_id=$1 AND superseded_at IS NULL',
        [policyId],
      )
    ).rows.map((r) => r.device_id);
    const direct = draft.filter((a) => a.scope_type === 'DEVICE').map((a) => a.scope_id);
    const groups = draft.filter((a) => a.scope_type === 'GROUP').map((a) => a.scope_id);
    const groupDevices = groups.length
      ? (
          await db.query<{ device_id: string }>(
            'SELECT DISTINCT device_id FROM gps_group_member WHERE group_id=ANY($1::uuid[]) AND valid_until IS NULL',
            [groups],
          )
        ).rows.map((r) => r.device_id)
      : [];
    return [...new Set([...previous, ...direct, ...groupDevices])];
  }

  private async publish(
    ctx: MutationContext,
    id: string,
    reason: unknown,
    mode: 'publish' | 'resume' | 'pause' | 'revoke',
  ): Promise<MutationResult> {
    if (!reasonOk(reason)) return invalid();
    const caps: GpsCapability[] = ['gps.policy.activate', 'gps.policy.write'];
    return this.mutate(ctx, caps, `gps.policy.${mode}`, async (db) => {
      if (!uuid.test(id)) return invalid();
      await db.query("SELECT pg_advisory_xact_lock(hashtext('gps-policy-graph'))");
      await this.lockResources(db, [`p:${id}`]);
      const draft = (
        await db.query<{
          scope_type: 'DEVICE' | 'GROUP';
          scope_id: string;
          valid_from: Date;
          valid_until: Date;
        }>(
          'SELECT scope_type,COALESCE(device_id,group_id) AS scope_id,valid_from,valid_until FROM gps_policy_assignment WHERE policy_id=$1 AND revision IS NULL',
          [id],
        )
      ).rows.map((r) => ({
        scope_type: r.scope_type,
        scope_id: r.scope_id,
        valid_from: asIso(r.valid_from),
        valid_until: asIso(r.valid_until),
      }));
      const currentGroups = (
        await db.query<{ group_id: string }>(
          'SELECT DISTINCT group_id FROM gps_policy_assignment WHERE policy_id=$1 AND group_id IS NOT NULL AND revision IS NOT NULL',
          [id],
        )
      ).rows.map((r) => r.group_id);
      const groups = [
        ...new Set([
          ...currentGroups,
          ...draft.filter((a) => a.scope_type === 'GROUP').map((a) => a.scope_id),
        ]),
      ];
      await this.lockResources(
        db,
        groups.map((g) => `g:${g}`),
      );
      const row = await this.policyForUpdate(db, id, ctx.ifMatch);
      if (
        row.state === 'REVOKED' ||
        (mode === 'resume' && row.state !== 'PAUSED') ||
        (mode === 'pause' && row.state !== 'ACTIVE') ||
        (mode === 'publish' && row.state === 'PAUSED')
      )
        return conflict('invalid_policy_state');
      const activating = mode === 'publish' || mode === 'resume';
      if (activating && !draft.length) return invalid();
      let scopeChanged = false;
      if (activating) {
        const previous = (
          await db.query<{
            scope_type: 'DEVICE' | 'GROUP';
            scope_id: string;
            valid_from: Date;
            valid_until: Date;
          }>(
            'SELECT scope_type,COALESCE(device_id,group_id) AS scope_id,valid_from,valid_until FROM gps_policy_assignment WHERE policy_id=$1 AND revision=$2',
            [id, row.current_revision],
          )
        ).rows.map((r) => ({
          scope_type: r.scope_type,
          scope_id: r.scope_id,
          valid_from: asIso(r.valid_from),
          valid_until: asIso(r.valid_until),
        }));
        const canonical = (items: AssignmentInput[]): string =>
          JSON.stringify(
            items
              .map((a) => [a.scope_type, a.scope_id, a.valid_from, a.valid_until])
              .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
          );
        scopeChanged = canonical(previous) !== canonical(draft);
        if (scopeChanged) await this.requireLockedCapabilities(db, ctx, ['gps.policy.assign']);
      }
      const affected = await this.affectedDevices(db, id, activating ? draft : []);
      await this.lockDevices(db, affected);
      const at = this.now();
      if (activating) {
        const revision = row.current_revision + 1;
        const spec = row.draft_config;
        if (
          Date.parse(spec.valid_until) <= at.getTime() ||
          !draft.some((a) => Date.parse(a.valid_until) > at.getTime())
        )
          return invalid();
        await db.query(
          'INSERT INTO gps_policy_revision(policy_id,revision,days_iso,start_local,end_local,time_zone,capture_interval_s,sync_interval_s,heartbeat_missing_after_s,health_interval_s,valid_from,valid_until,created_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',
          [
            id,
            revision,
            spec.days_iso,
            spec.start_local,
            spec.end_local,
            spec.time_zone,
            spec.capture_interval_s,
            spec.sync_interval_s,
            spec.heartbeat_missing_after_s,
            spec.health_interval_s ?? 300,
            spec.valid_from,
            spec.valid_until,
            ctx.adminId,
            reason,
          ],
        );
        for (const ex of spec.exceptions ?? [])
          await db.query(
            'INSERT INTO gps_policy_exception(policy_id,revision,local_date,mode,start_local,end_local,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [
              id,
              revision,
              ex.local_date,
              ex.mode,
              ex.start_local ?? null,
              ex.end_local ?? null,
              ex.reason,
            ],
          );
        for (const a of draft)
          await db.query(
            'INSERT INTO gps_policy_assignment(id,policy_id,revision,scope_type,device_id,group_id,valid_from,valid_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
            [
              randomUUID(),
              id,
              revision,
              a.scope_type,
              a.scope_type === 'DEVICE' ? a.scope_id : null,
              a.scope_type === 'GROUP' ? a.scope_id : null,
              a.valid_from,
              a.valid_until,
            ],
          );
        await db.query(
          "UPDATE gps_policy SET state='ACTIVE',current_revision=$2,version=version+1,updated_at=now() WHERE id=$1",
          [id, revision],
        );
      } else {
        await db.query(
          'UPDATE gps_policy SET state=$2,version=version+1,updated_at=now() WHERE id=$1',
          [id, mode === 'pause' ? 'PAUSED' : 'REVOKED'],
        );
      }
      for (const device of affected) await this.rebuildDevice(db, device, at);
      const updated = (
        await db.query<PolicyRow>(
          'SELECT id,name,state,version,current_revision,draft_config FROM gps_policy WHERE id=$1',
          [id],
        )
      ).rows[0]!;
      return {
        status: 200,
        body: this.view(updated),
        etag: policyEtag(updated),
        ...(scopeChanged ? { additionalCapabilities: ['gps.policy.assign' as const] } : {}),
      };
    });
  }

  publishPolicy(ctx: MutationContext, id: string, reason: unknown): Promise<MutationResult> {
    return this.publish(ctx, id, reason, 'publish');
  }
  resumePolicy(ctx: MutationContext, id: string, reason: unknown): Promise<MutationResult> {
    return this.publish(ctx, id, reason, 'resume');
  }
  pausePolicy(ctx: MutationContext, id: string, reason: unknown): Promise<MutationResult> {
    return this.publish(ctx, id, reason, 'pause');
  }
  revokePolicy(ctx: MutationContext, id: string, reason: unknown): Promise<MutationResult> {
    return this.publish(ctx, id, reason, 'revoke');
  }

  async rebuildDevice(db: PoolClient, deviceId: string, at: Date): Promise<void> {
    const state = (
      await db.query<{ assignment_version: string }>(
        'INSERT INTO gps_device_assignment_state(device_id,assignment_version,changed_at) VALUES($1,1,$2) ON CONFLICT (device_id) DO UPDATE SET assignment_version=gps_device_assignment_state.assignment_version+1,changed_at=$2 RETURNING assignment_version',
        [deviceId, at],
      )
    ).rows[0]!;
    await db.query(
      'UPDATE gps_effective_assignment SET superseded_at=$2 WHERE device_id=$1 AND superseded_at IS NULL',
      [deviceId, at],
    );
    await db.query(
      "UPDATE gps_scheduled_session SET state='CANCELLED' WHERE device_id=$1 AND state='SCHEDULED' AND start_at >= $2",
      [deviceId, at],
    );
    const source = await db.query<{
      id: string;
      policy_id: string;
      revision: number;
      scope_type: 'DEVICE' | 'GROUP';
      device_id: string | null;
      group_id: string | null;
      valid_from: Date;
      valid_until: Date;
      days_iso: number[];
      start_local: string;
      end_local: string;
      time_zone: string;
      capture_interval_s: number;
      sync_interval_s: number;
      heartbeat_missing_after_s: number;
      health_interval_s: number;
      policy_from: Date;
      policy_until: Date;
      exceptions: GpsPolicySpec['exceptions'];
    }>(
      `SELECT a.id,a.policy_id,a.revision,a.scope_type,a.device_id,a.group_id,a.valid_from,a.valid_until,
        r.days_iso,to_char(r.start_local,'HH24:MI') AS start_local,
        to_char(r.end_local,'HH24:MI') AS end_local,r.time_zone,r.capture_interval_s,
        r.sync_interval_s,r.heartbeat_missing_after_s,r.health_interval_s,r.valid_from AS policy_from,
        r.valid_until AS policy_until,
        COALESCE((SELECT json_agg(json_build_object('local_date',e.local_date,'mode',e.mode,
          'start_local',CASE WHEN e.start_local IS NULL THEN NULL ELSE to_char(e.start_local,'HH24:MI') END,
          'end_local',CASE WHEN e.end_local IS NULL THEN NULL ELSE to_char(e.end_local,'HH24:MI') END,
          'reason',e.reason)) FROM gps_policy_exception e WHERE e.policy_id=r.policy_id AND e.revision=r.revision),'[]'::json) AS exceptions
      FROM gps_policy_assignment a JOIN gps_policy p ON p.id=a.policy_id
      JOIN gps_policy_revision r ON r.policy_id=a.policy_id AND r.revision=a.revision
      WHERE a.revision=p.current_revision AND p.state='ACTIVE' AND
        (a.device_id=$1 OR a.group_id IN (SELECT m.group_id FROM gps_group_member m
          WHERE m.device_id=$1 AND m.valid_until IS NULL AND m.valid_from<=$2))`,
      [deviceId, at],
    );
    for (const a of source.rows) {
      const lower = Math.max(at.getTime(), a.valid_from.getTime(), a.policy_from.getTime());
      const upper = Math.min(a.valid_until.getTime(), a.policy_until.getTime());
      if (lower >= upper) continue;
      await db.query(
        "INSERT INTO gps_effective_assignment(id,device_id,policy_id,revision,source_assignment_id,effective_range,assignment_version) VALUES($1,$2,$3,$4,$5,tstzrange($6,$7,'[)'),$8)",
        [
          randomUUID(),
          deviceId,
          a.policy_id,
          a.revision,
          a.id,
          new Date(lower),
          new Date(upper),
          state.assignment_version,
        ],
      );
      const spec: GpsPolicySpec = {
        name: 'Published',
        days_iso: a.days_iso,
        start_local: a.start_local,
        end_local: a.end_local,
        time_zone: a.time_zone,
        capture_interval_s: a.capture_interval_s,
        sync_interval_s: a.sync_interval_s,
        heartbeat_missing_after_s: a.heartbeat_missing_after_s,
        health_interval_s: a.health_interval_s,
        valid_from: asIso(a.policy_from),
        valid_until: asIso(a.policy_until),
        exceptions: (a.exceptions ?? []).map((ex) => ({
          local_date: ex.local_date,
          mode: ex.mode,
          reason: ex.reason,
          ...(ex.start_local ? { start_local: ex.start_local } : {}),
          ...(ex.end_local ? { end_local: ex.end_local } : {}),
        })),
      };
      const horizon = new Date(Math.min(at.getTime() + 7 * 86400_000, upper));
      for (const window of windowsForRange(spec, new Date(lower), horizon)) {
        await db.query(
          "INSERT INTO gps_scheduled_session(id,device_id,policy_id,revision,assignment_version,local_date,start_at,end_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'SCHEDULED')",
          [
            randomUUID(),
            deviceId,
            a.policy_id,
            a.revision,
            state.assignment_version,
            window.local_date,
            window.start_at,
            window.end_at,
          ],
        );
      }
    }
  }

  async getPolicy(
    adminId: string,
    requestId: string,
    id: string,
  ): Promise<Record<string, unknown>> {
    await this.requireCapability(adminId, 'gps.policy.read', requestId);
    if (!uuid.test(id)) return invalid();
    const result = await this.pool.query<PolicyRow>(
      'SELECT id,name,state,version,current_revision,draft_config FROM gps_policy WHERE id=$1',
      [id],
    );
    if (!result.rows[0]) throw new ApiError(404, 'not_found', 'Not found');
    const assignments = await this.pool.query<{
      scope_type: 'DEVICE' | 'GROUP';
      scope_id: string;
      valid_from: Date;
      valid_until: Date;
    }>(
      'SELECT scope_type,COALESCE(device_id,group_id) AS scope_id,valid_from,valid_until FROM gps_policy_assignment WHERE policy_id=$1 AND revision IS NULL ORDER BY scope_type,scope_id',
      [id],
    );
    return {
      ...this.view(result.rows[0]),
      assignments: assignments.rows.map((row) => ({
        scope_type: row.scope_type,
        scope_id: row.scope_id,
        valid_from: asIso(row.valid_from),
        valid_until: asIso(row.valid_until),
      })),
    };
  }

  async listPolicies(
    adminId: string,
    requestId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Record<string, unknown>> {
    await this.requireCapability(adminId, 'gps.policy.read', requestId);
    const after = decodeCursor(cursor, 'p');
    const rows = await this.pool.query<PolicyRow>(
      'SELECT id,name,state,version,current_revision,draft_config FROM gps_policy WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2',
      [after, limit + 1],
    );
    const items = rows.rows.slice(0, limit).map((row) => this.view(row));
    const last = rows.rows[limit - 1];
    return {
      items,
      next_cursor: rows.rows.length > limit && last ? encodeCursor(last.id, 'p') : null,
    };
  }

  async listGroups(
    adminId: string,
    requestId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Record<string, unknown>> {
    await this.requireCapability(adminId, 'gps.policy.read', requestId);
    const after = decodeCursor(cursor, 'g');
    const rows = await this.pool.query<{ id: string; name: string; version: string }>(
      'SELECT id,name,version FROM gps_device_group WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2',
      [after, limit + 1],
    );
    const items = rows.rows
      .slice(0, limit)
      .map((row) => ({ id: row.id, name: row.name, etag: groupEtag(row.id, row.version) }));
    const last = rows.rows[limit - 1];
    return {
      items,
      next_cursor: rows.rows.length > limit && last ? encodeCursor(last.id, 'g') : null,
    };
  }
}
