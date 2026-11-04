import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from '../audit/index.js';
import { ApiError } from '../errors.js';
import { comparisonName, isRouteCandidate, normalizedCode } from './matcher.js';
import type { KmzService } from './service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function invalid(): never {
  throw new ApiError(422, 'invalid_confirmation', 'Invalid confirmation');
}
function conflict(code: string): never {
  throw new ApiError(409, code, 'Conflict');
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeText = (value: unknown, min: number, max: number): value is string =>
  typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
const validCode = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(value);
const generatedCode = (id: string) => `KMZ_${id.replaceAll('-', '').slice(0, 12).toUpperCase()}`;
const approvedAddress = (value: unknown) =>
  safeText(value, 1, 300) ? value.trim() : 'Pendiente de dirección (KMZ)';
const location = (value: Record<string, unknown>) => {
  const point = value.point as Record<string, unknown> | undefined;
  const latitude = value.proposedLatitude ?? point?.latitude;
  const longitude = value.proposedLongitude ?? point?.longitude;
  return typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
    ? { latitude, longitude }
    : null;
};
type PlanRow = {
  record_id: string;
  source_path: string;
  source_kind: string;
  record_type: string;
  review_state: string;
  conflicts: string[];
  warnings: string[];
  normalized: Record<string, unknown>;
  proposed: Record<string, unknown>;
  action: 'CREATE' | 'LINK' | 'UPDATE' | 'EXCLUDE' | 'PENDING';
  target_customer_id: string | null;
  target_customer_version: string | null;
  target_establishment_id: string | null;
  target_establishment_version: string | null;
  selected_fields: string[];
  reason: string | null;
  acknowledged_conflict: boolean;
};
type Commit = {
  id: string;
  import_id: string;
  analysis_id: string;
  review_revision: string;
  catalog_revision: string;
  plan_digest: string;
  state: string;
  counts: Record<string, number>;
  warnings: unknown[];
  blocking_issues: unknown[];
  plan: PlanRow[];
  expires_at: Date;
  confirmation_key: string | null;
  confirmation_hash: string | null;
  result: Record<string, unknown> | null;
};

export class KmzConfirmationService {
  constructor(
    private readonly pool: Pool,
    private readonly kmz: KmzService,
  ) {}

  private async permission(db: PoolClient, actorId: string): Promise<void> {
    const found = await db.query(
      "SELECT 1 FROM admin_user u JOIN gps_data_tenant_access a ON a.admin_id=u.id AND a.revoked_at IS NULL JOIN geops_operating_tenant t ON t.tenant_id=a.tenant_id AND t.singleton=true JOIN admin_permission p ON p.admin_id=u.id AND p.permission='catalog.import.confirm' AND p.revoked_at IS NULL JOIN admin_permission w ON w.admin_id=u.id AND w.permission='visit.catalog.write' AND w.revoked_at IS NULL WHERE u.id=$1 AND u.state='ACTIVE' FOR SHARE OF u,p,w,a",
      [actorId],
    );
    if (!found.rowCount) throw new ApiError(403, 'catalog_forbidden', 'Forbidden');
  }

  private async session(actorId: string, importId: string, requireReady = true) {
    if (!UUID.test(importId)) invalid();
    const session = await this.kmz.get(actorId, importId);
    if (
      requireReady &&
      (session.state !== 'READY' || new Date(session.expires_at).getTime() <= Date.now())
    )
      throw new ApiError(410, 'import_expired_or_unready', 'Import unavailable');
    return session;
  }

  async validate(
    actorId: string,
    importId: string,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    await this.session(actorId, importId);
    const db = await this.pool.connect();
    let connectionError: Error | undefined;
    const onConnectionError = (error: Error) => {
      connectionError = error;
    };
    db.on('error', onConnectionError);
    try {
      await db.query('BEGIN');
      await this.permission(db, actorId);
      await db.query("SELECT pg_advisory_xact_lock(hashtext('kmz.analysis'),hashtext($1))", [
        importId,
      ]);
      await db.query('SELECT pg_advisory_xact_lock(350024)');
      const run = (
        await db.query<{ id: string; catalog_revision: string; state: string }>(
          'SELECT id,catalog_revision,state FROM kmz_analysis_run WHERE import_id=$1 ORDER BY version DESC LIMIT 1',
          [importId],
        )
      ).rows[0];
      if (run?.state !== 'READY') conflict('analysis_not_ready');
      const catalog = (
        await db.query<{ version: string }>(
          'SELECT version FROM catalog_revision WHERE singleton=true FOR SHARE',
        )
      ).rows[0];
      if (!catalog) conflict('catalog_missing');
      if (String(catalog?.version) !== String(run.catalog_revision)) conflict('catalog_changed');
      const reviewRevision =
        (
          await db.query<{ revision: string }>(
            'SELECT revision FROM kmz_review_session WHERE import_id=$1',
            [importId],
          )
        ).rows[0]?.revision ?? '0';
      const found = await db.query<PlanRow>(
        `SELECT a.record_id,r.source_path,r.source_kind,a.record_type,a.review_state,a.conflicts,a.warnings,r.normalized,
          coalesce(v.proposed,'{}'::jsonb) AS proposed,coalesce(v.action,'PENDING') AS action,
          v.target_customer_id,v.target_customer_version,v.target_establishment_id,v.target_establishment_version,
          coalesce(v.selected_fields,'{}'::text[]) AS selected_fields,v.reason,coalesce(v.acknowledged_conflict,false) AS acknowledged_conflict
         FROM kmz_analysis_result a JOIN kmz_import_record r ON r.id=a.record_id
         LEFT JOIN kmz_review_record v ON v.record_id=a.record_id AND v.analysis_id=a.run_id
         WHERE a.run_id=$1 ORDER BY a.ordinal`,
        [run.id],
      );
      const rows = found.rows;
      const blocking: Array<{ record_id: string; code: string }> = [];
      const warnings: Array<{ record_id: string; code: string }> = [];
      const counts = {
        create: 0,
        link: 0,
        update: 0,
        exclude: 0,
        pending: 0,
        groups_candidate: 0,
        routes_candidate: 0,
      };
      const seenNames = new Set<string>();
      const seenCodes = new Set<string>();
      const updatedCustomers = new Set<string>();
      const updatedEstablishments = new Set<string>();
      for (const row of rows) {
        const action = row.action;
        if (isRouteCandidate(row)) counts.routes_candidate++;
        else if (row.record_type === 'GEOGRAPHIC_GROUP') counts.groups_candidate++;
        if (action === 'PENDING') {
          counts.pending++;
          continue;
        }
        if (action === 'CREATE') counts.create++;
        if (action === 'LINK') counts.link++;
        if (action === 'UPDATE') counts.update++;
        if (action === 'EXCLUDE') counts.exclude++;
        if (row.review_state === 'INVALID' && action !== 'EXCLUDE')
          blocking.push({ record_id: row.record_id, code: 'invalid_record' });
        if (row.review_state === 'CONFLICT' && !row.acknowledged_conflict && action !== 'EXCLUDE')
          blocking.push({ record_id: row.record_id, code: 'unacknowledged_conflict' });
        if (row.conflicts.length && action !== 'EXCLUDE' && !row.acknowledged_conflict)
          blocking.push({ record_id: row.record_id, code: 'blocking_conflict' });
        if (row.warnings.length)
          warnings.push({ record_id: row.record_id, code: 'review_warning' });
        if (action === 'EXCLUDE') continue;
        if (
          !['CLIENT_CANDIDATE', 'REFERENCE_POINT', 'WEEKLY_STOP'].includes(row.record_type) &&
          ['CREATE', 'LINK', 'UPDATE'].includes(action)
        ) {
          blocking.push({ record_id: row.record_id, code: 'record_is_not_customer' });
          continue;
        }
        const name = row.proposed.name ?? row.normalized.name;
        if (row.proposed.code !== undefined && !validCode(row.proposed.code))
          blocking.push({ record_id: row.record_id, code: 'invalid_geops_code' });
        if (
          action === 'UPDATE' &&
          row.selected_fields.includes('code') &&
          !validCode(row.proposed.code)
        )
          blocking.push({ record_id: row.record_id, code: 'approved_code_required' });
        if (
          action === 'UPDATE' &&
          row.selected_fields.includes('address') &&
          !safeText(row.proposed.address, 1, 300)
        )
          blocking.push({ record_id: row.record_id, code: 'approved_address_required' });
        if (row.proposed.address !== undefined && !safeText(row.proposed.address, 1, 300))
          blocking.push({ record_id: row.record_id, code: 'invalid_address' });
        const point = location({
          ...row.normalized,
          proposedLatitude: row.proposed.latitude,
          proposedLongitude: row.proposed.longitude,
        });
        if (action === 'CREATE' || (action === 'UPDATE' && row.selected_fields.includes('name'))) {
          if (!safeText(name, 1, 160))
            blocking.push({ record_id: row.record_id, code: 'invalid_name' });
          if (safeText(name, 1, 160)) {
            const targetCode =
              action === 'UPDATE' && !row.selected_fields.includes('code')
                ? (
                    await db.query<{ internal_code: string }>(
                      'SELECT internal_code FROM catalog_customer WHERE id=$1',
                      [row.target_customer_id],
                    )
                  ).rows[0]?.internal_code
                : (row.proposed.code ?? row.normalized.code);
            const code = normalizedCode(targetCode);
            const normalizedName = comparisonName(name);
            if (
              (seenNames.has(normalizedName) || (code && seenCodes.has(code))) &&
              !row.acknowledged_conflict
            )
              blocking.push({ record_id: row.record_id, code: 'duplicate_name_or_code_in_plan' });
            seenNames.add(normalizedName);
            if (code) seenCodes.add(code);
            const existing = await db.query<{ name: string; internal_code: string }>(
              "SELECT name,internal_code FROM catalog_customer WHERE id IS DISTINCT FROM $3::uuid AND archived_at IS NULL AND identity_status='VERIFIED' AND (lower(name)=lower($1) OR internal_code=$2)",
              [name, code, row.target_customer_id],
            );
            if (
              existing.rows.some(
                (customer) =>
                  comparisonName(customer.name) === normalizedName ||
                  (code && normalizedCode(customer.internal_code) === code),
              ) &&
              !row.acknowledged_conflict
            )
              blocking.push({ record_id: row.record_id, code: 'possible_duplicate_customer' });
          }
        }
        if (action === 'CREATE') {
          if (
            !['CLIENT_CANDIDATE', 'REFERENCE_POINT'].includes(row.record_type) ||
            !safeText(name, 1, 160) ||
            !point
          )
            blocking.push({ record_id: row.record_id, code: 'invalid_create' });
        } else {
          if (
            !row.target_customer_id ||
            !UUID.test(row.target_customer_id) ||
            !row.target_customer_version
          ) {
            blocking.push({ record_id: row.record_id, code: 'customer_target_required' });
            continue;
          }
          const customer = (
            await db.query<{ version: string; identity_status: string }>(
              'SELECT version,identity_status FROM catalog_customer WHERE id=$1 AND archived_at IS NULL',
              [row.target_customer_id],
            )
          ).rows[0];
          if (
            customer?.identity_status !== 'VERIFIED' ||
            String(customer.version) !== String(row.target_customer_version)
          )
            blocking.push({ record_id: row.record_id, code: 'customer_target_changed' });
          if (row.target_establishment_id) {
            const establishment = (
              await db.query<{ version: string }>(
                'SELECT version FROM catalog_establishment WHERE id=$1 AND archived_at IS NULL',
                [row.target_establishment_id],
              )
            ).rows[0];
            if (
              !establishment ||
              String(establishment.version) !== String(row.target_establishment_version)
            )
              blocking.push({ record_id: row.record_id, code: 'establishment_target_changed' });
            const link = await db.query(
              'SELECT 1 FROM catalog_customer_establishment WHERE customer_id=$1 AND establishment_id=$2',
              [row.target_customer_id, row.target_establishment_id],
            );
            if (!link.rowCount)
              blocking.push({ record_id: row.record_id, code: 'target_link_missing' });
          }
          if (action === 'UPDATE') {
            if (!row.reason || row.reason.trim().length < 8 || !row.selected_fields.length)
              blocking.push({ record_id: row.record_id, code: 'update_reason_or_fields_missing' });
            if (
              row.selected_fields.includes('name') &&
              updatedCustomers.has(row.target_customer_id)
            )
              blocking.push({ record_id: row.record_id, code: 'duplicate_customer_update' });
            if (row.selected_fields.includes('name')) updatedCustomers.add(row.target_customer_id);
            if (row.selected_fields.includes('coordinates')) {
              if (!row.target_establishment_id || !point)
                blocking.push({ record_id: row.record_id, code: 'coordinate_target_required' });
              else if (updatedEstablishments.has(row.target_establishment_id))
                blocking.push({ record_id: row.record_id, code: 'duplicate_establishment_update' });
              if (row.target_establishment_id)
                updatedEstablishments.add(row.target_establishment_id);
            }
          }
          if (
            action === 'LINK' &&
            !row.target_establishment_id &&
            row.record_type !== 'WEEKLY_STOP' &&
            !point
          )
            blocking.push({ record_id: row.record_id, code: 'link_location_required' });
        }
        if (row.proposed.group_id) {
          const group = await db.query(
            "SELECT 1 FROM kmz_import_record WHERE id=$1 AND import_id=$2 AND source_kind IN ('TERRITORY_GROUP','WEEKLY_GROUP','FOLDER')",
            [row.proposed.group_id, importId],
          );
          if (!group.rowCount) blocking.push({ record_id: row.record_id, code: 'group_missing' });
        }
      }
      if (counts.create + counts.link + counts.update + counts.exclude === 0)
        blocking.push({ record_id: importId, code: 'no_reviewed_operations' });
      const planDigest = digest({
        importId,
        analysisId: run.id,
        reviewRevision: String(reviewRevision),
        catalogRevision: String(catalog.version),
        rows,
      });
      const existing = (
        await db.query<Commit>('SELECT * FROM kmz_import_commit WHERE import_id=$1 FOR UPDATE', [
          importId,
        ])
      ).rows[0];
      if (existing?.state === 'APPLIED') conflict('already_applied');
      const commitId = existing?.id ?? randomUUID();
      const expiresAt = new Date(Date.now() + 15 * 60_000);
      await db.query(
        `INSERT INTO kmz_import_commit(id,import_id,analysis_id,review_revision,catalog_revision,plan_digest,state,counts,warnings,blocking_issues,plan,validated_by,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,'VALIDATED',$7,$8,$9,$10,$11,$12)
        ON CONFLICT(import_id) DO UPDATE SET analysis_id=$3,review_revision=$4,catalog_revision=$5,plan_digest=$6,state='VALIDATED',counts=$7,warnings=$8,blocking_issues=$9,plan=$10,validated_by=$11,validated_at=now(),expires_at=$12`,
        [
          commitId,
          importId,
          run.id,
          reviewRevision,
          catalog.version,
          planDigest,
          JSON.stringify(counts),
          JSON.stringify(warnings),
          JSON.stringify(blocking),
          JSON.stringify(rows),
          actorId,
          expiresAt,
        ],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId,
        action: 'kmz.confirm.validate',
        outcome: 'success',
        correlationId: requestId,
        metadata: { import_id: importId, plan_digest: planDigest, blocking: blocking.length },
      });
      await db.query('COMMIT');
      return {
        commit_id: commitId,
        import_id: importId,
        state: 'VALIDATED',
        plan_digest: planDigest,
        etag: `"kmz-plan:${planDigest}"`,
        counts,
        warnings,
        blocking_issues: blocking,
        expires_at: expiresAt,
        operational_confirmation_available: blocking.length === 0,
      };
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      db.release(connectionError);
      db.off('error', onConnectionError);
    }
  }

  async confirm(
    actorId: string,
    importId: string,
    body: unknown,
    ifMatch: string | undefined,
    key: string | undefined,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    const session = await this.session(actorId, importId, false);
    if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
    const input = body as Record<string, unknown>;
    if (
      Object.keys(input).some((name) => !['plan_digest', 'reason'].includes(name)) ||
      typeof input.plan_digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.plan_digest) ||
      !safeText(input.reason, 8, 240)
    )
      invalid();
    const reason = input.reason as string;
    if (ifMatch !== `"kmz-plan:${input.plan_digest}"`)
      throw new ApiError(428, 'plan_etag_required', 'Plan ETag required');
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{16,120}$/.test(key))
      throw new ApiError(428, 'idempotency_key_required', 'Idempotency key required');
    const requestHash = digest({
      importId,
      plan_digest: input.plan_digest,
      reason: reason.trim(),
      key,
    });
    const db = await this.pool.connect();
    let connectionError: Error | undefined;
    const onConnectionError = (error: Error) => {
      connectionError = error;
    };
    db.on('error', onConnectionError);
    try {
      await db.query('BEGIN');
      await this.permission(db, actorId);
      await db.query("SELECT pg_advisory_xact_lock(hashtext('kmz.analysis'),hashtext($1))", [
        importId,
      ]);
      await db.query('SELECT pg_advisory_xact_lock(350024)');
      const commit = (
        await db.query<Commit>('SELECT * FROM kmz_import_commit WHERE import_id=$1 FOR UPDATE', [
          importId,
        ])
      ).rows[0];
      if (!commit) conflict('plan_missing');
      if (commit.state === 'APPLIED') {
        if (
          commit.confirmation_key !== key ||
          commit.confirmation_hash !== requestHash ||
          commit.plan_digest !== input.plan_digest
        )
          conflict('confirmation_replay_conflict');
        await db.query('COMMIT');
        return commit.result ?? {};
      }
      if (session.state !== 'READY' || new Date(session.expires_at).getTime() <= Date.now())
        throw new ApiError(410, 'import_expired_or_unready', 'Import unavailable');
      if (
        commit.state !== 'VALIDATED' ||
        commit.plan_digest !== input.plan_digest ||
        commit.expires_at.getTime() <= Date.now()
      )
        conflict('plan_stale');
      if (commit.blocking_issues.length)
        throw new ApiError(422, 'blocking_issues', 'Unresolved review');
      const latest = (
        await db.query<{ id: string }>(
          'SELECT id FROM kmz_analysis_run WHERE import_id=$1 ORDER BY version DESC LIMIT 1',
          [importId],
        )
      ).rows[0];
      const review = (
        await db.query<{ revision: string }>(
          'SELECT revision FROM kmz_review_session WHERE import_id=$1',
          [importId],
        )
      ).rows[0];
      if (
        latest?.id !== commit.analysis_id ||
        String(review?.revision ?? 0) !== String(commit.review_revision)
      )
        conflict('review_changed');
      const catalog = (
        await db.query<{ version: string }>(
          'SELECT version FROM catalog_revision WHERE singleton=true FOR UPDATE',
        )
      ).rows[0];
      if (!catalog || String(catalog.version) !== String(commit.catalog_revision))
        conflict('catalog_changed');
      await db.query("UPDATE kmz_import_commit SET state='CONFIRMED' WHERE id=$1", [commit.id]);
      const tenantId = (
        await db.query<{ tenant_id: string }>(
          'SELECT tenant_id FROM geops_operating_tenant WHERE singleton=true',
        )
      ).rows[0]?.tenant_id;
      if (!tenantId) conflict('tenant_missing');
      const rows = commit.plan;
      const operations: Array<Record<string, unknown>> = [];
      for (const row of rows) {
        if (row.action === 'PENDING') continue;
        if (
          !['CLIENT_CANDIDATE', 'REFERENCE_POINT', 'WEEKLY_STOP'].includes(row.record_type) &&
          ['CREATE', 'LINK', 'UPDATE'].includes(row.action)
        )
          invalid();
        const proposed = row.proposed ?? {};
        const name = String(proposed.name ?? row.normalized.name ?? '').trim();
        const point = location({
          ...row.normalized,
          proposedLatitude: proposed.latitude,
          proposedLongitude: proposed.longitude,
        });
        let customerId = row.target_customer_id;
        let establishmentId = row.target_establishment_id;
        let before: Record<string, unknown> = {};
        let after: Record<string, unknown> = { proposed, source_path: row.source_path };
        if (row.action === 'CREATE') {
          if (!point || !safeText(name, 1, 160)) invalid();
          customerId = randomUUID();
          const code = proposed.code === undefined ? generatedCode(customerId) : proposed.code;
          if (!validCode(code)) invalid();
          const created = (
            await db.query(
              'INSERT INTO client(id,tenant_id,code,name,address,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING id,name,code,version',
              [customerId, tenantId, code, name, approvedAddress(proposed.address), actorId],
            )
          ).rows[0];
          establishmentId = await this.createSite(
            db,
            tenantId,
            customerId,
            name,
            point,
            actorId,
            proposed.address,
          );
          after = { ...after, customer: created, establishment_id: establishmentId };
        } else if (row.action === 'LINK' || row.action === 'UPDATE') {
          if (!customerId) invalid();
          const current = (
            await db.query(
              "SELECT id,name,code,address,version FROM client WHERE id=$1 AND tenant_id=$2 AND state='ACTIVE' FOR UPDATE",
              [customerId, tenantId],
            )
          ).rows[0];
          if (!current || String(current.version) !== String(row.target_customer_version))
            conflict('target_changed');
          before = { customer: current };
          if (
            row.action === 'UPDATE' &&
            row.selected_fields.some((field) => ['name', 'code', 'address'].includes(field))
          ) {
            if (row.selected_fields.includes('name') && !safeText(name, 1, 160)) invalid();
            if (row.selected_fields.includes('code') && !validCode(proposed.code)) invalid();
            if (row.selected_fields.includes('address') && !safeText(proposed.address, 1, 300))
              invalid();
            const changed = (
              await db.query(
                'UPDATE client SET name=CASE WHEN $2::boolean THEN $3 ELSE name END,code=CASE WHEN $4::boolean THEN $5 ELSE code END,address=CASE WHEN $6::boolean THEN $7 ELSE address END,version=version+1,updated_by=$8,updated_at=now() WHERE id=$1 AND tenant_id=$9 RETURNING id,name,code,address,version',
                [
                  customerId,
                  row.selected_fields.includes('name'),
                  name,
                  row.selected_fields.includes('code'),
                  proposed.code ?? null,
                  row.selected_fields.includes('address'),
                  proposed.address ?? null,
                  actorId,
                  tenantId,
                ],
              )
            ).rows[0];
            after = { ...after, customer: changed };
          } else after = { ...after, customer: current };
          if (establishmentId) {
            const establishment = (
              await db.query(
                "SELECT id,name,code,version,ST_Y(center::geometry) AS latitude,ST_X(center::geometry) AS longitude FROM client_site WHERE id=$1 AND tenant_id=$2 AND client_id=$3 AND state='ACTIVE' FOR UPDATE",
                [establishmentId, tenantId, customerId],
              )
            ).rows[0];
            if (
              !establishment ||
              String(establishment.version) !== String(row.target_establishment_version)
            )
              conflict('target_changed');
            before = { ...before, establishment };
            if (row.action === 'UPDATE' && row.selected_fields.includes('coordinates')) {
              if (!point) invalid();
              const updated = (
                await db.query(
                  'UPDATE client_site SET center=ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,version=version+1,updated_by=$4,updated_at=now() WHERE id=$1 AND tenant_id=$5 AND client_id=$6 RETURNING id,name,code,version,ST_Y(center::geometry) AS latitude,ST_X(center::geometry) AS longitude',
                  [establishmentId, point.longitude, point.latitude, actorId, tenantId, customerId],
                )
              ).rows[0];
              after = { ...after, establishment: updated };
            } else after = { ...after, establishment };
          } else if (row.action === 'LINK' && row.record_type !== 'WEEKLY_STOP' && point) {
            establishmentId = await this.createSite(
              db,
              tenantId,
              customerId,
              name,
              point,
              actorId,
              proposed.address,
            );
            after = { ...after, establishment_id: establishmentId };
          }
        }
        if (proposed.group_id && establishmentId)
          after = { ...after, group_candidate_id: proposed.group_id };
        if (row.action === 'EXCLUDE') after = { excluded: true, source_path: row.source_path };
        const operationId = randomUUID();
        await db.query(
          'INSERT INTO kmz_import_operation(id,commit_id,record_id,source_path,source_code,action,target_customer_id,target_establishment_id,before_value,after_value,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [
            operationId,
            commit.id,
            row.record_id,
            row.source_path,
            proposed.code ?? row.normalized.code ?? null,
            row.action,
            customerId,
            establishmentId,
            JSON.stringify(before),
            JSON.stringify(after),
            actorId,
          ],
        );
        operations.push({
          record_id: row.record_id,
          action: row.action,
          target_customer_id: customerId,
          target_establishment_id: establishmentId,
          operation_id: operationId,
        });
      }
      const result = {
        commit_id: commit.id,
        import_id: importId,
        state: 'APPLIED',
        plan_digest: commit.plan_digest,
        applied_at: new Date().toISOString(),
        counts: commit.counts,
        operations,
        groups_created: 0,
        routes_activated: 0,
        visits_created: 0,
      };
      await db.query(
        "UPDATE kmz_import_commit SET state='APPLIED',confirmation_key=$2,confirmation_hash=$3,confirmed_by=$4,applied_at=$5,result=$6 WHERE id=$1",
        [commit.id, key, requestHash, actorId, result.applied_at, JSON.stringify(result)],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId,
        action: 'kmz.confirm.applied',
        outcome: 'success',
        correlationId: requestId,
        metadata: {
          import_id: importId,
          commit_id: commit.id,
          plan_digest: commit.plan_digest,
          operations: operations.length,
          reason: reason.trim(),
        },
      });
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      if (error && typeof error === 'object' && 'code' in error && String(error.code) === '23505')
        conflict('confirmation_identity_conflict');
      throw error;
    } finally {
      db.release(connectionError);
      db.off('error', onConnectionError);
    }
  }

  private async createSite(
    db: PoolClient,
    tenantId: string,
    customerId: string,
    name: string,
    point: { latitude: number; longitude: number },
    actorId: string,
    address: unknown,
  ): Promise<string> {
    if (!safeText(name, 1, 160)) invalid();
    const id = randomUUID();
    await db.query(
      'INSERT INTO client_site(id,tenant_id,client_id,code,name,address,center,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,ST_SetSRID(ST_MakePoint($7,$8),4326)::geography,$9,$9)',
      [
        id,
        tenantId,
        customerId,
        generatedCode(id),
        name,
        approvedAddress(address),
        point.longitude,
        point.latitude,
        actorId,
      ],
    );
    return id;
  }

  async result(actorId: string, importId: string): Promise<Record<string, unknown>> {
    await this.session(actorId, importId, false);
    const found = (
      await this.pool.query<Commit>('SELECT * FROM kmz_import_commit WHERE import_id=$1', [
        importId,
      ])
    ).rows[0];
    if (!found) throw new ApiError(404, 'plan_missing', 'Not found');
    return found.state === 'APPLIED' && found.result
      ? found.result
      : {
          commit_id: found.id,
          import_id: importId,
          state: found.state,
          plan_digest: found.plan_digest,
          counts: found.counts,
          blocking_issues: found.blocking_issues,
        };
  }
}
