// Requires an empty disposable geops_verify_* PostGIS database and synthetic fixtures.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { applyMigrations } from '../src/db/migration-manager.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { MdmWebOAuth } from '../src/mdm/web-oauth.ts';
import { RealMdmGrantStore } from '../src/mdm/real-grants.ts';
import { MdmOAuthRuntime } from '../src/mdm/oauth-runtime.ts';
import { MdmConnectionControl } from '../src/mdm/connection-control.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic PostGIS database required');

const pool = new pg.Pool({ connectionString: url, max: 8 });
try {
  assert.equal((await applyMigrations(pool)).at(-1), '0022_mdm_web_oauth.sql');
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 11),
    csrfKey: Buffer.alloc(32, 12),
    allowedOrigins: ['http://localhost:3501'],
  });
  const adminId = await auth.bootstrap('web-oauth@example.invalid', 'synthetic-password-12345678');
  await pool.query(
    "INSERT INTO geops_operating_tenant(tenant_id,established_by,audit_ref) VALUES('synthetic',$1,$2)",
    [adminId, randomUUID()],
  );
  for (const permission of ['gps.installation.manage', 'gps.tenant.grant'])
    await pool.query(
      'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
      [adminId, permission, 'Synthetic Web OAuth fixture'],
    );
  for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
    await pool.query(
      `INSERT INTO ${table}(admin_id,tenant_id,granted_by,reason) VALUES($1,'synthetic',$1,$2)`,
      [adminId, 'Synthetic Web OAuth fixture'],
    );
  const session = await auth.login(
    'web-oauth@example.invalid',
    'synthetic-password-12345678',
    '192.0.2.10',
    randomUUID(),
  );
  const grants = new RealMdmGrantStore(pool, Buffer.alloc(32, 21), 'com', '12345');
  let refreshes = 0;
  const mockFetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/oauth/v2/token') {
      const body = new URLSearchParams(String(init?.body));
      if (body.get('grant_type') === 'authorization_code') {
        assert.ok(body.get('code_verifier'));
        return Response.json({
          access_token: 'synthetic-access-1',
          refresh_token: 'synthetic-refresh-1',
          expires_in: 3600,
          scope: 'MDMOnDemand.MDMInventory.READ',
        });
      }
      assert.equal(body.get('refresh_token'), 'synthetic-refresh-1');
      refreshes++;
      return Response.json({
        access_token: 'synthetic-access-2',
        refresh_token: 'synthetic-refresh-2',
        expires_in: 3600,
        scope: 'MDMOnDemand.MDMInventory.READ',
      });
    }
    if (path === '/oauth/v2/revoke/token') return Response.json({ status: 'success' });
    assert.equal(new Headers(init?.headers).get('X-CUSTOMER'), '12345');
    return Response.json({ devices: [], paging: {} });
  };
  const browser = new MdmWebOAuth(pool, grants, {
    region: 'com',
    customerId: '12345',
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-secret',
    webOrigin: 'http://localhost:3501',
    grantKey: Buffer.alloc(32, 21),
    fetchImpl: mockFetch,
  });
  const expired = await browser.start(adminId, session.sessionId);
  await pool.query('UPDATE admin_session SET revoked_at=now() WHERE id=$1', [session.sessionId]);
  await assert.rejects(
    browser.complete({
      state: new URL(expired.url).searchParams.get('state'),
      nonce: expired.nonce,
      code: 'synthetic-code',
      location: 'us',
      error: undefined,
      correlationId: randomUUID(),
    }),
    { code: 'mdm_oauth_session_expired' },
  );
  assert.equal(await grants.load(), null);
  const activeSession = await auth.login(
    'web-oauth@example.invalid',
    'synthetic-password-12345678',
    '192.0.2.10',
    randomUUID(),
  );
  const started = await browser.start(adminId, activeSession.sessionId);
  const state = new URL(started.url).searchParams.get('state');
  assert.ok(state);
  await browser.complete({
    state,
    nonce: started.nonce,
    code: 'synthetic-code',
    location: 'us',
    error: undefined,
    correlationId: randomUUID(),
  });
  assert.equal(await grants.load(), 'synthetic-refresh-1');
  await assert.rejects(
    browser.complete({
      state,
      nonce: started.nonce,
      code: 'synthetic-code',
      location: 'us',
      error: undefined,
      correlationId: randomUUID(),
    }),
    { code: 'mdm_oauth_state_invalid' },
  );
  const stored = await pool.query(
    "SELECT encrypted_refresh_token FROM mdm_integration WHERE region='com' AND customer_id='12345'",
  );
  assert.equal(stored.rowCount, 1);
  assert.equal(
    stored.rows[0].encrypted_refresh_token.includes(Buffer.from('synthetic-refresh-1')),
    false,
  );
  const runtime = new MdmOAuthRuntime({
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-secret',
    region: 'com',
    grantStore: grants,
    fetchImpl: mockFetch,
  });
  const control = new MdmConnectionControl(pool, 'com', '12345', () => runtime.refreshGrant());
  assert.equal(await control.isConnected(), true);
  assert.equal(await runtime.token(), 'synthetic-access-2');
  assert.equal(refreshes, 1);
  assert.equal(await grants.load(), 'synthetic-refresh-2');
  const digest = createHash('sha256').update('synthetic-refresh-2').digest();
  const row = await pool.query(
    "SELECT credential_digest FROM mdm_connection_control WHERE region='com' AND customer_id='12345'",
  );
  assert.equal(row.rows[0].credential_digest.equals(digest), true);
  assert.equal(await control.isConnected(), true);
  assert.equal(
    (await pool.query("SELECT count(*) AS n FROM audit_event WHERE action='mdm.oauth.connect'"))
      .rows[0].n,
    '1',
  );
  assert.equal(await control.disconnect(adminId, randomUUID(), () => runtime.revoke()), true);
  await runtime.removePersistedGrant();
  assert.equal(await grants.load(), null);
  assert.equal(await control.isConnected(), false);
  const restarted = await browser.start(adminId, activeSession.sessionId);
  const newState = new URL(restarted.url).searchParams.get('state');
  assert.ok(newState);
  await browser.complete({
    state: newState,
    nonce: restarted.nonce,
    code: 'synthetic-new-code',
    location: 'us',
    error: undefined,
    correlationId: randomUUID(),
  });
  assert.equal(await control.isConnected(), true);
  await grants.remove(); // A delayed cleanup from the previous disconnect cannot delete the new grant.
  assert.equal(await grants.load(), 'synthetic-refresh-1');
} finally {
  await pool.end();
}
