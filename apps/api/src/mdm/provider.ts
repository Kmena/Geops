import { ApiError } from '../errors.js';

export interface MdmDevice {
  mdm_device_id: string;
  status: string;
  display_name?: string;
}

export interface MdmPage {
  items: MdmDevice[];
  next_cursor: string | null;
  source: 'fake' | 'manageengine_trial';
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
      edition_evidence: 'FREE_UNVERIFIED',
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
}

export class ManageEngineReadOnly implements MdmProvider {
  private readonly fetchImpl: typeof fetch;
  private lastHttpStatus: number | null = null;
  private lastCheckedAt: string | null = null;
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
    if (response.status === 429) {
      const error = new ApiError(429, 'mdm_rate_limited', 'MDM rate limited');
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter && /^\d{1,5}$/.test(retryAfter)) Object.assign(error, { retryAfter });
      throw error;
    }
    if (response.status >= 300 && response.status < 400)
      throw new ApiError(503, 'mdm_redirect_rejected', 'MDM unavailable');
    if (!response.ok) throw new ApiError(503, 'mdm_upstream_error', 'MDM unavailable');
    try {
      return await response.json();
    } catch {
      throw new ApiError(503, 'mdm_invalid_shape', 'MDM unavailable');
    }
  }

  async listDevices(
    customerId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<MdmPage> {
    pageLimit(limit);
    const start = offset(cursor);
    const data = (await this.read(
      `/api/v1/mdm/devices?limit=${limit}&offset=${start}`,
      customerId,
    )) as { devices?: unknown };
    if (!Array.isArray(data?.devices))
      throw new ApiError(503, 'mdm_invalid_shape', 'MDM unavailable');
    const items: MdmDevice[] = data.devices.map((raw: unknown) => {
      if (typeof raw !== 'object' || raw === null)
        throw new ApiError(503, 'mdm_invalid_shape', 'MDM unavailable');
      const item = raw as Record<string, unknown>;
      if (typeof item.device_id !== 'string' && typeof item.device_id !== 'number')
        throw new ApiError(503, 'mdm_invalid_shape', 'MDM unavailable');
      return {
        mdm_device_id: String(item.device_id),
        status: typeof item.managed_status === 'string' ? item.managed_status : 'unknown',
      };
    });
    const next_cursor =
      items.length === limit
        ? Buffer.from(String(start + items.length)).toString('base64url')
        : null;
    return { items, next_cursor, source: 'manageengine_trial' };
  }

  async getDevice(customerId: string, mdmId: string): Promise<MdmDevice | null> {
    if (!/^[0-9]+$/.test(mdmId)) throw new ApiError(400, 'invalid_mdm_id', 'Invalid request');
    const data = (await this.read(
      `/api/v1/mdm/devices/${encodeURIComponent(mdmId)}`,
      customerId,
    )) as Record<string, unknown>;
    const raw = data?.device;
    if (typeof raw !== 'object' || raw === null)
      throw new ApiError(503, 'mdm_invalid_shape', 'MDM unavailable');
    const item = raw as Record<string, unknown>;
    return {
      mdm_device_id: String(item.device_id),
      status: String(item.managed_status ?? 'unknown'),
    };
  }

  async integrationStatus(): Promise<MdmStatus> {
    return {
      provider: 'manageengine',
      connected: this.lastHttpStatus === 200,
      edition_evidence: 'TRIAL',
      last_checked_at: this.lastCheckedAt,
      last_http_status: this.lastHttpStatus,
      sanitized_error_code: null,
    };
  }
}
