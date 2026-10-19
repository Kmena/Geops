import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { ApiError } from '../src/errors.ts';

const origin = 'https://geops-staging.duckdns.org';
const key = Buffer.alloc(32, 7).toString('base64url');
const env = {
  GEOPS_DATA_MODE: 'synthetic',
  DATABASE_URL: 'postgresql://synthetic:synthetic@localhost/geops_dev',
  GEOPS_ALLOWED_ORIGINS: origin,
  GEOPS_ADMIN_SESSION_KEY: key,
  GEOPS_ADMIN_CSRF_KEY: key,
  GEOPS_INVITATION_HMAC_KEY: key,
  GEOPS_MDM_GRANT_KEY: key,
  GEOPS_GPS_QUARANTINE_KEY: key,
  GEOPS_ADMIN_COOKIE_NAME: '__Host-geops_stage_admin',
  GEOPS_ADMIN_COOKIE_PATH: '/',
};

test('staging cookie requires an isolated name, path, and Secure', () => {
  const config = loadConfig(env);
  assert.equal(config.adminCookieName, '__Host-geops_stage_admin');
  assert.equal(config.adminCookiePath, '/');
  assert.equal(config.secureCookie, true);
  assert.throws(() => loadConfig({ ...env, GEOPS_ADMIN_COOKIE_NAME: 'geops_admin' }));
  assert.throws(() => loadConfig({ ...env, GEOPS_ADMIN_COOKIE_PATH: '/staging' }));
  assert.throws(() => loadConfig({ ...env, GEOPS_INSECURE_LOCAL_COOKIE: '1' }));
  assert.throws(() => loadConfig({ ...env, GEOPS_ALLOWED_ORIGINS: 'https://18.209.159.208' }));
});

test('login/logout scope and PoC/root cookie isolation retain Origin and CSRF', async () => {
  const identity = {
    id: randomUUID(),
    email: 'synthetic@example.test',
    csrfToken: 'csrf',
    sessionId: randomUUID(),
  };
  let loggedOut = false;
  const auth = {
    cookieName: '__Host-geops_stage_admin',
    isAllowedOrigin: (candidate) => candidate === origin,
    login: async () => ({
      ...identity,
      token: 'synthetic-token',
      expiresAt: new Date().toISOString(),
    }),
    authenticate: async (token) => {
      if (token !== 'synthetic-token' || loggedOut)
        throw new ApiError(401, 'unauthorized', 'Unauthorized');
      return identity;
    },
    assertCsrf: (_identity, token) => {
      if (token !== identity.csrfToken) throw new ApiError(403, 'csrf_rejected', 'Forbidden');
    },
    logout: async () => {
      loggedOut = true;
    },
  };
  const app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    adminCookiePath: '/',
  });
  try {
    const login = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/sessions',
      headers: { origin },
      payload: { email: identity.email, password: 'synthetic' },
    });
    assert.equal(login.statusCode, 200);
    assert.match(
      login.headers['set-cookie'],
      /^__Host-geops_stage_admin=synthetic-token; Path=\/; HttpOnly; SameSite=Strict; Secure$/,
    );
    const valid = { cookie: '__Host-geops_stage_admin=synthetic-token' };
    assert.equal(
      (await app.inject({ method: 'GET', url: '/v1/admin/auth/me', headers: valid })).statusCode,
      200,
    );
    for (const cookie of [
      'poc_admin=synthetic-token',
      'geops_admin=synthetic-token',
      'geops_stage_admin=synthetic-token',
    ])
      assert.equal(
        (await app.inject({ method: 'GET', url: '/v1/admin/auth/me', headers: { cookie } }))
          .statusCode,
        401,
      );
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: '/v1/admin/auth/sessions/current',
          headers: { ...valid, origin: 'https://foreign.example.test', 'x-csrf-token': 'csrf' },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: '/v1/admin/auth/sessions/current',
          headers: { ...valid, origin, 'x-csrf-token': 'wrong' },
        })
      ).statusCode,
      403,
    );
    const logout = await app.inject({
      method: 'DELETE',
      url: '/v1/admin/auth/sessions/current',
      headers: { ...valid, origin, 'x-csrf-token': 'csrf' },
    });
    assert.equal(logout.statusCode, 204);
    assert.match(
      logout.headers['set-cookie'],
      /^__Host-geops_stage_admin=; Path=\/; HttpOnly; SameSite=Strict; Max-Age=0; Secure$/,
    );
    assert.equal(
      (await app.inject({ method: 'GET', url: '/v1/admin/auth/me', headers: valid })).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});
