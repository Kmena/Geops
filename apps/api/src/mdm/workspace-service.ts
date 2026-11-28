import type { Pool } from 'pg';
import { appendAudit } from '../audit/index.js';
import type { DeviceDiagnosticsService } from '../device-diagnostics-service.js';
import { ApiError } from '../errors.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const issues = new Set([
  'unlinked',
  'permission',
  'battery',
  'capture',
  'transmission',
  'offline',
  'stale',
  'no_data',
  'configuration',
  'pending',
  'no_findings',
]);
const sorts: Record<string, string> = {
  name: 'display_label',
  contact: 'last_contact_at',
  diagnosis: 'received_at',
  android: 'android_release',
  app: 'app_version',
};

export interface WorkspaceQuery {
  q?: string;
  issue?: string;
  severity?: string;
  android?: string;
  app?: string;
  mdm?: string;
  age?: string;
  ownership?: string;
  sort?: string;
  direction?: string;
  page?: string;
  limit?: string;
  ids?: string;
}

interface DeviceRow {
  device_id: string;
  tenant_id: string;
  display_label: string;
  status: string;
  agent_name: string | null;
  ownership: string;
  installation_id: string | null;
  mdm_device_id: string | null;
  mdm_link_valid: boolean;
  manufacturer: string | null;
  model: string | null;
  android_release: string | null;
  app_version: string | null;
  observed_at: Date | null;
  received_at: Date | null;
  last_contact_at: Date | null;
  payload: Record<string, unknown> | null;
  findings: { code: string; classification: string; source: string }[] | null;
  no_data: boolean;
  stale: boolean;
  offline: boolean;
  permission_missing: boolean;
  battery_restricted: boolean;
  capture_problem: boolean;
  transmission_problem: boolean;
  configuration_pending: boolean;
  pending_corrections: number;
  total?: string;
}

/** One scoped SQL projection for both dashboard and listing; no vendor access or per-row queries. */
const base = `WITH owner_candidates AS (
  SELECT device_id,tenant_id FROM geops_device_tenant
  UNION
  SELECT geops_device_id AS device_id,customer_id AS tenant_id
  FROM mdm_binding WHERE state='ACTIVE'
), allowed AS (
  SELECT DISTINCT d.tenant_id FROM admin_user u
  JOIN admin_permission p ON p.admin_id=u.id AND p.permission='mdm.diagnostics.view'
    AND p.revoked_at IS NULL
  JOIN gps_data_tenant_access d ON d.admin_id=u.id AND d.revoked_at IS NULL
  JOIN gps_health_tenant_access h ON h.admin_id=u.id AND h.tenant_id=d.tenant_id
    AND h.revoked_at IS NULL
  WHERE u.id=$1 AND u.state='ACTIVE'
), unique_owner AS (
  SELECT c.device_id,min(c.tenant_id) AS tenant_id FROM owner_candidates c
  JOIN allowed a ON a.tenant_id=c.tenant_id
  GROUP BY c.device_id HAVING count(DISTINCT c.tenant_id)=1
), scoped AS (
  SELECT g.id AS device_id,o.tenant_id,g.display_label,g.status,
    ag.name AS agent_name,coalesce(own.ownership,'UNVERIFIED') AS ownership,
    inst.installation_id,mdm.mdm_device_id,
    (mdm.mdm_device_id ~ '^[0-9]{1,30}$' AND mdm.status='managed' AND NOT mdm.removed)
      AS mdm_link_valid,
    s.manufacturer,s.model,s.android_release,s.app_version,
    s.observed_at,s.received_at,s.payload,s.findings,
    GREATEST(s.received_at,
      (SELECT max(h.received_at) FROM gps_device_health_event h
       WHERE h.device_id=g.id AND h.tenant_id=o.tenant_id),
      (SELECT max(p.received_at) FROM position_event p
       WHERE p.device_id=g.id AND p.tenant_id=o.tenant_id),
      (SELECT max(e.received_at) FROM gps_session_event e
       WHERE e.device_id=g.id AND e.tenant_id=o.tenant_id)) AS last_contact_at,
    coalesce(rem.pending_corrections,0)::int AS pending_corrections
  FROM unique_owner o
  JOIN geops_device g ON g.id=o.device_id
  LEFT JOIN gps_device_ownership own ON own.device_id=g.id
  LEFT JOIN LATERAL (
    SELECT installation_id FROM gps_device_installation
    WHERE device_id=g.id AND retired_at IS NULL LIMIT 1
  ) inst ON true
  LEFT JOIN LATERAL (
    SELECT al.agent_id FROM agent_device_link al
    WHERE al.device_id=g.id AND al.tenant_id=o.tenant_id
      AND al.state='ACTIVE' AND al.valid_from<=now() AND al.valid_to IS NULL
    LIMIT 1
  ) link ON true
  LEFT JOIN agent ag ON ag.id=link.agent_id AND ag.tenant_id=o.tenant_id
  LEFT JOIN mdm_inventory_device mdm ON mdm.geops_device_id=g.id
    AND mdm.provider='manageengine'
  LEFT JOIN LATERAL (
    SELECT id,manufacturer,model,android_release,app_version,
      observed_at,received_at,payload,findings
    FROM device_diagnostic_snapshot
    WHERE device_id=g.id AND tenant_id=o.tenant_id
    ORDER BY observed_at DESC,sequence DESC,received_at DESC,id DESC LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS pending_corrections FROM mdm_remediation_request r
    WHERE r.device_id=g.id AND r.tenant_id=o.tenant_id
      AND r.state IN ('AWAITING_APPROVAL','SUBMITTED','PENDING_APPLICATION')
  ) rem ON true
), flags AS (
  SELECT scoped.*,
    received_at IS NULL AS no_data,
    (received_at IS NOT NULL AND
      (received_at<now()-interval '15 minutes' OR
       observed_at<now()-interval '15 minutes')) AS stale,
    (last_contact_at IS NOT NULL AND last_contact_at<now()-interval '15 minutes')
      OR (observed_at>=now()-interval '15 minutes' AND
          (payload #>> '{execution,internet}')='OFFLINE') AS offline,
    (received_at>=now()-interval '15 minutes' AND observed_at>=now()-interval '15 minutes' AND
      (payload #>> '{permissions,fine}') IN ('DENIED','RESTRICTED','NOT_DECLARED')
      OR received_at>=now()-interval '15 minutes' AND observed_at>=now()-interval '15 minutes' AND
      (payload #>> '{permissions,background}') IN ('DENIED','RESTRICTED','NOT_DECLARED'))
      AS permission_missing,
    (received_at>=now()-interval '15 minutes' AND observed_at>=now()-interval '15 minutes' AND
      ((payload #>> '{execution,battery_exempt}')='false' OR
       (payload #>> '{execution,background_restricted}')='true')) AS battery_restricted,
    (received_at>=now()-interval '15 minutes' AND observed_at>=now()-interval '15 minutes' AND
      coalesce(findings @> '[{"code":"GPS_CAPTURE_STALE"}]'::jsonb,false)) AS capture_problem,
    (received_at>=now()-interval '15 minutes' AND observed_at>=now()-interval '15 minutes' AND
      coalesce(findings @> '[{"code":"GPS_TRANSMISSION_STALE"}]'::jsonb,false)) AS transmission_problem,
    (received_at IS NULL OR (payload #>> '{gps,policy_revision}') IS NULL) AS configuration_pending
  FROM scoped
)`;

function parseQuery(query: WorkspaceQuery) {
  const keys = new Set([
    'q',
    'issue',
    'severity',
    'android',
    'app',
    'mdm',
    'age',
    'ownership',
    'sort',
    'direction',
    'page',
    'limit',
    'ids',
  ]);
  if (Object.values(query).some((value) => value !== undefined && typeof value !== 'string'))
    throw new ApiError(422, 'invalid_workspace_query', 'Invalid request');
  if (Object.keys(query).some((key) => !keys.has(key)))
    throw new ApiError(422, 'invalid_workspace_query', 'Invalid request');
  const q = query.q?.trim() || null;
  if (q && q.length > 80) throw new ApiError(422, 'invalid_workspace_query', 'Invalid request');
  if (query.issue && !issues.has(query.issue))
    throw new ApiError(422, 'invalid_workspace_query', 'Invalid request');
  if (
    query.severity &&
    !['CONFIRMED', 'POSSIBLE', 'STALE', 'OFFLINE', 'UNKNOWN'].includes(query.severity)
  )
    throw new ApiError(422, 'invalid_workspace_query', 'Invalid request');
  if (query.mdm && !['valid', 'unverified'].includes(query.mdm))
    throw new ApiError(422, 'invalid_workspace_query', 'Invalid request');
  if (query.age && !['fresh', 'stale', 'none'].includes(query.age))
    throw new ApiError(422, 'invalid_workspace_query', 'Invalid request');
  if (
    query.ownership &&
    !['CORPORATE_MANAGED', 'PERSONAL_BYOD', 'UNVERIFIED'].includes(query.ownership)
  )
    throw new ApiError(422, 'invalid_workspace_query', 'Invalid request');
  if (query.android && (query.android.length > 40 || !/^[\w. -]+$/.test(query.android)))
    throw new ApiError(422, 'invalid_workspace_query', 'Invalid request');
  if (query.app && (query.app.length > 80 || !/^[\w.+-]+$/.test(query.app)))
    throw new ApiError(422, 'invalid_workspace_query', 'Invalid request');
  if (query.sort && !(query.sort in sorts))
    throw new ApiError(422, 'invalid_workspace_query', 'Invalid request');
  if (query.direction && !['asc', 'desc'].includes(query.direction))
    throw new ApiError(422, 'invalid_workspace_query', 'Invalid request');
  const page = Number(query.page ?? 1),
    limit = Number(query.limit ?? 25);
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    page > 1000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new ApiError(422, 'invalid_workspace_query', 'Invalid request');
  const ids = query.ids?.split(',') ?? [];
  if (ids.length > 100 || ids.some((id) => !uuid.test(id)))
    throw new ApiError(422, 'invalid_workspace_query', 'Invalid request');
  return { q, page, limit, ids };
}

const filtered = `WHERE ($2::text IS NULL OR display_label ILIKE '%'||$2||'%' OR
   device_id::text ILIKE '%'||$2||'%' OR coalesce(agent_name,'') ILIKE '%'||$2||'%')
  AND ($3::text IS NULL OR
    ($3='unlinked' AND NOT coalesce(mdm_link_valid,false)) OR
    ($3='permission' AND permission_missing) OR
    ($3='battery' AND battery_restricted) OR
    ($3='capture' AND capture_problem) OR
    ($3='transmission' AND transmission_problem) OR
    ($3='offline' AND offline) OR ($3='stale' AND stale) OR
    ($3='no_data' AND no_data) OR ($3='configuration' AND configuration_pending) OR
    ($3='pending' AND pending_corrections>0) OR
    ($3='no_findings' AND NOT no_data AND NOT stale AND NOT offline AND
      NOT permission_missing AND NOT battery_restricted AND NOT capture_problem AND
      NOT transmission_problem AND coalesce(jsonb_array_length(findings),0)=0))
  AND ($4::text IS NULL OR ($4='UNKNOWN' AND no_data) OR
    EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(findings,'[]'::jsonb)) f
            WHERE f->>'classification'=$4))
  AND ($5::text IS NULL OR android_release=$5)
  AND ($6::text IS NULL OR app_version ILIKE '%'||$6||'%')
  AND ($7::text IS NULL OR ($7='valid' AND mdm_link_valid) OR
      ($7='unverified' AND NOT coalesce(mdm_link_valid,false)))
  AND ($8::text IS NULL OR ($8='fresh' AND NOT no_data AND NOT stale) OR
      ($8='stale' AND stale) OR ($8='none' AND no_data))
  AND ($9::text IS NULL OR ownership=$9)
  AND ($10::uuid[] IS NULL OR device_id=ANY($10::uuid[]))`;

export class MdmWorkspaceService {
  constructor(
    private readonly pool: Pool,
    private readonly diagnostics: DeviceDiagnosticsService,
  ) {}

  private async permission(adminId: string, capability = 'mdm.diagnostics.view') {
    const result = await this.pool.query(
      `SELECT 1 FROM admin_user u JOIN admin_permission p ON p.admin_id=u.id
       WHERE u.id=$1 AND u.state='ACTIVE' AND p.permission=$2 AND p.revoked_at IS NULL`,
      [adminId, capability],
    );
    if (!result.rowCount) throw new ApiError(403, 'workspace_forbidden', 'Forbidden');
  }

  async summary(adminId: string, requestId: string) {
    await this.permission(adminId);
    const result = await this.pool.query<{
      registered: string;
      linked: string;
      unlinked: string;
      no_data: string;
      stale: string;
      offline: string;
      permission: string;
      battery: string;
      capture: string;
      transmission: string;
      configuration: string;
      pending: string;
      no_findings: string;
    }>(
      `${base} SELECT count(*)::text AS registered,
      count(*) FILTER (WHERE mdm_link_valid)::text AS linked,
      count(*) FILTER (WHERE NOT coalesce(mdm_link_valid,false))::text AS unlinked,
      count(*) FILTER (WHERE no_data)::text AS no_data,
      count(*) FILTER (WHERE stale)::text AS stale,
      count(*) FILTER (WHERE offline)::text AS offline,
      count(*) FILTER (WHERE permission_missing)::text AS permission,
      count(*) FILTER (WHERE battery_restricted)::text AS battery,
      count(*) FILTER (WHERE capture_problem)::text AS capture,
      count(*) FILTER (WHERE transmission_problem)::text AS transmission,
      count(*) FILTER (WHERE configuration_pending)::text AS configuration,
      coalesce(sum(pending_corrections),0)::text AS pending,
      count(*) FILTER (WHERE NOT no_data AND NOT stale AND NOT offline AND
        NOT permission_missing AND NOT battery_restricted AND NOT capture_problem AND
        NOT transmission_problem AND coalesce(jsonb_array_length(findings),0)=0)::text AS no_findings
      FROM flags`,
      [adminId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('workspace_summary_missing');
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'mdm.workspace.summary',
      outcome: 'success',
      correlationId: requestId,
    });
    return {
      as_of: new Date().toISOString(),
      source: 'GEOPS_BACKEND',
      compliance: null,
      compliance_reason: 'MANAGEENGINE_TENANT_NOT_VERIFIED',
      ...Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])),
    };
  }

  async devices(adminId: string, query: WorkspaceQuery, requestId: string) {
    await this.permission(adminId);
    const parsed = parseQuery(query);
    const values = [
      adminId,
      parsed.q,
      query.issue ?? null,
      query.severity ?? null,
      query.android ?? null,
      query.app ?? null,
      query.mdm ?? null,
      query.age ?? null,
      query.ownership ?? null,
      parsed.ids.length ? parsed.ids : null,
      parsed.limit,
      (parsed.page - 1) * parsed.limit,
    ];
    const sort = sorts[query.sort ?? 'name'];
    const direction = query.direction === 'desc' ? 'DESC' : 'ASC';
    const result = await this.pool.query<DeviceRow>(
      `${base} SELECT *,count(*) OVER()::text AS total FROM flags ${filtered}
       ORDER BY ${sort} ${direction} NULLS LAST,device_id ASC LIMIT $11 OFFSET $12`,
      values,
    );
    const total = result.rows[0]
      ? Number(result.rows[0].total)
      : parsed.page > 1
        ? Number(
            (
              await this.pool.query<{ total: string }>(
                `${base} SELECT count(*)::text AS total FROM flags ${filtered}`,
                values.slice(0, 10),
              )
            ).rows[0]?.total ?? 0,
          )
        : 0;
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'mdm.workspace.devices',
      outcome: 'success',
      correlationId: requestId,
    });
    return {
      as_of: new Date().toISOString(),
      page: parsed.page,
      limit: parsed.limit,
      total,
      items: result.rows.map((row) => ({
        device_id: row.device_id,
        tenant_id: row.tenant_id,
        display_label: row.display_label,
        status: row.status,
        agent_name: row.agent_name,
        ownership: row.ownership,
        installation_id: row.installation_id,
        mdm_device_id: row.mdm_link_valid ? row.mdm_device_id : null,
        mdm_link_state: row.mdm_link_valid ? 'VALID' : 'UNVERIFIED',
        manufacturer: row.manufacturer,
        model: row.model,
        android_release: row.android_release,
        app_version: row.app_version,
        observed_at: row.observed_at?.toISOString() ?? null,
        received_at: row.received_at?.toISOString() ?? null,
        last_contact_at: row.last_contact_at?.toISOString() ?? null,
        permissions: (row.payload as { permissions?: unknown } | null)?.permissions ?? null,
        execution: (row.payload as { execution?: unknown } | null)?.execution ?? null,
        gps: (row.payload as { gps?: unknown } | null)?.gps ?? null,
        findings: row.findings ?? [],
        flags: {
          no_data: row.no_data,
          stale: row.stale,
          offline: row.offline,
          permission_missing: row.permission_missing,
          battery_restricted: row.battery_restricted,
          capture_problem: row.capture_problem,
          transmission_problem: row.transmission_problem,
          configuration_pending: row.configuration_pending,
        },
        pending_corrections: row.pending_corrections,
      })),
    };
  }

  async timeline(
    adminId: string,
    deviceId: string,
    requestId: string,
    from?: string,
    to?: string,
    kind?: string,
  ) {
    await this.permission(adminId);
    if (
      !uuid.test(deviceId) ||
      (kind &&
        ![
          'ALL',
          'DIAGNOSTIC',
          'GPS',
          'PERMISSION',
          'CONFIGURATION',
          'REMEDIATION',
          'ADMIN',
        ].includes(kind))
    )
      throw new ApiError(422, 'invalid_timeline_query', 'Invalid request');
    const start = from ? Date.parse(from) : Date.now() - 7 * 86_400_000;
    const end = to ? Date.parse(to) : Date.now();
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end ||
      end - start > 30 * 86_400_000
    )
      throw new ApiError(422, 'invalid_timeline_query', 'Invalid request');
    const history = await this.diagnostics.history(adminId, deviceId, requestId, 100);
    type Event = { at: string; type: string; label: string; source: string; evidence_ref: string };
    const events: Event[] = [];
    const snapshots = history.items.filter(
      (item): item is typeof item & { payload: NonNullable<typeof item.payload> } =>
        'payload' in item && item.payload !== undefined && item.payload !== null,
    );
    for (let index = 0; index < snapshots.length; index++) {
      const item = snapshots[index];
      if (!item) continue;
      const time = Date.parse(item.observed_at);
      if (time < start || time > end) continue;
      const ref = item.snapshot_id ?? 'unknown';
      events.push({
        at: item.received_at,
        type: 'DIAGNOSTIC',
        label: 'Diagnóstico recibido por GEOPS',
        source: 'GEOPS_BACKEND',
        evidence_ref: ref,
      });
      const gps = item.payload.gps;
      if (gps.service === 'STOPPED_OBSERVED')
        events.push({
          at: item.observed_at,
          type: 'GPS',
          label: 'Servicio detenido observado en diagnóstico',
          source: 'GPS_V2_LOCAL',
          evidence_ref: ref,
        });
      if (gps.service === 'RUNNING_OBSERVED')
        events.push({
          at: item.observed_at,
          type: 'GPS',
          label: 'Servicio activo observado en diagnóstico',
          source: 'GPS_V2_LOCAL',
          evidence_ref: ref,
        });
      if (gps.last_capture_at)
        events.push({
          at: gps.last_capture_at,
          type: 'GPS',
          label: 'Última captura reportada',
          source: 'GPS_V2_LOCAL',
          evidence_ref: ref,
        });
      if (gps.last_ack_at)
        events.push({
          at: gps.last_ack_at,
          type: 'GPS',
          label: 'Último ACK reportado',
          source: 'GPS_V2_LOCAL',
          evidence_ref: ref,
        });
      const older = snapshots[index + 1];
      if (older) {
        if (JSON.stringify(item.payload.permissions) !== JSON.stringify(older.payload.permissions))
          events.push({
            at: item.observed_at,
            type: 'PERMISSION',
            label: 'Cambio de permisos observado entre diagnósticos',
            source: 'ANDROID',
            evidence_ref: ref,
          });
        if (
          item.payload.gps.policy_revision !== older.payload.gps.policy_revision ||
          item.payload.gps.capture_interval_s !== older.payload.gps.capture_interval_s ||
          item.payload.gps.sync_interval_s !== older.payload.gps.sync_interval_s
        )
          events.push({
            at: item.observed_at,
            type: 'CONFIGURATION',
            label: 'Cambio de configuración GPS observado',
            source: 'GPS_V2_LOCAL',
            evidence_ref: ref,
          });
        if (
          item.payload.execution.internet === 'VALIDATED' &&
          older.payload.execution.internet !== 'VALIDATED'
        )
          events.push({
            at: item.observed_at,
            type: 'GPS',
            label: 'Conectividad recuperada observada',
            source: 'ANDROID',
            evidence_ref: ref,
          });
      }
    }
    const scope = await this.diagnostics.latest(adminId, deviceId, requestId);
    const auditPermission = await this.pool.query(
      `SELECT 1 FROM admin_permission WHERE admin_id=$1 AND permission='mdm.audit.view'
       AND revoked_at IS NULL`,
      [adminId],
    );
    if (auditPermission.rowCount) {
      const administrative = await this.pool.query<{
        id: string;
        action: string;
        occurred_at: Date;
      }>(
        `SELECT id,action,occurred_at FROM audit_event WHERE device_id=$1
         AND occurred_at BETWEEN $2 AND $3 ORDER BY occurred_at DESC LIMIT 100`,
        [deviceId, new Date(start), new Date(end)],
      );
      for (const item of administrative.rows)
        events.push({
          at: item.occurred_at.toISOString(),
          type: 'ADMIN',
          label: `Evento administrativo: ${item.action}`,
          source: 'GEOPS_BACKEND',
          evidence_ref: item.id,
        });
      const remediation = await this.pool.query<{ id: string; state: string; occurred_at: Date }>(
        `SELECT e.id,e.state,e.occurred_at FROM mdm_remediation_event e
         JOIN mdm_remediation_request r ON r.id=e.request_id
         WHERE r.device_id=$1 AND r.tenant_id=$2 AND e.occurred_at BETWEEN $3 AND $4
         ORDER BY e.occurred_at DESC LIMIT 100`,
        [deviceId, scope.tenant_id, new Date(start), new Date(end)],
      );
      for (const item of remediation.rows)
        events.push({
          at: item.occurred_at.toISOString(),
          type: 'REMEDIATION',
          label: `Estado de solicitud: ${item.state}`,
          source: 'GEOPS_BACKEND',
          evidence_ref: item.id,
        });
    }
    return {
      device_id: deviceId,
      from: new Date(start).toISOString(),
      to: new Date(end).toISOString(),
      truncated: history.items.length === 100,
      unavailable: [
        'Hora exacta de inicio o interrupción FGS',
        'Cambios históricos de perfil ManageEngine',
      ],
      items: events
        .filter(
          (item) =>
            (!kind || kind === 'ALL' || item.type === kind) &&
            Date.parse(item.at) >= start &&
            Date.parse(item.at) <= end,
        )
        .sort((a, b) => a.at.localeCompare(b.at))
        .slice(-300),
    };
  }

  async report(adminId: string, query: WorkspaceQuery, requestId: string) {
    await this.permission(adminId, 'mdm.diagnostics.export');
    const parsed = parseQuery(query);
    const result = await this.devices(
      adminId,
      { ...query, page: '1', limit: String(Math.min(parsed.limit, 100)) },
      requestId,
    );
    const auditPermission = await this.pool.query(
      `SELECT 1 FROM admin_permission WHERE admin_id=$1 AND permission='mdm.audit.view'
       AND revoked_at IS NULL`,
      [adminId],
    );
    const correctionRows =
      auditPermission.rowCount && result.items.length
        ? (
            await this.pool.query<{
              id: string;
              device_id: string;
              profile_id: string;
              state: string;
              requested_at: Date;
              updated_at: Date;
            }>(
              `SELECT r.id,r.device_id,r.profile_id,r.state,r.requested_at,r.updated_at
         FROM mdm_remediation_request r
         JOIN unnest($1::uuid[],$2::text[]) scope(device_id,tenant_id)
           ON scope.device_id=r.device_id AND scope.tenant_id=r.tenant_id
         ORDER BY r.requested_at DESC,r.id DESC LIMIT 501`,
              [
                result.items.map((item) => item.device_id),
                result.items.map((item) => item.tenant_id),
              ],
            )
          ).rows
        : null;
    const corrections = correctionRows
      ? correctionRows.slice(0, 500).map((item) => ({
          request_id: item.id,
          device_id: item.device_id,
          profile_id: item.profile_id,
          state: item.state,
          requested_at: item.requested_at.toISOString(),
          updated_at: item.updated_at.toISOString(),
        }))
      : null;
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      action: 'mdm.workspace.report',
      outcome: 'success',
      correlationId: requestId,
      metadata: { count: result.items.length },
    });
    return {
      generated_at: new Date().toISOString(),
      source: 'GEOPS_BACKEND',
      scope: {
        page: 1,
        limit: result.limit,
        total_matching: result.total,
        selected: parsed.ids.length,
      },
      mdm_applied_evidence: 'TENANT_NOT_VERIFIED',
      corrections,
      corrections_truncated: correctionRows ? correctionRows.length > 500 : null,
      items: result.items,
    };
  }
}
