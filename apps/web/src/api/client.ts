import { apiPath } from './base.js';

export interface AdminProfile {
  id: string;
  email: string;
  csrf_token: string;
}

export interface AdminUserRecord {
  id: string;
  email: string;
  state: 'ACTIVE' | 'LOCKED' | 'REVOKED';
  capabilities: string[];
  tenant_access: boolean;
}

export interface AdminInvitation {
  invitation_id: string;
  invitation_token: string;
  expires_at: string;
}

export interface BasicDevice {
  id: string;
  display_label: string;
  status: string;
  mdm_binding_id: string;
}

export interface Device extends BasicDevice {
  tenant_id: string;
  mdm_device_id: string;
  enrolled_at: string | null;
  last_communication_at: string | null;
  invitation_id: string | null;
  invitation_status: string | null;
  invitation_expires_at: string | null;
  claim_id: string | null;
  claim_status: string | null;
  key_id: string | null;
  installation_id: string | null;
  last_installation_retired_at: string | null;
  policy_name: string | null;
  session_state: string | null;
}

export interface DeviceInvitation {
  invitation_id: string;
  geops_device_id: string;
  invitation_secret: string;
  expires_at: string;
}

function validInvitation(value: unknown, deviceId: string): value is DeviceInvitation {
  if (!value || typeof value !== 'object') return false;
  const invite = value as Record<string, unknown>;
  return (
    typeof invite.invitation_id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(invite.invitation_id) &&
    invite.geops_device_id === deviceId &&
    typeof invite.invitation_secret === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(invite.invitation_secret) &&
    typeof invite.expires_at === 'string' &&
    Number.isFinite(Date.parse(invite.expires_at)) &&
    Date.parse(invite.expires_at) > Date.now()
  );
}

export interface MdmDevice {
  mdm_device_id: string;
  status: string;
  display_name?: string;
  platform?: 'android' | 'other' | 'unknown';
  model?: string;
  os_version?: string;
  removed?: boolean;
}

export interface MdmInventoryDevice extends MdmDevice {
  geops_device_id: string | null;
  last_seen_at: string;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  source: string;
}

export interface MdmStatus {
  provider: 'fake' | 'manageengine';
  connected: boolean;
  authorized?: boolean;
  oauth_configured?: boolean;
  authorization_state?: 'never' | 'connected' | 'disconnecting' | 'disconnected';
  edition_evidence: 'TRIAL' | 'FREE' | 'LICENSED' | 'UNVERIFIED';
  configured_edition?: 'TRIAL' | 'FREE' | 'LICENSED';
  region?: string;
  customer_id?: string;
  customer_name?: string;
  device_count?: number;
  last_sync_at?: string | null;
  last_checked_at: string | null;
  last_http_status: number | null;
  sanitized_error_code: string | null;
}

export interface CatalogClient {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  address: string;
  state: 'ACTIVE' | 'INACTIVE';
  version: number;
  site_id: string | null;
  latitude: number | null;
  longitude: number | null;
  created_at?: string;
  updated_at?: string;
}

export interface CatalogSite {
  id: string;
  client_id: string;
  tenant_id: string;
  code: string;
  name: string;
  address: string;
  state: 'ACTIVE' | 'INACTIVE';
  version: number;
  latitude: number;
  longitude: number;
}

export interface CatalogGeofence {
  tenant_id: string;
  client_id: string;
  site_id: string;
  revision: number;
  latitude: number;
  longitude: number;
  radius_m: number;
  min_dwell_s: number;
  state: 'ACTIVE' | 'INACTIVE';
  reason: string;
  created_at: string;
}

export interface GeocodingResult {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
}

export interface RouteStop {
  stop_id: string;
  client_id: string;
  site_id: string;
  geofence_revision: number;
  required: boolean;
  suggested_order: number | null;
  min_dwell_s: number | null;
  min_dwell_effective_s: number;
  client_code: string;
  client_name: string;
  site_code: string;
  site_name: string;
  latitude: number;
  longitude: number;
  radius_m: number;
}

export interface CatalogRoute {
  id: string;
  code: string;
  name: string;
  description: string;
  state: 'ACTIVE' | 'INACTIVE';
  version: number;
  published_revision: number;
  has_draft: boolean;
  content?: 'DRAFT' | 'PUBLISHED';
  stops?: RouteStop[];
}

export interface RouteRevision {
  route_id: string;
  revision: number;
  code: string;
  name: string;
  description: string;
  content_hash: string;
  published_at: string;
  stops: RouteStop[];
}

export interface ScheduleAgent {
  id: string;
  code: string;
  name: string;
  state: 'ACTIVE' | 'INACTIVE';
  version: number;
}

export interface AgentDeviceCandidate {
  id: string;
  display_label: string;
  status: string;
}

export interface AgentResponsibility {
  id: string;
  device_id: string;
  person_name: string;
  valid_from: string;
  valid_to: string | null;
  recorded_by: string;
  ended_by?: string | null;
  reason: string | null;
}

export interface AgentIdentity {
  agent: ScheduleAgent;
  device: {
    device_id: string;
    display_label: string;
    status: string;
    mdm_provider: string | null;
    mdm_device_id: string | null;
    last_communication_at: string | null;
  } | null;
  responsible: AgentResponsibility | null;
}

export interface ScheduleAssignment {
  id: string;
  agent_id: string;
  agent_code: string;
  agent_name: string;
  route_id: string;
  route_revision: number;
  route_code: string;
  route_name: string;
  local_date: string;
  time_zone: string;
  starts_at: string;
  ends_at: string;
  origin: 'MANUAL' | 'EXTRAORDINARY' | 'RECURRENCE';
  state: 'PLANNED' | 'CANCELLED';
  version: number;
  visits?: RouteStop[];
  snapshot_hash: string;
}

export interface ComplianceVisit {
  assignment_id: string;
  stop_id: string;
  agent_id: string;
  agent_code: string;
  agent_name: string;
  route_id: string;
  route_code: string;
  route_name: string;
  route_revision: number;
  local_date: string;
  starts_at: string;
  ends_at: string;
  time_zone: string;
  client_id: string;
  client_code: string;
  client_name: string;
  site_id: string;
  site_name: string;
  geofence_revision: number;
  latitude: number;
  longitude: number;
  radius_m: number;
  required: boolean;
  required_s: number;
  credited_s: number;
  status: string;
  sync_state: string;
  processing_state: string;
  last_ack_at: string | null;
  backlog_reported: number | null;
  provisional: boolean;
  evaluation_id: string | null;
  evaluation_no: number | null;
  evaluated_at: string | null;
  completed_at: string | null;
  first_qualified_at: string | null;
  last_qualified_at: string | null;
  algorithm_id: string | null;
  algorithm_revision: number | null;
  algorithm_scope: string | null;
  source_watermark: string | null;
  job_requested_at: string | null;
  job_finished_at: string | null;
  job_error_code: string | null;
  device_id: string | null;
  snapshot_hash: string;
}

export interface CompliancePage {
  indicators: {
    agents_with_routes: number;
    scheduled_routes: number;
    scheduled_visits: number;
    required_visits: number;
    completed_visits: number;
    in_progress_visits: number;
    pending_visits: number;
    insufficient_evidence_visits: number;
    unattributable_visits: number;
    completed_routes: number;
    accredited_compliance_percent: number | null;
    compliance_denominator: number;
    provisional: boolean;
  };
  routes: Array<{
    assignment_id: string;
    route_id: string;
    route_name: string;
    route_revision: number;
    agent_name: string;
    local_date: string;
    visits: number;
    required_visits: number;
    completed_required_visits: number;
    credited_s: number;
    status: string;
    provisional: boolean;
  }>;
  agents: Array<{
    id: string;
    name: string;
    routes: number;
    visits: number;
    required_visits: number;
    completed_required_visits: number;
    credited_s: number;
    pending_visits: number;
    device_ids: string[];
    provisional: boolean;
  }>;
  clients: Array<{
    id: string;
    name: string;
    routes: number;
    visits: number;
    required_visits: number;
    completed_required_visits: number;
    credited_s: number;
    pending_visits: number;
    device_ids: string[];
    provisional: boolean;
  }>;
  items: ComplianceVisit[];
  locations: ComplianceDeviceLocation[];
  location_access: boolean;
  total_visits: number;
  next_offset: number | null;
  reconciliation_policy: string;
  evaluation_access: { can_request: boolean; algorithm_approved: boolean };
}

export interface ComplianceDeviceLocation {
  agent_id: string;
  device_id: string;
  latitude: number | null;
  longitude: number | null;
  accuracy_m: number | null;
  captured_at: string | null;
  received_at: string | null;
  last_health_received_at: string | null;
  communication_state: 'RECENT_REPORT' | 'NO_RECENT_REPORT' | 'NETWORK_UNAVAILABLE_REPORTED';
}

export interface VisitMapData {
  assignment_id: string;
  stop_id: string;
  site: { latitude: number; longitude: number };
  historical_geofence: { latitude: number; longitude: number; radius_m: number; revision: number };
  current_geofence: {
    latitude: number;
    longitude: number;
    radius_m: number;
    revision: number;
  } | null;
  positions: Array<{
    event_id: string;
    device_id: string;
    session_id: string;
    captured_at: string;
    received_at: string;
    latitude: number;
    longitude: number;
    accuracy_m: number;
    distance_m: number;
    spatial_state: 'INSIDE' | 'OUTSIDE' | 'UNCERTAIN';
  }>;
}

export interface VisitEvaluationHistory {
  id: string;
  evaluation_no: number;
  status: string;
  credited_s: number;
  required_s: number;
  source_watermark: string | null;
  supersedes_id: string | null;
  evaluated_at: string;
  algorithm_id: string;
  algorithm_revision: number;
  first_qualified_at: string | null;
  last_qualified_at: string | null;
  completed_at: string | null;
  sample_count: number;
  uncertain_count: number;
  gap_count: number;
  trigger_reason: string | null;
}

export interface VisitEvidenceInterval {
  interval_no: number;
  device_id: string;
  session_id: string;
  event_id_a: string;
  event_id_b: string;
  from_at: string;
  to_at: string;
  observed_s: number;
  credited_s: number;
  event_a_captured_at: string | null;
  event_b_captured_at: string | null;
  event_a_received_at: string | null;
  event_b_received_at: string | null;
  event_a_accuracy_m: number | null;
  event_b_accuracy_m: number | null;
  event_a_quality_state: string | null;
  event_b_quality_state: string | null;
  event_a_available: boolean;
  event_b_available: boolean;
}

export interface ScheduleRule {
  id: string;
  agent_id: string;
  route_id: string;
  route_revision: number;
  start_date: string;
  end_date: string | null;
  days_iso: number[];
  time_zone: string;
  starts_local: string;
  ends_local: string;
  state: 'ACTIVE' | 'INACTIVE';
  version: number;
  exceptions?: ScheduleException[];
}

export interface ScheduleException {
  local_date: string;
  action: 'SKIP' | 'CANCEL' | 'REPLACE';
  replacement_route_id: string | null;
  replacement_revision: number | null;
  reason: string;
}

export type RouteStopInput = Pick<
  RouteStop,
  'stop_id' | 'site_id' | 'geofence_revision' | 'required' | 'suggested_order' | 'min_dwell_s'
>;

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function read<T>(path: `/v1/${string}`, init?: RequestInit): Promise<T> {
  const response = await fetch(apiPath(path), {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
  });
  if (response.status === 204) return undefined as T;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const error =
      record.error && typeof record.error === 'object'
        ? (record.error as Record<string, unknown>)
        : record;
    throw new ApiClientError(
      response.status,
      typeof error.code === 'string' ? error.code : 'request_failed',
    );
  }
  return body as T;
}

async function readAll<T>(path: `/v1/${string}`): Promise<{ items: T[] }> {
  const items: T[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const query: string = `?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const result: { items: T[]; next_cursor: string | null } = await read<{
      items: T[];
      next_cursor: string | null;
    }>(`${path}${query}`);
    items.push(...result.items);
    cursor = result.next_cursor;
    if (cursor) {
      if (seen.has(cursor)) throw new ApiClientError(502, 'invalid_pagination_response');
      seen.add(cursor);
    }
  } while (cursor);
  return { items };
}

const routeWrite = <T>(
  path: `/v1/${string}`,
  method: 'POST' | 'PATCH' | 'PUT',
  body: unknown,
  csrf: string,
  version?: number,
) =>
  read<T>(path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      'idempotency-key': crypto.randomUUID(),
      ...(version === undefined ? {} : { 'if-match': `"${version}"` }),
    },
    body: JSON.stringify(body),
  });

export const api = {
  compliance: (query: Record<string, string>) =>
    read<CompliancePage>(`/v1/admin/compliance?${new URLSearchParams(query).toString()}`),
  visitHistory: (assignmentId: string, stopId: string) =>
    read<{ items: VisitEvaluationHistory[] }>(
      `/v1/admin/assignments/${assignmentId}/visits/${stopId}/evaluations`,
    ),
  visitEvidence: (assignmentId: string, stopId: string, evaluationId: string, reason: string) =>
    read<{ evaluation_id: string; items: VisitEvidenceInterval[]; coordinates_included: boolean }>(
      `/v1/admin/assignments/${assignmentId}/visits/${stopId}/evaluations/${evaluationId}/evidence`,
      { headers: { 'x-geops-access-reason': reason } },
    ),
  visitMap: (assignmentId: string, stopId: string, reason: string) =>
    read<VisitMapData>(`/v1/admin/assignments/${assignmentId}/visits/${stopId}/map`, {
      headers: { 'x-geops-access-reason': reason },
    }),
  requestVisitEvaluation: (assignmentId: string, reason: string, csrf: string) =>
    routeWrite<{ assignment_id: string; state: 'PENDING' }>(
      `/v1/admin/assignments/${assignmentId}/evaluations`,
      'POST',
      { reason },
      csrf,
    ),
  me: () => read<AdminProfile>('/v1/admin/auth/me'),
  login: (email: string, password: string) =>
    read<{ admin_id: string; csrf_token: string; expires_at: string }>('/v1/admin/auth/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  logout: (csrf: string) =>
    read<void>('/v1/admin/auth/sessions/current', {
      method: 'DELETE',
      headers: { 'x-csrf-token': csrf },
    }),
  adminUsers: () => read<{ users: AdminUserRecord[]; tenant_id: string }>('/v1/admin/users'),
  createAdminUser: (email: string, reason: string, csrf: string) =>
    read<AdminInvitation & { admin_id: string }>('/v1/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ email, reason }),
    }),
  reissueAdminInvitation: (id: string, reason: string, csrf: string) =>
    read<AdminInvitation>(`/v1/admin/users/${id}/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ reason }),
    }),
  acceptAdminInvitation: (invitationId: string, token: string, password: string) =>
    read<void>('/v1/admin/users/invitations/accept', {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invitation_id: invitationId, invitation_token: token, password }),
    }),
  changeAdminCapabilities: (
    id: string,
    action: 'GRANT' | 'REVOKE',
    capabilities: string[],
    reason: string,
    csrf: string,
  ) =>
    read<void>(`/v1/admin/users/${id}/capabilities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ request_id: crypto.randomUUID(), action, capabilities, reason }),
    }),
  changeAdminTenantAccess: (id: string, action: 'GRANT' | 'REVOKE', reason: string, csrf: string) =>
    read<void>(`/v1/admin/users/${id}/tenant-access`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ request_id: crypto.randomUUID(), action, reason }),
    }),
  revokeAdminUser: (id: string, reason: string, csrf: string) =>
    read<void>(`/v1/admin/users/${id}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ request_id: crypto.randomUUID(), reason }),
    }),
  geopsDevices: (cursor?: string) =>
    read<Page<BasicDevice>>(
      `/v1/admin/devices${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  enrollmentDevices: (cursor?: string) =>
    read<Page<Device>>(
      `/v1/admin/enrollment/devices?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  createDevice: (label: string, csrf: string) =>
    read<BasicDevice>('/v1/admin/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ display_label: label }),
    }),
  issueInvitation: async (device: Device, csrf: string) => {
    const response = await read<unknown>(`/v1/admin/devices/${device.id}/invitations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({
        mdm_binding_id: device.mdm_binding_id,
        delivery_mode: 'supervised_qr',
      }),
    });
    if (!validInvitation(response, device.id)) {
      throw new ApiClientError(502, 'invalid_invitation_response');
    }
    return response;
  },
  cancelInvitation: (device: Device & { invitation_id: string }, csrf: string) =>
    read<{ status: 'CANCELLED' }>(
      `/v1/admin/devices/${device.id}/invitations/${device.invitation_id}`,
      {
        method: 'DELETE',
        headers: { 'x-csrf-token': csrf },
      },
    ),
  recordSyntheticEvidence: (
    device: Device & { claim_id: string },
    csrf: string,
    attestationException: boolean,
  ) =>
    read<{ evidence_ref: string; source: 'fake' }>(
      `/v1/admin/devices/${device.id}/synthetic-evidence`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({
          claim_id: device.claim_id,
          physical_confirmed: true,
          attestation_exception: attestationException,
        }),
      },
    ),
  activateDevice: (
    device: Device & { claim_id: string },
    csrf: string,
    pairingCode: string,
    evidenceRef: string,
  ) =>
    read<{ status: 'ACTIVE'; key_id: string; mdm_binding_id: string }>(
      `/v1/admin/devices/${device.id}/activate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({
          claim_id: device.claim_id,
          pairing_code: pairingCode,
          mdm_verification_method: 'manual_two_traits',
          evidence_ref: evidenceRef,
        }),
      },
    ),
  activateInstallation: (deviceId: string, csrf: string, reason: string) =>
    read<{ installation_id: string; device_id: string; state: 'ACTIVE' }>(
      '/v1/admin/gps-installations',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ device_id: deviceId, reason }),
      },
    ),
  retireInstallation: (installationId: string, csrf: string, reason: string) =>
    read<void>(`/v1/admin/gps-installations/${installationId}/retire`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ reason }),
    }),
  changeDeviceState: (
    deviceId: string,
    action: 'suspend' | 'reactivate' | 'revoke' | 'retire',
    csrf: string,
    reason: string,
  ) =>
    read<{ status: string }>(`/v1/admin/devices/${deviceId}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ reason }),
    }),
  mdmDevices: (cursor?: string) =>
    read<Page<MdmDevice>>(
      `/v1/admin/mdm/devices${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  mdmStatus: () => read<MdmStatus>('/v1/admin/mdm/status'),
  mdmOAuthConfig: () =>
    read<{
      configured: boolean;
      source: 'admin' | 'legacy' | 'none';
      region: string;
      callback_url: string | null;
    }>('/v1/admin/mdm/oauth/config'),
  mdmInventory: (after?: string) =>
    read<{ items: MdmInventoryDevice[]; next_cursor: string | null }>(
      `/v1/admin/mdm/inventory${after ? `?after=${encodeURIComponent(after)}` : ''}`,
    ),
  mdmOAuthStart: (csrf: string) =>
    read<{ authorization_url: string }>('/v1/admin/mdm/oauth/start', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf },
    }),
  mdmCustomers: () =>
    read<{ customers: { customer_id: string; customer_name: string }[] }>(
      '/v1/admin/mdm/oauth/customers',
    ),
  mdmChooseCustomer: (customerId: string, csrf: string) =>
    read<{ connected: true }>('/v1/admin/mdm/oauth/customers', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ customer_id: customerId }),
    }),
  mdmDisconnect: (csrf: string) =>
    read<{ local_disconnected: boolean; remote_revoked: boolean }>('/v1/admin/mdm/disconnect', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf },
    }),
  mdmSync: (csrf: string) =>
    read<{ run_id: string; device_count: number }>('/v1/admin/mdm/sync', {
      method: 'POST',
      headers: { 'x-csrf-token': csrf },
    }),
  mdmLink: (deviceId: string, mdmId: string, csrf: string) =>
    read<{ linked: true }>(`/v1/admin/devices/${encodeURIComponent(deviceId)}/mdm-link`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ mdm_device_id: mdmId }),
    }),
  mdmUnlink: (deviceId: string, csrf: string) =>
    read<{ linked: false }>(`/v1/admin/devices/${encodeURIComponent(deviceId)}/mdm-link`, {
      method: 'DELETE',
      headers: { 'x-csrf-token': csrf },
    }),
  gpsCapabilities: () => read<{ capabilities: string[] }>('/v1/admin/gps-capabilities'),
  catalogCapabilities: () =>
    read<{ capabilities: string[]; limits: { max_radius_m: number; max_dwell_s: number } }>(
      '/v1/admin/client-capabilities',
    ),
  geocodingSearch: (query: string) =>
    read<{ items: GeocodingResult[] }>(`/v1/admin/geocoding/search?q=${encodeURIComponent(query)}`),
  clients: (query: { q?: string; state?: string; cursor?: string; limit?: number } = {}) =>
    read<{ items: CatalogClient[]; next_cursor: string | null }>(
      `/v1/admin/clients?${new URLSearchParams(
        Object.entries(query)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      ).toString()}`,
    ),
  client: (id: string) => read<CatalogClient>(`/v1/admin/clients/${id}`),
  createClient: (
    input: {
      code: string;
      name: string;
      address: string;
      site: { code: string; name: string; address: string; latitude: number; longitude: number };
    },
    csrf: string,
  ) =>
    read<CatalogClient>('/v1/admin/clients', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify(input),
    }),
  patchClient: (
    id: string,
    version: number,
    input: Partial<Pick<CatalogClient, 'code' | 'name' | 'address' | 'state'>>,
    csrf: string,
  ) =>
    read<CatalogClient>(`/v1/admin/clients/${id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        'idempotency-key': crypto.randomUUID(),
        'if-match': `"${version}"`,
      },
      body: JSON.stringify(input),
    }),
  sites: (clientId: string) => readAll<CatalogSite>(`/v1/admin/clients/${clientId}/sites`),
  createSite: (
    clientId: string,
    input: Pick<CatalogSite, 'code' | 'name' | 'address' | 'latitude' | 'longitude'>,
    csrf: string,
  ) =>
    read<CatalogSite>(`/v1/admin/clients/${clientId}/sites`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify(input),
    }),
  patchSite: (
    clientId: string,
    siteId: string,
    version: number,
    input: Partial<
      Pick<CatalogSite, 'code' | 'name' | 'address' | 'latitude' | 'longitude' | 'state'>
    >,
    csrf: string,
  ) =>
    read<CatalogSite>(`/v1/admin/clients/${clientId}/sites/${siteId}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        'idempotency-key': crypto.randomUUID(),
        'if-match': `"${version}"`,
      },
      body: JSON.stringify(input),
    }),
  geofences: (clientId: string, siteId: string) =>
    readAll<CatalogGeofence>(`/v1/admin/clients/${clientId}/sites/${siteId}/geofences`),
  saveGeofence: (
    clientId: string,
    siteId: string,
    revision: number,
    input: Pick<
      CatalogGeofence,
      'latitude' | 'longitude' | 'radius_m' | 'min_dwell_s' | 'state' | 'reason'
    >,
    csrf: string,
  ) =>
    read<CatalogGeofence>(`/v1/admin/clients/${clientId}/sites/${siteId}/geofences`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrf,
        'idempotency-key': crypto.randomUUID(),
        'if-match': `"${revision}"`,
      },
      body: JSON.stringify(input),
    }),
  routes: (query: { q?: string; state?: string; cursor?: string; limit?: number } = {}) =>
    read<{ items: CatalogRoute[]; next_cursor: string | null }>(
      `/v1/admin/routes?${new URLSearchParams(
        Object.entries(query)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      ).toString()}`,
    ),
  route: (id: string) => read<CatalogRoute>(`/v1/admin/routes/${id}`),
  createRoute: (input: { code: string; name: string; description: string }, csrf: string) =>
    routeWrite<CatalogRoute>('/v1/admin/routes', 'POST', input, csrf),
  patchRoute: (
    id: string,
    version: number,
    input: { code: string; name: string; description: string },
    csrf: string,
  ) => routeWrite<CatalogRoute>(`/v1/admin/routes/${id}`, 'PATCH', input, csrf, version),
  saveRouteStops: (id: string, version: number, stops: RouteStopInput[], csrf: string) =>
    routeWrite<CatalogRoute>(`/v1/admin/routes/${id}/draft/stops`, 'PUT', { stops }, csrf, version),
  publishRoute: (id: string, version: number, csrf: string) =>
    routeWrite<CatalogRoute>(`/v1/admin/routes/${id}/publish`, 'POST', {}, csrf, version),
  setRouteState: (id: string, version: number, state: 'ACTIVE' | 'INACTIVE', csrf: string) =>
    routeWrite<CatalogRoute>(
      `/v1/admin/routes/${id}/${state === 'ACTIVE' ? 'activate' : 'deactivate'}`,
      'POST',
      {},
      csrf,
      version,
    ),
  routeRevisions: (id: string) =>
    readAll<Omit<RouteRevision, 'stops' | 'route_id'>>(`/v1/admin/routes/${id}/revisions`),
  routeRevision: (id: string, revision: number) =>
    read<RouteRevision>(`/v1/admin/routes/${id}/revisions/${revision}`),
  scheduleCapabilities: () =>
    read<{
      capabilities: string[];
      materialization_max_days: number;
      agent_device_integration: string;
    }>('/v1/admin/schedule-capabilities'),
  agents: () => readAll<ScheduleAgent>('/v1/admin/agents'),
  agent: (id: string) => read<ScheduleAgent>(`/v1/admin/agents/${id}`),
  availableAgentDevices: () =>
    read<{ items: AgentDeviceCandidate[] }>('/v1/admin/agent-devices/available'),
  agentIdentity: (id: string) => read<AgentIdentity>(`/v1/admin/agents/${id}/identity`),
  agentResponsibilityHistory: (id: string) =>
    read<{ agent_id: string; items: AgentResponsibility[] }>(
      `/v1/admin/agents/${id}/responsibilities`,
    ),
  registerAgentDevice: (
    input: { device_id: string; code: string; name: string; person_name?: string; reason: string },
    csrf: string,
  ) =>
    routeWrite<ScheduleAgent & { device_id: string }>(
      '/v1/admin/agent-devices',
      'POST',
      input,
      csrf,
    ),
  linkAgentDevice: (agent_id: string, device_id: string, reason: string, csrf: string) =>
    routeWrite<{ id: string; agent_id: string; device_id: string }>(
      '/v1/admin/agent-device-links',
      'POST',
      { agent_id, device_id, reason, establish_identity: true },
      csrf,
    ),
  setAgentResponsible: (id: string, person_name: string, reason: string, csrf: string) =>
    routeWrite<AgentResponsibility>(
      `/v1/admin/agents/${id}/responsibilities`,
      'POST',
      { person_name, reason },
      csrf,
    ),
  createAgent: (input: { code: string; name: string }, csrf: string) =>
    routeWrite<ScheduleAgent>('/v1/admin/agents', 'POST', input, csrf),
  patchAgent: (id: string, version: number, input: Partial<ScheduleAgent>, csrf: string) =>
    routeWrite<ScheduleAgent>(`/v1/admin/agents/${id}`, 'PATCH', input, csrf, version),
  calendar: (query: {
    from: string;
    to: string;
    agent_id?: string;
    route_id?: string;
    cursor?: string;
  }) =>
    read<{ items: ScheduleAssignment[]; next_cursor: string | null }>(
      `/v1/admin/calendar?${new URLSearchParams(query).toString()}`,
    ),
  assignment: (id: string) => read<ScheduleAssignment>(`/v1/admin/assignments/${id}`),
  createAssignment: (
    input: {
      agent_id: string;
      route_id: string;
      route_revision: number;
      local_date: string;
      time_zone: string;
      starts_local: string;
      ends_local: string;
      reason: string;
      origin?: 'MANUAL' | 'EXTRAORDINARY';
    },
    csrf: string,
  ) => routeWrite<ScheduleAssignment>('/v1/admin/assignments', 'POST', input, csrf),
  cancelAssignment: (id: string, version: number, reason: string, csrf: string) =>
    routeWrite<ScheduleAssignment>(
      `/v1/admin/assignments/${id}/cancel`,
      'POST',
      { reason },
      csrf,
      version,
    ),
  scheduleRules: () => readAll<ScheduleRule>('/v1/admin/schedule-rules'),
  scheduleRule: (id: string) => read<ScheduleRule>(`/v1/admin/schedule-rules/${id}`),
  createScheduleRule: (
    input: {
      agent_id: string;
      route_id: string;
      route_revision: number;
      start_date: string;
      end_date?: string | null;
      days_iso: number[];
      time_zone: string;
      starts_local: string;
      ends_local: string;
      reason: string;
    },
    csrf: string,
  ) => routeWrite<ScheduleRule>('/v1/admin/schedule-rules', 'POST', input, csrf),
  patchScheduleRule: (
    id: string,
    version: number,
    input: { state: 'ACTIVE' | 'INACTIVE'; reason: string },
    csrf: string,
  ) => routeWrite<ScheduleRule>(`/v1/admin/schedule-rules/${id}`, 'PATCH', input, csrf, version),
  putScheduleException: (
    id: string,
    date: string,
    version: number,
    input: {
      action: 'SKIP' | 'CANCEL' | 'REPLACE';
      reason: string;
      replacement_route_id?: string;
      replacement_revision?: number;
    },
    csrf: string,
  ) =>
    routeWrite<ScheduleException>(
      `/v1/admin/schedule-rules/${id}/exceptions/${date}`,
      'PUT',
      input,
      csrf,
      version,
    ),
  materializeScheduleRule: (id: string, version: number, from: string, to: string, csrf: string) =>
    routeWrite<{ generated: number; cancelled: number; skipped: number; unchanged: number }>(
      `/v1/admin/schedule-rules/${id}/materialize`,
      'POST',
      { from, to },
      csrf,
      version,
    ),
};
