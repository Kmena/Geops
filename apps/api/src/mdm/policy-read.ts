import { ApiError } from '../errors.js';

export type MdmReadState = 'AVAILABLE' | 'SCOPE_DENIED' | 'UNAVAILABLE' | 'NOT_SUPPORTED';
export interface MdmProfileObservation {
  profile_id: string;
  name: string | null;
  distribution: 'ASSIGNED' | 'PENDING' | 'APPLIED_REPORTED' | 'FAILED' | 'UNKNOWN';
  applied_at: string | null;
  shared_device_count: number | null;
  configured_global_permission: 'AUTO_GRANT' | 'USER_PROMPT' | 'AUTO_DENY' | 'UNKNOWN';
}
export interface MdmAppObservation {
  package_name: string;
  app_id: string | null;
  assigned: boolean;
  installed_reported: boolean;
  version_code: string | null;
  version_name: string | null;
}
export interface MdmDevicePolicyRead {
  mdm_device_id: string;
  fetched_at: string;
  device: {
    status: string;
    model: string | null;
    android_version: string | null;
    last_contact_at: string | null;
  };
  profiles: { state: MdmReadState; items: MdmProfileObservation[] };
  apps: { state: MdmReadState; items: MdmAppObservation[] };
}
export interface MdmProfileDetail {
  profile_id: string;
  platform: 'ANDROID' | 'OTHER' | 'UNKNOWN';
  version: number | null;
  published: boolean;
  trashed: boolean;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const id = (value: unknown): string | null =>
  typeof value === 'string' && /^[0-9]{1,30}$/.test(value)
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : null;
const small = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 160 ? value : null;
const when = (value: unknown): string | null => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  const ms = value < 10_000_000_000 ? value * 1000 : value;
  return ms <= Date.now() + 86_400_000 ? new Date(ms).toISOString() : null;
};

export function normalizeProfiles(raw: unknown): MdmProfileObservation[] {
  const body = record(raw);
  if (!body || !Array.isArray(body.profiles) || body.profiles.length > 100)
    throw new ApiError(503, 'mdm_invalid_shape', 'MDM unavailable');
  return body.profiles.map((value) => {
    const row = record(value);
    const profileId = id(row?.profile_id);
    if (!row || !profileId) throw new ApiError(503, 'mdm_invalid_shape', 'MDM unavailable');
    const status = small(row.status)?.toUpperCase();
    const distribution =
      status === 'APPLIED' || status === 'SUCCESS'
        ? 'APPLIED_REPORTED'
        : status === 'SCHEDULED' || status === 'PENDING' || status === 'IN_PROGRESS'
          ? 'PENDING'
          : status === 'FAILED'
            ? 'FAILED'
            : status === 'ASSIGNED'
              ? 'ASSIGNED'
              : 'UNKNOWN';
    const shared = row.device_count;
    return {
      profile_id: profileId,
      name: small(row.profile_name),
      distribution,
      applied_at: distribution === 'APPLIED_REPORTED' ? when(row.applied_time) : null,
      shared_device_count:
        typeof shared === 'number' && Number.isSafeInteger(shared) && shared >= 0 ? shared : null,
      configured_global_permission: 'UNKNOWN',
    };
  });
}

export function normalizeApps(raw: unknown): MdmAppObservation[] {
  const body = record(raw);
  if (
    !body ||
    !Array.isArray(body.installed_apps) ||
    !Array.isArray(body.apps) ||
    body.installed_apps.length > 500 ||
    body.apps.length > 500
  )
    throw new ApiError(503, 'mdm_invalid_shape', 'MDM unavailable');
  const apps = new Map<string, MdmAppObservation>();
  for (const source of ['apps', 'installed_apps'] as const) {
    for (const value of body[source] as unknown[]) {
      const row = record(value);
      const packageName = small(row?.identifier);
      if (!packageName || !/^[a-zA-Z][a-zA-Z0-9_.]{2,159}$/.test(packageName)) continue;
      const prior = apps.get(packageName);
      apps.set(packageName, {
        package_name: packageName,
        app_id: id(row?.app_id) ?? prior?.app_id ?? null,
        assigned: source === 'apps' || prior?.assigned === true,
        installed_reported: source === 'installed_apps' || prior?.installed_reported === true,
        version_code: id(row?.app_version_code) ?? prior?.version_code ?? null,
        version_name: small(row?.app_version) ?? prior?.version_name ?? null,
      });
    }
  }
  return [...apps.values()];
}

export function mdmReadState(error: unknown): MdmReadState {
  if (error instanceof ApiError && error.code === 'mdm_forbidden') return 'SCOPE_DENIED';
  // A 404 on this tenant may mean missing data, scope, edition or version;
  // it does not prove that the API capability is absent.
  if (error instanceof ApiError && error.code === 'mdm_not_found') return 'UNAVAILABLE';
  return 'UNAVAILABLE';
}

export function normalizeLastContact(raw: unknown): string | null {
  return when(record(raw)?.last_contact_time);
}

export function normalizeProfileDetail(raw: unknown): MdmProfileDetail {
  const row = record(raw);
  const profileId = id(row?.profile_id);
  if (!row || !profileId) throw new ApiError(503, 'mdm_invalid_shape', 'MDM unavailable');
  const platform =
    row.platform_type === 2 || row.platform_type === '2'
      ? 'ANDROID'
      : row.platform_type == null
        ? 'UNKNOWN'
        : 'OTHER';
  const version = row.profile_version;
  return {
    profile_id: profileId,
    platform,
    version:
      typeof version === 'number' && Number.isSafeInteger(version) && version > 0 ? version : null,
    published: row.profile_status_id === 110 || row.profile_status_id === '110',
    trashed: row.is_moved_to_trash === true,
  };
}
