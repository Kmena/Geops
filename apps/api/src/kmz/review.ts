import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from '../audit/index.js';
import { guardClient } from '../db/client-guard.js';
import { ApiError } from '../errors.js';
import type { KmzService } from './service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROUTE_CANDIDATE_SQL = `(r.source_kind='WEEKLY_GROUP' OR
  (r.source_kind='TERRITORY_GROUP' AND r.normalized->>'code_source'='NAME_PREFIX'))`;
const actions = ['CREATE', 'LINK', 'UPDATE', 'EXCLUDE', 'PENDING'] as const;
type Action = (typeof actions)[number];
type Change = {
  proposed?: {
    name?: string;
    code?: string;
    address?: string;
    latitude?: number;
    longitude?: number;
    group_id?: string | null;
    week_label?: string | null;
  };
  action?: Action;
  target_customer_id?: string | null;
  target_customer_version?: number | null;
  target_establishment_id?: string | null;
  target_establishment_version?: number | null;
  selected_fields?: string[];
  reason?: string | null;
  acknowledged_conflict?: boolean;
};
type Context = { id: string; catalog_revision: string; version: number; state: string };
type Row = {
  record_id: string;
  revision: string;
  analysis_id: string;
  proposed: Record<string, unknown>;
  action: Action;
  target_customer_id: string | null;
  target_customer_version: string | null;
  target_establishment_id: string | null;
  target_establishment_version: string | null;
  selected_fields: string[];
  reason: string | null;
  acknowledged_conflict: boolean;
};

function invalid(): never {
  throw new ApiError(422, 'invalid_review', 'Invalid review');
}
function id(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
function text(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
}
function version(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function point(value: Record<string, unknown>): boolean {
  return (
    typeof value.latitude === 'number' &&
    Number.isFinite(value.latitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    typeof value.longitude === 'number' &&
    Number.isFinite(value.longitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180
  );
}
function reviewValue(row: Row | undefined): Record<string, unknown> {
  return row
    ? {
        proposed: row.proposed,
        action: row.action,
        target_customer_id: row.target_customer_id,
        target_customer_version:
          row.target_customer_version === null ? null : Number(row.target_customer_version),
        target_establishment_id: row.target_establishment_id,
        target_establishment_version:
          row.target_establishment_version === null
            ? null
            : Number(row.target_establishment_version),
        selected_fields: row.selected_fields,
        reason: row.reason,
        acknowledged_conflict: row.acknowledged_conflict,
      }
    : {
        proposed: {},
        action: 'PENDING',
        target_customer_id: null,
        target_customer_version: null,
        target_establishment_id: null,
        target_establishment_version: null,
        selected_fields: [],
        reason: null,
        acknowledged_conflict: false,
      };
}

export class KmzReviewService {
  constructor(
    private readonly pool: Pool,
    private readonly kmz: KmzService,
  ) {}

  async capabilities(actorId: string): Promise<{ capabilities: string[] }> {
    const found = await this.pool.query<{ permission: string }>(
      "SELECT p.permission FROM admin_permission p JOIN admin_user u ON u.id=p.admin_id JOIN gps_data_tenant_access a ON a.admin_id=u.id AND a.revoked_at IS NULL JOIN geops_operating_tenant t ON t.singleton=true AND t.tenant_id=a.tenant_id WHERE u.id=$1 AND u.state='ACTIVE' AND p.revoked_at IS NULL AND p.permission IN ('catalog.import.read','catalog.import.write','catalog.import.confirm')",
      [actorId],
    );
    return { capabilities: found.rows.map((row) => row.permission) };
  }

  private async context(
    db: Pool | PoolClient,
    actorId: string,
    importId: string,
  ): Promise<Context> {
    const session = await this.kmz.get(actorId, importId);
    if (
      session.state !== 'READY' ||
      session.purged_at ||
      new Date(session.expires_at).getTime() <= Date.now()
    )
      throw new ApiError(409, 'import_not_ready', 'Import is not ready');
    const found = await db.query<Context>(
      'SELECT id,catalog_revision,version,state FROM kmz_analysis_run WHERE import_id=$1 ORDER BY version DESC LIMIT 1',
      [importId],
    );
    const run = found.rows[0];
    if (run?.state !== 'READY')
      throw new ApiError(409, 'analysis_not_ready', 'Analysis is not ready');
    return run;
  }

  private async current(db: Pool | PoolClient, run: Context, lock = false): Promise<void> {
    const found = await db.query<{ version: string }>(
      `SELECT version FROM catalog_revision WHERE singleton=true${lock ? ' FOR SHARE' : ''}`,
    );
    if (String(found.rows[0]?.version) !== String(run.catalog_revision))
      throw new ApiError(409, 'catalog_changed', 'Catalog changed; run analysis again');
  }

  async summary(actorId: string, importId: string): Promise<Record<string, unknown>> {
    const run = await this.context(this.pool, actorId, importId);
    const found = await this.pool.query(
      `SELECT count(*)::int AS total,
        count(*) FILTER (WHERE a.record_type='CLIENT_CANDIDATE')::int AS client_candidates,
        count(*) FILTER (WHERE ${ROUTE_CANDIDATE_SQL})::int AS route_candidates,
        count(*) FILTER (WHERE a.review_state='EXISTING_MATCH')::int AS existing_matches,
        count(*) FILTER (WHERE a.review_state='POSSIBLE_DUPLICATE')::int AS possible_duplicates,
        count(*) FILTER (WHERE a.review_state='CONFLICT')::int AS conflicts,
        count(*) FILTER (WHERE a.review_state='INVALID')::int AS invalid,
        count(*) FILTER (WHERE v.action IS NOT NULL AND v.analysis_id=a.run_id)::int AS reviewed,
        count(*) FILTER (WHERE v.action IS NULL OR v.action='PENDING' OR v.analysis_id<>a.run_id)::int AS pending,
        count(*) FILTER (WHERE v.action='EXCLUDE' AND v.analysis_id=a.run_id)::int AS excluded,
        count(*) FILTER (WHERE v.action='CREATE' AND v.analysis_id=a.run_id)::int AS create_count,
        count(*) FILTER (WHERE v.action='LINK' AND v.analysis_id=a.run_id)::int AS link_count,
        count(*) FILTER (WHERE v.action='UPDATE' AND v.analysis_id=a.run_id)::int AS update_count,
        count(*) FILTER (WHERE a.warnings <> '[]'::jsonb)::int AS warnings
       FROM kmz_analysis_result a JOIN kmz_import_record r ON r.id=a.record_id
       LEFT JOIN kmz_review_record v ON v.record_id=a.record_id WHERE a.run_id=$1`,
      [run.id],
    );
    const candidates = await this.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM kmz_analysis_candidate WHERE run_id=$1',
      [run.id],
    );
    const revision = await this.pool.query<{ revision: string }>(
      'SELECT revision FROM kmz_review_session WHERE import_id=$1',
      [importId],
    );
    return {
      analysis_id: run.id,
      analysis_version: run.version,
      catalog_revision: Number(run.catalog_revision),
      review_revision: Number(revision.rows[0]?.revision ?? 0),
      candidate_relations: candidates.rows[0]?.count ?? 0,
      ...found.rows[0],
    };
  }

  async records(
    actorId: string,
    importId: string,
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const run = await this.context(this.pool, actorId, importId);
    if (
      Object.keys(query).some(
        (key) =>
          ![
            'page',
            'limit',
            'state',
            'group',
            'week',
            'type',
            'sort',
            'search',
            'record_id',
          ].includes(key),
      )
    )
      invalid();
    const page = query.page === undefined ? 1 : Number(query.page);
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100000 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      invalid();
    const search = query.search === undefined ? null : String(query.search).trim();
    const state = query.state === undefined ? null : String(query.state);
    const group = query.group === undefined ? null : String(query.group);
    const week = query.week === undefined ? null : String(query.week);
    const type = query.type === undefined ? null : String(query.type);
    const sort = query.sort === undefined ? 'priority' : String(query.sort);
    const recordId = query.record_id === undefined ? null : String(query.record_id);
    if (
      (search && search.length > 120) ||
      (group && group.length > 1200) ||
      (week && week.length > 120) ||
      (state &&
        !['NEW', 'EXISTING_MATCH', 'POSSIBLE_DUPLICATE', 'CONFLICT', 'INVALID'].includes(state)) ||
      (type &&
        ![
          'CLIENT_CANDIDATE',
          'REFERENCE_POINT',
          'WEEKLY_STOP',
          'GEOGRAPHIC_GROUP',
          'ROUTE_CANDIDATE',
          'POLYGON',
          'LINE',
          'INVALID_OR_OTHER',
        ].includes(type)) ||
      !['priority', 'source', 'name'].includes(sort) ||
      (recordId !== null && !id(recordId))
    )
      invalid();
    const filter = `FROM kmz_analysis_result a JOIN kmz_import_record r ON r.id=a.record_id LEFT JOIN kmz_review_record v ON v.record_id=a.record_id AND v.analysis_id=a.run_id
      WHERE a.run_id=$1 AND ($2::text IS NULL OR a.review_state=$2) AND ($3::text IS NULL OR r.parent_path=$3) AND ($4::text IS NULL OR r.week_label=$4)
      AND ($5::text IS NULL OR (a.record_type=$5 AND ($5<>'GEOGRAPHIC_GROUP' OR NOT ${ROUTE_CANDIDATE_SQL}))
        OR ($5='ROUTE_CANDIDATE' AND ${ROUTE_CANDIDATE_SQL}))
      AND ($6::text IS NULL OR coalesce(v.proposed->>'name',r.normalized->>'name','') ILIKE '%'||$6||'%' OR coalesce(v.proposed->>'code',r.normalized->>'code','') ILIKE '%'||$6||'%')
      AND ($7::uuid IS NULL OR a.record_id=$7)`;
    const args = [run.id, state, group, week, type, search, recordId];
    const count = await this.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count ${filter}`,
      args,
    );
    const order =
      sort === 'source'
        ? 'a.ordinal'
        : sort === 'name'
          ? "lower(coalesce(v.proposed->>'name',r.normalized->>'name','')),a.ordinal"
          : "CASE a.review_state WHEN 'CONFLICT' THEN 0 WHEN 'INVALID' THEN 1 WHEN 'POSSIBLE_DUPLICATE' THEN 2 WHEN 'EXISTING_MATCH' THEN 3 ELSE 4 END,a.ordinal";
    const found = await this.pool.query(
      `SELECT a.record_id,a.ordinal,a.record_type,a.review_state,a.warnings,a.conflicts,a.evidence,r.source_path,r.parent_path,r.source_kind,r.week_label,r.normalized,
        ${ROUTE_CANDIDATE_SQL} AS route_candidate,v.proposed,v.action,coalesce(v.revision,0)::int AS revision
       ${filter} ORDER BY ${order} LIMIT $8 OFFSET $9`,
      [...args, limit, (page - 1) * limit],
    );
    return {
      analysis_id: run.id,
      page,
      limit,
      total: count.rows[0]?.count ?? 0,
      items: found.rows,
    };
  }

  async facets(actorId: string, importId: string): Promise<Record<string, unknown>> {
    const run = await this.context(this.pool, actorId, importId);
    const found = await this.pool.query(
      `SELECT array_agg(DISTINCT r.week_label) FILTER (WHERE r.week_label IS NOT NULL) AS weeks
       FROM kmz_analysis_result a JOIN kmz_import_record r ON r.id=a.record_id WHERE a.run_id=$1`,
      [run.id],
    );
    const choices = await this.pool.query<{ id: string; name: string; path: string }>(
      "SELECT id,coalesce(normalized->>'name',source_path) AS name,source_path AS path FROM kmz_import_record WHERE import_id=$1 AND source_kind IN ('TERRITORY_GROUP','WEEKLY_GROUP','FOLDER') ORDER BY ordinal LIMIT 1000",
      [importId],
    );
    const groupPaths = await this.pool.query<{ path: string }>(
      'SELECT DISTINCT parent_path AS path FROM kmz_import_record WHERE import_id=$1 AND parent_path IS NOT NULL ORDER BY parent_path LIMIT 1000',
      [importId],
    );
    return {
      groups: groupPaths.rows.map((row) => ({
        path: row.path,
        name: choices.rows.find((choice) => choice.path === row.path)?.name ?? 'Raíz del archivo',
      })),
      weeks: found.rows[0]?.weeks ?? [],
      group_choices: choices.rows,
    };
  }

  async targets(
    actorId: string,
    importId: string,
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await this.context(this.pool, actorId, importId);
    if (Object.keys(query).some((key) => !['search', 'kind'].includes(key))) invalid();
    const search = String(query.search ?? '').trim();
    const kind = String(query.kind ?? 'CUSTOMER');
    if (search.length < 2 || search.length > 120 || !['CUSTOMER', 'ESTABLISHMENT'].includes(kind))
      invalid();
    const found =
      kind === 'CUSTOMER'
        ? await this.pool.query(
            "SELECT id,name,version FROM catalog_customer WHERE archived_at IS NULL AND name ILIKE '%'||$1||'%' ORDER BY lower(name),id LIMIT 20",
            [search],
          )
        : await this.pool.query(
            "SELECT id,name,version,source_key,ST_Y(geog::geometry) AS latitude,ST_X(geog::geometry) AS longitude FROM catalog_establishment WHERE archived_at IS NULL AND name ILIKE '%'||$1||'%' ORDER BY lower(name),id LIMIT 20",
            [search],
          );
    return { kind, items: found.rows };
  }

  async detail(
    actorId: string,
    importId: string,
    recordId: string,
  ): Promise<Record<string, unknown>> {
    if (!id(recordId)) invalid();
    const run = await this.context(this.pool, actorId, importId);
    const found = await this.pool.query(
      `SELECT a.*,r.source_path,r.parent_path,r.source_kind,r.week_label,r.original,r.normalized,r.geometry,r.errors AS parse_errors,
        ${ROUTE_CANDIDATE_SQL} AS route_candidate,
        v.proposed,v.action,v.target_customer_id,v.target_customer_version,v.target_establishment_id,v.target_establishment_version,v.selected_fields,v.reason,v.acknowledged_conflict,coalesce(v.revision,0)::int AS revision,v.updated_at,v.updated_by
       FROM kmz_analysis_result a JOIN kmz_import_record r ON r.id=a.record_id LEFT JOIN kmz_review_record v ON v.record_id=a.record_id AND v.analysis_id=a.run_id
       WHERE a.run_id=$1 AND a.record_id=$2`,
      [run.id, recordId],
    );
    if (!found.rows[0]) throw new ApiError(404, 'record_missing', 'Not found');
    const candidates = await this.pool.query(
      `SELECT c.target_type,c.target_id,c.target_version,c.distance_m,c.proximity_band,c.confidence,c.signals,
         CASE WHEN c.target_type='CUSTOMER' THEN cu.name WHEN c.target_type='ESTABLISHMENT' THEN e.name WHEN c.target_type='STAGING_RECORD' THEN sr.normalized->>'name' ELSE NULL END AS target_name,
         CASE WHEN c.target_type='ESTABLISHMENT' THEN e.source_key WHEN c.target_type='STAGING_RECORD' THEN sr.normalized->>'code' ELSE NULL END AS target_code,
         CASE WHEN c.target_type='ESTABLISHMENT' THEN ST_Y(e.geog::geometry) WHEN c.target_type='PIN' THEN ST_Y(pin.geog::geometry) ELSE NULL END AS latitude,
         CASE WHEN c.target_type='ESTABLISHMENT' THEN ST_X(e.geog::geometry) WHEN c.target_type='PIN' THEN ST_X(pin.geog::geometry) ELSE NULL END AS longitude
       FROM kmz_analysis_candidate c LEFT JOIN catalog_customer cu ON c.target_type='CUSTOMER' AND cu.id=c.target_id
       LEFT JOIN catalog_establishment e ON c.target_type='ESTABLISHMENT' AND e.id=c.target_id
       LEFT JOIN catalog_pin pin ON c.target_type='PIN' AND pin.id=c.target_id
       LEFT JOIN kmz_import_record sr ON c.target_type='STAGING_RECORD' AND sr.id=c.target_id
       WHERE c.run_id=$1 AND c.record_id=$2 ORDER BY c.confidence,c.distance_m NULLS LAST LIMIT 100`,
      [run.id, recordId],
    );
    return { ...found.rows[0], analysis_id: run.id, candidates: candidates.rows };
  }

  async map(actorId: string, importId: string): Promise<Record<string, unknown>> {
    const run = await this.context(this.pool, actorId, importId);
    const found = await this.pool.query(
      `SELECT a.record_id,a.review_state,a.record_type,r.source_kind,r.normalized->>'name' AS name,
        (r.normalized #>> '{point,latitude}')::double precision AS latitude,
        (r.normalized #>> '{point,longitude}')::double precision AS longitude
       FROM kmz_analysis_result a JOIN kmz_import_record r ON r.id=a.record_id
       WHERE a.run_id=$1 AND r.normalized->'point' IS NOT NULL AND r.normalized->'point' <> 'null'::jsonb ORDER BY a.ordinal LIMIT 10000`,
      [run.id],
    );
    return { items: found.rows };
  }

  private validateShape(change: Change): void {
    if (
      !change ||
      typeof change !== 'object' ||
      Array.isArray(change) ||
      Object.keys(change).some(
        (key) =>
          ![
            'proposed',
            'action',
            'target_customer_id',
            'target_customer_version',
            'target_establishment_id',
            'target_establishment_version',
            'selected_fields',
            'reason',
            'acknowledged_conflict',
          ].includes(key),
      )
    )
      invalid();
    if (change.action !== undefined && !actions.includes(change.action)) invalid();
    if (change.proposed !== undefined) {
      const p = change.proposed;
      if (
        !p ||
        typeof p !== 'object' ||
        Array.isArray(p) ||
        Object.keys(p).some(
          (key) =>
            ![
              'name',
              'code',
              'address',
              'latitude',
              'longitude',
              'group_id',
              'week_label',
            ].includes(key),
        )
      )
        invalid();
      if (p.name !== undefined && !text(p.name, 160)) invalid();
      if (p.address !== undefined && !text(p.address, 300)) invalid();
      if (
        p.code !== undefined &&
        (typeof p.code !== 'string' || !/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(p.code))
      )
        invalid();
      if (
        p.latitude !== undefined &&
        (typeof p.latitude !== 'number' ||
          !Number.isFinite(p.latitude) ||
          p.latitude < -90 ||
          p.latitude > 90)
      )
        invalid();
      if (
        p.longitude !== undefined &&
        (typeof p.longitude !== 'number' ||
          !Number.isFinite(p.longitude) ||
          p.longitude < -180 ||
          p.longitude > 180)
      )
        invalid();
      if (p.group_id !== undefined && p.group_id !== null && !id(p.group_id)) invalid();
      if (
        p.week_label !== undefined &&
        p.week_label !== null &&
        (typeof p.week_label !== 'string' || p.week_label.length > 120)
      )
        invalid();
    }
    if (
      change.target_customer_id !== undefined &&
      change.target_customer_id !== null &&
      !id(change.target_customer_id)
    )
      invalid();
    if (
      change.target_establishment_id !== undefined &&
      change.target_establishment_id !== null &&
      !id(change.target_establishment_id)
    )
      invalid();
    if (
      change.target_customer_version !== undefined &&
      change.target_customer_version !== null &&
      !version(change.target_customer_version)
    )
      invalid();
    if (
      change.target_establishment_version !== undefined &&
      change.target_establishment_version !== null &&
      !version(change.target_establishment_version)
    )
      invalid();
    if (
      change.selected_fields !== undefined &&
      (!Array.isArray(change.selected_fields) ||
        change.selected_fields.length > 6 ||
        change.selected_fields.some(
          (field) => !['name', 'code', 'address', 'coordinates', 'group', 'week'].includes(field),
        ))
    )
      invalid();
    if (
      change.reason !== undefined &&
      change.reason !== null &&
      (typeof change.reason !== 'string' || change.reason.length > 500)
    )
      invalid();
    if (
      change.acknowledged_conflict !== undefined &&
      typeof change.acknowledged_conflict !== 'boolean'
    )
      invalid();
  }

  private async validateDecision(
    db: PoolClient,
    importId: string,
    result: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<void> {
    const action = decision.action;
    const proposed = decision.proposed as Record<string, unknown>;
    const normalized = result.normalized as Record<string, unknown>;
    const originalPoint = normalized.point as Record<string, unknown> | undefined;
    const merged = {
      name: proposed.name ?? normalized.name,
      latitude: proposed.latitude ?? originalPoint?.latitude,
      longitude: proposed.longitude ?? originalPoint?.longitude,
    };
    if (proposed.group_id) {
      const group = await db.query(
        "SELECT 1 FROM kmz_import_record WHERE id=$1 AND import_id=$2 AND source_kind IN ('TERRITORY_GROUP','WEEKLY_GROUP','FOLDER')",
        [proposed.group_id, importId],
      );
      if (!group.rowCount) invalid();
    }
    if (
      action === 'CREATE' &&
      (!text(merged.name, 160) ||
        !point(merged) ||
        !['CLIENT_CANDIDATE', 'REFERENCE_POINT'].includes(String(result.record_type)) ||
        result.review_state === 'INVALID')
    )
      invalid();
    if (result.source_kind === 'WEEKLY_STOP' && action === 'CREATE') invalid();
    if (result.record_type === 'GEOGRAPHIC_GROUP' && ['LINK', 'UPDATE'].includes(String(action)))
      invalid();
    if (
      result.review_state === 'POSSIBLE_DUPLICATE' &&
      action === 'CREATE' &&
      decision.acknowledged_conflict !== true
    )
      invalid();
    if (action === 'LINK' || action === 'UPDATE') {
      if (!id(decision.target_customer_id) || !version(decision.target_customer_version)) invalid();
      const target = await db.query<{ version: string }>(
        'SELECT version FROM catalog_customer WHERE id=$1 AND archived_at IS NULL',
        [decision.target_customer_id],
      );
      if (!target.rows[0] || Number(target.rows[0].version) !== decision.target_customer_version)
        throw new ApiError(409, 'target_changed', 'Customer changed');
      if (
        action === 'UPDATE' &&
        (!(decision.selected_fields as string[]).length || !text(decision.reason, 500))
      )
        invalid();
    }
    if (decision.target_establishment_id) {
      if (!version(decision.target_establishment_version)) invalid();
      const target = await db.query<{ version: string }>(
        'SELECT version FROM catalog_establishment WHERE id=$1 AND archived_at IS NULL',
        [decision.target_establishment_id],
      );
      if (
        !target.rows[0] ||
        Number(target.rows[0].version) !== decision.target_establishment_version
      )
        throw new ApiError(409, 'target_changed', 'Establishment changed');
      if (decision.target_customer_id) {
        const link = await db.query(
          'SELECT 1 FROM catalog_customer_establishment WHERE customer_id=$1 AND establishment_id=$2',
          [decision.target_customer_id, decision.target_establishment_id],
        );
        if (!link.rowCount) invalid();
      }
    }
    if (action === 'EXCLUDE' && !text(decision.reason, 500)) invalid();
    if (
      result.review_state === 'CONFLICT' &&
      action !== 'PENDING' &&
      action !== 'EXCLUDE' &&
      decision.acknowledged_conflict !== true
    )
      invalid();
  }

  async save(
    actorId: string,
    importId: string,
    recordId: string,
    expectedRevision: number,
    body: Change,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    if (!id(recordId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) invalid();
    this.validateShape(body);
    const db = await this.pool.connect();
    const release = guardClient(db);
    try {
      await db.query('BEGIN');
      await db.query("SELECT pg_advisory_xact_lock(hashtext('kmz.analysis'),hashtext($1))", [
        importId,
      ]);
      if (
        (
          await db.query("SELECT 1 FROM kmz_import_commit WHERE import_id=$1 AND state='APPLIED'", [
            importId,
          ])
        ).rowCount
      )
        throw new ApiError(409, 'import_already_applied', 'Import already applied');
      const run = await this.context(db, actorId, importId);
      await this.current(db, run, true);
      await db.query(
        'INSERT INTO kmz_review_session(import_id) VALUES($1) ON CONFLICT DO NOTHING',
        [importId],
      );
      await db.query('SELECT revision FROM kmz_review_session WHERE import_id=$1 FOR UPDATE', [
        importId,
      ]);
      const found = await db.query(
        `SELECT a.record_type,a.review_state,r.normalized,r.source_kind FROM kmz_analysis_result a JOIN kmz_import_record r ON r.id=a.record_id WHERE a.run_id=$1 AND a.record_id=$2`,
        [run.id, recordId],
      );
      const result = found.rows[0];
      if (!result) throw new ApiError(404, 'record_missing', 'Not found');
      const prior = (
        await db.query<Row>('SELECT * FROM kmz_review_record WHERE record_id=$1 FOR UPDATE', [
          recordId,
        ])
      ).rows[0];
      if (prior && prior.analysis_id !== run.id && expectedRevision !== 0)
        throw new ApiError(409, 'analysis_changed', 'Analysis changed; review again');
      const active = prior?.analysis_id === run.id ? prior : undefined;
      if (Number(active?.revision ?? 0) !== expectedRevision)
        throw new ApiError(409, 'review_changed', 'Review changed');
      const before = reviewValue(prior);
      const after = {
        ...reviewValue(active),
        ...body,
        proposed: {
          ...(reviewValue(active).proposed as Record<string, unknown>),
          ...(body.proposed ?? {}),
        },
      };
      if (!['LINK', 'UPDATE'].includes(String(after.action))) {
        after.target_customer_id = null;
        after.target_customer_version = null;
        after.target_establishment_id = null;
        after.target_establishment_version = null;
        after.selected_fields = [];
      }
      await this.validateDecision(db, importId, result, after);
      const revision = expectedRevision + 1;
      await db.query(
        `INSERT INTO kmz_review_record(record_id,import_id,analysis_id,revision,proposed,action,target_customer_id,target_customer_version,target_establishment_id,target_establishment_version,selected_fields,reason,acknowledged_conflict,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT(record_id) DO UPDATE SET analysis_id=$3,revision=$4,proposed=$5,action=$6,target_customer_id=$7,target_customer_version=$8,target_establishment_id=$9,target_establishment_version=$10,selected_fields=$11,reason=$12,acknowledged_conflict=$13,updated_by=$14,updated_at=now()`,
        [
          recordId,
          importId,
          run.id,
          revision,
          JSON.stringify(after.proposed),
          after.action,
          after.target_customer_id,
          after.target_customer_version,
          after.target_establishment_id,
          after.target_establishment_version,
          after.selected_fields,
          after.reason,
          after.acknowledged_conflict,
          actorId,
        ],
      );
      await db.query(
        'INSERT INTO kmz_review_event(id,import_id,record_id,before_value,after_value,actor_id,request_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          importId,
          recordId,
          JSON.stringify(before),
          JSON.stringify(after),
          actorId,
          requestId,
        ],
      );
      await db.query(
        'UPDATE kmz_review_session SET revision=revision+1,updated_at=now() WHERE import_id=$1',
        [importId],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId,
        action: 'kmz.review.save',
        outcome: 'success',
        correlationId: requestId,
        metadata: {
          import_id: importId,
          record_id: recordId,
          action: String(after.action),
          revision,
        },
      });
      await db.query('COMMIT');
      return { record_id: recordId, revision, ...after };
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      release();
    }
  }

  private bulkInput(body: unknown): {
    record_ids: string[];
    action: 'CREATE' | 'EXCLUDE' | 'ASSIGN_GROUP';
    reason?: string;
    group_id?: string;
  } {
    if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
    const input = body as Record<string, unknown>;
    if (
      Object.keys(input).some(
        (key) => !['record_ids', 'action', 'reason', 'group_id'].includes(key),
      ) ||
      !Array.isArray(input.record_ids) ||
      input.record_ids.length < 1 ||
      input.record_ids.length > 100 ||
      input.record_ids.some((item) => !id(item)) ||
      new Set(input.record_ids).size !== input.record_ids.length ||
      !['CREATE', 'EXCLUDE', 'ASSIGN_GROUP'].includes(String(input.action))
    )
      invalid();
    if (input.action === 'EXCLUDE' && !text(input.reason, 500)) invalid();
    if (input.action === 'ASSIGN_GROUP' && !id(input.group_id)) invalid();
    return input as ReturnType<KmzReviewService['bulkInput']>;
  }

  private async bulkCheck(
    db: Pool | PoolClient,
    importId: string,
    run: Context,
    input: ReturnType<KmzReviewService['bulkInput']>,
  ): Promise<{ digest: string; items: Record<string, unknown>[] }> {
    const found = await db.query(
      `SELECT a.record_id,a.review_state,a.record_type,r.normalized,r.source_kind,coalesce(v.revision,0)::int AS revision,v.action
      FROM kmz_analysis_result a JOIN kmz_import_record r ON r.id=a.record_id LEFT JOIN kmz_review_record v ON v.record_id=a.record_id AND v.analysis_id=a.run_id WHERE a.run_id=$1 AND a.record_id=ANY($2::uuid[]) ORDER BY a.record_id`,
      [run.id, input.record_ids],
    );
    if (
      found.rows.length !== input.record_ids.length ||
      found.rows.some(
        (row) =>
          row.review_state === 'CONFLICT' ||
          row.review_state === 'INVALID' ||
          (row.action && row.action !== 'PENDING'),
      )
    )
      invalid();
    if (
      input.action === 'CREATE' &&
      found.rows.some(
        (row) =>
          row.review_state !== 'NEW' ||
          !['CLIENT_CANDIDATE', 'REFERENCE_POINT'].includes(row.record_type) ||
          !text(row.normalized.name, 200) ||
          !point(row.normalized.point ?? {}),
      )
    )
      invalid();
    if (input.action === 'ASSIGN_GROUP') {
      const group = await db.query(
        "SELECT 1 FROM kmz_import_record WHERE id=$1 AND import_id=$2 AND source_kind IN ('TERRITORY_GROUP','WEEKLY_GROUP','FOLDER')",
        [input.group_id, importId],
      );
      if (!group.rowCount) invalid();
    }
    const digest = createHash('sha256')
      .update(
        JSON.stringify({
          importId,
          analysisId: run.id,
          catalogRevision: run.catalog_revision,
          input,
          rows: found.rows.map((row) => [row.record_id, row.revision]),
        }),
      )
      .digest('hex');
    return {
      digest,
      items: found.rows.map((row) => ({
        record_id: row.record_id,
        revision: row.revision,
        review_state: row.review_state,
        name: row.normalized.name,
      })),
    };
  }

  async bulkPreview(
    actorId: string,
    importId: string,
    body: unknown,
  ): Promise<Record<string, unknown>> {
    const input = this.bulkInput(body);
    const run = await this.context(this.pool, actorId, importId);
    await this.current(this.pool, run);
    return {
      ...(await this.bulkCheck(this.pool, importId, run, input)),
      action: input.action,
      count: input.record_ids.length,
    };
  }

  async bulkApply(
    actorId: string,
    importId: string,
    body: unknown,
    digest: string,
    requestId: string,
  ): Promise<Record<string, unknown>> {
    const input = this.bulkInput(body);
    if (!/^[0-9a-f]{64}$/.test(digest)) invalid();
    const db = await this.pool.connect();
    const release = guardClient(db);
    try {
      await db.query('BEGIN');
      await db.query("SELECT pg_advisory_xact_lock(hashtext('kmz.analysis'),hashtext($1))", [
        importId,
      ]);
      if (
        (
          await db.query("SELECT 1 FROM kmz_import_commit WHERE import_id=$1 AND state='APPLIED'", [
            importId,
          ])
        ).rowCount
      )
        throw new ApiError(409, 'import_already_applied', 'Import already applied');
      const run = await this.context(db, actorId, importId);
      await this.current(db, run, true);
      await db.query(
        'INSERT INTO kmz_review_session(import_id) VALUES($1) ON CONFLICT DO NOTHING',
        [importId],
      );
      await db.query('SELECT revision FROM kmz_review_session WHERE import_id=$1 FOR UPDATE', [
        importId,
      ]);
      const checked = await this.bulkCheck(db, importId, run, input);
      if (checked.digest !== digest)
        throw new ApiError(409, 'bulk_preview_changed', 'Preview changed');
      const batchId = randomUUID();
      for (const item of checked.items) {
        const recordId = item.record_id as string;
        const prior = (
          await db.query<Row>('SELECT * FROM kmz_review_record WHERE record_id=$1 FOR UPDATE', [
            recordId,
          ])
        ).rows[0];
        const before = reviewValue(prior);
        const after = {
          ...reviewValue(prior?.analysis_id === run.id ? prior : undefined),
          action: input.action === 'ASSIGN_GROUP' ? 'PENDING' : input.action,
          reason: input.reason ?? null,
          proposed: {
            ...(before.proposed as Record<string, unknown>),
            ...(input.group_id ? { group_id: input.group_id } : {}),
          },
        };
        const revision = Number(item.revision) + 1;
        await db.query(
          `INSERT INTO kmz_review_record(record_id,import_id,analysis_id,revision,proposed,action,reason,updated_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(record_id) DO UPDATE SET analysis_id=$3,revision=$4,proposed=$5,action=$6,reason=$7,target_customer_id=NULL,target_customer_version=NULL,target_establishment_id=NULL,target_establishment_version=NULL,selected_fields='{}',acknowledged_conflict=false,updated_by=$8,updated_at=now()`,
          [
            recordId,
            importId,
            run.id,
            revision,
            JSON.stringify(after.proposed),
            after.action,
            after.reason,
            actorId,
          ],
        );
        await db.query(
          'INSERT INTO kmz_review_event(id,import_id,record_id,batch_id,before_value,after_value,actor_id,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            randomUUID(),
            importId,
            recordId,
            batchId,
            JSON.stringify(before),
            JSON.stringify(after),
            actorId,
            requestId,
          ],
        );
      }
      await db.query(
        'UPDATE kmz_review_session SET revision=revision+$2,updated_at=now() WHERE import_id=$1',
        [importId, checked.items.length],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId,
        action: 'kmz.review.bulk',
        outcome: 'success',
        correlationId: requestId,
        metadata: {
          import_id: importId,
          batch_id: batchId,
          count: checked.items.length,
          action: input.action,
        },
      });
      await db.query('COMMIT');
      return { batch_id: batchId, count: checked.items.length };
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      release();
    }
  }

  async preview(actorId: string, importId: string, page = 1): Promise<Record<string, unknown>> {
    if (!Number.isInteger(page) || page < 1) invalid();
    const summary = await this.summary(actorId, importId);
    const found = await this.pool.query(
      `SELECT a.record_id,a.review_state,a.conflicts,a.warnings,r.normalized->>'name' AS source_name,v.action,v.proposed,v.target_customer_id,v.target_establishment_id,v.selected_fields,v.reason
      FROM kmz_analysis_result a JOIN kmz_import_record r ON r.id=a.record_id LEFT JOIN kmz_review_record v ON v.record_id=a.record_id AND v.analysis_id=a.run_id
      WHERE a.run_id=$1 ORDER BY a.ordinal LIMIT 100 OFFSET $2`,
      [summary.analysis_id, (page - 1) * 100],
    );
    return { summary, page, items: found.rows, operational_confirmation_available: false };
  }
}
