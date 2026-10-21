import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { ApiError } from '../src/errors.js';
import type { AdminAuthService } from '../src/admin-auth/service.js';
import type { DeviceRepository } from '../src/device-identity/repository.js';
import type { MdmOAuthRuntime } from '../src/mdm/oauth-runtime.js';

const routes = [
  ['GET', '/v1/admin/mdm/status'],
  ['GET', '/v1/admin/mdm/devices'],
  ['GET', '/v1/admin/mdm/inventory'],
  ['POST', '/v1/admin/mdm/sync'],
  ['PUT', '/v1/admin/devices/00000000-0000-4000-8000-000000000001/mdm-link'],
  ['DELETE', '/v1/admin/devices/00000000-0000-4000-8000-000000000001/mdm-link'],
  ['POST', '/v1/admin/mdm/disconnect'],
] as const;

test('MDM stays disabled across API recreations while GEOPS device routes remain registered', async () => {
  let databaseCalls = 0;
  let oauthCalls = 0;
  const auth = {
    cookieName: 'stage',
    authenticate: async (token: string | undefined) => {
      if (token !== 'synthetic-session') throw new ApiError(401, 'unauthorized', 'Unauthorized');
      return { id: '00000000-0000-4000-8000-000000000001' };
    },
  } as unknown as AdminAuthService;
  const devices = {
    pool: {
      query: async () => {
        databaseCalls++;
        throw new Error('MDM disabled route queried database');
      },
    },
  } as unknown as DeviceRepository;
  const oauth = {
    token: async () => {
      oauthCalls++;
      throw new Error('MDM disabled route renewed OAuth');
    },
    revoke: async () => {
      oauthCalls++;
      throw new Error('MDM disabled route revoked OAuth');
    },
  } as unknown as MdmOAuthRuntime;

  for (let boot = 0; boot < 2; boot++) {
    const app = createApp({
      readinessProbe: async () => true,
      logLevel: 'silent',
      adminAuth: auth,
      devices,
      mdmOAuth: oauth,
    });
    try {
      assert.equal(app.hasRoute({ method: 'GET', url: '/v1/admin/devices' }), true);
      assert.equal(app.hasRoute({ method: 'POST', url: '/v1/admin/devices' }), true);
      for (const [method, url] of routes) {
        const denied = await app.inject({ method, url });
        assert.equal(denied.statusCode, 401, `${method} ${url} without session`);
        const disabled = await app.inject({
          method,
          url,
          headers: { cookie: 'stage=synthetic-session' },
        });
        assert.equal(disabled.statusCode, 503, `${method} ${url}`);
        assert.equal(disabled.json().error.code, 'mdm_disabled');
      }
    } finally {
      await app.close();
    }
  }
  assert.equal(databaseCalls, 0);
  assert.equal(oauthCalls, 0);
});
