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
import { MdmTenantRuntime } from '../src/mdm/tenant-runtime.ts';
import { MdmOAuthClientStore } from '../src/mdm/oauth-client-store.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic PostGIS database required');

const pool = new pg.Pool({ connectionString: url, max: 8 });
try {
  assert.equal((await applyMigrations(pool)).at(-1), '0023_mdm_oauth_client.sql');
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
  for (const permission of ['gps.installation.manage', 'gps.tenant.grant', 'mdm.oauth.configure'])
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
  const clientStore = new MdmOAuthClientStore(pool, Buffer.alloc(32, 21), 'com', undefined,
    'http://localhost:3501');
  assert.deepEqual(await clientStore.status(), {
    configured: false, source: 'none', region: 'com',
  });
  await clientStore.save(adminId, randomUUID(), 'synthetic-config-id', 'synthetic-config-secret');
  await assert.rejects(
    clientStore.save(adminId, randomUUID(), 'too-fast-id', 'too-fast-secret'),
    { code: 'mdm_oauth_config_rate_limited' },
  );
  await assert.rejects(
    clientStore.save(randomUUID(), randomUUID(), 'unauthorized-id', 'unauthorized-secret'),
    { code: 'mdm_oauth_config_forbidden' },
  );
  const sealed = await pool.query('SELECT ciphertext,iv,tag FROM mdm_oauth_client_config');
  assert.equal(sealed.rowCount, 1);
  assert.equal(sealed.rows[0].ciphertext.includes(Buffer.from('synthetic-config-secret')), false);
  assert.equal(sealed.rows[0].iv.length, 12);
  assert.equal(sealed.rows[0].tag.length, 16);
  const reloadedStore = new MdmOAuthClientStore(pool, Buffer.alloc(32, 21), 'com');
  assert.equal((await reloadedStore.load()).clientId, 'synthetic-config-id');
  assert.deepEqual(await reloadedStore.status(), {
    configured: true, source: 'admin', region: 'com',
  });
  const oldGeneration = (await clientStore.load()).generation;
  await pool.query("UPDATE mdm_oauth_config_rate SET next_allowed_at=now()-interval '1 second'");
  await clientStore.save(adminId, randomUUID(), 'synthetic-new-id', 'synthetic-new-secret');
  await assert.rejects(clientStore.assertGeneration(pool, oldGeneration), {
    code: 'mdm_oauth_config_changed',
  });
  assert.equal((await reloadedStore.load()).clientId, 'synthetic-new-id');
  const grants = new RealMdmGrantStore(pool, Buffer.alloc(32, 21), 'com', '12345');
  let refreshes = 0;
  let customerMode = 'one';
  let insufficientScope = false;
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
          scope: insufficientScope
            ? 'MDMOnDemand.MDMInventory.READ'
            : 'MDMOnDemand.MDMInventory.READ,MDMOnDemand.MDMAdmin.READ',
        });
      }
      assert.ok(['synthetic-refresh-1', 'synthetic-refresh-2'].includes(body.get('refresh_token')));
      refreshes++;
      return Response.json({
        access_token: 'synthetic-access-2',
        refresh_token: 'synthetic-refresh-2',
        expires_in: 3600,
        scope: 'MDMOnDemand.MDMInventory.READ',
      });
    }
    if (path === '/oauth/v2/revoke/token') return Response.json({ status: 'success' });
    if (path === '/customers')
      return Response.json({
        customers:
          customerMode === 'none'
            ? []
            : customerMode === 'multi'
              ? [
                  { customer_id: '12345', customer_name: 'Synthetic MSP' },
                  { customer_id: '67890', customer_name: 'Other synthetic tenant' },
                ]
              : [{ customer_id: '12345', customer_name: 'Synthetic MSP' }],
      });
    assert.equal(new Headers(init?.headers).get('X-CUSTOMER'), '12345');
    return Response.json({ devices: [], paging: {} });
  };
  const configured = await reloadedStore.load();
  const configuredOAuth = new MdmWebOAuth(pool, {
    region: 'com', clientId: configured.clientId, clientSecret: configured.clientSecret,
    clientGeneration: configured.generation, clientStore: reloadedStore,
    webOrigin: 'http://localhost:3501', grantKey: Buffer.alloc(32, 21), fetchImpl: mockFetch,
  });
  const configuredStart = await configuredOAuth.start(adminId, session.sessionId);
  assert.equal(new URL(configuredStart.url).searchParams.get('client_id'), 'synthetic-new-id');
  await pool.query('DELETE FROM mdm_oauth_pending');
  const staleOAuth = new MdmWebOAuth(pool, {
    region: 'com', clientId: 'synthetic-config-id', clientSecret: 'synthetic-config-secret',
    clientGeneration: oldGeneration, clientStore: reloadedStore,
    webOrigin: 'http://localhost:3501', grantKey: Buffer.alloc(32, 21), fetchImpl: mockFetch,
  });
  await assert.rejects(staleOAuth.start(adminId, session.sessionId), {
    code: 'mdm_oauth_config_changed',
  });
  const browser = new MdmWebOAuth(pool, {
    region: 'com',
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
  await pool.query("UPDATE mdm_oauth_config_rate SET next_allowed_at=now()-interval '1 second'");
  await assert.rejects(
    clientStore.save(adminId, randomUUID(), 'bad-replacement', 'bad-replacement'),
    { code: 'mdm_disconnect_required' },
  );
  assert.equal(await runtime.token(), 'synthetic-access-2');
  assert.equal(refreshes, 1);
  assert.equal(await grants.load(), 'synthetic-refresh-2');
  const digest = createHash('sha256').update('synthetic-refresh-2').digest();
  const row = await pool.query(
    "SELECT credential_digest FROM mdm_connection_control WHERE region='com' AND customer_id='12345'",
  );
  assert.equal(row.rows[0].credential_digest.equals(digest), true);
  assert.equal(await control.isConnected(), true);
  const tenantRuntime = new MdmTenantRuntime(pool, {
    region: 'com',
    clientId: 'synthetic-client',
    clientSecret: 'synthetic-secret',
    grantKey: Buffer.alloc(32, 21),
    fetchImpl: mockFetch,
  });
  const tenantStatus = await tenantRuntime.status();
  assert.equal(tenantStatus.authorized, true);
  assert.equal(tenantStatus.customer_id, '12345');
  assert.equal(tenantStatus.customer_name, 'Synthetic MSP');
  assert.equal(tenantStatus.edition_evidence, 'UNVERIFIED');
  assert.deepEqual((await tenantRuntime.devices(undefined, 1)).items, []);
  assert.equal(
    (await pool.query("SELECT count(*) AS n FROM audit_event WHERE action='mdm.oauth.connect'"))
      .rows[0].n,
    '1',
  );
  assert.equal(await control.disconnect(adminId, randomUUID(), () => runtime.revoke()), true);
  await runtime.removePersistedGrant();
  assert.equal(await grants.load(), null);
  assert.equal(await control.isConnected(), false);
  customerMode = 'none';
  const empty = await browser.start(adminId, activeSession.sessionId);
  await assert.rejects(
    browser.complete({
      state: new URL(empty.url).searchParams.get('state'),
      nonce: empty.nonce,
      code: 'synthetic-code',
      location: 'us',
      error: undefined,
      correlationId: randomUUID(),
    }),
    { code: 'mdm_no_authorized_customer' },
  );
  assert.equal(await grants.load(), null);
  insufficientScope = true;
  const insufficient = await browser.start(adminId, activeSession.sessionId);
  await assert.rejects(
    browser.complete({
      state: new URL(insufficient.url).searchParams.get('state'),
      nonce: insufficient.nonce,
      code: 'synthetic-code',
      location: 'us',
      error: undefined,
      correlationId: randomUUID(),
    }),
    { code: 'mdm_oauth_scope_insufficient' },
  );
  insufficientScope = false;
  customerMode = 'multi';
  const unauthorized = await browser.start(adminId, activeSession.sessionId);
  const unauthorizedChoice = await browser.complete({
    state: new URL(unauthorized.url).searchParams.get('state'),
    nonce: unauthorized.nonce,
    code: 'synthetic-code',
    location: 'us',
    error: undefined,
    correlationId: randomUUID(),
  });
  assert.equal(unauthorizedChoice.kind, 'selection');
  await assert.rejects(
    browser.choose(
      unauthorizedChoice.selectionToken,
      '99999',
      adminId,
      activeSession.sessionId,
      randomUUID(),
    ),
    { code: 'mdm_customer_forbidden' },
  );
  assert.equal(await grants.load(), null);
  const restarted = await browser.start(adminId, activeSession.sessionId);
  const newState = new URL(restarted.url).searchParams.get('state');
  assert.ok(newState);
  const pendingChoice = await browser.complete({
    state: newState,
    nonce: restarted.nonce,
    code: 'synthetic-new-code',
    location: 'us',
    error: undefined,
    correlationId: randomUUID(),
  });
  assert.equal(pendingChoice.kind, 'selection');
  assert.equal(await grants.load(), null);
  const selectionToken = pendingChoice.selectionToken;
  assert.deepEqual(
    (await browser.customers(selectionToken, adminId, activeSession.sessionId)).map(
      (row) => row.customer_id,
    ),
    ['12345', '67890'],
  );
  await browser.choose(selectionToken, '12345', adminId, activeSession.sessionId, randomUUID());
  assert.equal(await control.isConnected(), true);
  await assert.rejects(
    browser.choose(selectionToken, '67890', adminId, activeSession.sessionId, randomUUID()),
    { code: 'mdm_selection_expired' },
  );
  await grants.remove(); // A delayed cleanup from the previous disconnect cannot delete the new grant.
  assert.equal(await grants.load(), 'synthetic-refresh-2');
} finally {
  await pool.end();
}
