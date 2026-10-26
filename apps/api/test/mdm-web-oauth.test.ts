import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { createApp } from '../src/app.js';
import type { AdminAuthService } from '../src/admin-auth/service.js';
import type { DeviceRepository } from '../src/device-identity/repository.js';
import { ApiError } from '../src/errors.js';
import { MdmWebOAuth } from '../src/mdm/web-oauth.js';
import { FakeMdmProvider } from '../src/mdm/provider.js';
import { MdmTenantRuntime } from '../src/mdm/tenant-runtime.js';
import type { MdmOAuthClientStore } from '../src/mdm/oauth-client-store.js';

test('OAuth client configuration requires admin Origin and CSRF and never returns secrets', async () => {
  const pool = { query: async () => ({ rowCount: 1, rows: [{ one: 1 }] }) } as unknown as Pool;
  let saved = false;
  const store = {
    webOrigin: 'https://example.invalid',
    status: async () => ({ configured: saved, source: saved ? 'admin' : 'none', region: 'com' }),
    save: async (_admin: string, _request: string, clientId: string, secret: string) => {
      assert.equal(clientId, 'synthetic-client');
      assert.equal(secret, 'synthetic-secret');
      saved = true;
    },
  } as unknown as MdmOAuthClientStore;
  const auth = {
    cookieName: 'geops_admin',
    authenticate: async (token: string | undefined) => {
      if (token !== 'session') throw new ApiError(401, 'unauthorized', 'Unauthorized');
      return {
        id: '00000000-0000-4000-8000-000000000001',
        sessionId: 'session',
        csrfToken: 'csrf',
      };
    },
    isAllowedOrigin: (origin: string | undefined) => origin === 'https://example.invalid',
    assertCsrf: (_identity: unknown, token: string | undefined) => {
      if (token !== 'csrf') throw new ApiError(403, 'csrf_rejected', 'Forbidden');
    },
  } as unknown as AdminAuthService;
  const app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    devices: { pool } as DeviceRepository,
    mdmTenant: new MdmTenantRuntime(pool, { region: 'com', grantKey: Buffer.alloc(32) }),
    mdmOAuthClientStore: store,
  });
  try {
    await app.ready();
    const body = { client_id: 'synthetic-client', client_secret: 'synthetic-secret' };
    const base = { cookie: 'geops_admin=session', origin: 'https://example.invalid' };
    const put = (headers: Record<string, string>) =>
      app.inject({
        method: 'PUT',
        url: '/v1/admin/mdm/oauth/config',
        headers,
        payload: body,
      });
    assert.equal((await put(base)).statusCode, 403);
    assert.equal(
      (await put({ ...base, origin: 'https://evil.invalid', 'x-csrf-token': 'csrf' })).statusCode,
      403,
    );
    assert.equal((await put({ ...base, 'x-csrf-token': 'csrf' })).statusCode, 200);
    const read = await app.inject({
      method: 'GET',
      url: '/v1/admin/mdm/oauth/config',
      headers: base,
    });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().configured, true);
    assert.equal(read.json().callback_url, 'https://example.invalid/v1/admin/mdm/oauth/callback');
    assert.equal(read.body.includes('synthetic-secret'), false);
    assert.equal(read.headers['cache-control'], 'no-store');
  } finally {
    await app.close();
  }
});

test('MDM interface remains available without OAuth credentials and cannot start OAuth', async () => {
  const pool = { query: async () => ({ rowCount: 1, rows: [{ one: 1 }] }) } as unknown as Pool;
  const auth = {
    cookieName: 'geops_admin',
    authenticate: async (token: string | undefined) => {
      if (token !== 'session') throw new ApiError(401, 'unauthorized', 'Unauthorized');
      return {
        id: '00000000-0000-4000-8000-000000000001',
        sessionId: 'session',
        csrfToken: 'csrf',
      };
    },
    isAllowedOrigin: (origin: string | undefined) => origin === 'http://localhost:3501',
    assertCsrf: (_identity: unknown, token: string | undefined) => {
      if (token !== 'csrf') throw new ApiError(403, 'csrf_rejected', 'Forbidden');
    },
  } as unknown as AdminAuthService;
  const app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    devices: { pool } as DeviceRepository,
    mdmTenant: new MdmTenantRuntime(pool, { region: 'com', grantKey: Buffer.alloc(32) }),
  });
  try {
    await app.ready();
    const headers = {
      cookie: 'geops_admin=session',
      origin: 'http://localhost:3501',
      'x-csrf-token': 'csrf',
    };
    const status = await app.inject({ method: 'GET', url: '/v1/admin/mdm/status', headers });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().oauth_configured, false);
    assert.equal(status.json().sanitized_error_code, 'mdm_oauth_unconfigured');
    const start = await app.inject({ method: 'POST', url: '/v1/admin/mdm/oauth/start', headers });
    assert.equal(start.statusCode, 503);
    assert.equal(start.json().error.code, 'mdm_oauth_unconfigured');
    assert.equal(start.headers.location, undefined);
    assert.equal(
      (await app.inject({ method: 'POST', url: '/v1/admin/mdm/oauth/start' })).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/admin/mdm/oauth/start',
          headers: { cookie: 'geops_admin=session', origin: 'http://localhost:3501' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/v1/admin/mdm/oauth/callback' })).statusCode,
      404,
    );
    assert.equal((await app.inject({ method: 'GET', url: '/health/live' })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('Web OAuth discovers one MSP customer without preconfigured identity and rejects replay', async () => {
  let pending: Record<string, unknown> | null = null;
  let consumed = false;
  let activation = false;
  const calls: string[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    if (
      sql.includes('FROM admin_session') ||
      sql.includes('FROM admin_permission') ||
      sql.includes('FROM admin_user u')
    )
      return { rowCount: 1, rows: [{ one: 1 }] };
    if (sql.includes('FROM mdm_connection_control') || sql.includes('FROM mdm_integration'))
      return { rowCount: 0, rows: [] };
    if (sql.startsWith('INSERT INTO mdm_integration')) {
      assert.equal(params[2], '12345');
      assert.equal((params[3] as Buffer).includes(Buffer.from('synthetic-refresh')), false);
      activation = true;
      return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith('DELETE FROM mdm_oauth_pending')) {
      pending = null;
      return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith('INSERT INTO mdm_oauth_pending')) {
      pending = {
        state_digest: params[0],
        nonce_digest: params[1],
        admin_id: params[2],
        session_id: params[3],
        verifier_ciphertext: params[6],
        verifier_iv: params[7],
        verifier_tag: params[8],
        expires_at: params[9],
      };
      consumed = false;
      return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith('UPDATE mdm_oauth_pending')) {
      if (
        !pending ||
        consumed ||
        !(params[0] as Buffer).equals(pending.state_digest as Buffer) ||
        !(params[1] as Buffer).equals(pending.nonce_digest as Buffer)
      )
        return { rowCount: 0, rows: [] };
      consumed = true;
      return { rowCount: 1, rows: [pending] };
    }
    return { rowCount: 0, rows: [] };
  };
  const pool = {
    query,
    connect: async () => ({ query, release: () => {} }),
  } as unknown as Pool;
  const oauth = new MdmWebOAuth(pool, {
    region: 'com',
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-secret',
    webOrigin: 'http://localhost:3501',
    grantKey: Buffer.alloc(32, 7),
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/oauth/v2/token')) {
        assert.equal(new URLSearchParams(String(init?.body)).get('code_verifier')?.length, 86);
        return Response.json({
          access_token: 'synthetic-access',
          refresh_token: 'synthetic-refresh',
          expires_in: 3600,
          scope: 'MDMOnDemand.MDMInventory.READ,MDMOnDemand.MDMAdmin.READ',
        });
      }
      if (url.endsWith('/customers')) {
        assert.equal(new Headers(init?.headers).get('X-CUSTOMER'), null);
        return Response.json({ customers: [{ customer_id: '12345', customer_name: 'Test MSP' }] });
      }
      assert.equal(new Headers(init?.headers).get('X-CUSTOMER'), '12345');
      return Response.json({ devices: [], paging: {} });
    },
  });
  const started = await oauth.start(
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
  );
  const url = new URL(started.url);
  assert.equal(url.origin, 'https://accounts.zoho.com');
  assert.equal(
    url.searchParams.get('redirect_uri'),
    'http://localhost:3501/v1/admin/mdm/oauth/callback',
  );
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    url.searchParams.get('scope'),
    'MDMOnDemand.MDMAdmin.READ,MDMOnDemand.MDMInventory.READ',
  );
  const state = url.searchParams.get('state') ?? '';
  const input = {
    state,
    code: 'synthetic-code',
    location: 'us',
    error: undefined,
    correlationId: 'request-1',
  };
  await assert.rejects(oauth.complete({ ...input, nonce: 'wrong' }), {
    code: 'mdm_oauth_state_invalid',
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(await oauth.complete({ ...input, nonce: started.nonce }), { kind: 'connected' });
  assert.equal(activation, true);
  assert.equal(calls.length, 3);
  await assert.rejects(oauth.complete({ ...input, nonce: started.nonce }), {
    code: 'mdm_oauth_state_invalid',
  });
  assert.equal(calls.length, 3);
});

test('OAuth routes require admin session, Origin and CSRF; callback uses only one-use correlation', async () => {
  let completed = false;
  const auth = {
    cookieName: 'geops_admin',
    authenticate: async (token: string | undefined) => {
      if (token !== 'session') throw new ApiError(401, 'unauthorized', 'Unauthorized');
      return {
        id: '00000000-0000-4000-8000-000000000001',
        sessionId: 'session-id',
        csrfToken: 'csrf',
        email: 'admin@example.invalid',
      };
    },
    isAllowedOrigin: (origin: string | undefined) => origin === 'http://localhost:3501',
    assertCsrf: (_identity: unknown, token: string | undefined) => {
      if (token !== 'csrf') throw new ApiError(403, 'csrf_rejected', 'Forbidden');
    },
  } as unknown as AdminAuthService;
  const oauth = {
    callbackPath: '/v1/admin/mdm/oauth/callback',
    cookieName: 'geops_mdm_oauth',
    secureCookie: false,
    start: async () => ({
      url: 'https://accounts.zoho.com/oauth/v2/auth?state=synthetic',
      nonce: 'synthetic-nonce',
    }),
    complete: async (input: { nonce?: string }) => {
      assert.equal(input.nonce, 'synthetic-nonce');
      completed = true;
    },
  } as unknown as MdmWebOAuth;
  const devices = {
    pool: { query: async () => ({ rowCount: 1, rows: [] }) },
  } as unknown as DeviceRepository;
  const app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    devices,
    mdm: new FakeMdmProvider(),
    mdmWebOAuth: oauth,
  });
  try {
    const url = '/v1/admin/mdm/oauth/start';
    assert.equal((await app.inject({ method: 'POST', url })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { cookie: 'geops_admin=session', 'x-csrf-token': 'csrf' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { cookie: 'geops_admin=session', origin: 'http://localhost:3501' },
        })
      ).statusCode,
      403,
    );
    const started = await app.inject({
      method: 'POST',
      url,
      headers: {
        cookie: 'geops_admin=session',
        origin: 'http://localhost:3501',
        'x-csrf-token': 'csrf',
      },
    });
    assert.equal(started.statusCode, 200);
    assert.match(String(started.headers['set-cookie']), /HttpOnly; SameSite=Lax/);
    assert.equal(
      JSON.parse(started.body).authorization_url.startsWith('https://accounts.zoho.com/'),
      true,
    );
    const callback = await app.inject({
      method: 'GET',
      url: '/v1/admin/mdm/oauth/callback?state=synthetic&code=synthetic-code',
      headers: { cookie: 'geops_mdm_oauth=synthetic-nonce' },
    });
    assert.equal(callback.statusCode, 303);
    assert.equal(callback.headers.location, '/status?mdm_oauth=connected');
    assert.equal(completed, true);
    assert.doesNotMatch(JSON.stringify(callback.headers), /synthetic-code/);
    const rejected = await app.inject({
      method: 'GET',
      url: '/v1/admin/mdm/oauth/callback?state=synthetic&code=private-code',
    });
    assert.equal(rejected.statusCode, 303);
    assert.equal(rejected.headers.location, '/status?mdm_oauth=failed');
    assert.doesNotMatch(JSON.stringify(rejected.headers), /private-code/);
  } finally {
    await app.close();
  }
});
