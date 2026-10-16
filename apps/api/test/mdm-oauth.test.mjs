import test from 'node:test';
import assert from 'node:assert/strict';
import { CALLBACK_URL, CUSTOMER_SCOPE, DiagnosticSession, INVENTORY_SCOPE,
  configFromValues, pkceChallenge } from '../mdm-oauth-core.mjs';

const fakeValues = {
  MDM_PROVIDER: 'manageengine', MDM_CLIENT_NAME: 'geops',
  MDM_CLIENT_ID: 'EXAMPLE_CLIENT_ID', MDM_CLIENT_SECRET: 'EXAMPLE_SECRET_NOT_REAL',
  MDM_OAUTH_REDIRECT_URI: CALLBACK_URL, MDM_REGION: 'com'
};
const config = configFromValues(fakeValues);
const tokenBody = { access_token: 'EXAMPLE_ACCESS_TOKEN', refresh_token: 'EXAMPLE_REFRESH_TOKEN', expires_in: 3600 };
const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const sessionWith = (fetchImpl, options = {}) => new DiagnosticSession(config, { fetchImpl, ...options });
const connect = async (session, mode = 'inventory') => {
  const flow = session.begin(mode);
  const url = new URL(flow.url);
  await session.complete({ state: url.searchParams.get('state'), code: 'EXAMPLE_CODE', cookie: flow.cookie, location: 'us' });
  return flow;
};

test('faltan credenciales', () => {
  assert.throws(() => configFromValues({ ...fakeValues, MDM_CLIENT_SECRET: '' }), { code: 'credentials_missing' });
});

test('state inválido no intercambia código', async () => {
  let calls = 0;
  const session = sessionWith(async () => { calls++; return ok(tokenBody); });
  const flow = session.begin('inventory');
  await assert.rejects(session.complete({ state: 'otro', code: 'EXAMPLE_CODE', cookie: flow.cookie }), { code: 'invalid_oauth_state' });
  assert.equal(calls, 0);
});

test('PKCE y URL de autorización omiten secreto y tokens', () => {
  const session = sessionWith(async () => ok(tokenBody));
  const flow = session.begin('inventory');
  const url = new URL(flow.url);
  assert.equal(url.origin, 'https://accounts.zoho.com');
  assert.equal(url.searchParams.get('scope'), INVENTORY_SCOPE);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), pkceChallenge(session.pending.verifier));
  assert.equal(url.href.includes(fakeValues.MDM_CLIENT_SECRET), false);
  assert.equal(url.href.includes(tokenBody.access_token), false);
});

test('código vencido devuelve error sanitizado', async () => {
  const session = sessionWith(async () => new Response(JSON.stringify({ error: 'invalid_code', secret: fakeValues.MDM_CLIENT_SECRET }), { status: 400 }));
  const flow = session.begin('inventory');
  const state = new URL(flow.url).searchParams.get('state');
  await assert.rejects(session.complete({ state, code: 'EXPIRED_EXAMPLE_CODE', cookie: flow.cookie }), { code: 'oauth_code_or_grant_rejected' });
  assert.equal(JSON.stringify(session.status()).includes(fakeValues.MDM_CLIENT_SECRET), false);
});

test('token vencido se renueva antes de lectura', async () => {
  const calls = [];
  const session = sessionWith(async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/oauth/v2/token')) return ok({ access_token: 'EXAMPLE_NEW_ACCESS', expires_in: 3600 });
    return ok({ devices: [], metadata: { total_record_count: 0 } });
  }, { now: () => 100000 });
  session.customerId = '12345';
  session.tokens.inventory = { accessToken: 'EXAMPLE_OLD_ACCESS', refreshToken: 'EXAMPLE_REFRESH', expiresAt: 1, scope: INVENTORY_SCOPE };
  const result = await session.listDevices();
  assert.equal(result.http_status, 200);
  assert.equal(result.device_count, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.includes('EXAMPLE_REFRESH'), false);
  assert.equal(calls[1].init.headers['X-CUSTOMER'], '12345');
});

test('scope insuficiente no conserva token', async () => {
  let calls = 0;
  const session = sessionWith(async () => { calls++; return ok({ ...tokenBody, scope: CUSTOMER_SCOPE }); });
  const flow = session.begin('inventory');
  await assert.rejects(session.complete({ state: new URL(flow.url).searchParams.get('state'), code: 'EXAMPLE_CODE', cookie: flow.cookie }), { code: 'scope_insufficient' });
  assert.equal(session.status().inventory_connected, false);
  assert.equal(calls, 2);
});

test('región de tenant incorrecta bloquea intercambio', async () => {
  let calls = 0;
  const session = sessionWith(async () => { calls++; return ok(tokenBody); });
  const flow = session.begin('inventory');
  await assert.rejects(session.complete({ state: new URL(flow.url).searchParams.get('state'), code: 'EXAMPLE_CODE', cookie: flow.cookie, location: 'eu' }), { code: 'tenant_region_mismatch' });
  assert.equal(calls, 0);
});

test('respuesta vacía es éxito autenticado', async () => {
  const session = sessionWith(async (url) => url.includes('/oauth/v2/token') ? ok(tokenBody) : ok({ devices: [], paging: {}, metadata: { total_record_count: 0 } }));
  session.customerId = '12345';
  await connect(session);
  const result = await session.listDevices();
  assert.equal(result.http_status, 200);
  assert.equal(result.device_count, 0);
  assert.equal(result.total_record_count, 0);
});

test('rate limiting conserva Retry-After numérico sanitizado', async () => {
  const session = sessionWith(async () => new Response('EXAMPLE_TOKEN_MUST_NOT_LEAK', { status: 429, headers: { 'retry-after': '12' } }));
  session.customerId = '12345';
  session.tokens.inventory = { accessToken: 'EXAMPLE_ACCESS', refreshToken: null, expiresAt: Date.now() + 60000 };
  await assert.rejects(session.listDevices(), error => error.code === 'mdm_rate_limited' && error.retryAfter === 12 && !JSON.stringify(error).includes('EXAMPLE_TOKEN_MUST_NOT_LEAK'));
});

test('error de conexión se sanitiza', async () => {
  const session = sessionWith(async () => { throw new Error('EXAMPLE_SECRET_NOT_REAL'); });
  session.customerId = '12345';
  session.tokens.inventory = { accessToken: 'EXAMPLE_ACCESS', refreshToken: null, expiresAt: Date.now() + 60000 };
  await assert.rejects(session.listDevices(), error => error.code === 'connection_error' && !error.message.includes(fakeValues.MDM_CLIENT_SECRET));
});

test('403 no revela cuerpo ni token', async () => {
  const session = sessionWith(async () => new Response('EXAMPLE_ACCESS_TOKEN', { status: 403 }));
  session.customerId = '12345';
  session.tokens.inventory = { accessToken: tokenBody.access_token, refreshToken: null, expiresAt: Date.now() + 60000 };
  await assert.rejects(session.listDevices(), error => error.code === 'mdm_forbidden' && !error.message.includes(tokenBody.access_token));
});

test('clientes MSP se listan sin inventar X-CUSTOMER', async () => {
  const calls = [];
  const session = sessionWith(async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/oauth/v2/token')) return ok(tokenBody);
    return ok({ customers: [{ customer_name: 'DEFAULT_CUSTOMER', customer_id: 12345 }] });
  });
  await connect(session, 'customers');
  const result = await session.findDefaultCustomer();
  assert.equal(result.customer_id_available, true);
  assert.equal(session.status().customer_name_verified_by_api, true);
  assert.equal(calls[1].init.headers['X-CUSTOMER'], undefined);
  assert.equal(JSON.stringify(result).includes('12345'), false);
});

test('401 renueva una vez y reintenta sin exponer cuerpo', async () => {
  let deviceCalls = 0;
  const session = sessionWith(async (url, init) => {
    if (url.includes('/oauth/v2/token')) return ok({ access_token: 'EXAMPLE_RENEWED', expires_in: 3600 });
    deviceCalls++;
    if (deviceCalls === 1) return new Response('EXAMPLE_ACCESS_TOKEN', { status: 401 });
    assert.equal(init.headers.authorization, 'Zoho-oauthtoken EXAMPLE_RENEWED');
    return ok({ devices: [], metadata: { total_record_count: 0 } });
  });
  session.customerId = '12345';
  session.tokens.inventory = { accessToken: 'EXAMPLE_ACCESS_TOKEN', refreshToken: 'EXAMPLE_REFRESH_TOKEN', expiresAt: Date.now() + 60000 };
  const result = await session.listDevices();
  assert.equal(result.http_status, 200);
  assert.equal(deviceCalls, 2);
});

test('desconexión revoca refresh token por POST sin incluirlo en URL', async () => {
  const calls = [];
  const session = sessionWith(async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/oauth/v2/token') ? new Response('{"error":"invalid_code"}', { status: 200 }) : new Response('', { status: 200 });
  });
  session.tokens.inventory = { accessToken: 'EXAMPLE_ACCESS_TOKEN', refreshToken: 'EXAMPLE_REFRESH_TOKEN', expiresAt: Date.now() + 60000 };
  const result = await session.disconnect();
  assert.equal(result.remote_refresh_tokens_revoked, 1);
  assert.equal(result.remote_refresh_reuse_rejected, 1);
  assert.equal(session.status().inventory_connected, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.endsWith('/oauth/v2/revoke/token'), true);
  assert.equal(calls[0].url.includes('EXAMPLE_REFRESH_TOKEN'), false);
  assert.equal(calls[0].init.method, 'POST');
});

test('ID MSP grande conserva sus dígitos exactos', async () => {
  const raw = '{"customers":[{"customer_name":"DEFAULT_CUSTOMER","customer_id":9007199254740995}]}';
  const session = sessionWith(async () => new Response(raw, { status: 200 }));
  session.tokens.customers = { accessToken: 'EXAMPLE_ACCESS', refreshToken: null, expiresAt: Date.now() + 60000 };
  await session.findDefaultCustomer();
  assert.equal(session.customerId, '9007199254740995');
});
test('redirección MDM se informa sin seguirla ni filtrar Location', async () => {
  const session = sessionWith(async () => new Response('', { status: 302, headers: { location: 'https://example.invalid/EXAMPLE_ACCESS_TOKEN' } }));
  session.tokens.customers = { accessToken: 'EXAMPLE_ACCESS_TOKEN', refreshToken: null, expiresAt: Date.now() + 60000 };
  await assert.rejects(session.findDefaultCustomer(), error => error.code === 'mdm_redirect' && error.upstreamStatus === 302 && !JSON.stringify(error).includes('example.invalid'));
});

test('Zoho invalid_code con HTTP 200 se trata como grant rechazado', async () => {
  const session = sessionWith(async () => new Response('{"error":"invalid_code"}', { status: 200 }));
  const flow = session.begin('inventory');
  await assert.rejects(session.complete({
    state: new URL(flow.url).searchParams.get('state'), code: 'EXAMPLE_CODE', cookie: flow.cookie
  }), { code: 'oauth_code_or_grant_rejected' });
});

test('X-CUSTOMER conserva un ID largo como string', async () => {
  const localConfig = configFromValues({ ...fakeValues, MDM_CUSTOMER_ID: '9007199254740995' });
  let header;
  const session = new DiagnosticSession(localConfig, { fetchImpl: async (_url, init) => {
    header = init.headers['X-CUSTOMER'];
    return ok({ devices: [] });
  } });
  session.tokens.inventory = { accessToken: 'EXAMPLE_ACCESS', refreshToken: null, expiresAt: Date.now() + 60000 };
  await session.listDevices();
  assert.equal(typeof header, 'string');
  assert.equal(header, '9007199254740995');
});
