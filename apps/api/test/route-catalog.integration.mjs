// Run after client-catalog.integration.mjs against a fresh disposable geops_verify_* database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { ClientCatalogService } from '../src/client-catalog.ts';
import { RouteCatalogService } from '../src/route-catalog.ts';
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
let app;
try {
  await applyMigrations(pool);
  check(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM geops_schema_migrations WHERE version='0025_route_catalog.sql'",
      )
    ).rows[0].n === 1,
    'route migration applied',
  );
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 11),
    csrfKey: Buffer.alloc(32, 12),
    allowedOrigins: [origin],
  });
  app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    clientCatalog: new ClientCatalogService(pool, { max_radius_m: 500, max_dwell_s: 3600 }),
    routeCatalog: new RouteCatalogService(pool, { max_radius_m: 500, max_dwell_s: 3600 }),
    secureCookie: false,
  });
  const login = async (email) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/sessions',
      headers: { origin },
      payload: { email, password: 'synthetic-password-12345678' },
    });
    status(response, 200, `login ${email}`);
    return {
      cookie: response.headers['set-cookie'].split(';')[0],
      csrf: response.json().csrf_token,
    };
  };
  const ownerSession = await login('owner@example.invalid');
  const readerSession = await login('outsider@example.invalid');
  const call = (session, method, path, payload, headers = {}) =>
    app.inject({
      method,
      url: path,
      headers: { origin, cookie: session.cookie, 'x-csrf-token': session.csrf, ...headers },
      ...(payload === undefined ? {} : { payload }),
    });
  const mutate = (session, method, path, payload, headers = {}) =>
    call(session, method, path, payload, { 'idempotency-key': randomUUID(), ...headers });
  status(await call(readerSession, 'GET', '/v1/admin/routes'), 200, 'reader can list routes');
  status(
    await mutate(readerSession, 'POST', '/v1/admin/routes', { code: 'R01', name: 'Ruta' }),
    403,
    'reader cannot create route',
  );
  status(
    await mutate(ownerSession, 'POST', '/v1/admin/routes', {
      code: 'R01',
      name: 'Ruta',
      tenant_id: 'other',
    }),
    422,
    'tenant spoof rejected',
  );
  status(
    await mutate(ownerSession, 'POST', '/v1/admin/routes', { code: '?', name: 'Ruta' }),
    422,
    'invalid route code',
  );
  const created = await mutate(ownerSession, 'POST', '/v1/admin/routes', {
    code: 'R01',
    name: 'Ruta norte',
    description: 'Síntesis',
  });
  status(created, 201, 'create route');
  const routeId = created.json().id;
  check(created.headers.etag === '"1"' && created.json().has_draft, 'initial draft and ETag');
  status(
    await mutate(ownerSession, 'POST', '/v1/admin/routes', { code: 'R01', name: 'Repetida' }),
    409,
    'duplicate code',
  );
  const list = await call(ownerSession, 'GET', '/v1/admin/routes?q=R01&state=ACTIVE&limit=1');
  status(list, 200, 'filtered list');
  check(
    list.json().items.some((item) => item.id === routeId),
    'route listed',
  );
  status(await call(ownerSession, 'GET', `/v1/admin/routes/${routeId}`), 200, 'get route');
  status(
    await mutate(
      ownerSession,
      'POST',
      `/v1/admin/routes/${routeId}/publish`,
      {},
      { 'if-match': '"1"' },
    ),
    422,
    'empty route cannot publish',
  );
  status(
    await mutate(ownerSession, 'PUT', `/v1/admin/routes/${routeId}/draft/stops`, { stops: [] }),
    428,
    'missing ETag',
  );
  status(
    await mutate(
      ownerSession,
      'PUT',
      `/v1/admin/routes/${routeId}/draft/stops`,
      { stops: [] },
      { 'if-match': '"0"' },
    ),
    412,
    'stale ETag',
  );
  status(
    await mutate(
      ownerSession,
      'PUT',
      `/v1/admin/routes/${routeId}/draft/stops`,
      { stops: [{ site_id: randomUUID(), geofence_revision: 1, required: true }] },
      { 'if-match': '"1"' },
    ),
    422,
    'missing site rejected',
  );
  const client = await mutate(ownerSession, 'POST', '/v1/admin/clients', {
    code: 'RCLIENT',
    name: 'Cliente rutas',
    address: 'Sintética',
    site: {
      code: 'MAIN',
      name: 'Principal',
      address: 'Sintética',
      latitude: 14.63,
      longitude: -90.51,
    },
  });
  status(client, 201, 'create synthetic client');
  const clientId = client.json().id,
    siteA = client.json().site_id;
  const site = await mutate(ownerSession, 'POST', `/v1/admin/clients/${clientId}/sites`, {
    code: 'BRANCH',
    name: 'Sucursal',
    address: 'Sintética',
    latitude: 14.65,
    longitude: -90.53,
  });
  status(site, 201, 'second site same client');
  const siteB = site.json().id;
  const zoneBody = (latitude, longitude) => ({
    latitude,
    longitude,
    radius_m: 100,
    min_dwell_s: 600,
    state: 'ACTIVE',
    reason: 'Synthetic route verification',
  });
  status(
    await mutate(
      ownerSession,
      'POST',
      `/v1/admin/clients/${clientId}/sites/${siteA}/geofences`,
      zoneBody(14.63, -90.51),
      { 'if-match': '"0"' },
    ),
    201,
    'site A zone',
  );
  status(
    await mutate(
      ownerSession,
      'POST',
      `/v1/admin/clients/${clientId}/sites/${siteB}/geofences`,
      zoneBody(14.65, -90.53),
      { 'if-match': '"0"' },
    ),
    201,
    'site B zone',
  );
  const stopA = {
    stop_id: randomUUID(),
    site_id: siteA,
    geofence_revision: 1,
    required: true,
    suggested_order: 2,
    min_dwell_s: null,
  };
  const stopB = {
    stop_id: randomUUID(),
    site_id: siteB,
    geofence_revision: 1,
    required: false,
    suggested_order: 1,
    min_dwell_s: 900,
  };
  status(
    await mutate(
      ownerSession,
      'PUT',
      `/v1/admin/routes/${routeId}/draft/stops`,
      { stops: [stopA, stopA] },
      { 'if-match': '"1"' },
    ),
    422,
    'duplicate site rejected',
  );
  status(
    await mutate(
      ownerSession,
      'PUT',
      `/v1/admin/routes/${routeId}/draft/stops`,
      { stops: [{ ...stopA, min_dwell_s: 3601 }] },
      { 'if-match': '"1"' },
    ),
    422,
    'invalid dwell rejected',
  );
  const saved = await mutate(
    ownerSession,
    'PUT',
    `/v1/admin/routes/${routeId}/draft/stops`,
    { stops: [stopA, stopB] },
    { 'if-match': '"1"' },
  );
  status(saved, 200, 'save two sites in draft');
  check(
    saved.json().stops.length === 2 && saved.json().stops[0].site_id === siteB,
    'visual order only',
  );
  check(
    saved.json().stops.find((stop) => stop.site_id === siteA).min_dwell_effective_s === 600,
    'zone dwell inherited',
  );
  check(
    saved.json().stops.find((stop) => stop.site_id === siteB).min_dwell_effective_s === 900,
    'route dwell override wins',
  );
  const published = await mutate(
    ownerSession,
    'POST',
    `/v1/admin/routes/${routeId}/publish`,
    {},
    { 'if-match': '"2"' },
  );
  status(published, 200, 'publish first revision');
  check(published.json().revision === 1 && !published.json().has_draft, 'published revision one');
  const firstRevision = await call(ownerSession, 'GET', `/v1/admin/routes/${routeId}/revisions/1`);
  status(firstRevision, 200, 'read exact first revision');
  check(
    firstRevision.json().stops.length === 2 && firstRevision.json().stops[0].site_id === siteB,
    'two sites preserved in revision',
  );
  check(
    firstRevision.json().stops.find((stop) => stop.site_id === siteA).latitude === 14.63,
    'published geofence center snapshot',
  );
  await assert.rejects(
    pool.query('UPDATE route_revision SET name=$1 WHERE route_id=$2 AND revision=1', [
      'tampered',
      routeId,
    ]),
    /immutable/,
  );
  checks++;
  await assert.rejects(
    pool.query('UPDATE route_stop_revision SET radius_m=1 WHERE route_id=$1 AND revision=1', [
      routeId,
    ]),
    /immutable/,
  );
  checks++;
  check(
    (
      await pool.query('SELECT sealed FROM route_revision WHERE route_id=$1 AND revision=1', [
        routeId,
      ])
    ).rows[0].sealed,
    'published revision sealed',
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO route_stop_revision(tenant_id,route_id,revision,stop_id,client_id,site_id,geofence_revision,required,
      suggested_order,min_dwell_override_s,min_dwell_effective_s,client_code,client_name,site_code,site_name,latitude,longitude,radius_m)
      SELECT tenant_id,route_id,revision,$1,client_id,site_id,geofence_revision,required,suggested_order,
      min_dwell_override_s,min_dwell_effective_s,client_code,client_name,site_code,site_name,latitude,longitude,radius_m
      FROM route_stop_revision WHERE route_id=$2 AND revision=1 LIMIT 1`,
      [randomUUID(), routeId],
    ),
    /immutable/,
  );
  checks++;
  status(
    await mutate(
      ownerSession,
      'POST',
      `/v1/admin/routes/${routeId}/publish`,
      {},
      { 'if-match': '"3"' },
    ),
    409,
    'cannot republish without draft',
  );
  const zone2 = await mutate(
    ownerSession,
    'POST',
    `/v1/admin/clients/${clientId}/sites/${siteA}/geofences`,
    zoneBody(14.631, -90.511),
    { 'if-match': '"1"' },
  );
  status(zone2, 201, 'new geofence revision');
  const historic = await call(ownerSession, 'GET', `/v1/admin/routes/${routeId}/revisions/1`);
  check(
    historic.json().stops.find((stop) => stop.site_id === siteA).latitude === 14.63,
    'historic snapshot survives zone edit',
  );
  const edited = await mutate(
    ownerSession,
    'PATCH',
    `/v1/admin/routes/${routeId}`,
    { name: 'Ruta norte editada' },
    { 'if-match': '"3"' },
  );
  status(edited, 200, 'edit published opens draft');
  check(
    edited.json().has_draft && edited.json().published_revision === 1,
    'stable identity with new draft',
  );
  status(
    await mutate(
      ownerSession,
      'POST',
      `/v1/admin/routes/${routeId}/publish`,
      {},
      { 'if-match': '"4"' },
    ),
    409,
    'stale geofence blocks publish',
  );
  const revisedStops = [
    { ...stopA, geofence_revision: 2, suggested_order: 1 },
    { ...stopB, suggested_order: 2, required: true, min_dwell_s: 1200 },
  ];
  const resaved = await mutate(
    ownerSession,
    'PUT',
    `/v1/admin/routes/${routeId}/draft/stops`,
    { stops: revisedStops },
    { 'if-match': '"4"' },
  );
  status(resaved, 200, 'replace draft stops and order');
  const secondPublished = await mutate(
    ownerSession,
    'POST',
    `/v1/admin/routes/${routeId}/publish`,
    {},
    { 'if-match': '"5"' },
  );
  status(secondPublished, 200, 'publish second revision');
  check(secondPublished.json().revision === 2, 'revision increments');
  const revisions = await call(
    ownerSession,
    'GET',
    `/v1/admin/routes/${routeId}/revisions?limit=1`,
  );
  status(revisions, 200, 'revisions paginated');
  check(
    revisions.json().items.length === 1 && Boolean(revisions.json().next_cursor),
    'revision cursor',
  );
  check(
    (
      await call(
        ownerSession,
        'GET',
        `/v1/admin/routes/${routeId}/revisions?limit=1&cursor=${encodeURIComponent(revisions.json().next_cursor)}`,
      )
    ).json().items[0].revision === 1,
    'older revision available',
  );
  check(
    (await call(ownerSession, 'GET', `/v1/admin/routes/${routeId}/revisions/1`))
      .json()
      .stops.find((stop) => stop.site_id === siteA).geofence_revision === 1,
    'exact old version retained',
  );
  const reused = await mutate(ownerSession, 'POST', '/v1/admin/routes', {
    code: 'R02',
    name: 'Otra ruta',
  });
  status(reused, 201, 'create reusable second route');
  status(
    await mutate(
      ownerSession,
      'PUT',
      `/v1/admin/routes/${reused.json().id}/draft/stops`,
      { stops: [{ ...stopA, stop_id: randomUUID(), geofence_revision: 2 }] },
      { 'if-match': '"1"' },
    ),
    200,
    'same site in multiple routes',
  );
  const deactivated = await mutate(
    ownerSession,
    'POST',
    `/v1/admin/routes/${routeId}/deactivate`,
    {},
    { 'if-match': '"6"' },
  );
  status(deactivated, 200, 'deactivate route');
  check(
    (await call(ownerSession, 'GET', `/v1/admin/routes/${routeId}/revisions/1`)).statusCode === 200,
    'deactivation keeps history',
  );
  status(
    await mutate(
      ownerSession,
      'PUT',
      `/v1/admin/routes/${routeId}/draft/stops`,
      { stops: [] },
      { 'if-match': '"7"' },
    ),
    409,
    'inactive route cannot edit',
  );
  status(
    await mutate(
      ownerSession,
      'POST',
      `/v1/admin/routes/${routeId}/activate`,
      {},
      { 'if-match': '"7"' },
    ),
    200,
    'reactivate route',
  );
  const replayKey = randomUUID();
  const replayPath = `/v1/admin/routes/${reused.json().id}/deactivate`;
  const replay = await call(
    ownerSession,
    'POST',
    replayPath,
    {},
    { 'idempotency-key': replayKey, 'if-match': '"2"' },
  );
  status(replay, 200, 'first idempotent mutation');
  status(
    await call(
      ownerSession,
      'POST',
      replayPath,
      {},
      { 'idempotency-key': replayKey, 'if-match': '"2"' },
    ),
    200,
    'exact replay',
  );
  const createKey = randomUUID();
  const thirdRoute = await call(
    ownerSession,
    'POST',
    '/v1/admin/routes',
    { code: 'R03', name: 'Idempotente' },
    { 'idempotency-key': createKey },
  );
  status(thirdRoute, 201, 'idempotent create');
  const optionalDraft = await mutate(
    ownerSession,
    'PUT',
    `/v1/admin/routes/${thirdRoute.json().id}/draft/stops`,
    { stops: [{ ...stopA, stop_id: randomUUID(), geofence_revision: 2, required: false }] },
    { 'if-match': '"1"' },
  );
  status(optionalDraft, 200, 'optional-only draft allowed');
  status(
    await mutate(
      ownerSession,
      'POST',
      `/v1/admin/routes/${thirdRoute.json().id}/publish`,
      {},
      { 'if-match': '"2"' },
    ),
    422,
    'optional-only route cannot publish',
  );
  const removed = await mutate(
    ownerSession,
    'PUT',
    `/v1/admin/routes/${thirdRoute.json().id}/draft/stops`,
    { stops: [] },
    { 'if-match': '"2"' },
  );
  status(removed, 200, 'remove stop from draft');
  check(removed.json().stops.length === 0, 'draft removal persisted');
  const inactiveClient = await mutate(ownerSession, 'POST', '/v1/admin/clients', {
    code: 'RINACT',
    name: 'Cliente inactivo',
    address: 'Sintética',
    site: {
      code: 'MAIN',
      name: 'Sede inactiva',
      address: 'Sintética',
      latitude: 14.66,
      longitude: -90.54,
    },
  });
  status(inactiveClient, 201, 'inactive reference fixture created');
  const inactiveClientId = inactiveClient.json().id;
  const inactiveSiteId = inactiveClient.json().site_id;
  status(
    await mutate(
      ownerSession,
      'POST',
      `/v1/admin/clients/${inactiveClientId}/sites/${inactiveSiteId}/geofences`,
      zoneBody(14.66, -90.54),
      { 'if-match': '"0"' },
    ),
    201,
    'inactive fixture zone',
  );
  status(
    await mutate(
      ownerSession,
      'POST',
      `/v1/admin/clients/${inactiveClientId}/deactivate`,
      {},
      { 'if-match': '"1"' },
    ),
    200,
    'fixture client deactivated',
  );
  status(
    await mutate(
      ownerSession,
      'PUT',
      `/v1/admin/routes/${thirdRoute.json().id}/draft/stops`,
      { stops: [{ site_id: inactiveSiteId, geofence_revision: 1, required: true }] },
      { 'if-match': '"3"' },
    ),
    422,
    'inactive client rejected',
  );
  const inactiveZoneClient = await mutate(ownerSession, 'POST', '/v1/admin/clients', {
    code: 'RZONE',
    name: 'Zona inactiva',
    address: 'Sintética',
    site: {
      code: 'MAIN',
      name: 'Sede zona',
      address: 'Sintética',
      latitude: 14.67,
      longitude: -90.55,
    },
  });
  status(inactiveZoneClient, 201, 'inactive zone fixture created');
  const zoneClientId = inactiveZoneClient.json().id;
  const zoneSiteId = inactiveZoneClient.json().site_id;
  status(
    await mutate(
      ownerSession,
      'POST',
      `/v1/admin/clients/${zoneClientId}/sites/${zoneSiteId}/geofences`,
      zoneBody(14.67, -90.55),
      { 'if-match': '"0"' },
    ),
    201,
    'zone fixture active revision',
  );
  status(
    await mutate(
      ownerSession,
      'POST',
      `/v1/admin/clients/${zoneClientId}/sites/${zoneSiteId}/geofences`,
      { ...zoneBody(14.67, -90.55), state: 'INACTIVE' },
      { 'if-match': '"1"' },
    ),
    201,
    'zone fixture inactive revision',
  );
  status(
    await mutate(
      ownerSession,
      'PUT',
      `/v1/admin/routes/${thirdRoute.json().id}/draft/stops`,
      { stops: [{ site_id: zoneSiteId, geofence_revision: 2, required: true }] },
      { 'if-match': '"3"' },
    ),
    422,
    'inactive geofence rejected',
  );
  status(
    await call(
      ownerSession,
      'POST',
      '/v1/admin/routes',
      { code: 'R04', name: 'Distinto' },
      { 'idempotency-key': createKey },
    ),
    409,
    'idempotency payload conflict',
  );
  const noCsrf = await app.inject({
    method: 'POST',
    url: '/v1/admin/routes',
    headers: { origin, cookie: ownerSession.cookie, 'idempotency-key': randomUUID() },
    payload: { code: 'BAD', name: 'Bad' },
  });
  status(noCsrf, 403, 'CSRF required');
  status(
    await call(ownerSession, 'GET', `/v1/admin/routes/${randomUUID()}`),
    404,
    'unknown route hidden',
  );
  check(
    (await pool.query("SELECT count(*)::int AS n FROM audit_event WHERE action LIKE 'route.%'"))
      .rows[0].n >= 9,
    'route mutations audited',
  );
  check(
    (
      await pool.query('SELECT count(*)::int AS n FROM route_template WHERE tenant_id=$1', [
        'synthetic',
      ])
    ).rows[0].n === 3,
    'routes remain tenant scoped',
  );
  await assert.rejects(
    pool.query(
      'INSERT INTO route_draft_stop(tenant_id,route_id,stop_id,client_id,site_id,geofence_revision,required) VALUES($1,$2,$3,$4,$5,1,true)',
      ['other', thirdRoute.json().id, randomUUID(), clientId, siteA],
    ),
    (error) => error.code === '23503',
  );
  checks++;
  console.log(`route catalog integration: ${checks} checks passed`);
} finally {
  await app?.close();
  await pool.end();
}
