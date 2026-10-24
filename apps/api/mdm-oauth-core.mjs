import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const INVENTORY_SCOPE = 'MDMOnDemand.MDMInventory.READ';
export const CUSTOMER_SCOPE = 'MDMOnDemand.MDMAdmin.READ';
export const PROFILE_SCOPE = 'MDMOnDemand.MDMDeviceMgmt.READ';
export const CALLBACK_URL = 'http://localhost:3500/api/integrations/mdm/oauth/callback';

const REGIONS = new Map([
  ['com', 'us'], ['eu', 'eu'], ['in', 'in'], ['com.au', 'au'],
  ['jp', 'jp'], ['ca', 'ca'], ['cn', 'cn'], ['sa', 'sa'], ['uk', 'uk']
]);

export class DiagnosticError extends Error {
  constructor(code, httpStatus = 400, retryAfter = null, upstreamStatus = null) {
    super(code);
    this.name = 'DiagnosticError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryAfter = retryAfter;
    this.upstreamStatus = upstreamStatus;
  }
}

export function parseDotEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) {
      throw new DiagnosticError('invalid_env_format');
    }
    let value = match[2].trim();
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        throw new DiagnosticError('invalid_env_format');
      }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export function configFromValues(values) {
  if (!values.MDM_CLIENT_ID || !values.MDM_CLIENT_SECRET || !values.MDM_OAUTH_REDIRECT_URI) {
    throw new DiagnosticError('credentials_missing');
  }
  if (values.MDM_PROVIDER !== 'manageengine' || values.MDM_CLIENT_NAME !== 'geops') {
    throw new DiagnosticError('provider_or_client_mismatch');
  }
  if (values.MDM_OAUTH_REDIRECT_URI !== CALLBACK_URL) {
    throw new DiagnosticError('redirect_mismatch');
  }
  const region = String(values.MDM_REGION || '').replace(/^\./, '');
  if (!REGIONS.has(region)) {
    throw new DiagnosticError('region_missing_or_unsupported');
  }
  const configuredCustomerId = values.MDM_CUSTOMER_ID || null;
  if (configuredCustomerId && !/^[0-9]{1,30}$/.test(configuredCustomerId)) {
    throw new DiagnosticError('customer_id_invalid');
  }
  return Object.freeze({
    clientId: values.MDM_CLIENT_ID,
    clientSecret: values.MDM_CLIENT_SECRET,
    redirectUri: CALLBACK_URL,
    region,
    authOrigin: 'https://accounts.zoho.' + region,
    mdmOrigin: 'https://mdm.manageengine.' + region,
    configuredCustomerId
  });
}

export function loadLocalConfig(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    throw new DiagnosticError('credentials_missing');
  }
  return configFromValues(parseDotEnv(text));
}

export function randomUrlSafe(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function buildAuthorizationUrl(config, flow) {
  const url = new URL('/oauth/v2/auth', config.authOrigin);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', flow.scope);
  url.searchParams.set('state', flow.state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', pkceChallenge(flow.verifier));
  return url.toString();
}

function safeExpirySeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400) {
    throw new DiagnosticError('invalid_token_response', 502);
  }
  return seconds;
}

async function postForm(fetchImpl, url, fields, headers = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    throw new DiagnosticError('connection_error', 502);
  }
  return response;
}

async function tokenJson(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new DiagnosticError(response.ok ? 'invalid_token_response' : 'oauth_exchange_failed', 502, null, response.status);
  }
  if (body?.error === 'invalid_code' || body?.error === 'invalid_grant') {
    throw new DiagnosticError('oauth_code_or_grant_rejected', 502, null, response.status);
  }
  if (!response.ok || body?.error) {
    throw new DiagnosticError('oauth_exchange_failed', 502, null, response.status);
  }
  if (!body || typeof body.access_token !== 'string' || !body.access_token) {
    throw new DiagnosticError('invalid_token_response', 502, null, response.status);
  }
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
    expiresIn: safeExpirySeconds(body.expires_in ?? body.expires_in_sec),
    grantedScope: typeof body.scope === 'string' ? body.scope : null,
    httpStatus: response.status
  };
}

export async function exchangeCode(config, code, verifier, fetchImpl = fetch) {
  const response = await postForm(fetchImpl, config.authOrigin + '/oauth/v2/token', {
    grant_type: 'authorization_code',
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    code_verifier: verifier
  });
  return tokenJson(response);
}

export async function refreshAccess(config, refreshToken, fetchImpl = fetch) {
  const response = await postForm(fetchImpl, config.authOrigin + '/oauth/v2/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret
  });
  return tokenJson(response);
}

export async function revokeRefresh(config, refreshToken, fetchImpl = fetch) {
  const basic = Buffer.from(config.clientId + ':' + config.clientSecret, 'utf8').toString('base64');
  const response = await postForm(fetchImpl, config.authOrigin + '/oauth/v2/revoke/token',
    { token: refreshToken, token_type: 'refresh_token' },
    { authorization: 'Basic ' + basic });
  return response.status === 200;
}

export function locationMatches(region, location) {
  if (!location) return true;
  const accepted = REGIONS.get(region);
  return location === region || location === accepted;
}

async function getJson(fetchImpl, url, accessToken, customerId) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        authorization: 'Zoho-oauthtoken ' + accessToken,
        accept: 'application/json',
        ...(customerId ? { 'X-CUSTOMER': customerId } : {})
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(10000)
    });
  } catch {
    throw new DiagnosticError('connection_error', 502);
  }
  if (response.status >= 300 && response.status < 400) throw new DiagnosticError('mdm_redirect', 502, null, response.status);
  if (response.status === 401) throw new DiagnosticError('mdm_unauthorized', 401, null, response.status);
  if (response.status === 403) throw new DiagnosticError('mdm_forbidden', 403, null, response.status);
  if (response.status === 429) {
    const raw = response.headers.get('retry-after');
    const seconds = raw && /^[0-9]{1,5}$/.test(raw) ? Number(raw) : null;
    throw new DiagnosticError('mdm_rate_limited', 429, seconds, response.status);
  }
  if (!response.ok) throw new DiagnosticError('mdm_http_error', 502, null, response.status);
  let data;
  try {
    const raw = await response.text();
    data = JSON.parse(raw, (key, value, context) =>
      key === 'customer_id' && typeof value === 'number' ? context.source : value);
  } catch {
    throw new DiagnosticError('mdm_invalid_json', 502);
  }
  return { status: response.status, data };
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export class DiagnosticSession {
  constructor(config, { fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.pending = null;
    this.tokens = { inventory: null, customers: null };
    this.customerId = config.configuredCustomerId;
    this.customerVerifiedByApi = false;
    this.lastOauthHttpStatus = { inventory: null, customers: null };
  }

  begin(mode) {
    if (mode !== 'inventory' && mode !== 'customers') {
      throw new DiagnosticError('unsupported_scope_mode');
    }
    const state = randomUrlSafe(32);
    const verifier = randomUrlSafe(64);
    const cookie = randomUrlSafe(32);
    const scope = mode === 'inventory' ? INVENTORY_SCOPE : CUSTOMER_SCOPE;
    this.pending = { mode, state, verifier, cookie, scope, expiresAt: this.now() + 300000 };
    return { url: buildAuthorizationUrl(this.config, this.pending), cookie };
  }

  async complete({ state, code, cookie, location, error }) {
    const pending = this.pending;
    if (!pending || this.now() > pending.expiresAt ||
        !equalSecret(state, pending.state) || !equalSecret(cookie, pending.cookie)) {
      throw new DiagnosticError('invalid_oauth_state', 400);
    }
    this.pending = null;
    if (error || !code) throw new DiagnosticError('oauth_denied_or_missing_code', 400);
    if (!locationMatches(this.config.region, location)) {
      throw new DiagnosticError('tenant_region_mismatch', 400);
    }
    const received = await exchangeCode(this.config, code, pending.verifier, this.fetchImpl);
    if (received.grantedScope && !received.grantedScope.split(/[,\s]+/).includes(pending.scope)) {
      if (received.refreshToken) {
        try { await revokeRefresh(this.config, received.refreshToken, this.fetchImpl); } catch { /* no token leaves memory */ }
      }
      throw new DiagnosticError('scope_insufficient', 403);
    }
    this.lastOauthHttpStatus[pending.mode] = received.httpStatus;
    this.tokens[pending.mode] = {
      accessToken: received.accessToken,
      refreshToken: received.refreshToken,
      expiresAt: this.now() + received.expiresIn * 1000,
      scope: pending.scope
    };
    return { connected: true, mode: pending.mode };
  }

  async access(mode) {
    const entry = this.tokens[mode];
    if (!entry) throw new DiagnosticError('not_connected', 401);
    if (entry.expiresAt > this.now() + 30000) return entry.accessToken;
    if (!entry.refreshToken) {
      this.tokens[mode] = null;
      throw new DiagnosticError('token_expired_reauthorize', 401);
    }
    const renewed = await refreshAccess(this.config, entry.refreshToken, this.fetchImpl);
    entry.accessToken = renewed.accessToken;
    entry.refreshToken = renewed.refreshToken || entry.refreshToken;
    entry.expiresAt = this.now() + renewed.expiresIn * 1000;
    return entry.accessToken;
  }

  async read(path, mode, customerId = null) {
    const url = this.config.mdmOrigin + path;
    let token = await this.access(mode);
    try {
      return await getJson(this.fetchImpl, url, token, customerId);
    } catch (error) {
      if (!(error instanceof DiagnosticError) || error.code !== 'mdm_unauthorized') throw error;
      const entry = this.tokens[mode];
      if (!entry?.refreshToken) throw error;
      entry.expiresAt = 0;
      token = await this.access(mode);
      return getJson(this.fetchImpl, url, token, customerId);
    }
  }

  async findDefaultCustomer() {
    // MSP documentation requires MDMAdmin.READ. No X-CUSTOMER is sent: the ID is unknown.
    const result = await this.read('/customers', 'customers');
    const customers = Array.isArray(result.data) ? result.data : result.data?.customers;
    if (!Array.isArray(customers)) throw new DiagnosticError('mdm_invalid_shape', 502);
    const matches = customers.filter(item => item?.customer_name === 'DEFAULT_CUSTOMER');
    if (matches.length !== 1) {
      throw new DiagnosticError(matches.length ? 'customer_ambiguous' : 'customer_not_found', 404);
    }
    const rawId = matches[0].customer_id;
    const validId = (typeof rawId === 'string' && /^[0-9]{1,30}$/.test(rawId)) ||
      (typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0);
    if (!validId) throw new DiagnosticError('customer_id_unsafe', 502);
    this.customerId = String(rawId);
    this.customerVerifiedByApi = true;
    return { http_status: result.status, customers_seen: customers.length,
      default_customer_found: true, customer_id_available: true };
  }

  async listDevices({ limit = 1, offset = 0 } = {}) {
    if (!this.customerId) throw new DiagnosticError('customer_id_missing', 409);
    const pageSize = Number(limit);
    const start = Number(offset);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50 ||
        !Number.isInteger(start) || start < 0) {
      throw new DiagnosticError('invalid_pagination');
    }
    const path = '/api/v1/mdm/devices?limit=' + pageSize + '&offset=' + start;
    const result = await this.read(path, 'inventory', this.customerId);
    if (!Array.isArray(result.data?.devices)) throw new DiagnosticError('mdm_invalid_shape', 502);
    const devices = result.data.devices;
    const fields = ['device_id', 'model', 'platform_type', 'os_version', 'managed_status'];
    return {
      http_status: result.status,
      device_count: devices.length,
      total_record_count: safeCount(result.data.metadata?.total_record_count),
      has_next_page: Boolean(result.data.paging?.next),
      fields_present: fields.filter(key => devices.some(item => item && Object.hasOwn(item, key))),
      customer_header_sent: true,
      customer_name_verified_by_api: this.customerVerifiedByApi
    };
  }

  status() {
    return {
      region: this.config.region,
      scopes: {
        inventory: INVENTORY_SCOPE,
        customers: CUSTOMER_SCOPE,
        profiles_documented_only: PROFILE_SCOPE
      },
      inventory_connected: Boolean(this.tokens.inventory),
      customer_lookup_connected: Boolean(this.tokens.customers),
      customer_id_available: Boolean(this.customerId),
      customer_name_verified_by_api: this.customerVerifiedByApi,
      oauth_http_status: this.lastOauthHttpStatus,
      token_storage: 'memory_only',
      environment: 'development_msp_trial_user_reported'
    };
  }

  async disconnect() {
    const entries = Object.values(this.tokens).filter(Boolean);
    this.tokens = { inventory: null, customers: null };
    this.pending = null;
    this.customerId = this.config.configuredCustomerId;
    this.customerVerifiedByApi = false;
    let revoked = 0;
    let failed = 0;
    let reuseRejected = 0;
    let reuseUnverified = 0;
    for (const entry of entries) {
      if (!entry.refreshToken) continue;
      try {
        if (!(await revokeRefresh(this.config, entry.refreshToken, this.fetchImpl))) { failed++; continue; }
        revoked++;
        try {
          await refreshAccess(this.config, entry.refreshToken, this.fetchImpl);
          reuseUnverified++;
        } catch (error) {
          if (error instanceof DiagnosticError && error.code === 'oauth_code_or_grant_rejected') reuseRejected++;
          else reuseUnverified++;
        }
      } catch {
        failed++;
      }
    }
    return { local_disconnected: true, remote_refresh_tokens_revoked: revoked,
      remote_revocation_failed: failed, remote_refresh_reuse_rejected: reuseRejected,
      remote_refresh_reuse_unverified: reuseUnverified };
  }
}
