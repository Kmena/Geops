import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import pg from 'pg';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { createApp } from '../src/app.ts';
import { applyMigrations } from '../src/db/migration-manager.ts';
import { KmzService } from '../src/kmz/service.ts';
import { KmzAnalysisService } from '../src/kmz/analysis.ts';
import { KmzReviewService } from '../src/kmz/review.ts';
import { KmzConfirmationService } from '../src/kmz/confirmation.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic geops_verify_* database required');
const pool = new pg.Pool({ connectionString: url, max: 8 });
const origin = 'https://geops.example.invalid';
let app;
function zip(kml) {
  const name = Buffer.from('doc.kml');
  const data = Buffer.from(kml);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(0x031e, 4);
  directory.writeUInt16LE(20, 6);
  directory.writeUInt32LE(crc32(data), 16);
  directory.writeUInt32LE(data.length, 20);
  directory.writeUInt32LE(data.length, 24);
  directory.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, directory, name, end]);
}
const check = (response, status) => assert.equal(response.statusCode, status, response.body);
try {
  assert.equal((await applyMigrations(pool)).at(-1), '0040_kmz_retention.sql');
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 81),
    csrfKey: Buffer.alloc(32, 82),
    allowedOrigins: [origin],
  });
  const actor = await auth.bootstrap('spec03-b32@example.invalid', 'synthetic-password-12345678');
  await pool.query(
    'INSERT INTO geops_operating_tenant(tenant_id,established_by,audit_ref) VALUES($1,$2,$3)',
    ['synthetic', actor, randomUUID()],
  );
  await pool.query(
    'INSERT INTO gps_data_tenant_access(admin_id,tenant_id,granted_by,reason) VALUES($1,$2,$1,$3)',
    [actor, 'synthetic', 'SPEC-03 synthetic grant'],
  );
  for (const permission of [
    'catalog.import.read',
    'catalog.import.write',
    'catalog.import.confirm',
    'visit.catalog.write',
  ])
    await pool.query(
      'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
      [actor, permission, 'SPEC-03 synthetic grant'],
    );
  const existingClient = randomUUID();
  const existingSite = randomUUID();
  await pool.query(
    "INSERT INTO client(id,tenant_id,code,name,address,created_by,updated_by) VALUES($1,'synthetic','B32OLD','Cliente B32 previo','Dirección anterior',$2,$2)",
    [existingClient, actor],
  );
  await pool.query(
    "INSERT INTO client_site(id,tenant_id,client_id,code,name,address,center,created_by,updated_by) VALUES($1,'synthetic',$2,'SITEOLD','Punto B32 previo','Dirección anterior',ST_SetSRID(ST_MakePoint(-84.3,9.9),4326)::geography,$3,$3)",
    [existingSite, existingClient, actor],
  );
  const nearbyClient = randomUUID();
  await pool.query(
    "INSERT INTO client(id,tenant_id,code,name,address,created_by,updated_by) VALUES($1,'synthetic','B32NEAR','Otro cliente cercano','Dirección cercana',$2,$2)",
    [nearbyClient, actor],
  );
  await pool.query(
    "INSERT INTO client_site(id,tenant_id,client_id,code,name,address,center,created_by,updated_by) VALUES($1,'synthetic',$2,'SITENEAR','Otro establecimiento cercano','Dirección cercana',ST_SetSRID(ST_MakePoint(-84.1006,9.9),4326)::geography,$3,$3)",
    [randomUUID(), nearbyClient, actor],
  );
  const kmz = new KmzService(pool);
  app = createApp({
    readinessProbe: async () => true,
    logLevel: 'silent',
    adminAuth: auth,
    kmz,
    kmzAnalysis: new KmzAnalysisService(pool, kmz),
    kmzReview: new KmzReviewService(pool, kmz),
    kmzConfirmation: new KmzConfirmationService(pool, kmz),
  });
  const login = await auth.login(
    'spec03-b32@example.invalid',
    'synthetic-password-12345678',
    '192.0.2.55',
    randomUUID(),
  );
  const headers = {
    cookie: `${auth.cookieName}=${login.token}`,
    origin,
    'x-csrf-token': login.csrfToken,
  };
  const call = (method, path, payload, extra = {}) =>
    app.inject({
      method,
      url: `/v1/admin/kmz-imports${path}`,
      headers: { ...headers, ...extra },
      ...(payload === undefined ? {} : { payload }),
    });
  const kml =
    '<kml><Document><Folder><name>Clientes</name>' +
    '<Placemark><name>Cliente KMZ nuevo</name><ExtendedData><Data name="code"><value>R-999</value></Data></ExtendedData><Point><coordinates>-84.1,9.9</coordinates></Point></Placemark>' +
    '<Placemark><name>Negocio distinto cercano</name><ExtendedData><Data name="code"><value>R-998</value></Data></ExtendedData><Point><coordinates>-84.1004,9.9</coordinates></Point></Placemark>' +
    '<Placemark><name>Duplicado real</name><ExtendedData><Data name="code"><value>R-900</value></Data></ExtendedData><Point><coordinates>-85.1,10.9</coordinates></Point></Placemark>' +
    '<Placemark><name>Duplicado real</name><ExtendedData><Data name="code"><value>R-901</value></Data></ExtendedData><Point><coordinates>-85.2,10.9</coordinates></Point></Placemark>' +
    '<Placemark><name>Cliente B32 previo</name><Point><coordinates>-84.3,9.9</coordinates></Point></Placemark>' +
    '</Folder></Document></kml>';
  const upload = await call('POST', '', zip(kml), {
    'content-type': 'application/vnd.google-earth.kmz',
    'x-file-name': 'spec03-b32.kmz',
    'idempotency-key': 'spec03-b32-upload-001',
  });
  check(upload, 202);
  const importId = upload.json().import_id;
  check(await call('POST', `/${importId}/rematch`, {}), 200);
  const rowsResponse = await call('GET', `/${importId}/review/records?limit=50`);
  check(rowsResponse, 200);
  const row = rowsResponse
    .json()
    .items.find((item) => item.normalized.name === 'Cliente KMZ nuevo');
  assert.ok(row, rowsResponse.body);
  const nearbyRow = rowsResponse
    .json()
    .items.find((item) => item.normalized.name === 'Negocio distinto cercano');
  assert.ok(nearbyRow, rowsResponse.body);
  assert.equal(row.review_state, 'NEW');
  assert.equal(nearbyRow.review_state, 'NEW');
  const actualDuplicates = rowsResponse
    .json()
    .items.filter((item) => item.normalized.name === 'Duplicado real');
  assert.equal(actualDuplicates.length, 2);
  assert.ok(actualDuplicates.every((item) => item.review_state === 'POSSIBLE_DUPLICATE'));
  const readyPoints = await call('GET', `/${importId}/review/records?type=READY_POINT&limit=100`);
  check(readyPoints, 200);
  assert.deepEqual(
    new Set(readyPoints.json().items.map((item) => item.record_id)),
    new Set([row.record_id, nearbyRow.record_id]),
  );
  await pool.query(
    "UPDATE admin_permission SET revoked_at=now() WHERE admin_id=$1 AND permission='catalog.import.write'",
    [actor],
  );
  check(
    await call(
      'PATCH',
      `/${importId}/review/records/${row.record_id}`,
      { action: 'CREATE', proposed: { name: 'No autorizado' } },
      { 'if-match': '0' },
    ),
    403,
  );
  await pool.query(
    "UPDATE admin_permission SET revoked_at=NULL WHERE admin_id=$1 AND permission='catalog.import.write'",
    [actor],
  );
  const review = await call(
    'PATCH',
    `/${importId}/review/records/${row.record_id}`,
    {
      action: 'CREATE',
      proposed: { name: 'Cliente GEOPS aprobado', address: 'Dirección revisada' },
    },
    { 'if-match': '0' },
  );
  check(review, 200);
  const decidedPoints = await call('GET', `/${importId}/review/records?type=READY_POINT`);
  check(decidedPoints, 200);
  assert.equal(decidedPoints.json().total, 1);
  assert.equal(decidedPoints.json().items[0].record_id, nearbyRow.record_id);
  const updateRow = rowsResponse
    .json()
    .items.find((item) => item.normalized.name === 'Cliente B32 previo');
  assert.ok(updateRow, rowsResponse.body);
  check(
    await call(
      'PATCH',
      `/${importId}/review/records/${updateRow.record_id}`,
      {
        action: 'UPDATE',
        target_customer_id: existingClient,
        target_customer_version: 1,
        target_establishment_id: existingSite,
        target_establishment_version: 1,
        selected_fields: ['name', 'code', 'address', 'coordinates'],
        reason: 'Corrección administrativa aprobada',
        proposed: {
          name: 'Cliente B32 corregido',
          code: 'B32NEW',
          address: 'Dirección corregida',
          latitude: 9.91,
          longitude: -84.31,
        },
      },
      { 'if-match': '0' },
    ),
    200,
  );
  await pool.query(
    "UPDATE admin_permission SET revoked_at=now() WHERE admin_id=$1 AND permission='catalog.import.confirm'",
    [actor],
  );
  check(await call('POST', `/${importId}/validate`, {}), 403);
  await pool.query(
    "UPDATE admin_permission SET revoked_at=NULL WHERE admin_id=$1 AND permission='catalog.import.confirm'",
    [actor],
  );
  const pendingRow = rowsResponse.json().items.find((item) => item.normalized.name === 'Clientes');
  assert.ok(pendingRow, 'synthetic KMZ includes an undecided grouping');
  await pool.query("UPDATE kmz_analysis_result SET review_state='CONFLICT' WHERE record_id=$1", [
    pendingRow.record_id,
  ]);
  const pendingConflict = await call('POST', `/${importId}/validate`, {});
  check(pendingConflict, 200);
  assert.equal(pendingConflict.json().operational_confirmation_available, true);
  assert.ok(pendingConflict.json().counts.pending > 0);
  await pool.query("UPDATE kmz_analysis_result SET review_state='INVALID' WHERE record_id=$1", [
    row.record_id,
  ]);
  const approvedInvalid = await call('POST', `/${importId}/validate`, {});
  check(approvedInvalid, 200);
  assert.equal(approvedInvalid.json().operational_confirmation_available, false);
  assert.ok(
    approvedInvalid
      .json()
      .blocking_issues.some(
        (issue) => issue.record_id === row.record_id && issue.code === 'invalid_record',
      ),
  );
  await pool.query("UPDATE kmz_analysis_result SET review_state='NEW' WHERE record_id=$1", [
    row.record_id,
  ]);
  await pool.query("UPDATE kmz_analysis_result SET review_state='INVALID' WHERE record_id=$1", [
    pendingRow.record_id,
  ]);
  const validated = await call('POST', `/${importId}/validate`, {});
  check(validated, 200);
  assert.equal(
    validated.json().operational_confirmation_available,
    true,
    JSON.stringify(validated.json().blocking_issues),
  );
  const plan = validated.json();
  assert.ok(plan.counts.pending > 0);
  await pool.query(
    "CREATE FUNCTION spec03_reject_operation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$",
  );
  await pool.query(
    'CREATE TRIGGER spec03_fail BEFORE INSERT ON kmz_import_operation FOR EACH ROW EXECUTE FUNCTION spec03_reject_operation()',
  );
  check(
    await call(
      'POST',
      `/${importId}/confirm`,
      { plan_digest: plan.plan_digest, reason: 'Aprobación administrativa sintética' },
      { 'if-match': plan.etag, 'idempotency-key': 'spec03-b32-confirm-001' },
    ),
    500,
  );
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM client')).rows[0].n, 2);
  assert.equal(
    (await pool.query('SELECT name FROM client WHERE id=$1', [existingClient])).rows[0].name,
    'Cliente B32 previo',
  );
  await pool.query('DROP TRIGGER spec03_fail ON kmz_import_operation');
  await pool.query('DROP FUNCTION spec03_reject_operation()');
  const confirmations = await Promise.all(
    [0, 1].map(() =>
      call(
        'POST',
        `/${importId}/confirm`,
        { plan_digest: plan.plan_digest, reason: 'Aprobación administrativa sintética' },
        { 'if-match': plan.etag, 'idempotency-key': 'spec03-b32-confirm-001' },
      ),
    ),
  );
  for (const response of confirmations) check(response, 200);
  assert.equal(confirmations[0].json().commit_id, confirmations[1].json().commit_id);
  assert.equal(
    confirmations[0]
      .json()
      .operations.some((operation) => operation.record_id === pendingRow.record_id),
    false,
  );
  const created = await pool.query(
    "SELECT id,code,name,address FROM client WHERE name='Cliente GEOPS aprobado'",
  );
  assert.equal(created.rowCount, 1);
  assert.match(created.rows[0].code, /^KMZ_[A-F0-9]{12}$/);
  assert.equal(created.rows[0].address, 'Dirección revisada');
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM client_site WHERE client_id=$1', [
        created.rows[0].id,
      ])
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query("SELECT source_code FROM kmz_import_operation WHERE action='CREATE'")).rows[0]
      .source_code,
    'R-999',
  );
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM route_template')).rows[0].n, 0);
  const updated = (
    await pool.query('SELECT name,code,address,version FROM client WHERE id=$1', [existingClient])
  ).rows[0];
  assert.equal(updated.name, 'Cliente B32 corregido');
  assert.equal(updated.code, 'B32NEW');
  assert.equal(updated.address, 'Dirección corregida');
  assert.equal(Number(updated.version), 2);
  const point = (
    await pool.query(
      'SELECT ST_Y(center::geometry) AS lat,ST_X(center::geometry) AS lon FROM client_site WHERE id=$1',
      [existingSite],
    )
  ).rows[0];
  assert.equal(point.lat, 9.91);
  assert.equal(point.lon, -84.31);
  check(
    await call(
      'POST',
      `/${importId}/confirm`,
      { plan_digest: plan.plan_digest, reason: 'Aprobación administrativa sintética' },
      { 'if-match': plan.etag, 'idempotency-key': 'spec03-b32-confirm-001' },
    ),
    200,
  );
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM client')).rows[0].n, 3);
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM kmz_import_operation')).rows[0].n,
    2,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE action='kmz.confirm.applied'",
      )
    ).rows[0].n,
    1,
  );
  console.log(
    'SPEC-03 canonical client/site, permissions, selective update, rollback, concurrency, replay: PASS',
  );
} finally {
  if (app) await app.close();
  await pool.end();
}
