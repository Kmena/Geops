import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Pool } from 'pg';
import { appendAudit } from '../audit/index.js';
import { guardClient } from '../db/client-guard.js';
import { ApiError } from '../errors.js';
import {
  buildIntraPairs,
  comparisonCode,
  comparisonName,
  DEFAULT_MATCH_CONFIG,
  hasIdentityEvidence,
  MATCHER_RULESET,
  normalizedCode,
  normalizedName,
  pointOf,
  proximityBand,
  recordType,
  similarName,
  type MatchConfig,
  type StageRecord,
} from './matcher.js';
import type { KmzService } from './service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POINT_KINDS = "('CLIENT_POINT','BRANCH_POINT','WEEKLY_STOP')";
const inputSql = `WITH input AS MATERIALIZED (
  SELECT id,normalized,
    regexp_replace(normalized->>'name','^[[:space:]]*[0-9]{1,20}[[:space:]]*[-:][[:space:]]*','') AS comparison_name,
    COALESCE(NULLIF(normalized->>'code',''),
      substring(normalized->>'name' from '^[[:space:]]*([0-9]{1,20})[[:space:]]*[-:]')) AS comparison_code,
    ST_SetSRID(ST_MakePoint(
    (normalized #>> '{point,longitude}')::double precision,
    (normalized #>> '{point,latitude}')::double precision),4326)::geography AS geog
  FROM kmz_import_record
  WHERE import_id=$1 AND source_kind IN ${POINT_KINDS}
)`;

type RunRow = {
  id: string;
  import_id: string;
  version: number;
  matcher_version: string;
  catalog_revision: string;
  state: string;
  config: MatchConfig;
  summary: Record<string, unknown>;
  error_code: string | null;
  started_at: Date;
  completed_at: Date | null;
};
type CatalogHit = {
  record_id: string;
  target_id: string;
  target_version: string;
  target_name: string;
  distance_m: number | null;
  establishment_id?: string;
  source_key?: string | null;
  source_namespace?: string | null;
  signal: string;
  target_type: 'CUSTOMER' | 'ESTABLISHMENT' | 'PIN';
};
type Candidate = {
  record_id: string;
  target_type: 'CUSTOMER' | 'ESTABLISHMENT' | 'PIN' | 'STAGING_RECORD';
  target_id: string;
  target_version: number | null;
  distance_m: number | null;
  proximity_band: 'HIGH' | 'EXTENDED' | null;
  confidence: 'IDENTIFIER' | 'CORROBORATED' | 'POSSIBLE' | 'WEAK';
  signals: string[];
};
type AnalysisResult = {
  record_id: string;
  ordinal: number;
  record_type: string;
  review_state: string;
  warnings: string[];
  conflicts: string[];
  evidence: Record<string, unknown>;
};

function publicRun(row: RunRow): Record<string, unknown> {
  return {
    analysis_id: row.id,
    import_id: row.import_id,
    analysis_version: row.version,
    matcher_version: row.matcher_version,
    catalog_revision: Number(row.catalog_revision),
    state: row.state,
    config: row.config,
    summary: row.summary,
    error_code: row.error_code,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

function parseConfig(body: unknown): MatchConfig {
  if (body === undefined || body === null) return DEFAULT_MATCH_CONFIG;
  if (typeof body !== 'object' || Array.isArray(body))
    throw new ApiError(422, 'invalid_match_config', 'Invalid request');
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['high_meters', 'extended_meters'].includes(key)))
    throw new ApiError(422, 'invalid_match_config', 'Invalid request');
  const highMeters = input.high_meters ?? DEFAULT_MATCH_CONFIG.highMeters;
  const extendedMeters = input.extended_meters ?? DEFAULT_MATCH_CONFIG.extendedMeters;
  if (
    typeof highMeters !== 'number' ||
    typeof extendedMeters !== 'number' ||
    !Number.isFinite(highMeters) ||
    !Number.isFinite(extendedMeters) ||
    highMeters < 1 ||
    highMeters > extendedMeters ||
    extendedMeters > 1_000
  )
    throw new ApiError(422, 'invalid_match_config', 'Invalid request');
  return { highMeters, extendedMeters };
}

function page(
  query: Record<string, unknown>,
  allowed: string[],
): { cursor: number; limit: number } {
  if (Object.keys(query).some((key) => !allowed.includes(key)))
    throw new ApiError(422, 'invalid_request', 'Invalid request');
  const cursor = query.cursor === undefined ? -1 : Number(query.cursor);
  const limit = query.limit === undefined ? 25 : Number(query.limit);
  if (
    !Number.isInteger(cursor) ||
    cursor < -1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new ApiError(422, 'invalid_request', 'Invalid request');
  return { cursor, limit };
}

export class KmzAnalysisService {
  constructor(
    private readonly pool: Pool,
    private readonly kmz: KmzService,
  ) {}

  private async latest(actorId: string, importId: string): Promise<RunRow> {
    await this.kmz.get(actorId, importId);
    const result = await this.pool.query<RunRow>(
      'SELECT * FROM kmz_analysis_run WHERE import_id=$1 ORDER BY version DESC LIMIT 1',
      [importId],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, 'analysis_missing', 'Not found');
    return row;
  }

  private async catalogHits(
    importId: string,
    config: MatchConfig,
    query: (sql: string, values?: unknown[]) => Promise<{ rows: CatalogHit[] }>,
  ): Promise<CatalogHit[]> {
    const spatialEstablishments = await query(
      `${inputSql}
       SELECT i.id AS record_id,e.id AS target_id,e.version AS target_version,
         e.name AS target_name,ST_Distance(e.geog,i.geog) AS distance_m,
         e.id AS establishment_id,e.source_key,s.namespace AS source_namespace,
         'ESTABLISHMENT_SPATIAL' AS signal,'ESTABLISHMENT' AS target_type
       FROM input i JOIN LATERAL (
         SELECT * FROM catalog_establishment e
         WHERE e.archived_at IS NULL AND e.classification <> 'ARCHIVED'
           AND i.geog IS NOT NULL AND e.geog IS NOT NULL
           AND ST_DWithin(e.geog,i.geog,$2 + 0.001)
           AND ST_Distance(e.geog,i.geog) <= $2
         ORDER BY e.geog <-> i.geog LIMIT 21
       ) e ON true LEFT JOIN catalog_source s ON s.id=e.source_id`,
      [importId, config.extendedMeters],
    );
    const namedEstablishments = await query(
      `${inputSql}
       SELECT i.id AS record_id,e.id AS target_id,e.version AS target_version,
         e.name AS target_name,
         CASE WHEN e.geog IS NOT NULL AND i.geog IS NOT NULL THEN ST_Distance(e.geog,i.geog) ELSE NULL END AS distance_m,
         e.id AS establishment_id,e.source_key,s.namespace AS source_namespace,
         'ESTABLISHMENT_NAME' AS signal,'ESTABLISHMENT' AS target_type
       FROM input i JOIN LATERAL (
         SELECT * FROM catalog_establishment e
         WHERE e.archived_at IS NULL AND e.classification <> 'ARCHIVED'
           AND (lower(e.name)=lower(i.comparison_name) OR lower(e.name)=lower(i.normalized->>'name'))
         ORDER BY e.id LIMIT 21
       ) e ON true LEFT JOIN catalog_source s ON s.id=e.source_id`,
      [importId],
    );
    const codedEstablishments = await query(
      `${inputSql}
       SELECT i.id AS record_id,e.id AS target_id,e.version AS target_version,
         e.name AS target_name,
         CASE WHEN e.geog IS NOT NULL AND i.geog IS NOT NULL THEN ST_Distance(e.geog,i.geog) ELSE NULL END AS distance_m,
         e.id AS establishment_id,e.source_key,s.namespace AS source_namespace,
         'ESTABLISHMENT_SOURCE_KEY' AS signal,'ESTABLISHMENT' AS target_type
       FROM input i JOIN LATERAL (
         SELECT * FROM catalog_establishment e
         WHERE e.archived_at IS NULL AND e.source_key IS NOT NULL
           AND e.source_key=i.comparison_code
         ORDER BY e.id LIMIT 21
       ) e ON true LEFT JOIN catalog_source s ON s.id=e.source_id`,
      [importId],
    );
    const explicitEstablishments = await query(
      `${inputSql}
       SELECT i.id AS record_id,e.id AS target_id,e.version AS target_version,
         e.name AS target_name,
         CASE WHEN e.geog IS NOT NULL AND i.geog IS NOT NULL THEN ST_Distance(e.geog,i.geog) ELSE NULL END AS distance_m,
         e.id AS establishment_id,e.source_key,s.namespace AS source_namespace,
         'EXPLICIT_GEOPS_ESTABLISHMENT_ID' AS signal,'ESTABLISHMENT' AS target_type
       FROM input i JOIN catalog_establishment e
         ON e.id=CASE WHEN i.normalized->>'geops_establishment_id' ~* $2
           THEN (i.normalized->>'geops_establishment_id')::uuid ELSE NULL END
       LEFT JOIN catalog_source s ON s.id=e.source_id
       WHERE e.archived_at IS NULL`,
      [importId, UUID.source],
    );
    const pins = await query(
      `${inputSql}
       SELECT i.id AS record_id,p.id AS target_id,p.version AS target_version,
         e.name AS target_name,ST_Distance(p.geog,i.geog) AS distance_m,
         e.id AS establishment_id,e.source_key,s.namespace AS source_namespace,
         'PIN_SPATIAL' AS signal,'PIN' AS target_type
       FROM input i JOIN LATERAL (
         SELECT * FROM catalog_pin p
         WHERE p.state <> 'ARCHIVED' AND i.geog IS NOT NULL
           AND ST_DWithin(p.geog,i.geog,$2 + 0.001)
           AND ST_Distance(p.geog,i.geog) <= $2
         ORDER BY p.geog <-> i.geog LIMIT 21
       ) p ON true JOIN catalog_establishment e ON e.id=p.establishment_id
       LEFT JOIN catalog_source s ON s.id=e.source_id
       WHERE e.archived_at IS NULL`,
      [importId, config.extendedMeters],
    );
    const explicitPins = await query(
      `${inputSql}
       SELECT i.id AS record_id,p.id AS target_id,p.version AS target_version,
         e.name AS target_name,
         CASE WHEN i.geog IS NOT NULL THEN ST_Distance(p.geog,i.geog) ELSE NULL END AS distance_m,
         e.id AS establishment_id,e.source_key,s.namespace AS source_namespace,
         'EXPLICIT_GEOPS_PIN_ID' AS signal,'PIN' AS target_type
       FROM input i JOIN catalog_pin p
         ON p.id=CASE WHEN i.normalized->>'geops_pin_id' ~* $2
           THEN (i.normalized->>'geops_pin_id')::uuid ELSE NULL END
       JOIN catalog_establishment e ON e.id=p.establishment_id
       LEFT JOIN catalog_source s ON s.id=e.source_id
       WHERE p.state <> 'ARCHIVED' AND e.archived_at IS NULL`,
      [importId, UUID.source],
    );
    const namedCustomers = await query(
      `${inputSql}
       SELECT i.id AS record_id,c.id AS target_id,c.version AS target_version,
         c.name AS target_name,NULL::double precision AS distance_m,
         NULL::uuid AS establishment_id,NULL::text AS source_key,NULL::text AS source_namespace,
         'CUSTOMER_NAME' AS signal,'CUSTOMER' AS target_type
       FROM input i JOIN LATERAL (
         SELECT * FROM catalog_customer c WHERE c.archived_at IS NULL
           AND (lower(c.name)=lower(i.comparison_name) OR lower(c.name)=lower(i.normalized->>'name'))
         ORDER BY c.id LIMIT 21
       ) c ON true`,
      [importId],
    );
    const explicitCustomers = await query(
      `${inputSql}
       SELECT i.id AS record_id,c.id AS target_id,c.version AS target_version,
         c.name AS target_name,NULL::double precision AS distance_m,
         NULL::uuid AS establishment_id,NULL::text AS source_key,NULL::text AS source_namespace,
         'EXPLICIT_GEOPS_CUSTOMER_ID' AS signal,'CUSTOMER' AS target_type
       FROM input i JOIN catalog_customer c
         ON c.id=CASE WHEN i.normalized->>'geops_customer_id' ~* $2
           THEN (i.normalized->>'geops_customer_id')::uuid ELSE NULL END
       WHERE c.archived_at IS NULL`,
      [importId, UUID.source],
    );
    const hits = [
      ...spatialEstablishments.rows,
      ...namedEstablishments.rows,
      ...codedEstablishments.rows,
      ...explicitEstablishments.rows,
      ...pins.rows,
      ...explicitPins.rows,
      ...namedCustomers.rows,
      ...explicitCustomers.rows,
    ];
    const establishmentIds = [
      ...new Set(hits.map((hit) => hit.establishment_id).filter((id): id is string => !!id)),
    ];
    if (establishmentIds.length) {
      const linked = await query(
        `SELECT ce.establishment_id,c.id AS target_id,c.version AS target_version,
          c.name AS target_name FROM catalog_customer_establishment ce
          JOIN catalog_customer c ON c.id=ce.customer_id
          WHERE ce.establishment_id=ANY($1::uuid[]) AND c.archived_at IS NULL`,
        [establishmentIds],
      );
      const byEstablishment = new Map<string, CatalogHit[]>();
      for (const row of linked.rows) {
        const bucket = byEstablishment.get(row.establishment_id ?? '') ?? [];
        bucket.push(row);
        byEstablishment.set(row.establishment_id ?? '', bucket);
      }
      for (const hit of [...hits])
        for (const customer of byEstablishment.get(hit.establishment_id ?? '') ?? [])
          hits.push({
            ...customer,
            record_id: hit.record_id,
            target_type: 'CUSTOMER',
            distance_m: hit.distance_m,
            signal: 'LINKED_CUSTOMER',
          });
    }
    return hits;
  }

  async analyze(
    actorId: string,
    importId: string,
    body: unknown,
    requestId: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const config = parseConfig(body);
    const session = await this.kmz.get(actorId, importId);
    if (session.state !== 'READY') throw new ApiError(409, 'import_not_ready', 'Conflict');
    if (new Date(session.expires_at).getTime() <= Date.now())
      throw new ApiError(410, 'import_expired', 'Import expired');
    const matcherVersion = `${MATCHER_RULESET}-${createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16)}`;
    const db = await this.pool.connect();
    const release = guardClient(db);
    let locked = false;
    let runId: string | null = null;
    let queryCount = 0;
    const query = async (sql: string, values: unknown[] = []) => {
      queryCount++;
      return db.query(sql, values);
    };
    try {
      await query("SELECT pg_advisory_lock(hashtext('kmz.analysis'),hashtext($1))", [importId]);
      locked = true;
      await query(
        "UPDATE kmz_analysis_run SET state='FAILED',error_code='ANALYSIS_INTERRUPTED',completed_at=now() WHERE import_id=$1 AND state='PROCESSING'",
        [importId],
      );
      if (
        (
          await query("SELECT 1 FROM kmz_import_commit WHERE import_id=$1 AND state='APPLIED'", [
            importId,
          ])
        ).rowCount
      )
        throw new ApiError(409, 'import_already_applied', 'Import already applied');
      const revision = await query('SELECT version FROM catalog_revision WHERE singleton=true');
      const catalogRevision = String(revision.rows[0]?.version ?? '0');
      const existing = await query(
        'SELECT * FROM kmz_analysis_run WHERE import_id=$1 ORDER BY version DESC LIMIT 1',
        [importId],
      );
      const prior = existing.rows[0] as RunRow | undefined;
      if (
        prior?.state === 'READY' &&
        prior.matcher_version === matcherVersion &&
        String(prior.catalog_revision) === catalogRevision
      )
        return { status: 200, body: publicRun(prior) };
      const next = await query(
        'SELECT COALESCE(max(version),0)+1 AS version FROM kmz_analysis_run WHERE import_id=$1',
        [importId],
      );
      const version = Number(next.rows[0]?.version ?? 1);
      runId = randomUUID();
      await query(
        "INSERT INTO kmz_analysis_run(id,import_id,version,matcher_version,catalog_revision,state,config,created_by) VALUES($1,$2,$3,$4,$5,'PROCESSING',$6,$7)",
        [
          runId,
          importId,
          version,
          matcherVersion,
          catalogRevision,
          JSON.stringify(config),
          actorId,
        ],
      );
      await query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const snapshotRevision = await query(
        'SELECT version FROM catalog_revision WHERE singleton=true',
      );
      await query('UPDATE kmz_analysis_run SET catalog_revision=$2 WHERE id=$1', [
        runId,
        String(snapshotRevision.rows[0]?.version ?? catalogRevision),
      ]);
      const start = performance.now();
      const cpu = process.cpuUsage();
      let peakRss = process.memoryUsage().rss;
      const stage = await query(
        'SELECT id,ordinal,source_path,parent_path,source_kind,week_label,normalized,warnings,errors FROM kmz_import_record WHERE import_id=$1 ORDER BY ordinal',
        [importId],
      );
      const records = stage.rows as StageRecord[];
      const byId = new Map(records.map((record) => [record.id, record]));
      const byPath = new Map(records.map((record) => [record.source_path, record]));
      const underHeredia = (record: StageRecord): boolean => {
        let parent = record.parent_path;
        for (let depth = 0; parent && depth < 32; depth++) {
          const ancestor = byPath.get(parent);
          if (!ancestor) break;
          if (/heredia/iu.test(String(ancestor.normalized.name ?? ''))) return true;
          parent = ancestor.parent_path;
        }
        return false;
      };
      const catalog = await this.catalogHits(importId, config, async (sql, values = []) => {
        const result = await query(sql, values);
        return { rows: result.rows as CatalogHit[] };
      });
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      const intra = buildIntraPairs(records, config.extendedMeters);
      const candidateMap = new Map<string, Map<string, Candidate>>();
      const conflictMap = new Map<string, Set<string>>();
      const warningMap = intra.warnings;
      const markConflict = (id: string, code: string) => {
        const bucket = conflictMap.get(id) ?? new Set<string>();
        bucket.add(code);
        conflictMap.set(id, bucket);
      };
      const markWarning = (id: string, code: string) => {
        const bucket = warningMap.get(id) ?? new Set<string>();
        bucket.add(code);
        warningMap.set(id, bucket);
      };
      const add = (candidate: Candidate) => {
        const bucket = candidateMap.get(candidate.record_id) ?? new Map<string, Candidate>();
        const key = `${candidate.target_type}:${candidate.target_id}`;
        const prior = bucket.get(key);
        if (prior) {
          for (const signal of candidate.signals)
            if (!prior.signals.includes(signal)) prior.signals.push(signal);
          if (prior.distance_m === null && candidate.distance_m !== null)
            prior.distance_m = candidate.distance_m;
          prior.proximity_band = proximityBand(prior.distance_m, config);
          if (prior.signals.some((signal) => signal.startsWith('EXPLICIT_')))
            prior.confidence = 'IDENTIFIER';
          else if (prior.signals.includes('NAME_NORMALIZED_EXACT') && prior.proximity_band)
            prior.confidence = 'CORROBORATED';
        } else if (bucket.size < 40) bucket.set(key, candidate);
        else markWarning(candidate.record_id, 'CANDIDATE_LIMIT');
        candidateMap.set(candidate.record_id, bucket);
      };
      const catalogHitCounts = new Map<string, number>();
      for (const hit of catalog) {
        const record = byId.get(hit.record_id);
        if (!record) continue;
        if (hit.signal !== 'LINKED_CUSTOMER') {
          const key = `${hit.record_id}:${hit.signal}`;
          const count = (catalogHitCounts.get(key) ?? 0) + 1;
          catalogHitCounts.set(key, count);
          if (count >= 21) markWarning(hit.record_id, 'CANDIDATE_LIMIT');
        }
        const distance = hit.distance_m === null ? null : Number(hit.distance_m);
        const nameExact =
          comparisonName(record.normalized.name) === normalizedName(hit.target_name);
        const codeExact =
          !!hit.source_key && comparisonCode(record).value === normalizedCode(hit.source_key);
        const signals = [hit.signal];
        if (nameExact) signals.push('NAME_NORMALIZED_EXACT');
        else if (
          similarName(comparisonName(record.normalized.name), normalizedName(hit.target_name))
        )
          signals.push('NAME_SIMILAR');
        if (codeExact) signals.push('SOURCE_KEY_EXACT_NON_AUTHORITATIVE');
        if (codeExact && hit.source_namespace)
          signals.push(`SOURCE_NAMESPACE:${hit.source_namespace}`);
        const band = proximityBand(distance, config);
        if (band) signals.push(`PROXIMITY_${band}`);
        add({
          record_id: hit.record_id,
          target_type: hit.target_type,
          target_id: hit.target_id,
          target_version: Number(hit.target_version),
          distance_m: distance,
          proximity_band: band,
          confidence: hit.signal.startsWith('EXPLICIT_')
            ? 'IDENTIFIER'
            : nameExact && band
              ? 'CORROBORATED'
              : nameExact || codeExact || band
                ? 'POSSIBLE'
                : 'WEAK',
          signals,
        });
        if (codeExact && !nameExact && distance !== null && distance > config.extendedMeters)
          markConflict(hit.record_id, 'CODE_NAME_LOCATION_CONFLICT');
        if (hit.signal.startsWith('EXPLICIT_') && !nameExact)
          markConflict(hit.record_id, 'IDENTITY_NAME_CONFLICT');
        if (
          hit.signal.startsWith('EXPLICIT_') &&
          distance !== null &&
          distance > config.extendedMeters
        )
          markConflict(hit.record_id, 'IDENTITY_LOCATION_CONFLICT');
      }
      for (const record of records) {
        for (const field of [
          'geops_customer_id',
          'geops_establishment_id',
          'geops_pin_id',
        ] as const) {
          const value = record.normalized[field];
          if (typeof value !== 'string' || !value) continue;
          const targetType =
            field === 'geops_customer_id'
              ? 'CUSTOMER'
              : field === 'geops_pin_id'
                ? 'PIN'
                : 'ESTABLISHMENT';
          if (!UUID.test(value) || !candidateMap.get(record.id)?.has(`${targetType}:${value}`))
            markConflict(record.id, 'INCONSISTENT_GEOPS_REFERENCE');
        }
      }
      for (let offset = 0; offset < intra.pairs.length; offset += 1_000) {
        const chunk = intra.pairs.slice(offset, offset + 1_000);
        const left = chunk.map((pair) => pair.left);
        const right = chunk.map((pair) => pair.right);
        const distances = await query(
          `WITH pairs AS (SELECT * FROM unnest($1::uuid[],$2::uuid[]) AS p(left_id,right_id))
           SELECT p.left_id,p.right_id,
             CASE WHEN a.normalized->'point' IS NOT NULL AND b.normalized->'point' IS NOT NULL
             THEN ST_Distance(
               ST_SetSRID(ST_MakePoint((a.normalized #>> '{point,longitude}')::double precision,
                 (a.normalized #>> '{point,latitude}')::double precision),4326)::geography,
               ST_SetSRID(ST_MakePoint((b.normalized #>> '{point,longitude}')::double precision,
                 (b.normalized #>> '{point,latitude}')::double precision),4326)::geography)
             ELSE NULL END AS distance_m
           FROM pairs p JOIN kmz_import_record a ON a.id=p.left_id
             JOIN kmz_import_record b ON b.id=p.right_id`,
          [left, right],
        );
        const distancesByKey = new Map<string, number | null>();
        for (const row of distances.rows)
          distancesByKey.set(
            `${row.left_id}:${row.right_id}`,
            row.distance_m === null ? null : Number(row.distance_m),
          );
        for (const pair of chunk) {
          const distance = distancesByKey.get(`${pair.left}:${pair.right}`) ?? null;
          const band = proximityBand(distance, config);
          const a = byId.get(pair.left);
          const b = byId.get(pair.right);
          if (!a || !b) continue;
          if (band && !pair.rules.includes('IN_FILE_PROXIMITY'))
            pair.rules.push('IN_FILE_PROXIMITY');
          if (distance === 0) {
            markWarning(a.id, 'COORDINATE_COLLISION');
            markWarning(b.id, 'COORDINATE_COLLISION');
          }
          if (a.parent_path && a.parent_path === b.parent_path)
            pair.rules.push('SAME_PARENT_GROUP');
          if (a.week_label && a.week_label === b.week_label) pair.rules.push('SAME_WEEK');
          if (
            pair.rules.includes('IN_FILE_CODE') &&
            comparisonName(a.normalized.name) !== comparisonName(b.normalized.name) &&
            (distance === null || distance > config.extendedMeters)
          ) {
            markConflict(a.id, 'CODE_NAME_LOCATION_CONFLICT');
            markConflict(b.id, 'CODE_NAME_LOCATION_CONFLICT');
          }
          if (
            (underHeredia(a) || underHeredia(b)) &&
            (pair.rules.includes('IN_FILE_CODE') || pair.rules.includes('IN_FILE_NAME'))
          ) {
            markWarning(a.id, 'HEREDIA_COPY_SUSPECT');
            markWarning(b.id, 'HEREDIA_COPY_SUSPECT');
          }
          for (const [source, target] of [
            [a, b],
            [b, a],
          ] as const)
            add({
              record_id: source.id,
              target_type: 'STAGING_RECORD',
              target_id: target.id,
              target_version: null,
              distance_m: distance,
              proximity_band: band,
              confidence:
                pair.rules.includes('IN_FILE_CODE') || pair.rules.includes('IN_FILE_NAME')
                  ? 'POSSIBLE'
                  : 'WEAK',
              signals: [...pair.rules, ...(band ? [`PROXIMITY_${band}`] : [])],
            });
        }
      }
      const results: AnalysisResult[] = [];
      const candidates: Candidate[] = [];
      const stateCounts: Record<string, number> = {};
      const typeCounts: Record<string, number> = {};
      for (const record of records) {
        const type = recordType(record.source_kind, record.errors);
        const warnings = new Set([...record.warnings, ...(warningMap.get(record.id) ?? [])]);
        const conflicts = new Set(conflictMap.get(record.id) ?? []);
        if (record.source_kind === 'WEEKLY_STOP') warnings.add('UNLINKED_STOP');
        if (record.source_kind === 'OTHER' && !pointOf(record)) warnings.add('NO_LOCATION');
        const matches = [...(candidateMap.get(record.id)?.values() ?? [])];
        const identityMatches = matches.filter(hasIdentityEvidence);
        const customers = identityMatches.filter((match) => match.target_type === 'CUSTOMER');
        const strong = customers.filter(
          (match) => match.confidence === 'IDENTIFIER' || match.confidence === 'CORROBORATED',
        );
        if (customers.length > 1) conflicts.add('MULTIPLE_CUSTOMER_CANDIDATES');
        let state = 'NEW';
        if (record.errors.length || (type === 'INVALID_OR_OTHER' && record.source_kind === 'OTHER'))
          state = 'INVALID';
        else if (conflicts.size) state = 'CONFLICT';
        else if (
          customers.length === 1 &&
          strong.length === 1 &&
          !identityMatches.some((match) => match.target_type === 'STAGING_RECORD') &&
          identityMatches.filter((match) => match.target_type === 'ESTABLISHMENT').length <= 1 &&
          identityMatches.filter((match) => match.target_type === 'PIN').length <= 1
        )
          state = 'EXISTING_MATCH';
        else if (identityMatches.length) state = 'POSSIBLE_DUPLICATE';
        results.push({
          record_id: record.id,
          ordinal: record.ordinal,
          record_type: type,
          review_state: state,
          warnings: [...warnings].sort(),
          conflicts: [...conflicts].sort(),
          evidence: {
            source_kind: record.source_kind,
            source_path: record.source_path,
            parent_path: record.parent_path,
            week_label: record.week_label,
            candidate_count: matches.length,
            normalization: 'NFC code; accentless casefold name',
            code_source: comparisonCode(record).source,
          },
        });
        candidates.push(...matches);
        stateCounts[state] = (stateCounts[state] ?? 0) + 1;
        typeCounts[type] = (typeCounts[type] ?? 0) + 1;
      }
      for (let offset = 0; offset < results.length; offset += 200) {
        const chunk = results.slice(offset, offset + 200);
        await query(
          `INSERT INTO kmz_analysis_result(run_id,record_id,ordinal,record_type,review_state,warnings,conflicts,evidence)
           SELECT $1::uuid,x.record_id::uuid,x.ordinal,x.record_type,x.review_state,x.warnings,x.conflicts,x.evidence
           FROM jsonb_to_recordset($2::jsonb) AS x(record_id text,ordinal integer,record_type text,
             review_state text,warnings jsonb,conflicts jsonb,evidence jsonb)`,
          [runId, JSON.stringify(chunk)],
        );
      }
      for (let offset = 0; offset < candidates.length; offset += 200) {
        const chunk = candidates.slice(offset, offset + 200);
        await query(
          `INSERT INTO kmz_analysis_candidate(run_id,record_id,target_type,target_id,target_version,
             distance_m,proximity_band,confidence,signals)
           SELECT $1::uuid,x.record_id::uuid,x.target_type,x.target_id::uuid,x.target_version,
             x.distance_m,x.proximity_band,x.confidence,x.signals
           FROM jsonb_to_recordset($2::jsonb) AS x(record_id text,target_type text,target_id text,
             target_version bigint,distance_m double precision,proximity_band text,confidence text,signals jsonb)`,
          [runId, JSON.stringify(chunk)],
        );
      }
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
      const elapsedMs = Math.round(performance.now() - start);
      const used = process.cpuUsage(cpu);
      const withInFileIdentityCandidate = new Set(
        candidates
          .filter(
            (candidate) =>
              candidate.target_type === 'STAGING_RECORD' && hasIdentityEvidence(candidate),
          )
          .map((candidate) => candidate.record_id),
      );
      const summary = {
        records: results.length,
        states: stateCounts,
        types: typeCounts,
        candidates: candidates.length,
        duplicate_records: results.filter(
          (r) =>
            r.warnings.includes('DUPLICATE_CODE') ||
            r.warnings.includes('COORDINATE_COLLISION') ||
            withInFileIdentityCandidate.has(r.record_id),
        ).length,
        conflicts: stateCounts.CONFLICT ?? 0,
        invalid: stateCounts.INVALID ?? 0,
        elapsed_ms: elapsedMs,
        cpu_ms: Math.round((used.user + used.system) / 1_000),
        peak_rss_bytes: peakRss,
        query_count: queryCount + 2,
      };
      const done = await query(
        "UPDATE kmz_analysis_run SET state='READY',summary=$2,completed_at=now() WHERE id=$1 RETURNING *",
        [runId, JSON.stringify(summary)],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId,
        action: 'kmz.analysis',
        outcome: 'success',
        correlationId: requestId,
        metadata: {
          import_id: importId,
          analysis_id: runId,
          version,
          records: results.length,
          candidates: candidates.length,
        },
      });
      await query('COMMIT');
      return { status: 200, body: publicRun(done.rows[0] as RunRow) };
    } catch (error) {
      try {
        await db.query('ROLLBACK');
      } catch {
        /* DB unavailable */
      }
      if (runId) {
        try {
          await db.query(
            "UPDATE kmz_analysis_run SET state='FAILED',error_code='ANALYSIS_FAILED',completed_at=now() WHERE id=$1 AND state='PROCESSING'",
            [runId],
          );
          await appendAudit(db, {
            actorType: 'ADMIN',
            actorId,
            action: 'kmz.analysis',
            outcome: 'failure',
            correlationId: requestId,
            metadata: { import_id: importId, analysis_id: runId },
          });
        } catch {
          /* Preserve the original failure. */
        }
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'kmz_analysis_unavailable', 'Service unavailable');
    } finally {
      if (locked) {
        try {
          await db.query("SELECT pg_advisory_unlock(hashtext('kmz.analysis'),hashtext($1))", [
            importId,
          ]);
        } catch {
          /* The connection is discarded by the pool when broken. */
        }
      }
      release();
    }
  }

  async summary(actorId: string, importId: string): Promise<Record<string, unknown>> {
    return publicRun(await this.latest(actorId, importId));
  }

  async results(
    actorId: string,
    importId: string,
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const run = await this.latest(actorId, importId);
    const { cursor, limit } = page(query, [
      'cursor',
      'limit',
      'state',
      'type',
      'warning',
      'search',
    ]);
    const state = query.state === undefined ? null : String(query.state);
    const type = query.type === undefined ? null : String(query.type);
    const warning = query.warning === undefined ? null : String(query.warning);
    const search = query.search === undefined ? null : String(query.search);
    if (
      (state &&
        !['NEW', 'EXISTING_MATCH', 'POSSIBLE_DUPLICATE', 'CONFLICT', 'INVALID'].includes(state)) ||
      (type &&
        ![
          'CLIENT_CANDIDATE',
          'REFERENCE_POINT',
          'WEEKLY_STOP',
          'GEOGRAPHIC_GROUP',
          'POLYGON',
          'LINE',
          'INVALID_OR_OTHER',
        ].includes(type)) ||
      (warning && warning.length > 60) ||
      (search && search.length > 120)
    )
      throw new ApiError(422, 'invalid_request', 'Invalid request');
    const found = await this.pool.query(
      `SELECT a.record_id,a.ordinal,a.record_type,a.review_state,a.warnings,a.conflicts,a.evidence,
        r.source_path,r.parent_path,r.source_kind,r.week_label,r.normalized
       FROM kmz_analysis_result a JOIN kmz_import_record r ON r.id=a.record_id
       WHERE a.run_id=$1 AND a.ordinal>$2 AND ($3::text IS NULL OR a.review_state=$3)
         AND ($4::text IS NULL OR a.record_type=$4)
         AND ($5::text IS NULL OR a.warnings ? $5)
         AND ($6::text IS NULL OR r.normalized->>'name' ILIKE '%'||$6||'%' OR r.normalized->>'code' ILIKE '%'||$6||'%')
       ORDER BY a.ordinal LIMIT $7`,
      [run.id, cursor, state, type, warning, search, limit + 1],
    );
    const rows = found.rows.slice(0, limit);
    return {
      analysis_version: run.version,
      items: rows,
      next_cursor: found.rows.length > limit ? rows.at(-1)?.ordinal : null,
    };
  }

  async candidates(
    actorId: string,
    importId: string,
    recordId: string,
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const run = await this.latest(actorId, importId);
    if (!UUID.test(recordId)) throw new ApiError(422, 'invalid_request', 'Invalid request');
    const { cursor, limit } = page(query, ['cursor', 'limit']);
    const owned = await this.pool.query(
      'SELECT 1 FROM kmz_analysis_result WHERE run_id=$1 AND record_id=$2',
      [run.id, recordId],
    );
    if (!owned.rowCount) throw new ApiError(404, 'record_missing', 'Not found');
    const found = await this.pool.query(
      `SELECT target_type,target_id,target_version,distance_m,proximity_band,confidence,signals
       FROM kmz_analysis_candidate WHERE run_id=$1 AND record_id=$2
       ORDER BY target_type,target_id OFFSET $3 LIMIT $4`,
      [run.id, recordId, cursor < 0 ? 0 : cursor, limit + 1],
    );
    const rows = found.rows.slice(0, limit);
    return {
      analysis_version: run.version,
      items: rows,
      next_cursor: found.rows.length > limit ? (cursor < 0 ? 0 : cursor) + limit : null,
    };
  }

  async conflicts(
    actorId: string,
    importId: string,
    query: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const run = await this.latest(actorId, importId);
    const { cursor, limit } = page(query, ['cursor', 'limit']);
    const found = await this.pool.query(
      `SELECT a.record_id,a.ordinal,a.record_type,a.review_state,a.conflicts,a.warnings,r.source_path
       FROM kmz_analysis_result a JOIN kmz_import_record r ON r.id=a.record_id
       WHERE a.run_id=$1 AND a.ordinal>$2 AND a.conflicts <> '[]'::jsonb
       ORDER BY a.ordinal LIMIT $3`,
      [run.id, cursor, limit + 1],
    );
    const rows = found.rows.slice(0, limit);
    return {
      analysis_version: run.version,
      items: rows,
      next_cursor: found.rows.length > limit ? rows.at(-1)?.ordinal : null,
    };
  }
}
