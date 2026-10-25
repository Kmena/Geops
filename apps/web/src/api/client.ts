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

export const api = {
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
};
