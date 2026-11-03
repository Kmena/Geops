// W1-A verification requires a fresh disposable synthetic geops_verify_* database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { applyMigrations, checkReadiness } from '../src/db/migration-manager.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { CatalogService } from '../src/catalog/service.ts';
import { createApp } from '../src/app.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Fresh disposable synthetic geops_verify_* DB required');
const pool = new pg.Pool({ connectionString: url, max: 5 });
let app;
try {
  assert.equal(
    (await pool.query("SELECT to_regclass('geops_schema_migrations') AS t")).rows[0].t,
    null,
  );
  const applied = await applyMigrations(pool);
  assert.equal(applied.at(-1), '0020_catalog_integrity.sql');
  assert.equal(await checkReadiness(pool), true);
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 71),
    csrfKey: Buffer.alloc(32, 72),
    allowedOrigins: ['https://geops.example.invalid'],
  });
  const actor = await auth.bootstrap('catalog@example.invalid', 'synthetic-password-12345678');
  const session = await auth.login(
    'catalog@example.invalid',
    'synthetic-password-12345678',
    '192.0.2.4',
    randomUUID(),
  );
  const catalog = new CatalogService(pool);
  app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    catalog,
  });
  const base = '/v1/admin/catalog';
  const headers = {
    cookie: auth.cookieName + '=' + session.token,
    origin: 'https://geops.example.invalid',
    'x-csrf-token': session.csrfToken,
  };
  const call = async (method, path, payload, extraHeaders = {}) => {
    const response = await app.inject({
      method,
      url: base + path,
      headers: { ...headers, ...extraHeaders },
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: response.statusCode, body: response.json(), etag: response.headers.etag };
  };
  const reason = 'Synthetic W1-A review';
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM admin_permission WHERE permission LIKE 'catalog.%'",
      )
    ).rows[0].n,
    0,
  );
  assert.equal((await call('GET', '/customers')).status, 403);
  assert.equal((await call('POST', '/customers', { name: 'Denied', reason })).status, 403);
  for (const capability of ['catalog.import.read', 'catalog.import.write']) {
    await pool.query(
      'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
      [actor, capability, reason],
    );
  }
  const source = await call('POST', '/sources', {
    kind: 'KMZ_GEO',
    namespace: 'synthetic-kmz',
    label: 'Synthetic geometry',
    reason,
  });
  assert.equal(source.status, 201);
  assert.equal(source.body.authority, 'PENDING');
  assert.equal(
    (
      await call('POST', '/sources', {
        kind: 'KMZ_GEO',
        namespace: 'invalid',
        label: 'Invalid',
        authority: 'AUTHORIZED',
        reason,
      })
    ).status,
    422,
  );
  const customer = await call('POST', '/customers', { name: 'Candidate customer', reason });
  assert.equal(customer.status, 201);
  assert.equal(customer.body.identity_status, 'CANDIDATE');
  const establishment = await call('POST', '/establishments', {
    name: 'Synthetic branch',
    longitude: -84.09,
    latitude: 9.93,
    source_id: source.body.id,
    source_key: 'feature-1',
    reason,
  });
  assert.equal(establishment.status, 201);
  assert.equal(establishment.body.longitude, -84.09);
  assert.equal(
    (
      await call('POST', '/establishments', {
        name: 'Duplicate external reference',
        source_id: source.body.id,
        source_key: 'feature-1',
        reason,
      })
    ).status,
    409,
  );
  const badPoint = await call('POST', '/establishments', {
    name: 'Invalid coordinate',
    longitude: 181,
    latitude: 9.9,
    reason,
  });
  assert.equal(badPoint.status, 422);
  const pin = await call('POST', '/pins', {
    establishment_id: establishment.body.id,
    longitude: -84.09,
    latitude: 9.93,
    reason,
  });
  assert.equal(pin.status, 201);
  const duplicatePin = await call('POST', '/pins', {
    establishment_id: establishment.body.id,
    longitude: -84.1,
    latitude: 9.94,
    reason,
  });
  assert.equal(duplicatePin.status, 409);
  const route = await call('POST', '/routes', { name: 'Synthetic draft route', reason });
  assert.equal(route.status, 201);
  assert.equal(route.body.state, 'DRAFT');
  const invalidLink = await call('POST', '/routes/' + route.body.id + '/stops', {
    label: 'Unapproved link',
    customer_id: customer.body.id,
    establishment_id: establishment.body.id,
    reason,
  });
  assert.equal(invalidLink.status, 422);
  const link = await call(
    'POST',
    '/establishments/' + establishment.body.id + '/customers',
    { customer_id: customer.body.id, reason },
    { 'if-match': establishment.etag },
  );
  assert.equal(link.status, 201);
  assert.equal(
    (await call('GET', '/establishments/' + establishment.body.id + '/customers')).body.items
      .length,
    1,
  );
  const stop = await call('POST', '/routes/' + route.body.id + '/stops', {
    label: 'Candidate stop',
    customer_id: customer.body.id,
    establishment_id: establishment.body.id,
    pin_id: pin.body.id,
    longitude: -84.09,
    latitude: 9.93,
    stop_order: 1,
    reason,
  });
  assert.equal(stop.status, 201);
  assert.equal(stop.body.state, 'CANDIDATE');
  const stale = await call(
    'PATCH',
    '/customers/' + customer.body.id,
    { changes: { name: 'Updated' }, reason },
    { 'if-match': '"catalog:customers:wrong:1"' },
  );
  assert.equal(stale.status, 409);
  const updated = await call(
    'PATCH',
    '/customers/' + customer.body.id,
    { changes: { name: 'Updated' }, reason },
    { 'if-match': customer.etag },
  );
  assert.equal(updated.status, 200);
  assert.equal(updated.body.version, '2');
  const racing = await Promise.all([
    call(
      'PATCH',
      '/customers/' + customer.body.id,
      { changes: { name: 'Editor one' }, reason },
      { 'if-match': updated.etag },
    ),
    call(
      'PATCH',
      '/customers/' + customer.body.id,
      { changes: { name: 'Editor two' }, reason },
      { 'if-match': updated.etag },
    ),
  ]);
  assert.deepEqual(racing.map((result) => result.status).sort(), [200, 409]);
  const group = await call('POST', '/groups', { name: 'Synthetic group', reason });
  assert.equal(group.status, 201);
  const member = await call(
    'POST',
    '/groups/' + group.body.id + '/members/' + establishment.body.id,
    { reason },
    { 'if-match': group.etag },
  );
  assert.equal(member.status, 201);
  assert.equal((await call('GET', '/groups/' + group.body.id + '/members')).body.items.length, 1);
  assert.equal(
    (
      await call(
        'DELETE',
        '/establishments/' + establishment.body.id + '/customers/' + customer.body.id,
        { reason },
        { 'if-match': link.etag },
      )
    ).status,
    409,
  );
  assert.equal((await call('GET', '/routes/' + route.body.id + '/stops')).body.items.length, 1);
  assert.equal(
    (await pool.query('SELECT state FROM catalog_route WHERE id=$1', [route.body.id])).rows[0]
      .state,
    'DRAFT',
  );
  assert.equal(
    (await pool.query('SELECT state FROM catalog_route_version WHERE route_id=$1', [route.body.id]))
      .rows[0].state,
    'DRAFT',
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM audit_event WHERE action LIKE $1', [
        'catalog.%',
      ])
    ).rows[0].n > 5,
    true,
  );
  const audit = await pool.query(
    "SELECT previous_state,next_state FROM audit_event WHERE action='catalog.change.detail' AND metadata_redacted->>'resource_id'=$1 ORDER BY occurred_at DESC LIMIT 1",
    [customer.body.id],
  );
  assert.equal(audit.rows.length, 1);
  assert.equal(JSON.parse(audit.rows[0].previous_state).id, customer.body.id);
  assert.equal(JSON.parse(audit.rows[0].next_state).id, customer.body.id);
  assert.equal(
    (await pool.query('SELECT version FROM catalog_revision')).rows[0].version > 0,
    true,
  );
  assert.equal((await call('GET', '/revision')).status, 200);
  await assert.rejects(
    pool.query("UPDATE catalog_route SET state='ACTIVE' WHERE id=$1", [route.body.id]),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    pool.query("UPDATE catalog_route_stop SET state='CONFIRMED' WHERE id=$1", [stop.body.id]),
    (error) => error.code === '23514',
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO catalog_customer(id,name,identity_status,source_id,source_authority,external_customer_id,created_by) VALUES($1,$2,'VERIFIED',$3,'AUTHORIZED',$4,$5)",
      [randomUUID(), 'Unauthorized identity', source.body.id, 'kmz-code', actor],
    ),
    (error) => error.code === '23503',
  );
  await pool.query(
    "UPDATE admin_permission SET revoked_at=now() WHERE admin_id=$1 AND permission='catalog.import.write'",
    [actor],
  );
  assert.equal((await call('GET', '/customers')).status, 200);
  assert.equal((await call('POST', '/customers', { name: 'Read only', reason })).status, 403);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM admin_permission WHERE permission='catalog.import.confirm'",
      )
    ).rows[0].n,
    0,
  );
  console.log(
    'W1-A clean migration, permissions, draft-only CRUD, constraints, links, CAS race, audit: PASS',
  );
} finally {
  await app?.close();
  await pool.end();
}
