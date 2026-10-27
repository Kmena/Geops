// Mocked provider only; never calls the public service during tests.
import assert from 'node:assert/strict';
import pg from 'pg';
import { GeocodingSearchService } from '../src/geocoding-search.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { createApp } from '../src/app.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic PostGIS required');
const pool = new pg.Pool({ connectionString: url, max: 4 });
const origin = 'https://geops.example.invalid';
let checks = 0;
const check = (condition, label) => {
  assert.ok(condition, label);
  checks++;
};
let app;
try {
  await pool.query('DELETE FROM geocoding_cache');
  await pool.query('DELETE FROM geocoding_actor_bucket');
  await pool.query("UPDATE geocoding_provider_slot SET next_allowed_at='-infinity'");
  const owner = (
    await pool.query("SELECT id FROM admin_user WHERE email_normalized='owner@example.invalid'")
  ).rows[0].id;
  const requested = [];
  const mock = async (input, init) => {
    requested.push({ url: String(input), init });
    return new Response(
      JSON.stringify([
        {
          osm_type: 'node',
          osm_id: 1,
          display_name: 'San Carlos, Guatemala',
          lat: '14.63',
          lon: '-90.51',
        },
        {
          osm_type: 'way',
          osm_id: 2,
          display_name: 'San Carlos Norte',
          lat: '14.64',
          lon: '-90.52',
        },
        { osm_type: 'node', osm_id: 3, display_name: 'Invalid', lat: '999', lon: '2' },
      ]),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const service = new GeocodingSearchService(pool, mock);
  await assert.rejects(service.search(owner, ' '), (error) => error.statusCode === 422);
  checks++;
  const first = await service.search(owner, 'San Carlos');
  check(
    first.items.length === 2 && first.items[0].latitude === 14.63,
    'multiple sanitized results',
  );
  check(
    requested.length === 1 &&
      requested[0].url.startsWith('https://nominatim.openstreetmap.org/search?'),
    'fixed OpenStreetMap provider URL',
  );
  check(requested[0].init.headers['User-Agent'].startsWith('GEOPS-'), 'identifying User-Agent');
  const cached = await service.search(owner, '  san   carlos  ');
  check(
    cached.items.length === 2 && requested.length === 1,
    'normalized query cache avoids extra egress',
  );
  const cache = await pool.query('SELECT query_sha256,results FROM geocoding_cache');
  check(
    cache.rows.length === 1 && Buffer.isBuffer(cache.rows[0].query_sha256),
    'cache stores hash, not raw address',
  );
  await assert.rejects(service.search(owner, 'Another place'), (error) => error.statusCode === 429);
  checks++;
  await pool.query("UPDATE geocoding_provider_slot SET next_allowed_at='-infinity'");
  const empty = new GeocodingSearchService(pool, async () => new Response('[]', { status: 200 }));
  check((await empty.search(owner, 'Unknown place')).items.length === 0, 'no-results response');
  await pool.query("UPDATE geocoding_provider_slot SET next_allowed_at='-infinity'");
  const unavailable = new GeocodingSearchService(pool, async () => {
    throw Error('offline');
  });
  await assert.rejects(
    unavailable.search(owner, 'Network outage'),
    (error) => error.statusCode === 503,
  );
  checks++;
  await pool.query("UPDATE geocoding_provider_slot SET next_allowed_at='-infinity'");
  const rateLimited = new GeocodingSearchService(
    pool,
    async () => new Response('', { status: 429 }),
  );
  await assert.rejects(
    rateLimited.search(owner, 'Provider limit'),
    (error) => error.statusCode === 429,
  );
  checks++;
  await pool.query("UPDATE geocoding_provider_slot SET next_allowed_at='-infinity'");
  const oversized = new GeocodingSearchService(
    pool,
    async () => new Response('x'.repeat(128_001), { status: 200 }),
  );
  await assert.rejects(
    oversized.search(owner, 'Oversized provider'),
    (error) => error.statusCode === 503,
  );
  checks++;
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 11),
    csrfKey: Buffer.alloc(32, 12),
    allowedOrigins: [origin],
  });
  app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    geocoding: service,
    secureCookie: false,
  });
  const anonymous = await app.inject({
    method: 'GET',
    url: '/v1/admin/geocoding/search?q=San%20Carlos',
  });
  check(anonymous.statusCode === 401, 'authentication required');
  const login = await app.inject({
    method: 'POST',
    url: '/v1/admin/auth/sessions',
    headers: { origin },
    payload: { email: 'owner@example.invalid', password: 'synthetic-password-12345678' },
  });
  check(login.statusCode === 200, 'admin login');
  const authorized = await app.inject({
    method: 'GET',
    url: '/v1/admin/geocoding/search?q=San%20Carlos',
    headers: { origin, cookie: login.headers['set-cookie'].split(';')[0] },
  });
  check(
    authorized.statusCode === 200 && authorized.json().items.length === 2,
    'authorized cached search',
  );
  console.log(`post-B30 geocoding integration: ${checks} checks passed (mock provider)`);
} finally {
  await app?.close();
  await pool.end();
}
