export interface AdminProfile {
  id: string;
  email: string;
  csrf_token: string;
}

export interface Device {
  id: string;
  display_label: string;
  status: string;
  mdm_binding_id?: string;
}

export interface MdmDevice {
  mdm_device_id: string;
  status: string;
  display_name?: string;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  source: string;
}

export interface MdmStatus {
  provider: 'fake' | 'manageengine';
  connected: boolean;
  edition_evidence: 'TRIAL' | 'FREE_UNVERIFIED';
  region?: string;
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

async function read<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
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
  geopsDevices: (cursor?: string) =>
    read<Page<Device>>(`/v1/admin/devices${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  mdmDevices: (cursor?: string) =>
    read<Page<MdmDevice>>(
      `/v1/admin/mdm/devices${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  mdmStatus: () => read<MdmStatus>('/v1/admin/mdm/status'),
};
