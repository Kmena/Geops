import type { Pool } from 'pg';
import { appendAudit } from './audit/index.js';
import { ApiError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const statuses = new Set([
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'INCOMPLETE',
  'NOT_VISITED',
  'INSUFFICIENT_EVIDENCE',
  'UNATTRIBUTABLE',
  'CANCELLED',
]);
const syncStates = new Set(['UNKNOWN', 'BACKLOG_REPORTED', 'ACK_RECENT', 'NO_RECENT_ACK']);
const invalid = () => new ApiError(422, 'invalid_request', 'Invalid request');
const validDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  DATE.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const asNumber = (value: unknown) => Number(value ?? 0);

export function gpsSyncState(lastAck: Date | null, backlog: number | null, now: Date) {
  if (backlog === null || (!lastAck && backlog === 0)) return 'UNKNOWN';
  if (backlog > 0) return 'BACKLOG_REPORTED';
  const age = lastAck ? now.getTime() - lastAck.getTime() : Infinity;
  return age >= 0 && age <= 15 * 60 * 1000 ? 'ACK_RECENT' : 'NO_RECENT_ACK';
}

export type ComplianceQuery = {
  from?: string;
  to?: string;
  agent_id?: string;
  route_id?: string;
  client_id?: string;
  status?: string;
  sync_state?: string;
  limit?: string;
  offset?: string;
};

export type ComplianceVisit = {
  assignment_id: string;
  stop_id: string;
  agent_id: string;
  agent_code: string;
  agent_name: string;
  route_id: string;
  route_code: string;
  route_name: string;
  route_revision: number;
  local_date: string;
  starts_at: string;
  ends_at: string;
  time_zone: string;
  client_id: string;
  client_code: string;
  client_name: string;
  site_id: string;
  site_name: string;
  geofence_revision: number;
  latitude: number;
  longitude: number;
  radius_m: number;
  required: boolean;
  required_s: number;
  credited_s: number;
  status: string;
  sync_state: string;
  processing_state: string;
  last_ack_at: string | null;
  backlog_reported: number | null;
  provisional: boolean;
  evaluation_id: string | null;
  evaluation_no: number | null;
  evaluated_at: string | null;
  completed_at: string | null;
  first_qualified_at: string | null;
  last_qualified_at: string | null;
  algorithm_id: string | null;
  algorithm_revision: number | null;
  algorithm_scope: string | null;
  source_watermark: string | null;
  job_requested_at: string | null;
  job_finished_at: string | null;
  job_error_code: string | null;
  device_id: string | null;
  snapshot_hash: string;
};

export type ComplianceDeviceLocation = {
  agent_id: string;
  device_id: string;
  latitude: number | null;
  longitude: number | null;
  accuracy_m: number | null;
  captured_at: string | null;
  received_at: string | null;
  last_health_received_at: string | null;
  communication_state: 'RECENT_REPORT' | 'NO_RECENT_REPORT' | 'NETWORK_UNAVAILABLE_REPORTED';
};

type DbRow = Omit<
  ComplianceVisit,
  'status' | 'sync_state' | 'processing_state' | 'last_ack_at' | 'backlog_reported' | 'provisional'
> & {
  assignment_state: string;
  evaluation_status: string | null;
  job_state: string | null;
};

export function normalizeVisit(row: DbRow, now: Date): ComplianceVisit {
  const { assignment_state, evaluation_status, job_state, ...snapshot } = row;
  const status =
    assignment_state === 'CANCELLED'
      ? 'CANCELLED'
      : (evaluation_status ??
        (job_state === 'PENDING' || job_state === 'RUNNING'
          ? 'PENDING'
          : 'PENDING'));
  return {
    ...snapshot,
    required_s: asNumber(row.required_s),
    credited_s: asNumber(row.credited_s),
    radius_m: asNumber(row.radius_m),
    latitude: asNumber(row.latitude),
    longitude: asNumber(row.longitude),
    route_revision: asNumber(row.route_revision),
    geofence_revision: asNumber(row.geofence_revision),
    evaluation_no: row.evaluation_no === null ? null : asNumber(row.evaluation_no),
    algorithm_revision: row.algorithm_revision === null ? null : asNumber(row.algorithm_revision),
    status,
    sync_state: 'UNKNOWN',
    processing_state: job_state ?? 'NOT_QUEUED',
    last_ack_at: null,
    backlog_reported: null,
    // No approved reconciliation/finalization policy exists yet. Even a completed
    // evaluation can change when accepted late evidence is processed.
    provisional: status !== 'CANCELLED',
  };
}

export function summarizeVisits(visits: ComplianceVisit[]) {
  const active = visits.filter((visit) => visit.status !== 'CANCELLED');
  const required = active.filter((visit) => visit.required);
  const completed = required.filter((visit) => visit.status === 'COMPLETED').length;
  const routes = new Map<string, ComplianceVisit[]>();
  for (const visit of active) {
    const key = visit.assignment_id;
    routes.set(key, [...(routes.get(key) ?? []), visit]);
  }
  const routeItems = [...routes.values()].map((items) => {
    const first = items[0];
    if (!first) throw new Error('Empty route group');
    const obligations = items.filter((item) => item.required);
    const fulfilled = obligations.filter((item) => item.status === 'COMPLETED').length;
    return {
      assignment_id: first.assignment_id,
      route_id: first.route_id,
      route_code: first.route_code,
      route_name: first.route_name,
      route_revision: first.route_revision,
      agent_id: first.agent_id,
      agent_name: first.agent_name,
      local_date: first.local_date,
      visits: items.length,
      required_visits: obligations.length,
      completed_required_visits: fulfilled,
      credited_s: items.reduce((sum, item) => sum + item.credited_s, 0),
      status:
        obligations.length > 0 && fulfilled === obligations.length
          ? 'COMPLETED'
          : obligations.some((item) => item.status === 'IN_PROGRESS')
            ? 'IN_PROGRESS'
            : 'PENDING',
      provisional: true,
    };
  });
  const group = (key: 'agent_id' | 'client_id') => {
    const groups = new Map<string, ComplianceVisit[]>();
    for (const visit of active) groups.set(visit[key], [...(groups.get(visit[key]) ?? []), visit]);
    return [...groups.values()].map((items) => {
      const first = items[0];
      if (!first) throw new Error('Empty compliance group');
      const obligations = items.filter((item) => item.required);
      return {
        id: first[key],
        name: key === 'agent_id' ? first.agent_name : first.client_name,
        routes: new Set(items.map((item) => item.assignment_id)).size,
        visits: items.length,
        required_visits: obligations.length,
        completed_required_visits: obligations.filter((item) => item.status === 'COMPLETED').length,
        credited_s: items.reduce((sum, item) => sum + item.credited_s, 0),
        pending_visits: obligations.filter((item) => item.status !== 'COMPLETED').length,
        device_ids: [...new Set(items.map((item) => item.device_id).filter((id) => id !== null))],
        provisional: true,
      };
    });
  };
  return {
    indicators: {
      agents_with_routes: new Set(active.map((visit) => visit.agent_id)).size,
      scheduled_routes: routes.size,
      scheduled_visits: active.length,
      required_visits: required.length,
      completed_visits: active.filter((visit) => visit.status === 'COMPLETED').length,
      in_progress_visits: active.filter((visit) => visit.status === 'IN_PROGRESS').length,
      pending_visits: active.filter((visit) => visit.status === 'PENDING').length,
      insufficient_evidence_visits: active.filter(
        (visit) => visit.status === 'INSUFFICIENT_EVIDENCE',
      ).length,
      unattributable_visits: active.filter((visit) => visit.status === 'UNATTRIBUTABLE').length,
      completed_routes: routeItems.filter((route) => route.status === 'COMPLETED').length,
      accredited_compliance_percent: required.length
        ? Math.round((completed * 10000) / required.length) / 100
        : null,
      compliance_denominator: required.length,
      provisional: true,
    },
    routes: routeItems,
    agents: group('agent_id'),
    clients: group('client_id'),
  };
}

export class ComplianceDashboardService {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private parse(query: ComplianceQuery) {
    if (
      Object.keys(query).some(
        (key) =>
          ![
            'from',
            'to',
            'agent_id',
            'route_id',
            'client_id',
            'status',
            'sync_state',
            'limit',
            'offset',
          ].includes(key),
      )
    )
      throw invalid();
    if (!validDate(query.from) || !validDate(query.to) || query.from > query.to) throw invalid();
    const days =
      (Date.parse(`${query.to}T00:00:00Z`) - Date.parse(`${query.from}T00:00:00Z`)) / 86400000;
    if (days > 30) throw invalid();
    for (const key of ['agent_id', 'route_id', 'client_id'] as const)
      if (query[key] && !UUID.test(query[key])) throw invalid();
    if (query.status && !statuses.has(query.status)) throw invalid();
    if (query.sync_state && !syncStates.has(query.sync_state)) throw invalid();
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 10000
    )
      throw invalid();
    return { from: query.from, to: query.to, limit, offset };
  }

  async read(actor: string, requestId: string, query: ComplianceQuery) {
    const { from, to, limit, offset } = this.parse(query);
    const db = await this.pool.connect();
    try {
      const permission = await db.query<{ tenant_id: string }>(
        `SELECT t.tenant_id FROM geops_operating_tenant t
         JOIN admin_user u ON u.id=$1 AND u.state='ACTIVE'
         JOIN gps_data_tenant_access a ON a.admin_id=u.id AND a.tenant_id=t.tenant_id AND a.revoked_at IS NULL
         JOIN admin_permission p ON p.admin_id=u.id AND p.permission='visit.result.read' AND p.revoked_at IS NULL
         WHERE t.singleton=true`,
        [actor],
      );
      const tenant = permission.rows[0]?.tenant_id;
      if (!tenant) throw new ApiError(403, 'visit_result_forbidden', 'Forbidden');
      const optionalPermissions = await db.query<{ permission: string }>(
        `SELECT permission FROM admin_permission WHERE admin_id=$1 AND revoked_at IS NULL
         AND permission IN ('visit.device.read','gps.location.read','gps.session.read')`,
        [actor],
      );
      const canReadDevice = optionalPermissions.rows.some(
        (row) => row.permission === 'visit.device.read',
      );
      const canReadLocation =
        canReadDevice &&
        optionalPermissions.rows.some((row) => row.permission === 'gps.location.read');
      const canReadSync =
        canReadDevice &&
        optionalPermissions.rows.some((row) => row.permission === 'gps.session.read');
      const result = await db.query<DbRow>(
        `SELECT a.id AS assignment_id,v.stop_id,a.agent_id,a.agent_code,a.agent_name,
          a.route_id,a.route_code,a.route_name,a.route_revision,a.local_date::text,a.starts_at,a.ends_at,
          a.time_zone,a.state AS assignment_state,a.snapshot_hash,
          v.client_id,v.client_code,v.client_name,v.site_id,v.site_name,v.geofence_revision,
          v.latitude,v.longitude,v.radius_m,v.required,v.min_dwell_effective_s AS required_s,
          coalesce(e.credited_s,0) AS credited_s,e.status AS evaluation_status,e.id AS evaluation_id,
          e.evaluation_no,e.evaluated_at,e.completed_at,e.first_qualified_at,e.last_qualified_at,
          e.algorithm_id,e.algorithm_revision,e.source_watermark,ar.scope AS algorithm_scope,
          j.state AS job_state,j.requested_at AS job_requested_at,j.finished_at AS job_finished_at,
          j.last_error_code AS job_error_code,
          (SELECT l.device_id FROM agent_device_link l WHERE l.tenant_id=a.tenant_id
            AND l.agent_id=a.agent_id AND l.state<>'REVOKED' AND l.valid_from<a.ends_at
            AND coalesce(l.valid_to,'infinity'::timestamptz)>a.starts_at
            ORDER BY l.valid_from DESC LIMIT 1) AS device_id
         FROM route_assignment a JOIN assignment_visit v ON v.tenant_id=a.tenant_id AND v.assignment_id=a.id
         LEFT JOIN visit_evaluation_current c ON c.tenant_id=v.tenant_id AND c.assignment_id=v.assignment_id AND c.stop_id=v.stop_id
         LEFT JOIN visit_evaluation e ON e.id=c.evaluation_id
         LEFT JOIN visit_algorithm_revision ar ON ar.algorithm_id=e.algorithm_id AND ar.revision=e.algorithm_revision
         LEFT JOIN visit_evaluation_job j ON j.tenant_id=a.tenant_id AND j.assignment_id=a.id
         WHERE a.tenant_id=$1 AND a.local_date BETWEEN $2::date AND $3::date
           AND ($4::uuid IS NULL OR a.agent_id=$4) AND ($5::uuid IS NULL OR a.route_id=$5)
           AND ($6::uuid IS NULL OR v.client_id=$6)
         ORDER BY a.local_date,a.agent_code,a.id,v.suggested_order NULLS LAST,v.stop_id
         LIMIT 10001`,
        [tenant, from, to, query.agent_id ?? null, query.route_id ?? null, query.client_id ?? null],
      );
      if (result.rows.length > 10000)
        throw new ApiError(422, 'dashboard_range_too_large', 'Invalid request');
      const now = this.now();
      const normalized = result.rows.map((row) => {
        const visit = normalizeVisit(row, now);
        return canReadDevice ? visit : { ...visit, device_id: null };
      });
      const syncByDevice = new Map<
        string,
        {
          last_ack_at: Date | null;
          backlog_reported: number;
        }
      >();
      if (canReadSync) {
        const deviceIds = [
          ...new Set(normalized.map((visit) => visit.device_id).filter((id) => id !== null)),
        ];
        if (deviceIds.length) {
          const sync = await db.query<{
            device_id: string;
            last_ack_at: Date | null;
            backlog_reported: number;
          }>(
            `SELECT device_id,last_ack_at,backlog_reported FROM gps_sync_status
             WHERE device_id=ANY($1::uuid[])`,
            [deviceIds],
          );
          for (const row of sync.rows) syncByDevice.set(row.device_id, row);
        }
      }
      const visits = normalized
        .map((visit) => {
          const sync = visit.device_id ? syncByDevice.get(visit.device_id) : undefined;
          const lastAck = sync?.last_ack_at ?? null;
          return {
            ...visit,
            sync_state: gpsSyncState(lastAck, sync ? Number(sync.backlog_reported) : null, now),
            last_ack_at: lastAck?.toISOString() ?? null,
            backlog_reported: sync ? Number(sync.backlog_reported) : null,
          };
        })
        .filter(
          (visit) =>
            (!query.status || visit.status === query.status) &&
            (!query.sync_state || visit.sync_state === query.sync_state),
        );
      const aggregates = summarizeVisits(visits);
      const items = visits.slice(offset, offset + limit);
      const locations: ComplianceDeviceLocation[] = [];
      if (canReadLocation) {
        const pairs = new Map<string, { agentId: string; deviceId: string }>();
        for (const visit of items)
          if (visit.device_id)
            pairs.set(`${visit.agent_id}:${visit.device_id}`, {
              agentId: visit.agent_id,
              deviceId: visit.device_id,
            });
        if (pairs.size > 100)
          throw new ApiError(422, 'dashboard_device_range_too_large', 'Invalid request');
        if (pairs.size) {
          const agents = [...pairs.values()].map((pair) => pair.agentId);
          const devices = [...pairs.values()].map((pair) => pair.deviceId);
          const startAt = items.reduce(
            (min, visit) => Math.min(min, new Date(visit.starts_at).getTime()),
            Infinity,
          );
          const endAt = items.reduce(
            (max, visit) => Math.max(max, new Date(visit.ends_at).getTime()),
            -Infinity,
          );
          const recent = await db.query<{
            agent_id: string;
            device_id: string;
            latitude: number | null;
            longitude: number | null;
            accuracy_m: number | null;
            captured_at: Date | null;
            received_at: Date | null;
            last_health_received_at: Date | null;
            network_available: boolean | null;
          }>(
            `SELECT selected.agent_id,selected.device_id,p.latitude,p.longitude,p.accuracy_m,
              p.captured_at,p.received_at,h.received_at AS last_health_received_at,h.network_available
             FROM unnest($2::uuid[],$3::uuid[]) AS selected(agent_id,device_id)
             LEFT JOIN LATERAL (
               SELECT ST_Y(pe.geom::geometry) AS latitude,ST_X(pe.geom::geometry) AS longitude,
                 pe.accuracy_m,pe.captured_at,pe.received_at
               FROM position_event pe JOIN agent_device_link l ON l.tenant_id=pe.tenant_id
                 AND l.device_id=pe.device_id AND l.agent_id=selected.agent_id AND l.state<>'REVOKED'
                 AND pe.captured_at>=l.valid_from
                 AND pe.captured_at<coalesce(l.valid_to,'infinity'::timestamptz)
               WHERE pe.tenant_id=$1 AND pe.device_id=selected.device_id
                 AND pe.captured_at>=$4 AND pe.captured_at<$5
               ORDER BY pe.captured_at DESC,pe.event_id DESC LIMIT 1
             ) p ON true
             LEFT JOIN LATERAL (
               SELECT received_at,network_available FROM gps_device_health_event
               WHERE tenant_id=$1 AND device_id=selected.device_id
               ORDER BY received_at DESC LIMIT 1
             ) h ON true`,
            [tenant, agents, devices, new Date(startAt), new Date(endAt)],
          );
          for (const row of recent.rows) {
            const healthAge = row.last_health_received_at
              ? now.getTime() - row.last_health_received_at.getTime()
              : Infinity;
            locations.push({
              agent_id: row.agent_id,
              device_id: row.device_id,
              latitude: row.latitude,
              longitude: row.longitude,
              accuracy_m: row.accuracy_m,
              captured_at: row.captured_at?.toISOString() ?? null,
              received_at: row.received_at?.toISOString() ?? null,
              last_health_received_at: row.last_health_received_at?.toISOString() ?? null,
              communication_state:
                healthAge > 15 * 60 * 1000
                  ? 'NO_RECENT_REPORT'
                  : row.network_available === false
                    ? 'NETWORK_UNAVAILABLE_REPORTED'
                    : 'RECENT_REPORT',
            });
          }
        }
      }
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: actor,
        action: 'visit.dashboard.read',
        outcome: 'success',
        correlationId: requestId,
        metadata: { tenant_id: tenant, from, to, filtered_count: visits.length },
      });
      const evaluationAccess = await db.query<{
        can_request: boolean;
        algorithm_approved: boolean;
      }>(
        `SELECT EXISTS(SELECT 1 FROM admin_permission WHERE admin_id=$1
          AND permission='visit.evaluation.recompute' AND revoked_at IS NULL) AS can_request,
          EXISTS(SELECT 1 FROM visit_algorithm_revision WHERE algorithm_id='dwell-pair-v1'
          AND scope='APPROVED') AS algorithm_approved`,
        [actor],
      );
      return {
        ...aggregates,
        filters: { ...query, limit, offset },
        total_visits: visits.length,
        items,
        locations,
        location_access: canReadLocation,
        next_offset: offset + limit < visits.length ? offset + limit : null,
        reconciliation_policy: 'PENDING_APPROVAL',
        evaluation_access: evaluationAccess.rows[0] ?? {
          can_request: false,
          algorithm_approved: false,
        },
      };
    } finally {
      db.release();
    }
  }
}
