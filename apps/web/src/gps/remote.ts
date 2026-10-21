import { ApiClientError, type AdminProfile } from '../api/client.js';
import { apiPath } from '../api/base.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RemotePolicy {
  id: string;
  state: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'REVOKED';
  etag: string;
  revision: number;
  policy: RemotePolicySpec;
  assignments?: RemoteAssignment[];
}

export interface RemoteAssignment {
  scope_type: 'DEVICE' | 'GROUP';
  scope_id: string;
  valid_from: string;
  valid_until: string;
}

export interface RemotePolicySpec {
  name: string;
  days_iso: number[];
  start_local: string;
  end_local: string;
  time_zone: string;
  capture_interval_s: number;
  sync_interval_s: number;
  heartbeat_missing_after_s: number;
  health_interval_s: number;
  valid_from: string;
  valid_until: string;
  exceptions?: Array<{
    local_date: string;
    mode: 'OFF' | 'REPLACE';
    start_local?: string;
    end_local?: string;
    reason: string;
  }>;
}

export interface RemoteHealthEvent {
  event_id: string;
  observed_at: string;
  received_at: string;
  battery_percent: number | null;
  charging: boolean | null;
  plugged: boolean | null;
  power_save: boolean | null;
  provider_available: boolean | null;
  network_available: boolean | null;
  tracking_state: string | null;
  observed_states: string[];
}

export interface RemoteHealth {
  device_id: string;
  state: string;
  source: 'DEVICE_OBSERVATION' | 'SERVER_INFERENCE';
  observed_at: string | null;
  possible_battery_depletion: boolean;
  latest: RemoteHealthEvent | null;
  items: RemoteHealthEvent[];
  next_cursor: string | null;
}

export interface RemotePage<T> {
  items: T[];
  next_cursor: string | null;
}

export interface RemoteGpsDevice {
  device_id: string;
  display_label?: string;
  identity_state?: string;
  tenant_id: string;
  installation_id: string | null;
  assignment_version: number;
}

export interface RemoteGpsSession {
  scheduled_session_id: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
  state: string;
  evidence_state: string;
  missed_start_reported: boolean;
  interruption_count: number;
  session_id?: string;
  started_at?: string;
  stopped_at?: string;
}

export interface RemotePosition {
  event_id: string;
  session_id: string;
  captured_at: string;
  received_at: string;
  latitude: number;
  longitude: number;
  accuracy_m: number;
}

export interface RemoteContinuityAlert {
  alert_id: string;
  device_id: string;
  scheduled_session_id: string;
  status: 'OPEN' | 'RESOLVED';
  reason_code: 'CAPTURE_STALE' | 'COMMUNICATION_MISSING';
  severity: 'WARNING' | 'CRITICAL';
  source: 'SERVER_INFERENCE';
  observed: {
    tracking_state: 'RUNNING' | 'STOPPED' | null;
    last_position_captured_at: string | null;
    last_position_received_at: string | null;
    last_health_observed_at: string | null;
    last_health_received_at: string | null;
  };
  inference: {
    evidence_at: string | null;
    age_s: number;
    threshold_s: number;
    evaluated_at: string | null;
  };
  opened_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolution_reason:
    | 'EVIDENCE_RECOVERED'
    | 'WINDOW_ENDED'
    | 'POLICY_CHANGED'
    | 'DEVICE_INACTIVE'
    | 'INSTALLATION_CHANGED'
    | null;
}

export interface RemoteContinuityPage extends RemotePage<RemoteContinuityAlert> {
  schema_version: 1;
}

export interface ContinuityFilters {
  device_id?: string;
  status?: 'OPEN' | 'RESOLVED' | 'ALL';
  severity?: 'WARNING' | 'CRITICAL';
  reason_code?: 'CAPTURE_STALE' | 'COMMUNICATION_MISSING';
  opened_from?: string;
  opened_before?: string;
  limit?: number;
  cursor?: string;
}

function validContinuityPage(value: unknown): value is RemoteContinuityPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const page = value as Record<string, unknown>;
  if (
    page.schema_version !== 1 ||
    !Array.isArray(page.items) ||
    !(
      page.next_cursor === null ||
      (typeof page.next_cursor === 'string' &&
        page.next_cursor.length > 0 &&
        page.next_cursor.length <= 1024)
    )
  )
    return false;
  return page.items.every((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    if (
      !uuid.test(String(item.alert_id)) ||
      !uuid.test(String(item.device_id)) ||
      !uuid.test(String(item.scheduled_session_id)) ||
      !['OPEN', 'RESOLVED'].includes(String(item.status)) ||
      !['CAPTURE_STALE', 'COMMUNICATION_MISSING'].includes(String(item.reason_code)) ||
      !['WARNING', 'CRITICAL'].includes(String(item.severity)) ||
      item.source !== 'SERVER_INFERENCE'
    )
      return false;
    const observed = item.observed;
    const inference = item.inference;
    if (!observed || typeof observed !== 'object' || !inference || typeof inference !== 'object')
      return false;
    const o = observed as Record<string, unknown>;
    const i = inference as Record<string, unknown>;
    const dateOrNull = (v: unknown) =>
      v === null || (typeof v === 'string' && Number.isFinite(Date.parse(v)) && v.endsWith('Z'));
    const date = (v: unknown) =>
      typeof v === 'string' && Number.isFinite(Date.parse(v)) && v.endsWith('Z');
    return (
      (o.tracking_state === null || ['RUNNING', 'STOPPED'].includes(String(o.tracking_state))) &&
      [
        'last_position_captured_at',
        'last_position_received_at',
        'last_health_observed_at',
        'last_health_received_at',
      ].every((key) => dateOrNull(o[key])) &&
      dateOrNull(i.evidence_at) &&
      dateOrNull(i.evaluated_at) &&
      Number.isInteger(i.age_s) &&
      Number(i.age_s) >= 0 &&
      Number.isInteger(i.threshold_s) &&
      Number(i.threshold_s) > 0 &&
      date(item.opened_at) &&
      date(item.updated_at) &&
      dateOrNull(item.resolved_at) &&
      ((item.status === 'OPEN' && item.resolved_at === null && item.resolution_reason === null) ||
        (item.status === 'RESOLVED' &&
          item.resolved_at !== null &&
          item.resolution_reason !== null)) &&
      (item.resolution_reason === null ||
        [
          'EVIDENCE_RECOVERED',
          'WINDOW_ENDED',
          'POLICY_CHANGED',
          'DEVICE_INACTIVE',
          'INSTALLATION_CHANGED',
        ].includes(String(item.resolution_reason)))
    );
  });
}

/** Authenticated transport; server capabilities, CSRF and ETags remain authoritative. */
export class GpsRemote {
  constructor(private readonly send: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  private async get<T>(
    path: `/v1/${string}`,
    headers?: HeadersInit,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = apiPath(path);
    let response: Response;
    try {
      response = await this.send(url, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        ...(headers ? { headers } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ApiClientError(0, 'network_error');
    }
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
      const nested =
        record.error && typeof record.error === 'object'
          ? (record.error as Record<string, unknown>)
          : record;
      throw new ApiClientError(
        response.status,
        typeof nested.code === 'string' ? nested.code : 'request_failed',
      );
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new ApiClientError(502, 'invalid_response');
    return body as T;
  }

  private async mutate<T>(
    method: 'POST' | 'PATCH' | 'PUT',
    path: `/v1/${string}`,
    body: unknown,
    csrf: string,
    etag?: string,
  ): Promise<T> {
    if (!csrf || (etag !== undefined && !etag.startsWith('"gps-policy:')))
      throw new ApiClientError(422, 'invalid_mutation');
    const response = await this.send(apiPath(path), {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        'idempotency-key': crypto.randomUUID(),
        ...(etag ? { 'if-match': etag } : {}),
      },
      body: JSON.stringify(body),
    });
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const record =
        result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
      const nested =
        record.error && typeof record.error === 'object'
          ? (record.error as Record<string, unknown>)
          : record;
      throw new ApiClientError(
        response.status,
        typeof nested.code === 'string' ? nested.code : 'request_failed',
      );
    }
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new ApiClientError(502, 'invalid_response');
    return result as T;
  }

  createPolicy(spec: RemotePolicySpec, csrf: string): Promise<RemotePolicy> {
    return this.mutate('POST', '/v1/admin/gps-policies', spec, csrf);
  }

  editPolicy(
    id: string,
    spec: RemotePolicySpec,
    etag: string,
    csrf: string,
  ): Promise<RemotePolicy> {
    if (!uuid.test(id)) throw new ApiClientError(422, 'invalid_policy_id');
    return this.mutate('PATCH', `/v1/admin/gps-policies/${id}`, spec, csrf, etag);
  }

  assignPolicy(
    id: string,
    assignments: RemoteAssignment[],
    etag: string,
    csrf: string,
  ): Promise<RemotePolicy> {
    if (!uuid.test(id) || assignments.some((item) => !uuid.test(item.scope_id)))
      throw new ApiClientError(422, 'invalid_assignment');
    return this.mutate(
      'PUT',
      `/v1/admin/gps-policies/${id}/assignments`,
      { assignments },
      csrf,
      etag,
    );
  }

  transitionPolicy(
    id: string,
    action: 'publish' | 'resume' | 'pause' | 'revoke',
    reason: string,
    etag: string,
    csrf: string,
  ): Promise<RemotePolicy> {
    if (!uuid.test(id) || reason.trim().length < 8 || reason.length > 240)
      throw new ApiClientError(422, 'invalid_transition');
    return this.mutate(
      'POST',
      `/v1/admin/gps-policies/${id}/${action}`,
      { reason: reason.trim() },
      csrf,
      etag,
    );
  }

  session(signal?: AbortSignal): Promise<AdminProfile> {
    return this.get('/v1/admin/auth/me', undefined, signal);
  }

  async capabilities(
    signal?: AbortSignal,
  ): Promise<{ capabilities: string[]; tenant_ids: string[] }> {
    const body = await this.get<{ capabilities?: unknown; tenant_ids?: unknown }>(
      '/v1/admin/gps-capabilities',
      undefined,
      signal,
    );
    if (
      !Array.isArray(body.capabilities) ||
      !body.capabilities.every((item) => typeof item === 'string')
    )
      throw new ApiClientError(502, 'invalid_response');
    if (
      body.tenant_ids !== undefined &&
      (!Array.isArray(body.tenant_ids) ||
        !body.tenant_ids.every((item) => typeof item === 'string'))
    )
      throw new ApiClientError(502, 'invalid_response');
    return { capabilities: body.capabilities, tenant_ids: (body.tenant_ids ?? []) as string[] };
  }

  devices(signal?: AbortSignal): Promise<{ items: RemoteGpsDevice[] }> {
    return this.get('/v1/admin/gps-devices', undefined, signal);
  }

  sessions(
    deviceId: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<RemotePage<RemoteGpsSession>> {
    if (!uuid.test(deviceId)) throw new ApiClientError(422, 'invalid_device_id');
    if (cursor !== undefined && (!cursor || cursor.length > 200))
      throw new ApiClientError(422, 'invalid_cursor');
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.get(`/v1/admin/devices/${deviceId}/gps-sessions${suffix}`, undefined, signal);
  }

  positions(
    deviceId: string,
    reason: string,
    from: string,
    to: string,
    cursor?: string,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<RemotePage<RemotePosition>> {
    if (!uuid.test(deviceId)) throw new ApiClientError(422, 'invalid_device_id');
    if (reason.trim().length < 8 || reason.length > 240)
      throw new ApiClientError(422, 'access_reason_required');
    const start = Date.parse(from),
      end = Date.parse(to);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end ||
      end - start > 86_400_000
    )
      throw new ApiClientError(422, 'invalid_period');
    if (cursor !== undefined && (!cursor || cursor.length > 200))
      throw new ApiClientError(422, 'invalid_cursor');
    if (sessionId !== undefined && !uuid.test(sessionId))
      throw new ApiClientError(422, 'invalid_session_id');
    const query = new URLSearchParams({ from, to });
    if (cursor) query.set('cursor', cursor);
    if (sessionId) query.set('session_id', sessionId);
    return this.get(
      `/v1/admin/devices/${deviceId}/locations?${query}`,
      { 'x-geops-access-reason': reason.trim() },
      signal,
    );
  }

  policies(cursor?: string, signal?: AbortSignal): Promise<RemotePage<RemotePolicy>> {
    if (cursor !== undefined && (!cursor || cursor.length > 128))
      throw new ApiClientError(422, 'invalid_cursor');
    return this.get(
      `/v1/admin/gps-policies${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      undefined,
      signal,
    );
  }

  policy(id: string, signal?: AbortSignal): Promise<RemotePolicy> {
    if (!uuid.test(id)) throw new ApiClientError(422, 'invalid_policy_id');
    return this.get(`/v1/admin/gps-policies/${id}`, undefined, signal);
  }

  health(
    deviceId: string,
    reason: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<RemoteHealth> {
    if (!uuid.test(deviceId)) throw new ApiClientError(422, 'invalid_device_id');
    if (reason.trim().length < 8 || reason.length > 240)
      throw new ApiClientError(422, 'access_reason_required');
    if (cursor !== undefined && (!cursor || cursor.length > 200))
      throw new ApiClientError(422, 'invalid_cursor');
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.get(
      `/v1/admin/devices/${deviceId}/health${suffix}`,
      { 'x-geops-access-reason': reason },
      signal,
    );
  }

  async continuityAlerts(
    filters: ContinuityFilters,
    reason: string,
    signal?: AbortSignal,
  ): Promise<RemoteContinuityPage> {
    if (
      reason.trim().length < 8 ||
      reason.length > 240 ||
      (filters.device_id !== undefined && !uuid.test(filters.device_id)) ||
      (filters.cursor !== undefined && (!filters.cursor || filters.cursor.length > 1024))
    )
      throw new ApiClientError(422, 'invalid_request');
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const suffix = query.size ? `?${query}` : '';
    const response = await this.get<unknown>(
      `/v1/admin/gps-continuity/alerts${suffix}`,
      { 'x-geops-access-reason': reason.trim() },
      signal,
    );
    if (!validContinuityPage(response)) throw new ApiClientError(502, 'invalid_response');
    return response;
  }
}
