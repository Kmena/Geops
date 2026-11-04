import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { checkReadiness } from '../src/db/migration-manager.ts';
import { KmzConfirmationService } from '../src/kmz/confirmation.ts';
import { KmzRetentionService } from '../src/kmz/retention.ts';
import { KmzService } from '../src/kmz/service.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  !['127.0.0.1', 'localhost'].includes(new URL(url).hostname) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable local synthetic database required');
const pool = new pg.Pool({ connectionString: url, max: 8 });
pool.on('error', () => {});
const retention = new KmzRetentionService(pool);
const clock = new Date();
const older = (days) => new Date(clock.getTime() - days * 86_400_000);
try {
  assert.equal(await checkReadiness(pool), true);
  const approved = (
    await pool.query(
      "SELECT import_id,confirmed_by,id FROM kmz_import_commit WHERE state='APPLIED'",
    )
  ).rows[0];
  assert.ok(approved, 'W5 integration fixture must be applied first');
  const actor = approved.confirmed_by;
  const original = await pool.query(
    'SELECT (SELECT count(*)::int FROM kmz_import_operation WHERE commit_id=$1) AS operations,(SELECT count(*)::int FROM kmz_review_event WHERE import_id=$2) AS events,(SELECT count(*)::int FROM kmz_review_record WHERE import_id=$2) AS decisions,(SELECT count(*)::int FROM kmz_import_record WHERE import_id=$2) AS records',
    [approved.id, approved.import_id],
  );
  assert.ok(original.rows[0].operations > 0);
  assert.ok(original.rows[0].events > 0);
  assert.ok(original.rows[0].records > 0);
  const operational = async () =>
    (
      await pool.query(`SELECT
        (SELECT count(*)::int FROM client) AS customers,
        (SELECT count(*)::int FROM client_site) AS establishments,
        (SELECT count(*)::int FROM route_template) AS routes,
        (SELECT count(*)::int FROM route_stop_revision) AS route_stops,
        (SELECT count(*)::int FROM position_event) AS positions,
        (SELECT count(*)::int FROM gps_policy) AS policies`)
    ).rows[0];
  const baseline = await operational();
  await pool.query('UPDATE kmz_import_session SET created_at=$2,expires_at=$3 WHERE id=$1', [
    approved.import_id,
    older(31),
    older(1),
  ]);
  async function makeSession(label, state, days) {
    const id = randomUUID();
    await pool.query(
      'INSERT INTO kmz_import_session(id,created_by,idempotency_key,sha256,file_name,compressed_bytes,state,created_at,expires_at) VALUES($1,$2,$3,$4,$5,4,$6,$7,$8)',
      [
        id,
        actor,
        `w6r-${label}-${id}`,
        'a'.repeat(64),
        `${label}.kmz`,
        state,
        older(days),
        older(days - 30),
      ],
    );
    await pool.query('INSERT INTO kmz_import_file(import_id,content) VALUES($1,$2)', [
      id,
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    ]);
    return id;
  }
  const recent = await makeSession('recent', 'READY', 29);
  const boundary = await makeSession('boundary', 'READY', 30);
  const expired = await makeSession('expired', 'READY', 31);
  const failed = await makeSession('failed', 'FAILED', 31);
  const processing = await makeSession('processing', 'PROCESSING', 31);
  await pool.query(
    'UPDATE kmz_import_session SET processing_started_at=$2,processing_token=$3 WHERE id=$1',
    [processing, clock, randomUUID()],
  );
  const abandoned = await makeSession('abandoned', 'PROCESSING', 31);
  const busy = await makeSession('busy', 'READY', 31);
  await assert.rejects(retention.run(randomUUID(), { dryRun: false, now: clock }), {
    statusCode: 403,
  });
  const dry = await retention.run(actor, { dryRun: true, now: clock });
  assert.equal(dry.eligible, 6);
  assert.equal(dry.purged, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM kmz_import_file')).rows[0].n, 8);
  const lock = await pool.connect();
  await lock.query("SELECT pg_advisory_lock(hashtext('kmz.analysis'),hashtext($1))", [busy]);
  try {
    const run = await retention.run(actor, { dryRun: false, now: clock });
    assert.deepEqual(
      { eligible: run.eligible, purged: run.purged, skipped_busy: run.skipped_busy },
      { eligible: 6, purged: 5, skipped_busy: 1 },
    );
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext('kmz.analysis'),hashtext($1))", [busy]);
    lock.release();
  }
  for (const id of [recent, processing, busy])
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM kmz_import_file WHERE import_id=$1', [id]))
        .rows[0].n,
      1,
    );
  for (const id of [boundary, expired, failed, abandoned, approved.import_id]) {
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM kmz_import_file WHERE import_id=$1', [id]))
        .rows[0].n,
      0,
    );
    assert.ok(
      (await pool.query('SELECT purged_at FROM kmz_import_session WHERE id=$1', [id])).rows[0]
        .purged_at,
    );
  }
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM kmz_import_operation WHERE commit_id=$1', [
        approved.id,
      ])
    ).rows[0].n,
    original.rows[0].operations,
  );
  assert.equal(
    (await pool.query('SELECT state FROM kmz_import_commit WHERE id=$1', [approved.id])).rows[0]
      .state,
    'APPLIED',
  );
  assert.deepEqual(
    (await pool.query('SELECT plan FROM kmz_import_commit WHERE id=$1', [approved.id])).rows[0]
      .plan,
    [],
  );
  const kmz = new KmzService(pool);
  assert.equal((await kmz.status(actor, approved.import_id)).state, 'EXPIRED');
  await assert.rejects(kmz.records(actor, approved.import_id, {}), { statusCode: 410 });
  assert.equal(
    (await new KmzConfirmationService(pool, kmz).result(actor, approved.import_id)).state,
    'APPLIED',
  );
  const archived = await pool.query(
    'SELECT entry_kind,count(*)::int AS n FROM kmz_import_review_archive WHERE import_id=$1 GROUP BY entry_kind',
    [approved.import_id],
  );
  const archivedCounts = Object.fromEntries(archived.rows.map((row) => [row.entry_kind, row.n]));
  assert.equal(archivedCounts.EVENT, original.rows[0].events);
  assert.equal(archivedCounts.DECISION, original.rows[0].decisions);
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM kmz_import_record WHERE import_id=$1', [
        approved.import_id,
      ])
    ).rows[0].n,
    0,
  );
  assert.deepEqual(await operational(), baseline);
  const replay = await retention.run(actor, { dryRun: false, now: clock });
  assert.equal(replay.purged, 1);
  assert.equal((await retention.run(actor, { dryRun: false, now: clock })).purged, 0);
  const beforeBroken = await makeSession('before-broken', 'FAILED', 32);
  const broken = await makeSession('broken', 'FAILED', 31);
  await pool.query(
    "CREATE FUNCTION w6r_block_file_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'W6R_INDUCED'; END $$",
  );
  await pool.query(
    `CREATE TRIGGER w6r_block BEFORE DELETE ON kmz_import_file FOR EACH ROW
     WHEN (OLD.import_id='${broken}'::uuid) EXECUTE FUNCTION w6r_block_file_delete()`,
  );
  await assert.rejects(retention.run(actor, { dryRun: false, now: clock }), /W6R_INDUCED/);
  assert.ok(
    (await pool.query('SELECT purged_at FROM kmz_import_session WHERE id=$1', [beforeBroken]))
      .rows[0].purged_at,
  );
  assert.equal(
    (
      await pool.query('SELECT count(*)::int AS n FROM kmz_import_file WHERE import_id=$1', [
        broken,
      ])
    ).rows[0].n,
    1,
  );
  assert.equal(
    (await pool.query('SELECT purged_at FROM kmz_import_session WHERE id=$1', [broken])).rows[0]
      .purged_at,
    null,
  );
  await pool.query('DROP TRIGGER w6r_block ON kmz_import_file');
  await pool.query('DROP FUNCTION w6r_block_file_delete()');
  const parallel = await Promise.all([
    retention.run(actor, { dryRun: false, now: clock }),
    retention.run(actor, { dryRun: false, now: clock }),
  ]);
  assert.equal(
    parallel.reduce((sum, item) => sum + item.purged, 0),
    1,
  );
  assert.equal((await retention.run(actor, { dryRun: false, now: clock })).purged, 0);
  assert.deepEqual(await operational(), baseline);
  const audits = await pool.query(
    "SELECT action,count(*)::int AS n FROM audit_event WHERE action LIKE 'kmz.retention.%' GROUP BY action ORDER BY action",
  );
  const auditCounts = Object.fromEntries(audits.rows.map((row) => [row.action, row.n]));
  assert.equal(auditCounts['kmz.retention.purged'], 8);
  assert.equal(auditCounts['kmz.retention.failed'], 1);
  assert.equal(auditCounts['kmz.retention.denied'], 1);
  assert.equal(auditCounts['kmz.retention.started'], auditCounts['kmz.retention.completed'] + 1);
  console.log(
    JSON.stringify({
      state: 'W6R_RETENTION_PASS',
      dry_run_eligible: dry.eligible,
      purged: auditCounts['kmz.retention.purged'],
      archived_events: archivedCounts.EVENT,
      archived_decisions: archivedCounts.DECISION,
      failure_recovered: true,
      concurrent_runs: parallel.length,
      operational_tables_unchanged: true,
    }),
  );
} finally {
  await pool.end();
}
