// Run only against a fresh disposable geops_verify_* PostGIS database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { ClientCatalogService } from '../src/client-catalog.ts';
import { applyMigrations } from '../src/db/migration-manager.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic DB required');
const pool = new pg.Pool({ connectionString: url, max: 5 });
const origin = 'https://geops.example.invalid';
let checks = 0;
const check = (condition, label) => {
  assert.ok(condition, label);
  checks++;
};
const status = (response, expected, label) =>
  check(response.statusCode === expected, `${label}: ${response.statusCode} ${response.body}`);
const clientInput = (code) => ({
  code,
  name: `Cliente ${code}`,
  address: 'Dirección sintética',
  site: {
    code: 'MAIN',
    name: 'Sede principal',
    address: 'Dirección sintética',
    latitude: 14.63,
    longitude: -90.51,
  },
});
let app;
try {
  const applied = await applyMigrations(pool);
  check(applied.includes('0024_client_geofences.sql'), 'new migration applied');
  check(
    (await pool.query('SELECT PostGIS_Version() AS v')).rows[0].v.length > 0,
    'PostGIS enabled',
  );
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 11),
    csrfKey: Buffer.alloc(32, 12),
    allowedOrigins: [origin],
  });
  const owner = await auth.bootstrap('owner@example.invalid', 'synthetic-password-12345678');
  const outsider = randomUUID();
  await pool.query(
    "INSERT INTO admin_user(id,email_normalized,password_hash,state) SELECT $1,'outsider@example.invalid',password_hash,'ACTIVE' FROM admin_user WHERE id=$2",
    [outsider, owner],
  );
  await pool.query(
    'INSERT INTO geops_operating_tenant(tenant_id,established_by,audit_ref) VALUES($1,$2,$3)',
    ['synthetic', owner, randomUUID()],
  );
  await pool.query(
    'INSERT INTO gps_data_tenant_access(admin_id,tenant_id,granted_by,reason) VALUES($1,$2,$3,$4)',
    [owner, 'synthetic', owner, 'Synthetic catalog verification'],
  );
  for (const permission of ['visit.catalog.read', 'visit.catalog.write'])
    await pool.query(
      'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$3,$4)',
      [owner, permission, owner, 'Synthetic catalog verification'],
    );
  app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    clientCatalog: new ClientCatalogService(pool, { max_radius_m: 500, max_dwell_s: 3600 }),
    secureCookie: false,
  });
  const login = async (email) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/sessions',
      headers: { origin },
      payload: { email, password: 'synthetic-password-12345678' },
    });
    status(response, 200, 'login');
    return {
      cookie: response.headers['set-cookie'].split(';')[0],
      csrf: response.json().csrf_token,
    };
  };
  const ownerSession = await login('owner@example.invalid');
  const outsiderSession = await login('outsider@example.invalid');
  const call = (session, method, path, payload, extra = {}) =>
    app.inject({
      method,
      url: path,
      headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrf, ...extra },
      ...(payload === undefined ? {} : { payload }),
    });
  const mutate = (session, method, path, payload, extra = {}) =>
    call(session, method, path, payload, { 'idempotency-key': randomUUID(), ...extra });
  status(await call(outsiderSession, 'GET', '/v1/admin/clients'), 403, 'ungranted read denied');
  status(
    await mutate(outsiderSession, 'POST', '/v1/admin/clients', clientInput('A01')),
    403,
    'ungranted write denied',
  );
  await pool.query(
    'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$3,$4)',
    [outsider, 'visit.catalog.read', owner, 'Synthetic read-only verification'],
  );
  status(
    await call(outsiderSession, 'GET', '/v1/admin/clients'),
    403,
    'capability without tenant denied',
  );
  await pool.query(
    'INSERT INTO gps_data_tenant_access(admin_id,tenant_id,granted_by,reason) VALUES($1,$2,$3,$4)',
    [outsider, 'synthetic', owner, 'Synthetic read-only verification'],
  );
  status(await call(outsiderSession, 'GET', '/v1/admin/clients'), 200, 'read-only access granted');
  status(
    await mutate(outsiderSession, 'POST', '/v1/admin/clients', clientInput('A01')),
    403,
    'read-only write denied',
  );
  const rights = await call(ownerSession, 'GET', '/v1/admin/client-capabilities');
  status(rights, 200, 'capabilities');
  check(rights.json().limits.max_radius_m === 500, 'configurable limits exposed');
  const invalidCoordinate = await mutate(ownerSession, 'POST', '/v1/admin/clients', {
    ...clientInput('A01'),
    site: { ...clientInput('A01').site, latitude: 91 },
  });
  status(invalidCoordinate, 422, 'invalid latitude');
  const created = await mutate(ownerSession, 'POST', '/v1/admin/clients', clientInput('A01'));
  status(created, 201, 'create client and site');
  const clientId = created.json().id,
    siteId = created.json().site_id;
  check(
    created.json().latitude === 14.63 && created.json().longitude === -90.51,
    'site coordinates returned',
  );
  status(
    await mutate(ownerSession, 'POST', '/v1/admin/clients', {
      ...clientInput('X01'),
      tenant_id: 'other',
    }),
    422,
    'forged tenant rejected',
  );
  status(
    await mutate(ownerSession, 'POST', '/v1/admin/clients', clientInput('A01')),
    409,
    'duplicate client code',
  );
  const listed = await call(ownerSession, 'GET', '/v1/admin/clients?q=A01&state=ACTIVE');
  status(listed, 200, 'search and filter');
  check(listed.json().items.length === 1, 'search returns client');
  const detail = await call(ownerSession, 'GET', `/v1/admin/clients/${clientId}`);
  status(detail, 200, 'get client');
  check(detail.headers.etag === '"1"', 'client ETag');
  status(
    await mutate(ownerSession, 'PATCH', `/v1/admin/clients/${clientId}`, { name: 'Actualizado' }),
    428,
    'missing precondition',
  );
  status(
    await mutate(
      ownerSession,
      'PATCH',
      `/v1/admin/clients/${clientId}`,
      { name: 'Actualizado' },
      { 'if-match': '"0"' },
    ),
    412,
    'stale precondition',
  );
  const updated = await mutate(
    ownerSession,
    'PATCH',
    `/v1/admin/clients/${clientId}`,
    { name: 'Actualizado' },
    { 'if-match': '"1"' },
  );
  status(updated, 200, 'update client');
  check(updated.json().version === 2, 'client version increment');
  const second = await mutate(ownerSession, 'POST', `/v1/admin/clients/${clientId}/sites`, {
    code: 'BRANCH',
    name: 'Sucursal',
    address: 'Dirección sintética',
    latitude: 14.64,
    longitude: -90.52,
  });
  status(second, 201, 'second site');
  status(
    await mutate(ownerSession, 'POST', `/v1/admin/clients/${clientId}/sites`, {
      code: 'BRANCH',
      name: 'Duplicada',
      address: 'Dirección sintética',
      latitude: 14.64,
      longitude: -90.52,
    }),
    409,
    'duplicate site code',
  );
  check(
    (await call(ownerSession, 'GET', `/v1/admin/clients/${clientId}/sites`)).json().items.length ===
      2,
    'many sites',
  );
  const firstSitePage = await call(
    ownerSession,
    'GET',
    `/v1/admin/clients/${clientId}/sites?limit=1`,
  );
  status(firstSitePage, 200, 'site page');
  check(
    firstSitePage.json().items.length === 1 && Boolean(firstSitePage.json().next_cursor),
    'site cursor',
  );
  const nextSitePage = await call(
    ownerSession,
    'GET',
    `/v1/admin/clients/${clientId}/sites?limit=1&cursor=${encodeURIComponent(firstSitePage.json().next_cursor)}`,
  );
  check(
    nextSitePage.json().items.length === 1 &&
      nextSitePage.json().items[0].id !== firstSitePage.json().items[0].id,
    'next site page',
  );
  const zone = {
    latitude: 14.63,
    longitude: -90.51,
    radius_m: 125,
    min_dwell_s: 600,
    state: 'ACTIVE',
    reason: 'Synthetic zone creation',
  };
  status(
    await mutate(
      ownerSession,
      'POST',
      `/v1/admin/clients/${clientId}/sites/${siteId}/geofences`,
      { ...zone, radius_m: 0 },
      { 'if-match': '"0"' },
    ),
    422,
    'zero radius',
  );
  status(
    await mutate(
      ownerSession,
      'POST',
      `/v1/admin/clients/${clientId}/sites/${siteId}/geofences`,
      { ...zone, radius_m: -1 },
      { 'if-match': '"0"' },
    ),
    422,
    'negative radius',
  );
  status(
    await mutate(
      ownerSession,
      'POST',
      `/v1/admin/clients/${clientId}/sites/${siteId}/geofences`,
      { ...zone, radius_m: 501 },
      { 'if-match': '"0"' },
    ),
    422,
    'configured radius limit',
  );
  status(
    await mutate(
      ownerSession,
      'POST',
      `/v1/admin/clients/${clientId}/sites/${siteId}/geofences`,
      { ...zone, min_dwell_s: 0 },
      { 'if-match': '"0"' },
    ),
    422,
    'invalid dwell',
  );
  status(
    await mutate(
      ownerSession,
      'POST',
      `/v1/admin/clients/${clientId}/sites/${siteId}/geofences`,
      { ...zone, min_dwell_s: 3601 },
      { 'if-match': '"0"' },
    ),
    422,
    'configured dwell limit',
  );
  const zonePath = `/v1/admin/clients/${clientId}/sites/${siteId}/geofences`;
  const key = randomUUID();
  const first = await call(ownerSession, 'POST', zonePath, zone, {
    'idempotency-key': key,
    'if-match': '"0"',
  });
  status(first, 201, 'publish geofence');
  check(first.json().revision === 1 && first.json().radius_m === 125, 'zone persisted');
  const replay = await call(ownerSession, 'POST', zonePath, zone, {
    'idempotency-key': key,
    'if-match': '"0"',
  });
  status(replay, 201, 'idempotent replay');
  check(replay.headers.etag === '"1"', 'replay preserves ETag');
  status(
    await call(
      ownerSession,
      'POST',
      zonePath,
      { ...zone, radius_m: 130 },
      { 'idempotency-key': key, 'if-match': '"0"' },
    ),
    409,
    'idempotency conflict',
  );
  const revision = await mutate(
    ownerSession,
    'POST',
    zonePath,
    { ...zone, radius_m: 200, min_dwell_s: 900, reason: 'Synthetic radius adjustment' },
    { 'if-match': '"1"' },
  );
  status(revision, 201, 'new revision');
  check(revision.json().revision === 2, 'revision increment');
  const history = await call(ownerSession, 'GET', zonePath);
  check(
    history.json().items.length === 2 &&
      history.json().items[0].radius_m === 200 &&
      history.json().items[1].radius_m === 125,
    'immutable history',
  );
  const firstZonePage = await call(ownerSession, 'GET', `${zonePath}?limit=1`);
  status(firstZonePage, 200, 'geofence page');
  check(
    firstZonePage.json().items[0].revision === 2 && Boolean(firstZonePage.json().next_cursor),
    'geofence cursor',
  );
  const nextZonePage = await call(
    ownerSession,
    'GET',
    `${zonePath}?limit=1&cursor=${encodeURIComponent(firstZonePage.json().next_cursor)}`,
  );
  check(nextZonePage.json().items[0].revision === 1, 'older geofence page');
  status(await call(ownerSession, 'GET', `${zonePath}?limit=101`), 422, 'nested list bound');
  status(
    await mutate(
      ownerSession,
      'POST',
      zonePath,
      { ...zone, state: 'INACTIVE', reason: 'Synthetic deactivation' },
      { 'if-match': '"2"' },
    ),
    201,
    'deactivate geofence',
  );
  check(
    (await call(ownerSession, 'GET', zonePath)).json().items[0].state === 'INACTIVE',
    'zone inactive',
  );
  const meters = await pool.query(
    'SELECT ST_Distance(center, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography) AS meters FROM client_geofence_revision WHERE site_id=$3 AND revision=1',
    [-90.51, 14.63, siteId],
  );
  check(Number(meters.rows[0].meters) < 1, 'PostGIS center uses meters');
  status(
    await mutate(
      ownerSession,
      'POST',
      `/v1/admin/clients/${clientId}/deactivate`,
      {},
      { 'if-match': '"2"' },
    ),
    200,
    'deactivate client',
  );
  check(
    (await call(ownerSession, 'GET', `/v1/admin/clients/${clientId}`)).json().state === 'INACTIVE',
    'client inactive',
  );
  const deniedCsrf = await app.inject({
    method: 'POST',
    url: '/v1/admin/clients',
    headers: { origin, cookie: ownerSession.cookie, 'idempotency-key': randomUUID() },
    payload: clientInput('B02'),
  });
  status(deniedCsrf, 403, 'CSRF denied');
  const audit = await pool.query(
    "SELECT count(*)::int AS n FROM audit_event WHERE action LIKE 'client.%'",
  );
  check(audit.rows[0].n >= 6, 'mutation audit recorded');
  const crossTenant = await pool.query('SELECT count(*)::int AS n FROM client WHERE tenant_id=$1', [
    'other',
  ]);
  check(crossTenant.rows[0].n === 0, 'tenant fixed by server');
  await assert.rejects(
    pool.query(
      'INSERT INTO client(id,tenant_id,code,name,address,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6)',
      [randomUUID(), 'other', 'OTHER', 'Foreign', 'Synthetic', owner],
    ),
    (error) => error.code === '23503',
  );
  checks++;
  await assert.rejects(
    pool.query('UPDATE client_geofence_revision SET radius_m=10 WHERE site_id=$1 AND revision=1', [
      siteId,
    ]),
    /immutable/,
  );
  checks++;
  console.log(`client catalog integration: ${checks} checks passed`);
} finally {
  await app?.close();
  await pool.end();
}
