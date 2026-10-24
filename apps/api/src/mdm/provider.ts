import { ApiError } from '../errors.js';

export interface MdmDevice {
  mdm_device_id: string;
  status: string;
  display_name?: string | undefined;
  model?: string | undefined;
  os_version?: string | undefined;
  serial_number?: string | undefined;
  udid?: string | undefined;
  platform?: 'android' | 'other' | 'unknown';
  removed?: boolean;
}

export interface MdmPage {
  items: MdmDevice[];
  next_cursor: string | null;
  source: 'fake' | 'manageengine';
}

export interface MdmStatus {
  provider: 'fake' | 'manageengine';
  connected: boolean;
  authorized?: boolean;
  authorization_state?: 'never' | 'connected' | 'disconnecting' | 'disconnected';
  edition_evidence: 'TRIAL' | 'FREE' | 'LICENSED' | 'UNVERIFIED';
  configured_edition?: 'TRIAL' | 'FREE' | 'LICENSED';
  region?: string | undefined;
  last_checked_at: string | null;
  last_http_status: number | null;
  sanitized_error_code: string | null;
}

export interface MdmProvider {
  listDevices(customerId: string, cursor: string | undefined, limit: number): Promise<MdmPage>;
  getDevice(customerId: string, mdmId: string): Promise<MdmDevice | null>;
  integrationStatus(): Promise<MdmStatus>;
}

function offset(cursor: string | undefined): number {
  if (!cursor) return 0;
  let value: string;
  try {
    value = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
  }
  if (!/^(0|[1-9][0-9]{0,8})$/.test(value))
    throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
  return Number(value);
}

function pageLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(400, 'invalid_limit', 'Invalid limit');
  }
}

export class FakeMdmProvider implements MdmProvider {
  private readonly records: readonly MdmDevice[];

  constructor(records: readonly MdmDevice[] = []) {
    this.records = records.map((item) => ({ ...item }));
  }

  async listDevices(
    _customerId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<MdmPage> {
    pageLimit(limit);
    const start = offset(cursor);
    const items = this.records.slice(start, start + limit).map((item) => ({ ...item }));
    const next =
      start + items.length < this.records.length
        ? Buffer.from(String(start + items.length)).toString('base64url')
        : null;
    return { items, next_cursor: next, source: 'fake' };
  }

  async getDevice(_customerId: string, mdmId: string): Promise<MdmDevice | null> {
    const item = this.records.find((device) => device.mdm_device_id === mdmId);
    return item ? { ...item } : null;
  }

  async integrationStatus(): Promise<MdmStatus> {
    return {
      provider: 'fake',
      connected: false,
      edition_evidence: 'UNVERIFIED',
      last_checked_at: null,
      last_http_status: null,
      sanitized_error_code: null,
    };
  }
}

export interface RealClientOptions {
  enabled: boolean;
  origin: string;
  expectedOrigin: string;
  token: () => Promise<string>;
  refresh?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  region?: string;
  editionEvidence?: MdmStatus['edition_evidence'];
  configuredEdition?: 'TRIAL' | 'FREE' | 'LICENSED';
}

// A 25-device fleet can have more than 25 vendor records, but a page must stay bounded.
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PAGE_RECORDS = 100;

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new ApiError(503, 'mdm_response_too_large', 'MDM unavailable');
  }
  if (!response.body) throw new ApiError(503, 'mdm_invalid_shape', 'MDM unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ApiError(503, 'mdm_response_too_large', 'MDM unavailable');
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'mdm_connection_error', 'MDM unavailable');
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, size).toString('utf8');
  try {
    const parseLossless = JSON.parse as unknown as (
      text: string,
      reviver: (key: string, value: unknown, context: { source: string }) => unknown,
    ) => unknown;
    return parseLossless(body, (key, value, context) =>
      key === 'device_id' && typeof value === 'number' ? context.source : value,
    );
  } catch {
    throw new ApiError(503, 'mdm_invalid_shape', 'MDM unavailable');
  }
}

function exactId(value: unknown): string {
  if (typeof value === 'string' && /^[0-9]{1,30}$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  throw new ApiError(503, 'mdm_invalid_shape', 'MDM unavailable');
}

function field(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 160 ? value : undefined;
}

function normalizeDevice(raw: unknown): MdmDevice {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ApiError(503, 'mdm_invalid_shape', 'MDM unavailable');
  const item = raw as Record<string, unknown>;
  const os = item.os && typeof item.os === 'object' ? (item.os as Record<string, unknown>) : {};
  const platformValue = item.platform_type ?? os.platform_type;
  const platform =
    platformValue === 'android' || item.platform_type_id === 2 || item.platform_type_id === '2'
      ? 'android'
      : platformValue === undefined && item.platform_type_id === undefined
        ? 'unknown'
        : 'other';
  const removed = item.is_removed === true || item.is_removed === 'true' || item.is_removed === 1;
  const rawStatus = item.managed_status;
  const status = removed
    ? 'removed'
    : rawStatus === 2 || rawStatus === '2' || rawStatus === 'managed'
      ? 'managed'
      : rawStatus === 4 || rawStatus === '4' || rawStatus === 'unmanaged'
        ? 'unmanaged'
        : 'unknown';
  return {
    mdm_device_id: exactId(item.device_id),
    status,
    platform,
    removed,
    ...(field(item.device_name) ? { display_name: field(item.device_name) } : {}),
    ...(field(item.model) ? { model: field(item.model) } : {}),
    ...(field(item.os_version ?? os.os_version)
      ? { os_version: field(item.os_version ?? os.os_version) }
      : {}),
    ...(field(item.serial_number ?? os.serial_number)
      ? { serial_number: field(item.serial_number ?? os.serial_number) }
      : {}),
    ...(field(item.udid) ? { udid: field(item.udid) } : {}),
  };
}

function decodeRealCursor(cursor: string | undefined): { offset: number; skip?: string } {
  if (!cursor) return { offset: 0 };
  if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
  }
  if (!value || typeof value !== 'object')
    throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
  const parsed = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(parsed.offset) ||
    (parsed.offset as number) < 0 ||
    (parsed.skip !== undefined &&
      (typeof parsed.skip !== 'string' ||
        parsed.skip.length > 1024 ||
        !/^[A-Za-z0-9_~.%=+/-]+$/.test(parsed.skip)))
  )
    throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
  return {
    offset: parsed.offset as number,
    ...(parsed.skip ? { skip: parsed.skip as string } : {}),
  };
}

function nextRealCursor(
  data: Record<string, unknown>,
  start: number,
  count: number,
  limit: number,
): string | null {
  const paging = data.paging;
  if (
    paging &&
    typeof paging === 'object' &&
    typeof (paging as Record<string, unknown>).next === 'string'
  ) {
    // Never request the returned host: some vendor examples even contain localhost.
    let next: URL;
    try {
      next = new URL((paging as { next: string }).next, 'https://mdm.manageengine.com');
    } catch {
      throw new ApiError(503, 'mdm_invalid_paging', 'MDM unavailable');
    }
    if (next.pathname !== '/api/v1/mdm/devices')
      throw new ApiError(503, 'mdm_invalid_paging', 'MDM unavailable');
    const skip = next.searchParams.get('skip-token');
    const offsetValue = next.searchParams.get('offset');
    const parsedOffset = offsetValue === null ? start + count : Number(offsetValue);
    if (!Number.isSafeInteger(parsedOffset) || parsedOffset <= start || parsedOffset > 1_000_000)
      throw new ApiError(503, 'mdm_invalid_paging', 'MDM unavailable');
    return Buffer.from(
      JSON.stringify({ offset: parsedOffset, ...(skip ? { skip } : {}) }),
    ).toString('base64url');
  }
  const metadata = data.metadata as Record<string, unknown> | undefined;
  const total = metadata?.total_record_count;
  const more =
    Number.isSafeInteger(total) && (total as number) >= 0
      ? start + count < (total as number)
      : count === limit;
  return more ? Buffer.from(JSON.stringify({ offset: start + count })).toString('base64url') : null;
}

export class ManageEngineReadOnly implements MdmProvider {
  private readonly fetchImpl: typeof fetch;
  private lastHttpStatus: number | null = null;
  private lastCheckedAt: string | null = null;
  private lastConnected = false;
  private refreshInFlight: Promise<string> | null = null;

  constructor(private readonly options: RealClientOptions) {
    if (!options.enabled) throw new Error('Real MDM adapter disabled');
    const origin = new URL(options.origin);
    if (
      origin.protocol !== 'https:' ||
      origin.origin !== options.expectedOrigin ||
      origin.pathname !== '/'
    ) {
      throw new Error('MDM origin not allowlisted');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async refresh(): Promise<string> {
    if (!this.options.refresh) throw new ApiError(401, 'mdm_unauthorized', 'MDM unavailable');
    this.refreshInFlight ??= this.options.refresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async read(path: string, customerId: string, retried = false): Promise<unknown> {
    this.lastConnected = false;
    this.lastHttpStatus = null;
    this.lastCheckedAt = new Date().toISOString();
    if (!customerId || !/^[0-9]+$/.test(customerId))
      throw new ApiError(400, 'invalid_customer', 'Invalid customer');
    const url = new URL(path, this.options.origin);
    if (url.origin !== this.options.expectedOrigin || !url.pathname.startsWith('/api/v1/mdm/')) {
      throw new ApiError(400, 'invalid_mdm_path', 'Invalid request');
    }
    let response: Response;
    try {
      const accessToken = retried ? await this.refresh() : await this.options.token();
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          'X-CUSTOMER': customerId,
          Accept: 'application/json',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'mdm_connection_error', 'MDM unavailable');
    }
    this.lastCheckedAt = new Date().toISOString();
    this.lastHttpStatus = response.status;
    if (response.status === 401 && !retried) return this.read(path, customerId, true);
    if (response.status === 401) throw new ApiError(401, 'mdm_unauthorized', 'MDM unavailable');
    if (response.status === 403) throw new ApiError(403, 'mdm_forbidden', 'MDM unavailable');
    if (response.status === 404) throw new ApiError(404, 'mdm_not_found', 'MDM unavailable');
    if (response.status === 429) {
      const error = new ApiError(429, 'mdm_rate_limited', 'MDM rate limited');
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter && /^\d{1,5}$/.test(retryAfter)) Object.assign(error, { retryAfter });
      throw error;
    }
    if (response.status >= 300 && response.status < 400)
      throw new ApiError(503, 'mdm_redirect_rejected', 'MDM unavailable');
    if (!response.ok) throw new ApiError(503, 'mdm_upstream_error', 'MDM unavailable');
    return boundedJson(response);
  }

  async listDevices(
    customerId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<MdmPage> {
    pageLimit(limit);
    const current = decodeRealCursor(cursor);
    const start = current.offset;
    const query = new URLSearchParams({
      limit: String(limit),
      offset: String(start),
      exclude_removed: 'false',
    });
    if (current.skip) query.set('skip-token', current.skip);
    const data = (await this.read(`/api/v1/mdm/devices?${query}`, customerId)) as Record<
      string,
      unknown
    >;
    if (
      !Array.isArray(data?.devices) ||
      data.devices.length > limit ||
      data.devices.length > MAX_PAGE_RECORDS
    )
      throw new ApiError(503, 'mdm_invalid_shape', 'MDM unavailable');
    const items = data.devices.map(normalizeDevice);
    if (new Set(items.map((item) => item.mdm_device_id)).size !== items.length)
      throw new ApiError(503, 'mdm_duplicate_device', 'MDM unavailable');
    const next_cursor = nextRealCursor(data, start, items.length, limit);
    this.lastConnected = true;
    return { items, next_cursor, source: 'manageengine' };
  }

  async getDevice(customerId: string, mdmId: string): Promise<MdmDevice | null> {
    if (!/^[0-9]+$/.test(mdmId)) throw new ApiError(400, 'invalid_mdm_id', 'Invalid request');
    let data: Record<string, unknown>;
    try {
      data = (await this.read(
        `/api/v1/mdm/devices/${encodeURIComponent(mdmId)}`,
        customerId,
      )) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'mdm_not_found') return null;
      throw error;
    }
    const raw = data?.device ?? data;
    if (typeof raw !== 'object' || raw === null)
      throw new ApiError(503, 'mdm_invalid_shape', 'MDM unavailable');
    const device = normalizeDevice(raw);
    this.lastConnected = true;
    return device;
  }

  async integrationStatus(): Promise<MdmStatus> {
    return {
      provider: 'manageengine',
      connected: this.lastConnected,
      edition_evidence: this.options.editionEvidence ?? 'UNVERIFIED',
      ...(this.options.configuredEdition
        ? { configured_edition: this.options.configuredEdition }
        : {}),
      region: this.options.region,
      last_checked_at: this.lastCheckedAt,
      last_http_status: this.lastHttpStatus,
      sanitized_error_code: null,
    };
  }
}
