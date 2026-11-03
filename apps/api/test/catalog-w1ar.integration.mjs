// W1-A-R regression in a fresh disposable synthetic geops_verify_* database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { applyMigrations, checkReadiness } from '../src/db/migration-manager.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { AdminUserAdministrationService } from '../src/admin-auth/user-administration.ts';
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
  assert.equal((await applyMigrations(pool)).at(-1), '0020_catalog_integrity.sql');
  assert.equal(await checkReadiness(pool), true);
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 91),
    csrfKey: Buffer.alloc(32, 92),
    allowedOrigins: ['https://geops.example.invalid'],
  });
  const actor = await auth.bootstrap('w1ar@example.invalid', 'synthetic-password-12345678');
  const session = await auth.login(
    'w1ar@example.invalid',
    'synthetic-password-12345678',
    '192.0.2.19',
    randomUUID(),
  );
  app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    catalog: new CatalogService(pool),
  });
  const headers = {
    cookie: auth.cookieName + '=' + session.token,
    origin: 'https://geops.example.invalid',
    'x-csrf-token': session.csrfToken,
  };
  const reason = 'Synthetic W1-A-R correction';
  const call = async (method, path, payload, extraHeaders = {}) => {
    const response = await app.inject({
      method,
      url: '/v1/admin/catalog' + path,
      headers: { ...headers, ...extraHeaders },
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: response.statusCode, body: response.json(), etag: response.headers.etag };
  };
  const create = async (resource, payload) => {
    const result = await call('POST', '/' + resource, { ...payload, reason });
    assert.equal(result.status, 201, resource + ' create');
    return result;
  };
  assert.equal((await call('GET', '/customers', undefined, { cookie: '' })).status, 401);
  assert.equal((await call('GET', '/customers')).status, 403);
  assert.equal((await call('POST', '/customers', { name: 'Denied', reason })).status, 403);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM admin_permission WHERE permission LIKE 'catalog.%'",
      )
    ).rows[0].n,
    0,
  );
  for (const permission of ['catalog.import.read', 'catalog.import.write'])
    await pool.query(
      'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
      [actor, permission, reason],
    );
  const source = await create('sources', {
    kind: 'KMZ_GEO',
    namespace: 'w1ar-synthetic',
    label: 'Synthetic source',
  });
  const customer = await create('customers', { name: 'Synthetic customer' });
  const establishment = await create('establishments', {
    name: 'Synthetic establishment',
    longitude: -84.09,
    latitude: 9.93,
    source_id: source.body.id,
    source_key: 'feature-one',
  });
  const pin = await create('pins', {
    establishment_id: establishment.body.id,
    longitude: -84.09,
    latitude: 9.93,
  });
  const route = await create('routes', { name: 'Synthetic draft route' });
  assert.equal(route.body.state, 'DRAFT');

  // H-03: both sides, actor, reason and DB time survive unlink and relink.
  const linked = await call(
    'POST',
    '/establishments/' + establishment.body.id + '/customers',
    { customer_id: customer.body.id, reason },
    { 'if-match': establishment.etag },
  );
  assert.equal(linked.status, 201);
  const linkHistory = await pool.query(
    "SELECT actor_id,occurred_at,previous_state,next_state FROM audit_event WHERE action='catalog.customer.link.history' ORDER BY occurred_at",
  );
  assert.equal(linkHistory.rows.length, 1);
  const createdState = JSON.parse(linkHistory.rows[0].next_state);
  assert.equal(createdState.customer_id, customer.body.id);
  assert.equal(createdState.establishment_id, establishment.body.id);
  assert.equal(createdState.approved_by, actor);
  assert.equal(createdState.reason, reason);
  assert.ok(createdState.linked_at);
  assert.equal(linkHistory.rows[0].actor_id, actor);
  const unlinked = await call(
    'DELETE',
    '/establishments/' + establishment.body.id + '/customers/' + customer.body.id,
    { reason },
    { 'if-match': linked.etag },
  );
  assert.equal(unlinked.status, 200);
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM catalog_customer_establishment WHERE customer_id=$1 AND establishment_id=$2',
        [customer.body.id, establishment.body.id],
      )
    ).rows[0].n,
    0,
  );
  const unlinkHistory = await pool.query(
    "SELECT actor_id,occurred_at,previous_state,next_state FROM audit_event WHERE action='catalog.customer.unlink.history'",
  );
  assert.equal(unlinkHistory.rows.length, 1);
  assert.equal(JSON.parse(unlinkHistory.rows[0].previous_state).linked_at, createdState.linked_at);
  assert.equal(JSON.parse(unlinkHistory.rows[0].next_state).unlinked_by, actor);
  assert.equal(JSON.parse(unlinkHistory.rows[0].next_state).reason, reason);
  assert.ok(JSON.parse(unlinkHistory.rows[0].next_state).unlinked_at);
  const relink = await Promise.all([
    call(
      'POST',
      '/establishments/' + establishment.body.id + '/customers',
      { customer_id: customer.body.id, reason },
      { 'if-match': unlinked.etag },
    ),
    call(
      'POST',
      '/establishments/' + establishment.body.id + '/customers',
      { customer_id: customer.body.id, reason },
      { 'if-match': unlinked.etag },
    ),
  ]);
  assert.deepEqual(relink.map((item) => item.status).sort(), [201, 409]);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE action='catalog.customer.link.history'",
      )
    ).rows[0].n,
    2,
  );

  // H-02: active targets work; archived customer, establishment, pin and source do not.
  const goodStop = await call('POST', '/routes/' + route.body.id + '/stops', {
    label: 'Candidate stop',
    customer_id: customer.body.id,
    establishment_id: establishment.body.id,
    pin_id: pin.body.id,
    longitude: -84.09,
    latitude: 9.93,
    reason,
  });
  assert.equal(goodStop.status, 201);
  assert.equal(
    (await call('GET', '/routes/' + route.body.id + '/stops/' + goodStop.body.id)).status,
    200,
  );
  const unlinkedStop = await call('POST', '/routes/' + route.body.id + '/stops', {
    label: 'Unlinked candidate',
    reason,
  });
  assert.equal(unlinkedStop.status, 201);
  assert.equal(unlinkedStop.body.state, 'CANDIDATE');
  assert.equal(unlinkedStop.body.customer_id, null);
  assert.equal(
    (
      await call(
        'DELETE',
        '/routes/' + route.body.id + '/stops/' + unlinkedStop.body.id,
        { reason },
        { 'if-match': unlinkedStop.etag },
      )
    ).status,
    200,
  );
  assert.equal(
    (await call('GET', '/routes/' + route.body.id + '/stops/' + unlinkedStop.body.id)).status,
    404,
  );
  const oldEstablishment = await create('establishments', { name: 'Archive before use' });
  assert.equal(
    (
      await call(
        'DELETE',
        '/establishments/' + oldEstablishment.body.id,
        { reason },
        { 'if-match': oldEstablishment.etag },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call('POST', '/pins', {
        establishment_id: oldEstablishment.body.id,
        longitude: -84,
        latitude: 10,
        reason,
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await call('POST', '/routes/' + route.body.id + '/stops', {
        label: 'Archived branch',
        establishment_id: oldEstablishment.body.id,
        reason,
      })
    ).status,
    422,
  );
  const oldCustomer = await create('customers', { name: 'Archive before stop' });
  assert.equal(
    (
      await call(
        'DELETE',
        '/customers/' + oldCustomer.body.id,
        { reason },
        { 'if-match': oldCustomer.etag },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call('POST', '/routes/' + route.body.id + '/stops', {
        label: 'Archived customer',
        customer_id: oldCustomer.body.id,
        reason,
      })
    ).status,
    422,
  );
  const pinEstablishment = await create('establishments', { name: 'Pin branch' });
  const oldPin = await create('pins', {
    establishment_id: pinEstablishment.body.id,
    longitude: -84,
    latitude: 10,
  });
  assert.equal(
    (await call('DELETE', '/pins/' + oldPin.body.id, { reason }, { 'if-match': oldPin.etag }))
      .status,
    200,
  );
  assert.equal(
    (
      await call('POST', '/routes/' + route.body.id + '/stops', {
        label: 'Archived pin',
        establishment_id: pinEstablishment.body.id,
        pin_id: oldPin.body.id,
        reason,
      })
    ).status,
    422,
  );
  const oldSource = await create('sources', {
    kind: 'MANUAL',
    namespace: 'w1ar-retired',
    label: 'Retired source',
  });
  assert.equal(
    (
      await call(
        'DELETE',
        '/sources/' + oldSource.body.id,
        { reason },
        { 'if-match': oldSource.etag },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call('POST', '/establishments', {
        name: 'Archived source branch',
        source_id: oldSource.body.id,
        source_key: 'old',
        reason,
      })
    ).status,
    422,
  );
  for (let n = 0; n < 3; n++) {
    const target = await create('establishments', { name: 'Race branch ' + n });
    const results = await Promise.all([
      call('DELETE', '/establishments/' + target.body.id, { reason }, { 'if-match': target.etag }),
      call('POST', '/routes/' + route.body.id + '/stops', {
        label: 'Race stop ' + n,
        establishment_id: target.body.id,
        reason,
      }),
    ]);
    assert.ok(
      (results[0].status === 200 && results[1].status === 422) ||
        (results[0].status === 409 && results[1].status === 201),
    );
    const invalid = await pool.query(
      'SELECT count(*)::int AS n FROM catalog_route_stop s JOIN catalog_establishment e ON e.id=s.establishment_id WHERE e.id=$1 AND e.archived_at IS NOT NULL',
      [target.body.id],
    );
    assert.equal(invalid.rows[0].n, 0);
  }

  // M-01/M-02: historical group membership, selective updates, pagination and CSRF.
  const group = await create('groups', { name: 'Historical group' });
  const member = await call(
    'POST',
    '/groups/' + group.body.id + '/members/' + establishment.body.id,
    { reason },
    { 'if-match': group.etag },
  );
  assert.equal(member.status, 201);
  const removed = await call(
    'DELETE',
    '/groups/' + group.body.id + '/members/' + establishment.body.id,
    { reason },
    { 'if-match': member.etag },
  );
  assert.equal(removed.status, 200);
  assert.equal(
    (await call('DELETE', '/groups/' + group.body.id, { reason }, { 'if-match': removed.etag }))
      .status,
    200,
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM catalog_territory_member WHERE group_id=$1 AND valid_until IS NOT NULL',
        [group.body.id],
      )
    ).rows[0].n,
    1,
  );
  const currentEstablishment = await call('GET', '/establishments/' + establishment.body.id);
  const editedEstablishment = await call(
    'PATCH',
    '/establishments/' + establishment.body.id,
    { changes: { name: 'Renamed branch' }, reason },
    { 'if-match': currentEstablishment.etag },
  );
  assert.equal(editedEstablishment.status, 200);
  assert.equal(editedEstablishment.body.longitude, -84.09);
  assert.equal(editedEstablishment.body.source_key, 'feature-one');
  const editedStop = await call(
    'PATCH',
    '/routes/' + route.body.id + '/stops/' + goodStop.body.id,
    { changes: { label: 'Renamed stop' }, reason },
    { 'if-match': goodStop.etag },
  );
  assert.equal(editedStop.status, 200);
  assert.equal(editedStop.body.customer_id, customer.body.id);
  assert.equal(editedStop.body.pin_id, pin.body.id);
  assert.equal(editedStop.body.longitude, -84.09);
  await create('customers', { name: 'Second active customer' });
  const page1 = await call('GET', '/customers?limit=1');
  assert.equal(page1.status, 200);
  assert.equal(page1.body.items.length, 1);
  assert.ok(page1.body.next_cursor);
  const page2 = await call('GET', '/customers?limit=1&cursor=' + page1.body.next_cursor);
  assert.equal(page2.status, 200);
  assert.notEqual(page2.body.items[0].id, page1.body.items[0].id);
  assert.equal((await call('GET', '/customers/' + randomUUID())).status, 404);
  assert.equal(
    (
      await call(
        'POST',
        '/customers',
        { name: 'Wrong origin', reason },
        { origin: 'https://attacker.invalid' },
      )
    ).status,
    403,
  );
  assert.equal(
    (await call('POST', '/customers', { name: 'Wrong csrf', reason }, { 'x-csrf-token': 'wrong' }))
      .status,
    403,
  );
  const stale = await call(
    'PATCH',
    '/establishments/' + establishment.body.id,
    { changes: { name: 'Stale' }, reason },
    { 'if-match': currentEstablishment.etag },
  );
  assert.equal(stale.status, 409);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE action='catalog.access.denied' AND metadata_redacted->>'reason_code'='version_conflict'",
      )
    ).rows[0].n > 0,
    true,
  );

  // A success-audit failure must roll back the catalog write.
  await pool.query(
    "CREATE FUNCTION catalog_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'catalog.%' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$",
  );
  await pool.query(
    'CREATE TRIGGER catalog_test_audit_failure BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION catalog_test_audit_failure()',
  );
  const beforeRollback = (await pool.query('SELECT count(*)::int AS n FROM catalog_customer'))
    .rows[0].n;
  assert.equal((await call('POST', '/customers', { name: 'Must roll back', reason })).status, 500);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM catalog_customer')).rows[0].n,
    beforeRollback,
  );
  await pool.query('DROP TRIGGER catalog_test_audit_failure ON audit_event');
  await pool.query('DROP FUNCTION catalog_test_audit_failure()');

  // H-01: permission denial is durable after releasing transaction clients.
  await pool.query(
    "UPDATE admin_permission SET revoked_at=now() WHERE admin_id=$1 AND permission='catalog.import.write' AND revoked_at IS NULL",
    [actor],
  );
  const smallPool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 600 });
  try {
    const service = new CatalogService(smallPool);
    const ids = Array.from({ length: 8 }, () => randomUUID());
    const denied = await Promise.all(
      ids.map((requestId, n) =>
        service.create('customers', { name: 'Denied ' + n, reason }, actor, requestId).then(
          () => 201,
          (error) => error.statusCode,
        ),
      ),
    );
    assert.deepEqual(denied, Array(8).fill(403));
    const recorded = await pool.query(
      "SELECT correlation_id,metadata_redacted FROM audit_event WHERE action='catalog.access.denied' AND correlation_id=ANY($1::uuid[])",
      [ids],
    );
    assert.equal(recorded.rows.length, 8);
    for (const row of recorded.rows) {
      assert.equal(row.metadata_redacted.company_scope, 'SINGLE_COMPANY');
      assert.equal(row.metadata_redacted.operation, 'customers.create');
      assert.equal(row.metadata_redacted.resource, 'customers');
      assert.equal(row.metadata_redacted.reason_code, 'catalog_forbidden');
    }
    await assert.rejects(
      service.create('customers', { name: 'Retry', reason }, actor, ids[0]),
      (error) => error.statusCode === 403,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM audit_event WHERE action='catalog.access.denied' AND correlation_id=$1",
          [ids[0]],
        )
      ).rows[0].n,
      1,
    );
    await pool.query(
      "CREATE FUNCTION catalog_test_denial_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='catalog.access.denied' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$",
    );
    await pool.query(
      'CREATE TRIGGER catalog_test_denial_failure BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION catalog_test_denial_failure()',
    );
    await assert.rejects(
      service.create('customers', { name: 'Audit unavailable', reason }, actor, randomUUID()),
      (error) => error.statusCode === 503 && error.code === 'catalog_audit_unavailable',
    );
    await pool.query('DROP TRIGGER catalog_test_denial_failure ON audit_event');
    await pool.query('DROP FUNCTION catalog_test_denial_failure()');
  } finally {
    await smallPool.end();
  }
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM catalog_customer WHERE name='Audit unavailable'",
      )
    ).rows[0].n,
    0,
  );

  // New capabilities can be granted/revoked through the existing audited admin path.
  await pool.query(
    "INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,'gps.user.manage',$1,$2)",
    [actor, reason],
  );
  await pool.query(
    "INSERT INTO geops_operating_tenant(singleton,tenant_id,established_by,audit_ref) VALUES(true,'synthetic',$1,$2)",
    [actor, randomUUID()],
  );
  const tenantDenialId = randomUUID();
  await assert.rejects(
    new CatalogService(pool).create(
      'customers',
      { name: 'Tenant scoped denial', reason },
      actor,
      tenantDenialId,
    ),
    (error) => error.statusCode === 403,
  );
  const tenantDenial = await pool.query(
    "SELECT metadata_redacted FROM audit_event WHERE action='catalog.access.denied' AND correlation_id=$1",
    [tenantDenialId],
  );
  assert.equal(tenantDenial.rows[0].metadata_redacted.operating_tenant_id, 'synthetic');
  const targetId = randomUUID();
  await pool.query(
    "INSERT INTO admin_user(id,email_normalized,password_hash,state) SELECT $1,'operator-w1ar@example.invalid',password_hash,'ACTIVE' FROM admin_user WHERE id=$2",
    [targetId, actor],
  );
  const users = new AdminUserAdministrationService(pool);
  const grantId = randomUUID();
  const capabilities = ['catalog.import.read', 'catalog.import.write', 'catalog.import.confirm'];
  await users.capabilities(actor, targetId, grantId, 'GRANT', capabilities, reason);
  await users.capabilities(actor, targetId, grantId, 'GRANT', capabilities, reason);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM admin_permission WHERE admin_id=$1 AND permission LIKE 'catalog.%' AND revoked_at IS NULL",
        [targetId],
      )
    ).rows[0].n,
    3,
  );
  await users.capabilities(actor, targetId, randomUUID(), 'REVOKE', capabilities, reason);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM admin_permission WHERE admin_id=$1 AND permission LIKE 'catalog.%' AND revoked_at IS NULL",
        [targetId],
      )
    ).rows[0].n,
    0,
  );
  console.log('W1-A-R H-01/H-02/H-03, M-01/M-02, rollback, security and admin grants: PASS');
} finally {
  await app?.close();
  await pool.end();
}
