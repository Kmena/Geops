import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { appendAudit } from './audit/index.js';
import { resolveGpsDeviceScope } from './gps-device-scope.js';
import type { DevicePrincipal } from './device-identity/session.js';
import { ApiError } from './errors.js';
import type { GpsPolicyService } from './gps-policy-service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const STATES = [
  'ONLINE',
  'GPS_UNAVAILABLE',
  'NETWORK_UNAVAILABLE',
  'BATTERY_LOW',
  'BATTERY_CRITICAL',
  'POWER_SAVE_ENABLED',
  'UNKNOWN',
] as const;
type State = (typeof STATES)[number];
type TrackingState = 'RUNNING' | 'STOPPED';
const MAX_BATCH = 100;
const MAX_BYTES = 128 * 1024;
const RETENTION_MS = 90 * 86_400_000;

interface HealthEvent {
  event_id: string;
  device_id: string;
  installation_id: string;
  assignment_version: number;
  policy_revision: number;
  due_at: string;
  observed_at: string;
  boot_id: string;
  capture_anchor_id: string;
  anchor_elapsed_realtime_ms: number;
  elapsed_realtime_ms: number;
  battery_percent: number | null;
  charging: boolean | null;
  plugged: boolean | null;
  power_save: boolean | null;
  provider_available: boolean | null;
  network_available: boolean | null;
  tracking_state: TrackingState;
  observed_states: State[];
}
interface HealthBatch {
  schema_version: 1;
  batch_id: string;
  device_id: string;
  installation_id: string;
  events: HealthEvent[];
}
interface HealthAck {
  batch_id: string;
  persisted_at: string;
  accepted_event_ids: string[];
  duplicate_event_ids: string[];
}
interface HealthRow extends Omit<HealthEvent, 'due_at' | 'observed_at'> {
  due_at: Date;
  observed_at: Date;
  received_at: Date;
  tenant_id: string;
}

export class HealthValidationError extends ApiError {
  constructor(readonly invalidIds: string[] = []) {
    super(422, 'invalid_health_event', 'Invalid request', true);
  }
}
export class HealthRateLimited extends ApiError {
  constructor(readonly retryAfter: number) {
    super(429, 'rate_limited', 'Try again later', true);
  }
}

function record(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !names.includes(key))
  )
    throw new HealthValidationError();
  return value as Record<string, unknown>;
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
function utc(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    UTC.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z')
  );
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}
function optionalBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean';
}
function expectedStates(event: HealthEvent): State[] {
  const states: State[] = [];
  if (event.provider_available === false) states.push('GPS_UNAVAILABLE');
  if (event.network_available === false) states.push('NETWORK_UNAVAILABLE');
  if (event.battery_percent !== null) {
    if (event.battery_percent <= 5) states.push('BATTERY_CRITICAL');
    else if (event.battery_percent <= 15) states.push('BATTERY_LOW');
  }
  if (event.power_save === true) states.push('POWER_SAVE_ENABLED');
  if (!states.length)
    states.push(
      event.tracking_state === 'RUNNING' &&
        event.provider_available === true &&
        event.network_available === true &&
        event.battery_percent !== null &&
        event.power_save !== null
        ? 'ONLINE'
        : 'UNKNOWN',
    );
  return states;
}

export function parseHealthBatch(body: unknown, bytes: number): HealthBatch {
  if (bytes > MAX_BYTES) throw new ApiError(413, 'batch_too_large', 'Request too large', true);
  const b = record(body, ['schema_version', 'batch_id', 'device_id', 'installation_id', 'events']);
  if (
    b.schema_version !== 1 ||
    !uuid(b.batch_id) ||
    !uuid(b.device_id) ||
    !uuid(b.installation_id) ||
    !Array.isArray(b.events) ||
    b.events.length < 1 ||
    b.events.length > MAX_BATCH
  )
    throw new HealthValidationError();
  const events: HealthEvent[] = [];
  const ids = new Set<string>();
  for (const raw of b.events) {
    const eventId =
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      uuid((raw as Record<string, unknown>).event_id)
        ? (raw as { event_id: string }).event_id
        : undefined;
    try {
      const e = record(raw, [
        'event_id',
        'device_id',
        'installation_id',
        'assignment_version',
        'policy_revision',
        'due_at',
        'observed_at',
        'boot_id',
        'capture_anchor_id',
        'anchor_elapsed_realtime_ms',
        'elapsed_realtime_ms',
        'battery_percent',
        'charging',
        'plugged',
        'power_save',
        'provider_available',
        'network_available',
        'tracking_state',
        'observed_states',
      ]);
      if (
        !uuid(e.event_id) ||
        !uuid(e.device_id) ||
        !uuid(e.installation_id) ||
        !uuid(e.boot_id) ||
        !uuid(e.capture_anchor_id) ||
        !integer(e.assignment_version, 0) ||
        !integer(e.policy_revision, 1) ||
        !integer(e.anchor_elapsed_realtime_ms, 0) ||
        !integer(e.elapsed_realtime_ms, 0) ||
        e.elapsed_realtime_ms < e.anchor_elapsed_realtime_ms ||
        !utc(e.due_at) ||
        !utc(e.observed_at) ||
        Date.parse(e.due_at) > Date.parse(e.observed_at) ||
        !(e.battery_percent === null || integer(e.battery_percent, 0, 100)) ||
        !optionalBoolean(e.charging) ||
        !optionalBoolean(e.plugged) ||
        !optionalBoolean(e.power_save) ||
        !optionalBoolean(e.provider_available) ||
        !optionalBoolean(e.network_available) ||
        (e.tracking_state !== 'RUNNING' && e.tracking_state !== 'STOPPED') ||
        !Array.isArray(e.observed_states) ||
        e.observed_states.length < 1 ||
        e.observed_states.length > 6 ||
        e.observed_states.some((s) => !STATES.includes(s)) ||
        new Set(e.observed_states).size !== e.observed_states.length ||
        ids.has(e.event_id)
      )
        throw new HealthValidationError(eventId ? [eventId] : []);
      const parsed = e as unknown as HealthEvent;
      if (
        parsed.device_id !== b.device_id ||
        parsed.installation_id !== b.installation_id ||
        expectedStates(parsed).sort().join('|') !== [...parsed.observed_states].sort().join('|')
      )
        throw new HealthValidationError([parsed.event_id]);
      ids.add(parsed.event_id);
      events.push(parsed);
    } catch (error) {
      if (error instanceof HealthValidationError)
        throw error.invalidIds.length || !eventId ? error : new HealthValidationError([eventId]);
      throw new HealthValidationError(eventId ? [eventId] : []);
    }
  }
  return {
    schema_version: 1,
    batch_id: b.batch_id,
    device_id: b.device_id,
    installation_id: b.installation_id,
    events,
  };
}

function digest(event: HealthEvent): Buffer {
  const ordered = {
    event_id: event.event_id,
    device_id: event.device_id,
    installation_id: event.installation_id,
    assignment_version: event.assignment_version,
    policy_revision: event.policy_revision,
    due_at: event.due_at,
    observed_at: event.observed_at,
    boot_id: event.boot_id,
    capture_anchor_id: event.capture_anchor_id,
    anchor_elapsed_realtime_ms: event.anchor_elapsed_realtime_ms,
    elapsed_realtime_ms: event.elapsed_realtime_ms,
    battery_percent: event.battery_percent,
    charging: event.charging,
    plugged: event.plugged,
    power_save: event.power_save,
    provider_available: event.provider_available,
    network_available: event.network_available,
    tracking_state: event.tracking_state,
    observed_states: [...event.observed_states].sort(),
  };
  return createHash('sha256').update(JSON.stringify(ordered)).digest();
}
function batchDigest(batch: HealthBatch): Buffer {
  return createHash('sha256')
    .update(batch.events.map((event) => digest(event).toString('hex')).join('|'))
    .digest();
}
function invalid(id: string): never {
  throw new HealthValidationError([id]);
}

export class GpsHealthService {
  constructor(
    private readonly pool: Pool,
    private readonly policies: GpsPolicyService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async checkQuota(deviceId: string): Promise<void> {
    const at = this.now();
    const bucket = new Date(Math.floor(at.getTime() / 60_000) * 60_000);
    const result = await this.pool.query(
      'INSERT INTO gps_health_request_quota(device_id,minute_bucket,request_count) VALUES($1,$2,1) ON CONFLICT (device_id,minute_bucket) DO UPDATE SET request_count=gps_health_request_quota.request_count+1 WHERE gps_health_request_quota.request_count<6 RETURNING request_count',
      [deviceId, bucket],
    );
    if (!result.rowCount)
      throw new HealthRateLimited(Math.ceil((bucket.getTime() + 60_000 - at.getTime()) / 1000));
  }

  async ingest(
    principal: DevicePrincipal,
    batch: HealthBatch,
    requestId: string,
  ): Promise<HealthAck> {
    if (batch.device_id !== principal.deviceId)
      throw new ApiError(403, 'device_mismatch', 'Forbidden', true);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const identity = await resolveGpsDeviceScope(db, principal.deviceId, batch.installation_id);
      const tenant = { id: identity.bindingId, customer_id: identity.tenantId };
      const received = this.now();
      for (const event of batch.events) {
        const observed = Date.parse(event.observed_at);
        if (observed < received.getTime() - RETENTION_MS || observed > received.getTime() + 30_000)
          invalid(event.event_id);
      }
      const prior = await db.query<{
        payload_digest: Buffer;
        accepted_event_ids: string[];
        duplicate_event_ids: string[];
        persisted_at: Date;
      }>(
        'SELECT payload_digest,accepted_event_ids,duplicate_event_ids,persisted_at FROM gps_health_batch_receipt WHERE device_id=$1 AND batch_id=$2 FOR UPDATE',
        [principal.deviceId, batch.batch_id],
      );
      const fingerprint = batchDigest(batch);
      if (prior.rows[0]) {
        if (!prior.rows[0].payload_digest.equals(fingerprint))
          throw new ApiError(409, 'batch_conflict', 'Conflict', true);
        await db.query('COMMIT');
        return {
          batch_id: batch.batch_id,
          persisted_at: prior.rows[0].persisted_at.toISOString(),
          accepted_event_ids: prior.rows[0].accepted_event_ids,
          duplicate_event_ids: prior.rows[0].duplicate_event_ids,
        };
      }
      const anchorIds = [...new Set(batch.events.map((e) => e.capture_anchor_id))].sort();
      const anchors = await db.query<{
        capture_anchor_id: string;
        device_id: string;
        installation_id: string;
        assignment_version: string;
        health_mdm_binding_id: string | null;
        health_tenant_id: string | null;
        server_time: Date;
        offline_not_after: Date;
        health_boot_id: string | null;
      }>(
        'SELECT capture_anchor_id,device_id,installation_id,assignment_version,health_mdm_binding_id,health_tenant_id,server_time,offline_not_after,health_boot_id FROM gps_policy_delivery WHERE capture_anchor_id=ANY($1::uuid[]) ORDER BY capture_anchor_id FOR UPDATE',
        [anchorIds],
      );
      const byAnchor = new Map(anchors.rows.map((row) => [row.capture_anchor_id, row]));
      const accepted: string[] = [];
      const duplicate: string[] = [];
      for (const event of batch.events) {
        const observed = Date.parse(event.observed_at);
        const due = Date.parse(event.due_at);
        const anchor = byAnchor.get(event.capture_anchor_id);
        if (
          !anchor ||
          anchor.device_id !== principal.deviceId ||
          anchor.installation_id !== batch.installation_id ||
          Number(anchor.assignment_version) !== event.assignment_version ||
          anchor.health_mdm_binding_id !== tenant.id ||
          anchor.health_tenant_id !== tenant.customer_id ||
          (anchor.health_boot_id !== null && anchor.health_boot_id !== event.boot_id) ||
          observed < anchor.server_time.getTime() ||
          observed >= anchor.offline_not_after.getTime() ||
          Math.abs(
            observed -
              (anchor.server_time.getTime() +
                event.elapsed_realtime_ms -
                event.anchor_elapsed_realtime_ms),
          ) > 30_000
        )
          invalid(event.event_id);
        const window = await db.query<{ id: string }>(
          `SELECT s.id FROM gps_scheduled_session s JOIN gps_policy_revision r
             ON r.policy_id=s.policy_id AND r.revision=s.revision
           WHERE s.device_id=$1 AND s.assignment_version=$2 AND s.revision=$3
             AND s.start_at<=$4 AND $4<s.end_at AND s.start_at<=$5 AND $5<s.end_at
             AND r.valid_from<=$4 AND $4<r.valid_until LIMIT 2`,
          [
            principal.deviceId,
            event.assignment_version,
            event.policy_revision,
            new Date(observed),
            new Date(due),
          ],
        );
        const selectedWindow = window.rows[0];
        if (window.rows.length !== 1 || !selectedWindow) invalid(event.event_id);
        if (anchor.health_boot_id === null) {
          await db.query(
            'UPDATE gps_policy_delivery SET health_boot_id=$2 WHERE capture_anchor_id=$1',
            [event.capture_anchor_id, event.boot_id],
          );
          anchor.health_boot_id = event.boot_id;
        }
        const eventDigest = digest(event);
        const inserted = await db.query(
          `INSERT INTO gps_device_health_event(device_id,event_id,tenant_id,mdm_binding_id,
            installation_id,batch_id,assignment_version,policy_revision,scheduled_session_id,
            capture_anchor_id,boot_id,anchor_elapsed_realtime_ms,elapsed_realtime_ms,due_at,
            observed_at,received_at,battery_percent,charging,plugged,power_save,
            provider_available,network_available,tracking_state,observed_states,payload_digest)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
           ON CONFLICT (device_id,event_id) DO NOTHING RETURNING event_id`,
          [
            principal.deviceId,
            event.event_id,
            tenant.customer_id,
            tenant.id,
            batch.installation_id,
            batch.batch_id,
            event.assignment_version,
            event.policy_revision,
            selectedWindow.id,
            event.capture_anchor_id,
            event.boot_id,
            event.anchor_elapsed_realtime_ms,
            event.elapsed_realtime_ms,
            event.due_at,
            event.observed_at,
            received,
            event.battery_percent,
            event.charging,
            event.plugged,
            event.power_save,
            event.provider_available,
            event.network_available,
            event.tracking_state,
            event.observed_states,
            eventDigest,
          ],
        );
        if (inserted.rowCount) accepted.push(event.event_id);
        else {
          const existing = await db.query<{ payload_digest: Buffer }>(
            'SELECT payload_digest FROM gps_device_health_event WHERE device_id=$1 AND event_id=$2',
            [principal.deviceId, event.event_id],
          );
          if (!existing.rows[0]?.payload_digest.equals(eventDigest))
            throw new ApiError(409, 'event_conflict', 'Conflict', true);
          duplicate.push(event.event_id);
        }
      }
      await db.query(
        'INSERT INTO gps_health_batch_receipt(device_id,batch_id,payload_digest,accepted_event_ids,duplicate_event_ids,persisted_at) VALUES($1,$2,$3,$4,$5,$6)',
        [principal.deviceId, batch.batch_id, fingerprint, accepted, duplicate, received],
      );
      await appendAudit(db, {
        actorType: 'DEVICE',
        deviceId: principal.deviceId,
        action: 'gps.health.ingest',
        outcome: 'success',
        correlationId: requestId,
        metadata: { accepted: accepted.length, duplicate: duplicate.length },
      });
      await db.query('COMMIT');
      return {
        batch_id: batch.batch_id,
        persisted_at: received.toISOString(),
        accepted_event_ids: accepted,
        duplicate_event_ids: duplicate,
      };
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  async read(
    adminId: string,
    requestId: string,
    deviceId: string,
    reason: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Record<string, unknown>> {
    await this.policies.requireCapability(adminId, 'gps.session.read', requestId);
    if (
      !uuid(deviceId) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      reason.trim().length < 8 ||
      reason.length > 240
    )
      throw new HealthValidationError();
    const tenants = await this.pool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM gps_health_tenant_access WHERE admin_id=$1 AND revoked_at IS NULL',
      [adminId],
    );
    const tenantIds = tenants.rows.map((row) => row.tenant_id);
    const visible = await this.pool.query(
      `SELECT 1 FROM mdm_binding WHERE geops_device_id=$1 AND customer_id=ANY($2::text[])
       UNION SELECT 1 FROM gps_device_health_event WHERE device_id=$1 AND tenant_id=ANY($2::text[]) LIMIT 1`,
      [deviceId, tenantIds],
    );
    if (!visible.rowCount) {
      await appendAudit(this.pool, {
        actorType: 'ADMIN',
        actorId: adminId,
        deviceId,
        action: 'gps.health.read',
        outcome: 'rejected',
        correlationId: requestId,
        metadata: { code: 'tenant_scope', access_reason: reason.trim() },
      });
      throw new ApiError(404, 'not_found', 'Not found');
    }
    let beforeAt: string | null = null;
    let beforeId: string | null = null;
    if (cursor !== undefined) {
      if (cursor.length > 200) throw new HealthValidationError();
      const decoded = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
      if (
        decoded.length !== 2 ||
        !utc(decoded[0]) ||
        !uuid(decoded[1]) ||
        Buffer.from(decoded.join('|')).toString('base64url') !== cursor
      )
        throw new HealthValidationError();
      [beforeAt, beforeId] = decoded as [string, string];
    }
    const latest = await this.pool.query<HealthRow>(
      `SELECT * FROM gps_device_health_event WHERE device_id=$1 AND tenant_id=ANY($2::text[])
       ORDER BY observed_at DESC,event_id DESC LIMIT 1`,
      [deviceId, tenantIds],
    );
    const history = await this.pool.query<HealthRow>(
      `SELECT * FROM gps_device_health_event WHERE device_id=$1 AND tenant_id=ANY($2::text[])
         AND ($3::timestamptz IS NULL OR (observed_at,event_id)<($3::timestamptz,$4::uuid))
       ORDER BY observed_at DESC,event_id DESC LIMIT $5`,
      [deviceId, tenantIds, beforeAt, beforeId, limit + 1],
    );
    const rows = history.rows.slice(0, limit);
    const last = rows.at(-1);
    const next =
      history.rows.length > limit && last
        ? Buffer.from(`${last.observed_at.toISOString()}|${last.event_id}`).toString('base64url')
        : null;
    const now = this.now();
    const currentWindow = await this.pool.query<{
      start_at: Date;
      heartbeat_missing_after_s: number;
    }>(
      `SELECT s.start_at,r.heartbeat_missing_after_s FROM gps_scheduled_session s
       JOIN gps_policy_revision r ON r.policy_id=s.policy_id AND r.revision=s.revision
       JOIN mdm_binding b ON b.geops_device_id=s.device_id AND b.state='ACTIVE'
       WHERE s.device_id=$1 AND s.start_at<=$2 AND $2<s.end_at AND s.state='SCHEDULED'
         AND b.customer_id=ANY($3::text[])
       ORDER BY s.start_at DESC LIMIT 1`,
      [deviceId, now, tenantIds],
    );
    const recent = latest.rows[0];
    const window = currentWindow.rows[0];
    const silenceStart = window
      ? Math.max(window.start_at.getTime(), recent?.received_at.getTime() ?? 0)
      : 0;
    const silent =
      !!window && now.getTime() - silenceStart > window.heartbeat_missing_after_s * 1000;
    const observed = recent?.observed_states ?? ['UNKNOWN'];
    const priority: State[] = [
      'BATTERY_CRITICAL',
      'GPS_UNAVAILABLE',
      'NETWORK_UNAVAILABLE',
      'BATTERY_LOW',
      'POWER_SAVE_ENABLED',
      'ONLINE',
      'UNKNOWN',
    ];
    const state = silent
      ? 'NO_COMMUNICATION'
      : (priority.find((item) => observed.includes(item)) ?? 'UNKNOWN');
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      deviceId,
      action: 'gps.health.read',
      outcome: 'success',
      correlationId: requestId,
      metadata: { count: rows.length, access_reason: reason.trim() },
    });
    return {
      device_id: deviceId,
      state,
      source: silent ? 'SERVER_INFERENCE' : recent ? 'DEVICE_OBSERVATION' : 'SERVER_INFERENCE',
      observed_at: recent?.observed_at.toISOString() ?? null,
      possible_battery_depletion:
        silent &&
        recent?.battery_percent !== null &&
        recent?.battery_percent !== undefined &&
        recent.battery_percent <= 5,
      latest: recent ? this.view(recent) : null,
      items: rows.map((row) => this.view(row)),
      next_cursor: next,
    };
  }

  async purgeExpired(limit = 500): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) throw new Error('invalid_limit');
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const cutoff = new Date(this.now().getTime() - RETENTION_MS);
      const removed = await db.query(
        `DELETE FROM gps_device_health_event WHERE ctid IN
         (SELECT ctid FROM gps_device_health_event WHERE observed_at<$1 ORDER BY observed_at LIMIT $2
          FOR UPDATE SKIP LOCKED) RETURNING event_id`,
        [cutoff, limit],
      );
      await db.query('DELETE FROM gps_health_batch_receipt WHERE persisted_at<$1', [cutoff]);
      await db.query('DELETE FROM gps_health_request_quota WHERE minute_bucket<$1', [
        new Date(this.now().getTime() - 2 * 86_400_000),
      ]);
      await appendAudit(db, {
        actorType: 'SYSTEM',
        action: 'gps.health.purge',
        outcome: 'success',
        correlationId: randomUUID(),
        metadata: { removed: removed.rowCount ?? 0 },
      });
      await db.query('COMMIT');
      return removed.rowCount ?? 0;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  private view(row: HealthRow): Record<string, unknown> {
    return {
      event_id: row.event_id,
      assignment_version: row.assignment_version,
      policy_revision: row.policy_revision,
      due_at: new Date(row.due_at).toISOString(),
      observed_at: new Date(row.observed_at).toISOString(),
      received_at: row.received_at.toISOString(),
      battery_percent: row.battery_percent,
      charging: row.charging,
      plugged: row.plugged,
      power_save: row.power_save,
      provider_available: row.provider_available,
      network_available: row.network_available,
      tracking_state: row.tracking_state,
      observed_states: row.observed_states,
    };
  }
}
