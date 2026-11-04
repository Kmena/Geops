import { apiPath } from '../api/base.js';
import { ApiClientError } from '../api/client.js';

export type Action = 'CREATE' | 'LINK' | 'UPDATE' | 'EXCLUDE' | 'PENDING';
export type ReviewRow = {
  record_id: string;
  ordinal: number;
  record_type: string;
  route_candidate: boolean;
  review_state: string;
  warnings: string[];
  conflicts: string[];
  parse_errors: string[];
  evidence: { candidate_count?: number };
  source_path: string;
  parent_path: string | null;
  source_kind: string;
  week_label: string | null;
  normalized: {
    name?: string;
    code?: string;
    point?: { latitude: number; longitude: number };
  };
  proposed: {
    name?: string;
    code?: string;
    address?: string;
    latitude?: number;
    longitude?: number;
    group_id?: string;
    week_label?: string;
  } | null;
  action: Action | null;
  revision: number;
};
export type Candidate = {
  target_type: string;
  target_id: string;
  target_version: number | null;
  distance_m: number | null;
  confidence: string;
  signals: string[];
  target_name: string | null;
  target_code: string | null;
  target_parent_path: string | null;
  target_parent_name: string | null;
  latitude: number | null;
  longitude: number | null;
};
export type Detail = ReviewRow & {
  analysis_id: string;
  original: Record<string, unknown>;
  geometry: Record<string, unknown> | null;
  candidates: Candidate[];
  route_progress: { points: number; invalid: number; pending: number; weekly_stops: number } | null;
  target_customer_id: string | null;
  target_customer_version: number | null;
  target_establishment_id: string | null;
  target_establishment_version: number | null;
  selected_fields: string[] | null;
  reason: string | null;
  acknowledged_conflict: boolean | null;
};
export type Summary = {
  analysis_id: string;
  analysis_version: number;
  total: number;
  client_candidates: number;
  route_candidates: number;
  candidate_relations: number;
  existing_matches: number;
  possible_duplicates: number;
  conflicts: number;
  invalid: number;
  reviewed: number;
  pending: number;
  excluded: number;
  create_count: number;
  link_count: number;
  update_count: number;
  warnings: number;
};
export type Session = {
  import_id: string;
  state: string;
  file_name?: string;
  record_count: number;
  created_at: string;
};
export type ConfirmationPlan = {
  commit_id: string;
  import_id: string;
  state: 'VALIDATED';
  plan_digest: string;
  etag: string;
  counts: Record<
    'create' | 'link' | 'update' | 'exclude' | 'pending' | 'groups_candidate' | 'routes_candidate',
    number
  >;
  warnings: Array<{ record_id: string; code: string }>;
  blocking_issues: Array<{ record_id: string; code: string }>;
  expires_at: string;
  operational_confirmation_available: boolean;
};
export type ConfirmationResult = {
  commit_id: string;
  import_id: string;
  state: 'APPLIED';
  plan_digest: string;
  applied_at: string;
  counts: ConfirmationPlan['counts'];
  operations: Array<{
    record_id: string;
    action: Action;
    target_customer_id: string | null;
    target_establishment_id: string | null;
    operation_id: string;
  }>;
  groups_created: number;
  routes_activated: 0;
  visits_created: 0;
};
export type MapPoint = {
  record_id: string;
  review_state: string;
  record_type: string;
  source_kind: string;
  name: string | null;
  latitude: number;
  longitude: number;
};
export type Change = {
  proposed?: {
    name?: string;
    code?: string;
    address?: string;
    latitude?: number | undefined;
    longitude?: number | undefined;
    group_id?: string | null;
    week_label?: string | null;
  };
  action: Action;
  target_customer_id?: string | null;
  target_customer_version?: number | null;
  target_establishment_id?: string | null;
  target_establishment_version?: number | null;
  selected_fields?: Array<string | undefined>;
  reason?: string | null;
  acknowledged_conflict?: boolean;
};
export type Filters = {
  page: number;
  limit: number;
  state: string;
  group: string;
  week: string;
  type: string;
  sort: string;
  search: string;
  record_id: string;
};
export type Facets = {
  groups: { path: string; name: string }[];
  weeks: string[];
  group_choices: { id: string; name: string; path: string }[];
};
export type Target = {
  id: string;
  name: string;
  version: number;
  source_key?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

async function request<T>(path: `/v1/${string}`, options?: RequestInit): Promise<T> {
  const response = await fetch(apiPath(path), {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const error =
      raw.error && typeof raw.error === 'object' ? (raw.error as Record<string, unknown>) : raw;
    throw new ApiClientError(
      response.status,
      typeof error.code === 'string' ? error.code : 'request_failed',
    );
  }
  return body as T;
}
const path = (id: string, suffix: string) =>
  `/v1/admin/kmz-imports/${encodeURIComponent(id)}${suffix}` as `/v1/${string}`;
const json = (csrf: string, extra: Record<string, string> = {}) => ({
  'content-type': 'application/json',
  'x-csrf-token': csrf,
  ...extra,
});
export const importsApi = {
  capabilities: () => request<{ capabilities: string[] }>('/v1/admin/kmz-imports/capabilities'),
  sessions: () => request<{ items: Session[] }>('/v1/admin/kmz-imports'),
  upload: async (file: File, csrf: string, newReview = false) =>
    request<Session>('/v1/admin/kmz-imports', {
      method: 'POST',
      headers: {
        'content-type': 'application/vnd.google-earth.kmz',
        'x-csrf-token': csrf,
        'idempotency-key': crypto.randomUUID(),
        'x-file-name': file.name,
        ...(newReview ? { 'x-new-review': 'true' } : {}),
      },
      body: file,
    }),
  analyze: (id: string, csrf: string) =>
    request<Record<string, unknown>>(path(id, '/rematch'), {
      method: 'POST',
      headers: json(csrf),
      body: '{}',
    }),
  summary: (id: string) => request<Summary>(path(id, '/review/summary')),
  records: (id: string, filters: Filters) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters))
      if (value !== '') query.set(key, String(value));
    return request<{ items: ReviewRow[]; total: number; page: number; limit: number }>(
      path(id, `/review/records?${query}`),
    );
  },
  facets: (id: string) => request<Facets>(path(id, '/review/facets')),
  targets: (id: string, kind: 'CUSTOMER' | 'ESTABLISHMENT', search: string) =>
    request<{ kind: string; items: Target[] }>(
      path(id, `/review/targets?kind=${kind}&search=${encodeURIComponent(search)}`),
    ),
  map: (id: string) => request<{ items: MapPoint[] }>(path(id, '/review/map')),
  detail: (id: string, recordId: string) =>
    request<Detail>(path(id, `/review/records/${encodeURIComponent(recordId)}`)),
  save: (id: string, recordId: string, revision: number, change: Change, csrf: string) =>
    request<Record<string, unknown>>(path(id, `/review/records/${encodeURIComponent(recordId)}`), {
      method: 'PATCH',
      headers: json(csrf, { 'if-match': String(revision) }),
      body: JSON.stringify(change),
    }),
  bulkPreview: (id: string, input: Record<string, unknown>, csrf: string) =>
    request<{ digest: string; count: number; items: { record_id: string; name: string }[] }>(
      path(id, '/review/bulk-preview'),
      { method: 'POST', headers: json(csrf), body: JSON.stringify(input) },
    ),
  bulkApply: (id: string, input: Record<string, unknown>, digest: string, csrf: string) =>
    request<{ count: number }>(path(id, '/review/bulk-apply'), {
      method: 'POST',
      headers: json(csrf, { 'if-match': digest }),
      body: JSON.stringify(input),
    }),
  preview: (id: string, page: number) =>
    request<{
      summary: Summary;
      items: Array<{
        record_id: string;
        source_name: string;
        action: Action | null;
        proposed: Record<string, unknown> | null;
        reason: string | null;
        warnings: string[];
        conflicts: string[];
      }>;
    }>(path(id, `/review/preview?page=${page}`)),
  validate: (id: string, csrf: string) =>
    request<ConfirmationPlan>(path(id, '/validate'), {
      method: 'POST',
      headers: json(csrf),
      body: '{}',
    }),
  confirm: (id: string, plan: ConfirmationPlan, reason: string, key: string, csrf: string) =>
    request<ConfirmationResult>(path(id, '/confirm'), {
      method: 'POST',
      headers: json(csrf, { 'if-match': plan.etag, 'idempotency-key': key }),
      body: JSON.stringify({ plan_digest: plan.plan_digest, reason }),
    }),
  result: (id: string) => request<ConfirmationResult | ConfirmationPlan>(path(id, '/result')),
};
