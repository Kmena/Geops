import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from './audit/index.js';
import type { DevicePrincipal } from './device-identity/session.js';
import { ApiError } from './errors.js';
import {
  digest,
  GpsValidationError,
  type GpsBatch,
  type GpsBatchAck,
  type GpsBatchV2,
  type GpsBatchV3,
  type GpsEventKind,
  type PositionEvent,
  type SessionEvent,
} from './gps-event-contracts.js';
import type { GpsPolicyService } from './gps-policy-service.js';
import { windowsForRange, type GpsPolicySpec } from './gps-policy-windows.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DAY = 86_400_000;
const RETENTION = 90 * DAY;
const DEPENDENCY = 7 * DAY;
function invalid(id: string): never {
  throw new GpsValidationError([id]);
}
function conflict(code = 'event_conflict'): never {
  throw new ApiError(409, code, 'Conflict', true);
}

interface Scope {
  bindingId: string;
  tenantId: string;
  installationId: string;
}
interface Anchor {
  capture_anchor_id: string;
  device_id: string;
  installation_id: string;
  assignment_version: string;
  health_mdm_binding_id: string | null;
  health_tenant_id: string | null;
  server_time: Date;
  offline_not_after: Date;
  health_boot_id: string | null;
  session_boot_id: string | null;
  contract_version: number;
  policy_id: string | null;
  policy_revision: number | null;
  assignment_start: Date | null;
  authorized_until: Date | null;
}
interface Effective {
  id: string;
  client_session_id: string;
  scheduled_session_id: string;
  assignment_version: string;
  started_at: Date;
  stopped_at: Date | null;
  state: 'OPEN' | 'INTERRUPTED' | 'STOPPED' | 'UNKNOWN_END';
  start_boot_id: string;
  start_anchor_id: string;
  tenant_id: string;
  mdm_binding_id: string;
  installation_id: string;
}
interface Receipt {
  payload_digest: Buffer;
  accepted_event_ids: string[];
  duplicate_event_ids: string[];
  session_mappings: Array<{ client_session_id: string; session_id: string }>;
  persisted_at: Date;
}
interface Pending {
  batch_id: string;
  pending_event_ids: string[];
  reason_code: 'pending_dependency';
}

export class GpsRateLimited extends ApiError {
  constructor(readonly retryAfter: number) {
    super(429, 'rate_limited', 'Try again later', true);
  }
}

/** All ingest transactions lock the canonical device, then its active tenant and installation. */
export class GpsEventService {
  constructor(
    private readonly pool: Pool,
    private readonly policies: GpsPolicyService,
    private readonly quarantineKey: Buffer,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (quarantineKey.length !== 32) throw new Error('gps_quarantine_key_invalid');
  }

  async checkQuota(deviceId: string, kind: GpsEventKind): Promise<number> {
    const at = this.now();
    const bucket = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
    const result = await this.pool.query(
      `INSERT INTO gps_event_request_quota(device_id,kind,minute_bucket,request_count)
       VALUES($1,$2,$3,1) ON CONFLICT (device_id,kind,minute_bucket)
       DO UPDATE SET request_count=gps_event_request_quota.request_count+1
       WHERE gps_event_request_quota.request_count<6 RETURNING request_count`,
      [deviceId, kind, bucket],
    );
    if (!result.rowCount) {
      const after = Math.max(1, Math.ceil((bucket.getTime() + 60_000 - at.getTime()) / 1000));
      throw new GpsRateLimited(after);
    }
    return Math.max(1, Math.ceil((bucket.getTime() + 60_000 - at.getTime()) / 1000));
  }

  private async scope(
    db: PoolClient,
    principal: DevicePrincipal,
    installationId: string,
  ): Promise<Scope> {
    const device = await db.query<{ status: string }>(
      'SELECT status FROM geops_device WHERE id=$1 FOR UPDATE',
      [principal.deviceId],
    );
    if (device.rows[0]?.status !== 'ACTIVE')
      throw new ApiError(403, 'device_inactive', 'Forbidden', true);
    const binding = await db.query<{ id: string; customer_id: string }>(
      "SELECT id,customer_id FROM mdm_binding WHERE geops_device_id=$1 AND state='ACTIVE' FOR SHARE",
      [principal.deviceId],
    );
    const selected = binding.rows[0];
    if (binding.rows.length !== 1 || !selected)
      throw new ApiError(403, 'binding_inactive', 'Forbidden', true);
    const install = await db.query(
      'SELECT 1 FROM gps_device_installation WHERE device_id=$1 AND installation_id=$2 AND activation_binding_id=$3 AND activation_tenant_id=$4 AND retired_at IS NULL FOR SHARE',
      [principal.deviceId, installationId, selected.id, selected.customer_id],
    );
    if (!install.rowCount) throw new ApiError(403, 'installation_inactive', 'Forbidden', true);
    return { bindingId: selected.id, tenantId: selected.customer_id, installationId };
  }

  private async anchor(
    db: PoolClient,
    eventId: string,
    anchorId: string,
    deviceId: string,
    scope: Scope,
    version: number,
  ): Promise<Anchor> {
    const result = await db.query<Anchor>(
      'SELECT * FROM gps_policy_delivery WHERE capture_anchor_id=$1 FOR UPDATE',
      [anchorId],
    );
    const anchor = result.rows[0];
    if (
      !anchor ||
      anchor.device_id !== deviceId ||
      anchor.installation_id !== scope.installationId ||
      Number(anchor.assignment_version) !== version ||
      anchor.health_mdm_binding_id !== scope.bindingId ||
      anchor.health_tenant_id !== scope.tenantId
    )
      invalid(eventId);
    return anchor;
  }

  private async anchorTime(
    db: PoolClient,
    eventId: string,
    anchor: Anchor,
    bootId: string,
    anchorElapsed: number,
    elapsed: number,
    at: string,
    terminal = false,
  ): Promise<void> {
    const observed = Date.parse(at);
    if (
      (anchor.session_boot_id !== null && anchor.session_boot_id !== bootId) ||
      (anchor.health_boot_id !== null && anchor.health_boot_id !== bootId) ||
      observed < anchor.server_time.getTime() ||
      (!terminal && observed >= anchor.offline_not_after.getTime()) ||
      Math.abs(observed - (anchor.server_time.getTime() + elapsed - anchorElapsed)) > 30_000
    )
      invalid(eventId);
    if (anchor.session_boot_id === null) {
      await db.query(
        'UPDATE gps_policy_delivery SET session_boot_id=$2 WHERE capture_anchor_id=$1',
        [anchor.capture_anchor_id, bootId],
      );
      anchor.session_boot_id = bootId;
    }
  }

  /** V3 keeps a per-boot relative clock check; civil time after reboot remains device-reported. */
  private async offlineTime(
    db: PoolClient,
    eventId: string,
    anchor: Anchor,
    bootId: string,
    elapsed: number,
    at: string,
    terminal = false,
  ): Promise<void> {
    const observed = Date.parse(at);
    if (
      anchor.contract_version !== 2 ||
      !anchor.authorized_until ||
      !anchor.policy_id ||
      !anchor.assignment_start ||
      observed < anchor.server_time.getTime() ||
      (!terminal && observed >= anchor.authorized_until.getTime()) ||
      (terminal && observed > anchor.authorized_until.getTime() + DAY)
    )
      invalid(eventId);
    await db.query(
      `INSERT INTO gps_offline_boot_clock(capture_anchor_id,boot_id,first_reported_at,first_elapsed_ms)
       VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [anchor.capture_anchor_id, bootId, at, elapsed],
    );
    const first = await db.query<{ first_reported_at: Date; first_elapsed_ms: string }>(
      `SELECT first_reported_at,first_elapsed_ms FROM gps_offline_boot_clock
       WHERE capture_anchor_id=$1 AND boot_id=$2 FOR UPDATE`,
      [anchor.capture_anchor_id, bootId],
    );
    const baseline = first.rows[0] ?? invalid(eventId);
    if (
      Math.abs(
        observed -
          baseline.first_reported_at.getTime() -
          (elapsed - Number(baseline.first_elapsed_ms)),
      ) > 30_000
    )
      invalid(eventId);
  }

  /** Materialize an exact historical window from the delivered immutable revision. */
  private async offlineScheduled(
    db: PoolClient,
    deviceId: string,
    anchor: Anchor,
    at: string,
  ): Promise<{ id: string; start_at: Date; end_at: Date } | null> {
    if (
      !anchor.policy_id ||
      !anchor.policy_revision ||
      !anchor.assignment_start ||
      !anchor.authorized_until
    )
      return null;
    const assignment = await db.query<{
      days_iso: number[];
      start_local: string;
      end_local: string;
      time_zone: string;
      valid_from: Date;
      valid_until: Date;
      lower_at: Date;
      upper_at: Date;
      exceptions: GpsPolicySpec['exceptions'];
    }>(
      `SELECT r.days_iso,to_char(r.start_local,'HH24:MI') AS start_local,
         to_char(r.end_local,'HH24:MI') AS end_local,r.time_zone,r.valid_from,r.valid_until,
         lower(e.effective_range) AS lower_at,upper(e.effective_range) AS upper_at,
         COALESCE((SELECT json_agg(json_build_object('local_date',x.local_date,'mode',x.mode,
           'start_local',CASE WHEN x.start_local IS NULL THEN NULL ELSE to_char(x.start_local,'HH24:MI') END,
           'end_local',CASE WHEN x.end_local IS NULL THEN NULL ELSE to_char(x.end_local,'HH24:MI') END,
           'reason',x.reason)) FROM gps_policy_exception x
           WHERE x.policy_id=r.policy_id AND x.revision=r.revision),'[]'::json) AS exceptions
       FROM gps_effective_assignment e JOIN gps_policy_revision r
         ON r.policy_id=e.policy_id AND r.revision=e.revision
       WHERE e.device_id=$1 AND e.assignment_version=$2 AND e.policy_id=$3 AND e.revision=$4
         AND e.effective_range @> $5::timestamptz LIMIT 2`,
      [deviceId, anchor.assignment_version, anchor.policy_id, anchor.policy_revision, at],
    );
    if (assignment.rows.length !== 1) return null;
    const row = assignment.rows[0]!;
    const time = Date.parse(at);
    const lower = Math.max(
      row.lower_at.getTime(),
      anchor.assignment_start.getTime(),
      anchor.server_time.getTime() - 2 * DAY,
      time - 2 * DAY,
    );
    const upper = Math.min(
      row.upper_at.getTime(),
      anchor.authorized_until.getTime(),
      time + 2 * DAY,
    );
    const spec: GpsPolicySpec = {
      name: 'Published',
      days_iso: row.days_iso,
      start_local: row.start_local,
      end_local: row.end_local,
      time_zone: row.time_zone,
      capture_interval_s: 60,
      sync_interval_s: 60,
      heartbeat_missing_after_s: 900,
      health_interval_s: 300,
      valid_from: row.valid_from.toISOString(),
      valid_until: row.valid_until.toISOString(),
      exceptions: (row.exceptions ?? []).map((ex) => ({
        local_date: ex.local_date,
        mode: ex.mode,
        reason: ex.reason,
        ...(ex.start_local ? { start_local: ex.start_local } : {}),
        ...(ex.end_local ? { end_local: ex.end_local } : {}),
      })),
    };
    const windows = windowsForRange(spec, new Date(lower), new Date(upper)).filter(
      (window) => Date.parse(window.start_at) <= time && time < Date.parse(window.end_at),
    );
    if (windows.length !== 1) return null;
    const window = windows[0]!;
    await db.query(
      `INSERT INTO gps_scheduled_session(id,device_id,policy_id,revision,assignment_version,
       local_date,start_at,end_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'SCHEDULED')
       ON CONFLICT DO NOTHING`,
      [
        randomUUID(),
        deviceId,
        anchor.policy_id,
        anchor.policy_revision,
        anchor.assignment_version,
        window.local_date,
        window.start_at,
        window.end_at,
      ],
    );
    const selected = await db.query<{ id: string; start_at: Date; end_at: Date }>(
      `SELECT id,start_at,end_at FROM gps_scheduled_session
       WHERE device_id=$1 AND policy_id=$2 AND revision=$3 AND assignment_version=$4
         AND local_date=$5 AND start_at=$6 AND end_at=$7 AND state IN ('SCHEDULED','MISSED')`,
      [
        deviceId,
        anchor.policy_id,
        anchor.policy_revision,
        anchor.assignment_version,
        window.local_date,
        window.start_at,
        window.end_at,
      ],
    );
    return selected.rows[0] ?? null;
  }

  private validAge(eventId: string, at: string): void {
    const time = Date.parse(at),
      now = this.now().getTime();
    if (time < now - RETENTION || time > now + 30_000) invalid(eventId);
  }

  private async scheduled(
    db: PoolClient,
    deviceId: string,
    version: number,
    at: string,
    id?: string,
  ): Promise<{ id: string; start_at: Date; end_at: Date } | null> {
    const rows = await db.query<{ id: string; start_at: Date; end_at: Date }>(
      `SELECT s.id,s.start_at,s.end_at FROM gps_scheduled_session s
       JOIN gps_policy_revision r ON r.policy_id=s.policy_id AND r.revision=s.revision
       WHERE s.device_id=$1 AND s.assignment_version=$2 AND
         ($3::uuid IS NULL OR s.id=$3) AND s.state IN ('SCHEDULED','MISSED') AND
         s.start_at<=$4 AND $4<s.end_at AND r.valid_from<=$4 AND $4<r.valid_until LIMIT 2`,
      [deviceId, version, id ?? null, at],
    );
    if (rows.rows.length > 1)
      throw new ApiError(503, 'gps_window_ambiguous', 'Service unavailable', true);
    return rows.rows[0] ?? null;
  }

  private async effective(
    db: PoolClient,
    deviceId: string,
    scope: Scope,
    clientId: string,
  ): Promise<Effective | null> {
    const result = await db.query<Effective>(
      `SELECT * FROM gps_effective_session WHERE device_id=$1 AND installation_id=$2
       AND client_session_id=$3 FOR UPDATE`,
      [deviceId, scope.installationId, clientId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.tenant_id !== scope.tenantId || row.mdm_binding_id !== scope.bindingId)
      throw new ApiError(403, 'tenant_mismatch', 'Forbidden', true);
    return row;
  }

  private async quarantine(
    db: PoolClient,
    kind: GpsEventKind,
    batch: GpsBatch<SessionEvent> | GpsBatch<PositionEvent>,
    scope: Scope,
    requestId: string,
  ): Promise<Pending> {
    const now = this.now();
    const count = await db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM gps_event_quarantine WHERE device_id=$1 AND expires_at>$2',
      [batch.device_id, now],
    );
    if (Number(count.rows[0]?.n ?? 0) + batch.events.length > 1000)
      throw new ApiError(429, 'dependency_queue_full', 'Try again later', true);
    for (const event of batch.events) {
      const hash = digest(event);
      const prior = await db.query<{ payload_digest: Buffer }>(
        'SELECT payload_digest FROM gps_event_quarantine WHERE device_id=$1 AND event_id=$2 AND kind=$3 FOR UPDATE',
        [batch.device_id, event.event_id, kind],
      );
      if (prior.rows[0]) {
        if (!prior.rows[0].payload_digest.equals(hash)) conflict();
        continue;
      }
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.quarantineKey, nonce);
      cipher.setAAD(Buffer.from(`${batch.device_id}:${event.event_id}:${kind}`));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(event), 'utf8'),
        cipher.final(),
      ]);
      await db.query(
        `INSERT INTO gps_event_quarantine(device_id,event_id,kind,encrypted_payload_ref,
         reason_code,first_seen_at,expires_at,batch_id,installation_id,tenant_id,mdm_binding_id,
         payload_digest,payload_nonce,payload_tag,payload_ciphertext)
         VALUES($1,$2,$3,$4,'pending_dependency',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          batch.device_id,
          event.event_id,
          kind,
          `inline-aes256gcm-v1:${event.event_id}`,
          now,
          new Date(now.getTime() + DEPENDENCY),
          batch.batch_id,
          scope.installationId,
          scope.tenantId,
          scope.bindingId,
          hash,
          nonce,
          cipher.getAuthTag(),
          ciphertext,
        ],
      );
    }
    await appendAudit(db, {
      actorType: 'DEVICE',
      deviceId: batch.device_id,
      action: 'gps.events.pending',
      outcome: 'success',
      correlationId: requestId,
      metadata: { kind, count: batch.events.length },
    });
    return {
      batch_id: batch.batch_id,
      pending_event_ids: batch.events.map((event) => event.event_id),
      reason_code: 'pending_dependency',
    };
  }

  async ingestSessions(
    principal: DevicePrincipal,
    batch: GpsBatch<SessionEvent>,
    requestId: string,
  ): Promise<GpsBatchAck | Pending> {
    return this.ingest('SESSION', principal, batch, requestId);
  }
  async ingestPositions(
    principal: DevicePrincipal,
    batch: GpsBatch<PositionEvent>,
    requestId: string,
  ): Promise<GpsBatchAck | Pending> {
    return this.ingest('POSITION', principal, batch, requestId);
  }

  async ingestOffline(
    principal: DevicePrincipal,
    batch: GpsBatchV3,
    requestId: string,
  ): Promise<GpsBatchAck | Pending> {
    return this.ingestMixed(principal, batch, requestId);
  }

  /** V2/v3 commit local STARTED, canonical session, positions and receipt together. */
  async ingestMixed(
    principal: DevicePrincipal,
    batch: GpsBatchV2 | GpsBatchV3,
    requestId: string,
  ): Promise<GpsBatchAck | Pending> {
    const offline = batch.schema_version === 3;
    if (batch.device_id !== principal.deviceId)
      throw new ApiError(403, 'device_mismatch', 'Forbidden', true);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const scope = await this.scope(db, principal, batch.installation_id);
      const fingerprint = digest(batch);
      const receipt = await db.query<Receipt>(
        'SELECT * FROM gps_mixed_batch_receipt WHERE device_id=$1 AND batch_id=$2 FOR UPDATE',
        [principal.deviceId, batch.batch_id],
      );
      const previous = receipt.rows[0];
      if (previous) {
        if (!previous.payload_digest.equals(fingerprint)) conflict('batch_conflict');
        await db.query('COMMIT');
        return {
          batch_id: batch.batch_id,
          persisted_at: previous.persisted_at.toISOString(),
          accepted_event_ids: previous.accepted_event_ids,
          duplicate_event_ids: previous.duplicate_event_ids,
          session_mappings: previous.session_mappings,
          processing: 'complete',
        };
      }
      const sessions = batch.events
        .filter((event) => event.kind === 'SESSION')
        .map((event) => event.payload as SessionEvent)
        .sort(
          (a, b) =>
            Date.parse(a.occurred_at) - Date.parse(b.occurred_at) ||
            (a.type === 'STARTED' ? -1 : 1),
        );
      const positions = batch.events
        .filter((event) => event.kind === 'POSITION')
        .map((event) => event.payload as PositionEvent)
        .sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at));
      const anchors = new Map<string, Anchor>();
      for (const event of [...sessions, ...positions]) {
        this.validAge(
          event.event_id,
          'occurred_at' in event ? event.occurred_at : event.captured_at,
        );
        const kind = 'occurred_at' in event ? 'SESSION' : 'POSITION';
        const pending = await db.query<{ expires_at: Date; payload_digest: Buffer }>(
          `SELECT expires_at,payload_digest FROM gps_event_quarantine
           WHERE device_id=$1 AND event_id=$2 AND kind=$3 FOR UPDATE`,
          [principal.deviceId, event.event_id, kind],
        );
        const priorPending = pending.rows[0];
        if (priorPending && priorPending.expires_at.getTime() <= this.now().getTime())
          throw new ApiError(410, 'dependency_expired', 'Gone', true);
        if (priorPending && !priorPending.payload_digest.equals(digest(event))) conflict();
        if (event.capture_anchor_id && !anchors.has(event.capture_anchor_id)) {
          anchors.set(
            event.capture_anchor_id,
            await this.anchor(
              db,
              event.event_id,
              event.capture_anchor_id,
              principal.deviceId,
              scope,
              event.assignment_version,
            ),
          );
          if (offline && anchors.get(event.capture_anchor_id)?.contract_version !== 2)
            invalid(event.event_id);
        }
      }
      const hasStarted = sessions.some((event) => event.type === 'STARTED');
      if (
        !hasStarted &&
        !(await this.effective(db, principal.deviceId, scope, batch.client_session_id))
      ) {
        await db.query('ROLLBACK');
        return {
          batch_id: batch.batch_id,
          pending_event_ids: batch.events.map((event) => event.payload.event_id),
          reason_code: 'pending_dependency',
        };
      }
      const accepted: string[] = [];
      const duplicate: string[] = [];
      const mappings = new Map<string, string>();
      for (const event of sessions) {
        const result = await this.sessionEvent(
          db,
          principal.deviceId,
          scope,
          event,
          anchors,
          true,
          offline,
        );
        (result.duplicate ? duplicate : accepted).push(event.event_id);
        if (result.mapping)
          mappings.set(result.mapping.client_session_id, result.mapping.session_id);
        await db.query(
          "DELETE FROM gps_event_quarantine WHERE device_id=$1 AND event_id=$2 AND kind='SESSION'",
          [principal.deviceId, event.event_id],
        );
      }
      for (const event of positions) {
        const isDuplicate = await this.positionEvent(
          db,
          principal.deviceId,
          scope,
          event,
          anchors,
          offline,
        );
        (isDuplicate ? duplicate : accepted).push(event.event_id);
        await db.query(
          "DELETE FROM gps_event_quarantine WHERE device_id=$1 AND event_id=$2 AND kind='POSITION'",
          [principal.deviceId, event.event_id],
        );
      }
      const persisted = this.now();
      const sessionMappings = [...mappings].map(([client_session_id, session_id]) => ({
        client_session_id,
        session_id,
      }));
      await db.query(
        `INSERT INTO gps_mixed_batch_receipt(device_id,batch_id,payload_digest,
         accepted_event_ids,duplicate_event_ids,session_mappings,persisted_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          principal.deviceId,
          batch.batch_id,
          fingerprint,
          accepted,
          duplicate,
          JSON.stringify(sessionMappings),
          persisted,
        ],
      );
      await db.query(
        `INSERT INTO gps_sync_status(device_id,last_ack_at,updated_at) VALUES($1,$2,$2)
         ON CONFLICT (device_id) DO UPDATE SET last_ack_at=$2,updated_at=$2`,
        [principal.deviceId, persisted],
      );
      await appendAudit(db, {
        actorType: 'DEVICE',
        deviceId: principal.deviceId,
        action: offline ? 'gps.offline.ingest' : 'gps.mixed.ingest',
        outcome: 'success',
        correlationId: requestId,
        metadata: { accepted: accepted.length, duplicate: duplicate.length },
      });
      await db.query('COMMIT');
      return {
        batch_id: batch.batch_id,
        persisted_at: persisted.toISOString(),
        accepted_event_ids: accepted,
        duplicate_event_ids: duplicate,
        session_mappings: sessionMappings,
        processing: 'complete',
      };
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  private async ingest(
    kind: GpsEventKind,
    principal: DevicePrincipal,
    batch: GpsBatch<SessionEvent> | GpsBatch<PositionEvent>,
    requestId: string,
  ): Promise<GpsBatchAck | Pending> {
    if (batch.device_id !== principal.deviceId)
      throw new ApiError(403, 'device_mismatch', 'Forbidden', true);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const scope = await this.scope(db, principal, batch.installation_id);
      const anchors = new Map<string, Anchor>();
      for (const event of batch.events) {
        this.validAge(
          event.event_id,
          kind === 'SESSION'
            ? (event as SessionEvent).occurred_at
            : (event as PositionEvent).captured_at,
        );
        const id = event.capture_anchor_id;
        if (id && !anchors.has(id))
          anchors.set(
            id,
            await this.anchor(
              db,
              event.event_id,
              id,
              principal.deviceId,
              scope,
              event.assignment_version,
            ),
          );
      }
      const fingerprint = digest(batch);
      for (const event of batch.events) {
        const pending = await db.query<{ expires_at: Date; payload_digest: Buffer }>(
          'SELECT expires_at,payload_digest FROM gps_event_quarantine WHERE device_id=$1 AND event_id=$2 AND kind=$3',
          [principal.deviceId, event.event_id, kind],
        );
        if (
          pending.rows[0] &&
          (pending.rows[0].expires_at.getTime() <= this.now().getTime() ||
            !pending.rows[0].payload_digest.equals(digest(event)))
        )
          throw new ApiError(
            pending.rows[0].expires_at.getTime() <= this.now().getTime() ? 410 : 409,
            pending.rows[0].expires_at.getTime() <= this.now().getTime()
              ? 'dependency_expired'
              : 'event_conflict',
            pending.rows[0].expires_at.getTime() <= this.now().getTime() ? 'Gone' : 'Conflict',
            true,
          );
      }
      const receipt = await db.query<Receipt>(
        'SELECT * FROM gps_event_batch_receipt WHERE device_id=$1 AND kind=$2 AND batch_id=$3 FOR UPDATE',
        [principal.deviceId, kind, batch.batch_id],
      );
      const previous = receipt.rows[0];
      if (previous) {
        if (!previous.payload_digest.equals(fingerprint)) conflict('batch_conflict');
        await db.query('COMMIT');
        return {
          batch_id: batch.batch_id,
          persisted_at: previous.persisted_at.toISOString(),
          accepted_event_ids: previous.accepted_event_ids,
          duplicate_event_ids: previous.duplicate_event_ids,
          session_mappings: previous.session_mappings,
          processing: 'complete',
        };
      }
      const startClients = new Set(
        kind === 'SESSION'
          ? (batch.events as SessionEvent[])
              .filter((event) => event.type === 'STARTED')
              .map((event) => event.client_session_id)
          : [],
      );
      for (const event of batch.events) {
        const clientId = event.client_session_id;
        const needs =
          kind === 'POSITION' ||
          (kind === 'SESSION' &&
            !['START_ATTEMPT', 'MISSED_START', 'STARTED'].includes((event as SessionEvent).type));
        if (
          needs &&
          clientId &&
          !startClients.has(clientId) &&
          !(await this.effective(db, principal.deviceId, scope, clientId))
        ) {
          const pending = await this.quarantine(db, kind, batch, scope, requestId);
          await db.query('COMMIT');
          return pending;
        }
      }
      const accepted: string[] = [],
        duplicate: string[] = [];
      const mappings = new Map<string, string>();
      const ordered =
        kind === 'SESSION'
          ? [...batch.events].sort(
              (a, b) =>
                Date.parse((a as SessionEvent).occurred_at) -
                  Date.parse((b as SessionEvent).occurred_at) ||
                ((a as SessionEvent).type === 'STARTED' ? -1 : 1),
            )
          : batch.events;
      for (const event of ordered) {
        if (kind === 'SESSION') {
          const outcome = await this.sessionEvent(
            db,
            principal.deviceId,
            scope,
            event as SessionEvent,
            anchors,
          );
          (outcome.duplicate ? duplicate : accepted).push(event.event_id);
          if (outcome.mapping)
            mappings.set(outcome.mapping.client_session_id, outcome.mapping.session_id);
        } else {
          const isDuplicate = await this.positionEvent(
            db,
            principal.deviceId,
            scope,
            event as PositionEvent,
            anchors,
          );
          (isDuplicate ? duplicate : accepted).push(event.event_id);
        }
        await db.query(
          'DELETE FROM gps_event_quarantine WHERE device_id=$1 AND event_id=$2 AND kind=$3',
          [principal.deviceId, event.event_id, kind],
        );
      }
      const persisted = this.now();
      const sessionMappings = [...mappings].map(([client_session_id, session_id]) => ({
        client_session_id,
        session_id,
      }));
      await db.query(
        `INSERT INTO gps_event_batch_receipt(device_id,kind,batch_id,payload_digest,
         accepted_event_ids,duplicate_event_ids,session_mappings,persisted_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          principal.deviceId,
          kind,
          batch.batch_id,
          fingerprint,
          accepted,
          duplicate,
          JSON.stringify(sessionMappings),
          persisted,
        ],
      );
      await db.query(
        `INSERT INTO gps_sync_status(device_id,last_ack_at,updated_at) VALUES($1,$2,$2)
         ON CONFLICT (device_id) DO UPDATE SET last_ack_at=$2,updated_at=$2`,
        [principal.deviceId, persisted],
      );
      await appendAudit(db, {
        actorType: 'DEVICE',
        deviceId: principal.deviceId,
        action: kind === 'SESSION' ? 'gps.session.ingest' : 'gps.position.ingest',
        outcome: 'success',
        correlationId: requestId,
        metadata: { accepted: accepted.length, duplicate: duplicate.length },
      });
      await db.query('COMMIT');
      return {
        batch_id: batch.batch_id,
        persisted_at: persisted.toISOString(),
        accepted_event_ids: accepted,
        duplicate_event_ids: duplicate,
        session_mappings: sessionMappings,
        processing: 'complete',
      };
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  private async sessionEvent(
    db: PoolClient,
    deviceId: string,
    scope: Scope,
    event: SessionEvent,
    anchors: Map<string, Anchor>,
    historicalMode = false,
    offline = false,
  ): Promise<{
    duplicate: boolean;
    mapping?: { client_session_id: string; session_id: string };
  }> {
    const hash = digest(event);
    const previous = await db.query<{ payload_digest: Buffer; session_id: string | null }>(
      'SELECT payload_digest,session_id FROM gps_session_event WHERE device_id=$1 AND event_id=$2',
      [deviceId, event.event_id],
    );
    if (previous.rows[0]) {
      if (!previous.rows[0].payload_digest.equals(hash)) conflict();
      const sessionId = previous.rows[0].session_id;
      return {
        duplicate: true,
        ...(sessionId && event.client_session_id
          ? { mapping: { client_session_id: event.client_session_id, session_id: sessionId } }
          : {}),
      };
    }
    const diagnostic = event.type === 'START_ATTEMPT' || event.type === 'MISSED_START';
    const terminal = event.type === 'STOPPED' || event.type === 'STOP_REQUESTED';
    const anchor = event.capture_anchor_id ? anchors.get(event.capture_anchor_id) : undefined;
    if (!diagnostic && (!anchor || event.anchor_elapsed_realtime_ms === undefined))
      invalid(event.event_id);
    if (anchor && event.anchor_elapsed_realtime_ms !== undefined)
      if (offline)
        await this.offlineTime(
          db,
          event.event_id,
          anchor,
          event.boot_id,
          event.elapsed_realtime_ms,
          event.occurred_at,
          terminal,
        );
      else
        await this.anchorTime(
          db,
          event.event_id,
          anchor,
          event.boot_id,
          event.anchor_elapsed_realtime_ms,
          event.elapsed_realtime_ms,
          event.occurred_at,
          terminal,
        );
    let effective: Effective | null = null;
    let scheduledId: string | null = null;
    if (event.type === 'STARTED') {
      const window = offline
        ? await this.offlineScheduled(
            db,
            deviceId,
            anchor ?? invalid(event.event_id),
            event.occurred_at,
          )
        : await this.scheduled(
            db,
            deviceId,
            event.assignment_version,
            event.occurred_at,
            event.scheduled_session_id,
          );
      if (!window || (!offline && window.id !== event.scheduled_session_id))
        invalid(event.event_id);
      scheduledId = window.id;
      await db.query(
        "UPDATE gps_scheduled_session SET state='SCHEDULED' WHERE id=$1 AND state='MISSED'",
        [window.id],
      );
      effective = await this.effective(
        db,
        deviceId,
        scope,
        event.client_session_id ?? invalid(event.event_id),
      );
      if (effective) conflict('client_session_conflict');
      let historical = false;
      if (historicalMode) {
        const later = await db.query<{ started_at: Date }>(
          `SELECT started_at FROM gps_effective_session WHERE device_id=$1 AND started_at>=$2
           ORDER BY started_at LIMIT 1`,
          [deviceId, event.occurred_at],
        );
        if (later.rows[0]) {
          if (window.end_at.getTime() > later.rows[0].started_at.getTime())
            conflict('session_order_conflict');
          historical = true;
        }
      }
      const open = await db.query<Effective & { window_end: Date }>(
        `SELECT e.*,s.end_at AS window_end FROM gps_effective_session e
         JOIN gps_scheduled_session s ON s.id=e.scheduled_session_id
         WHERE e.device_id=$1 AND e.state IN ('OPEN','INTERRUPTED') FOR UPDATE OF e`,
        [deviceId],
      );
      const old = open.rows[0];
      if (old && !historical) {
        if (old.started_at.getTime() >= Date.parse(event.occurred_at))
          conflict('session_order_conflict');
        if (
          old.window_end.getTime() > Date.parse(event.occurred_at) &&
          Number(old.assignment_version) === event.assignment_version
        )
          conflict('session_already_open');
        await db.query(
          "UPDATE gps_effective_session SET state='UNKNOWN_END',end_reason='UNKNOWN',evidence_state='START_REPORTED_END_UNKNOWN' WHERE id=$1",
          [old.id],
        );
      }
      const sessionId = randomUUID();
      await db.query(
        `INSERT INTO gps_effective_session(id,device_id,installation_id,client_session_id,
         scheduled_session_id,assignment_version,started_at,start_event_id,state,evidence_state,
         tenant_id,mdm_binding_id,start_boot_id,start_anchor_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          sessionId,
          deviceId,
          scope.installationId,
          event.client_session_id,
          window.id,
          event.assignment_version,
          event.occurred_at,
          event.event_id,
          historical ? 'UNKNOWN_END' : 'OPEN',
          historical ? 'START_REPORTED_END_UNKNOWN' : 'DEVICE_REPORTED',
          scope.tenantId,
          scope.bindingId,
          event.boot_id,
          (anchor ?? invalid(event.event_id)).capture_anchor_id,
        ],
      );
      effective = await this.effective(
        db,
        deviceId,
        scope,
        event.client_session_id ?? invalid(event.event_id),
      );
      if (!effective)
        throw new ApiError(503, 'gps_session_unavailable', 'Service unavailable', true);
    } else if (!diagnostic) {
      effective = await this.effective(
        db,
        deviceId,
        scope,
        event.client_session_id ?? invalid(event.event_id),
      );
      if (!effective) invalid(event.event_id);
      if (
        Number(effective.assignment_version) !== event.assignment_version ||
        effective.start_boot_id !== event.boot_id
      )
        invalid(event.event_id);
      scheduledId = effective.scheduled_session_id;
      if (Date.parse(event.occurred_at) < effective.started_at.getTime()) invalid(event.event_id);
      const last = await db.query<{ occurred_at: Date }>(
        'SELECT occurred_at FROM gps_session_event WHERE device_id=$1 AND session_id=$2 ORDER BY occurred_at DESC,event_id DESC LIMIT 1',
        [deviceId, effective.id],
      );
      if (last.rows[0] && Date.parse(event.occurred_at) < last.rows[0].occurred_at.getTime())
        conflict('session_order_conflict');
      if (event.type === 'INTERRUPTED') {
        if (effective.state !== 'OPEN') conflict('session_transition_conflict');
        const window = offline
          ? await this.offlineScheduled(
              db,
              deviceId,
              anchor ?? invalid(event.event_id),
              event.occurred_at,
            )
          : await this.scheduled(
              db,
              deviceId,
              event.assignment_version,
              event.occurred_at,
              effective.scheduled_session_id,
            );
        if (!window || window.id !== effective.scheduled_session_id) invalid(event.event_id);
        await db.query("UPDATE gps_effective_session SET state='INTERRUPTED' WHERE id=$1", [
          effective.id,
        ]);
      } else if (event.type === 'RESUMED') {
        if (effective.state !== 'INTERRUPTED') conflict('session_transition_conflict');
        const window = offline
          ? await this.offlineScheduled(
              db,
              deviceId,
              anchor ?? invalid(event.event_id),
              event.occurred_at,
            )
          : await this.scheduled(
              db,
              deviceId,
              event.assignment_version,
              event.occurred_at,
              effective.scheduled_session_id,
            );
        if (!window || window.id !== effective.scheduled_session_id) invalid(event.event_id);
        await db.query("UPDATE gps_effective_session SET state='OPEN' WHERE id=$1", [effective.id]);
      } else if (event.type === 'STOPPED') {
        if (!['OPEN', 'INTERRUPTED', 'UNKNOWN_END'].includes(effective.state))
          conflict('session_transition_conflict');
        await db.query(
          "UPDATE gps_effective_session SET state='STOPPED',stopped_at=$2,stop_event_id=$3,end_reason=$4 WHERE id=$1",
          [effective.id, event.occurred_at, event.event_id, event.reason_code ?? 'UNKNOWN'],
        );
      } else if (event.type === 'STOP_REQUESTED' && effective.state === 'STOPPED') {
        conflict('session_transition_conflict');
      }
    } else {
      const window = await this.scheduled(
        db,
        deviceId,
        event.assignment_version,
        event.occurred_at,
        event.scheduled_session_id,
      );
      scheduledId = window?.id ?? null;
      // A diagnostic without an anchor is never projected as effective evidence.
    }
    await db.query(
      `INSERT INTO gps_session_event(device_id,event_id,installation_id,client_session_id,
       session_id,type,occurred_at,reason_code,assignment_version,capture_anchor_id,
       boot_id,anchor_elapsed_realtime_ms,elapsed_realtime_ms,payload_digest,
        tenant_id,mdm_binding_id,scheduled_session_id,time_evidence)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        deviceId,
        event.event_id,
        scope.installationId,
        event.client_session_id ?? null,
        effective?.id ?? null,
        event.type,
        event.occurred_at,
        event.reason_code ?? null,
        event.assignment_version,
        event.capture_anchor_id ?? null,
        event.boot_id,
        event.anchor_elapsed_realtime_ms ?? null,
        event.elapsed_realtime_ms,
        hash,
        scope.tenantId,
        scope.bindingId,
        scheduledId,
        offline ? 'DEVICE_CLOCK_OFFLINE_V2' : 'SERVER_ANCHORED_V1',
      ],
    );
    if (event.type === 'MISSED_START' && scheduledId && !effective)
      await db.query("UPDATE gps_scheduled_session SET state='MISSED' WHERE id=$1", [scheduledId]);
    return {
      duplicate: false,
      ...(effective && event.client_session_id
        ? { mapping: { client_session_id: event.client_session_id, session_id: effective.id } }
        : {}),
    };
  }

  private async positionEvent(
    db: PoolClient,
    deviceId: string,
    scope: Scope,
    event: PositionEvent,
    anchors: Map<string, Anchor>,
    offline = false,
  ): Promise<boolean> {
    const hash = digest(event);
    const previous = await db.query<{ payload_digest: Buffer }>(
      'SELECT payload_digest FROM position_event WHERE device_id=$1 AND event_id=$2',
      [deviceId, event.event_id],
    );
    if (previous.rows[0]) {
      if (!previous.rows[0].payload_digest.equals(hash)) conflict();
      return true;
    }
    const effective = await this.effective(db, deviceId, scope, event.client_session_id);
    if (!effective) invalid(event.event_id);
    if (
      (event.session_id && event.session_id !== effective.id) ||
      Number(effective.assignment_version) !== event.assignment_version ||
      effective.start_boot_id !== event.boot_id ||
      Date.parse(event.captured_at) < effective.started_at.getTime() ||
      (effective.stopped_at && Date.parse(event.captured_at) >= effective.stopped_at.getTime())
    )
      invalid(event.event_id);
    const anchor = anchors.get(event.capture_anchor_id);
    if (!anchor) invalid(event.event_id);
    if (offline)
      await this.offlineTime(
        db,
        event.event_id,
        anchor,
        event.boot_id,
        event.elapsed_realtime_ms,
        event.captured_at,
      );
    else
      await this.anchorTime(
        db,
        event.event_id,
        anchor,
        event.boot_id,
        event.anchor_elapsed_realtime_ms,
        event.elapsed_realtime_ms,
        event.captured_at,
      );
    const window = offline
      ? await this.offlineScheduled(db, deviceId, anchor, event.captured_at)
      : await this.scheduled(
          db,
          deviceId,
          event.assignment_version,
          event.captured_at,
          effective.scheduled_session_id,
        );
    if (!window || window.id !== effective.scheduled_session_id) invalid(event.event_id);
    const last = await db.query<{ type: string }>(
      `SELECT type FROM gps_session_event WHERE device_id=$1 AND session_id=$2
       AND occurred_at<=$3 AND type IN ('STARTED','INTERRUPTED','RESUMED','STOPPED')
       ORDER BY occurred_at DESC,event_id DESC LIMIT 1`,
      [deviceId, effective.id, event.captured_at],
    );
    if (!['STARTED', 'RESUMED'].includes(last.rows[0]?.type ?? '')) invalid(event.event_id);
    await db.query(
      `INSERT INTO position_event(device_id,event_id,session_id,assignment_version,
       captured_at,capture_anchor_id,boot_id,anchor_elapsed_realtime_ms,elapsed_realtime_ms,
       geom,accuracy_m,payload_digest,quality_state,tenant_id,mdm_binding_id,installation_id,time_evidence)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,
         ST_SetSRID(ST_MakePoint($10,$11),4326)::geography,$12,$13,'DEVICE_REPORTED',$14,$15,$16,$17)`,
      [
        deviceId,
        event.event_id,
        effective.id,
        event.assignment_version,
        event.captured_at,
        event.capture_anchor_id,
        event.boot_id,
        event.anchor_elapsed_realtime_ms,
        event.elapsed_realtime_ms,
        event.longitude,
        event.latitude,
        event.accuracy_m,
        hash,
        scope.tenantId,
        scope.bindingId,
        scope.installationId,
        offline ? 'DEVICE_CLOCK_OFFLINE_V2' : 'SERVER_ANCHORED_V1',
      ],
    );
    return false;
  }

  private async tenantIds(adminId: string): Promise<string[]> {
    const result = await this.pool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM gps_data_tenant_access WHERE admin_id=$1 AND revoked_at IS NULL',
      [adminId],
    );
    return result.rows.map((row) => row.tenant_id);
  }

  async readSessions(
    adminId: string,
    requestId: string,
    deviceId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Record<string, unknown>> {
    await this.policies.requireCapability(adminId, 'gps.session.read', requestId);
    if (!uuid.test(deviceId) || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new GpsValidationError();
    const tenantIds = await this.tenantIds(adminId);
    const visible = await this.pool.query(
      `SELECT 1 FROM mdm_binding WHERE geops_device_id=$1 AND state='ACTIVE'
       AND customer_id=ANY($2::text[]) UNION
       SELECT 1 FROM gps_effective_session WHERE device_id=$1 AND tenant_id=ANY($2::text[]) LIMIT 1`,
      [deviceId, tenantIds],
    );
    if (!visible.rowCount) {
      await appendAudit(this.pool, {
        actorType: 'ADMIN',
        actorId: adminId,
        deviceId,
        action: 'gps.session.read',
        outcome: 'rejected',
        correlationId: requestId,
        metadata: { code: 'tenant_scope' },
      });
      throw new ApiError(404, 'not_found', 'Not found');
    }
    const before = this.cursor(cursor);
    const rows = await this.pool.query<{
      id: string;
      cursor_id: string;
      start_at: Date;
      end_at: Date;
      scheduled_state: string;
      session_id: string | null;
      effective_state: string | null;
      evidence_state: string | null;
      started_at: Date | null;
      stopped_at: Date | null;
      missed: boolean;
      interrupted: number;
    }>(
      `SELECT s.id,coalesce(e.id,s.id) AS cursor_id,s.start_at,s.end_at,s.state AS scheduled_state,
         e.id AS session_id,e.state AS effective_state,e.evidence_state,
         e.started_at,e.stopped_at,
         EXISTS(SELECT 1 FROM gps_session_event x WHERE x.scheduled_session_id=s.id
           AND x.type='MISSED_START' AND x.tenant_id=ANY($2::text[])) AS missed,
         (SELECT count(*)::int FROM gps_session_event x WHERE x.session_id=e.id
           AND x.type='INTERRUPTED') AS interrupted
       FROM gps_scheduled_session s
       LEFT JOIN gps_effective_session e ON e.scheduled_session_id=s.id
         AND e.tenant_id=ANY($2::text[])
       WHERE s.device_id=$1 AND
         (e.id IS NOT NULL OR EXISTS(SELECT 1 FROM mdm_binding b
           WHERE b.geops_device_id=s.device_id AND b.state='ACTIVE'
             AND b.customer_id=ANY($2::text[])))
         AND ($3::timestamptz IS NULL OR
           (s.start_at,coalesce(e.id,s.id))<($3::timestamptz,$4::uuid))
       ORDER BY s.start_at DESC,coalesce(e.id,s.id) DESC LIMIT $5`,
      [deviceId, tenantIds, before?.at ?? null, before?.id ?? null, limit + 1],
    );
    const selected = rows.rows.slice(0, limit);
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      deviceId,
      action: 'gps.session.read',
      outcome: 'success',
      correlationId: requestId,
      metadata: { count: selected.length },
    });
    const last = selected.at(-1);
    return {
      items: selected.map((row) => ({
        scheduled_session_id: row.id,
        scheduled_start_at: row.start_at.toISOString(),
        scheduled_end_at: row.end_at.toISOString(),
        state: row.effective_state ?? row.scheduled_state,
        evidence_state:
          row.evidence_state ??
          (row.scheduled_state === 'MISSED' ? 'SERVER_INFERRED_MISSED' : 'SCHEDULED_ONLY'),
        missed_start_reported: row.missed,
        interruption_count: row.interrupted,
        ...(row.session_id ? { session_id: row.session_id } : {}),
        ...(row.started_at ? { started_at: row.started_at.toISOString() } : {}),
        ...(row.stopped_at ? { stopped_at: row.stopped_at.toISOString() } : {}),
      })),
      next_cursor:
        rows.rows.length > limit && last
          ? Buffer.from(`${last.start_at.toISOString()}|${last.cursor_id}`).toString('base64url')
          : null,
    };
  }

  async readPositions(
    adminId: string,
    requestId: string,
    deviceId: string,
    reason: string,
    from: string,
    to: string,
    cursor: string | undefined,
    limit: number,
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    await this.policies.requireCapability(adminId, 'gps.location.read', requestId);
    if (
      !uuid.test(deviceId) ||
      typeof reason !== 'string' ||
      reason.trim().length < 8 ||
      reason.length > 240 ||
      !utc.test(from) ||
      !utc.test(to) ||
      !Number.isFinite(Date.parse(from)) ||
      !Number.isFinite(Date.parse(to)) ||
      Date.parse(from) >= Date.parse(to) ||
      Date.parse(to) - Date.parse(from) > DAY ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (sessionId !== undefined && !uuid.test(sessionId))
    )
      throw new GpsValidationError();
    const tenantIds = await this.tenantIds(adminId);
    const visible = await this.pool.query(
      `SELECT 1 FROM mdm_binding WHERE geops_device_id=$1 AND state='ACTIVE'
       AND customer_id=ANY($2::text[]) UNION
       SELECT 1 FROM position_event WHERE device_id=$1 AND tenant_id=ANY($2::text[]) LIMIT 1`,
      [deviceId, tenantIds],
    );
    if (!visible.rowCount) {
      await appendAudit(this.pool, {
        actorType: 'ADMIN',
        actorId: adminId,
        deviceId,
        action: 'gps.location.read',
        outcome: 'rejected',
        correlationId: requestId,
        metadata: { code: 'tenant_scope', access_reason: reason.trim() },
      });
      throw new ApiError(404, 'not_found', 'Not found');
    }
    const before = this.cursor(cursor);
    const rows = await this.pool.query<{
      event_id: string;
      session_id: string;
      captured_at: Date;
      received_at: Date;
      latitude: number;
      longitude: number;
      accuracy_m: number;
    }>(
      `SELECT event_id,session_id,captured_at,received_at,ST_Y(geom::geometry) AS latitude,
         ST_X(geom::geometry) AS longitude,accuracy_m FROM position_event
       WHERE device_id=$1 AND tenant_id=ANY($2::text[]) AND
         captured_at >=$3 AND captured_at<$4 AND ($8::uuid IS NULL OR session_id=$8) AND
         ($5::timestamptz IS NULL OR (captured_at,event_id)<($5::timestamptz,$6::uuid))
       ORDER BY captured_at DESC,event_id DESC LIMIT $7`,
      [
        deviceId,
        tenantIds,
        from,
        to,
        before?.at ?? null,
        before?.id ?? null,
        limit + 1,
        sessionId ?? null,
      ],
    );
    const selected = rows.rows.slice(0, limit);
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      deviceId,
      action: 'gps.location.read',
      outcome: 'success',
      correlationId: requestId,
      metadata: { count: selected.length, access_reason: reason.trim() },
    });
    const last = selected.at(-1);
    return {
      items: selected.map((row) => ({
        event_id: row.event_id,
        session_id: row.session_id,
        captured_at: row.captured_at.toISOString(),
        received_at: row.received_at.toISOString(),
        latitude: row.latitude,
        longitude: row.longitude,
        accuracy_m: row.accuracy_m,
      })),
      next_cursor:
        rows.rows.length > limit && last
          ? Buffer.from(`${last.captured_at.toISOString()}|${last.event_id}`).toString('base64url')
          : null,
    };
  }

  private cursor(value: string | undefined): { at: string; id: string } | null {
    if (value === undefined) return null;
    if (value.length > 200) throw new GpsValidationError();
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const [at, id, extra] = decoded.split('|');
    if (
      !at ||
      !id ||
      extra !== undefined ||
      !utc.test(at) ||
      !uuid.test(id) ||
      !Number.isFinite(Date.parse(at)) ||
      Buffer.from(decoded).toString('base64url') !== value
    )
      throw new GpsValidationError();
    return { at, id };
  }

  async purgeExpired(limit = 500): Promise<{ positions: number; quarantined: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('invalid_limit');
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const cutoff = new Date(this.now().getTime() - RETENTION);
      const positions = await db.query(
        'DELETE FROM position_event WHERE ctid IN (SELECT ctid FROM position_event WHERE captured_at<$1 LIMIT $2)',
        [cutoff, limit],
      );
      const pending = await db.query(
        `UPDATE gps_event_quarantine SET reason_code='dependency_expired',
           encrypted_payload_ref='expired',payload_ciphertext=decode('','hex')
         WHERE ctid IN (SELECT ctid FROM gps_event_quarantine
           WHERE expires_at<$1 AND reason_code='pending_dependency' LIMIT $2)`,
        [this.now(), limit],
      );
      await db.query(
        `DELETE FROM gps_event_quarantine WHERE reason_code='dependency_expired'
           AND first_seen_at<$1`,
        [cutoff],
      );
      await db.query('DELETE FROM gps_event_batch_receipt WHERE persisted_at<$1', [cutoff]);
      await db.query('DELETE FROM gps_mixed_batch_receipt WHERE persisted_at<$1', [cutoff]);
      await db.query('DELETE FROM gps_event_request_quota WHERE minute_bucket<$1', [
        new Date(this.now().getTime() - DAY),
      ]);
      await appendAudit(db, {
        actorType: 'SYSTEM',
        action: 'gps.events.purge',
        outcome: 'success',
        correlationId: randomUUID(),
        metadata: { positions: positions.rowCount ?? 0, quarantined: pending.rowCount ?? 0 },
      });
      await db.query('COMMIT');
      return { positions: positions.rowCount ?? 0, quarantined: pending.rowCount ?? 0 };
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
}
