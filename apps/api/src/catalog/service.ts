import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { appendAudit } from '../audit/index.js';
import { ApiError } from '../errors.js';

export type CatalogResource =
  | 'sources'
  | 'customers'
  | 'establishments'
  | 'pins'
  | 'groups'
  | 'routes';
export interface CatalogResult {
  status: number;
  body: Record<string, unknown>;
  etag?: string;
}
type Row = Record<string, unknown> & { id: string; version: string };
type Fields = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const resources: Record<CatalogResource, { table: string; columns: string; active: string }> = {
  sources: {
    table: 'catalog_source',
    columns: 'id,kind,authority,namespace,label,version,created_at,updated_at,archived_at',
    active: 'archived_at IS NULL',
  },
  customers: {
    table: 'catalog_customer',
    columns:
      'id,name,identity_status,source_id,external_customer_id,version,created_at,updated_at,archived_at',
    active: 'archived_at IS NULL',
  },
  establishments: {
    table: 'catalog_establishment',
    columns:
      'id,name,classification,source_id,source_key,version,created_at,updated_at,archived_at,ST_X(geog::geometry) AS longitude,ST_Y(geog::geometry) AS latitude',
    active: 'archived_at IS NULL',
  },
  pins: {
    table: 'catalog_pin',
    columns:
      'id,establishment_id,state,version,created_at,updated_at,ST_X(geog::geometry) AS longitude,ST_Y(geog::geometry) AS latitude',
    active: "state <> 'ARCHIVED'",
  },
  groups: {
    table: 'catalog_territory_group',
    columns: 'id,name,state,version,created_at,updated_at',
    active: "state <> 'ARCHIVED'",
  },
  routes: {
    table: 'catalog_route',
    columns: 'id,name,state,version,created_at,updated_at',
    active: "state <> 'ARCHIVED'",
  },
};
const stopColumns =
  'id,route_version_id,label,customer_id,establishment_id,pin_id,stop_order,state,version,created_at,updated_at,ST_X(geog::geometry) AS longitude,ST_Y(geog::geometry) AS latitude';
const invalid = (): never => {
  throw new ApiError(422, 'invalid_request', 'Invalid request');
};
const notFound = (): never => {
  throw new ApiError(404, 'catalog_missing', 'Not found');
};
const conflict = (): never => {
  throw new ApiError(409, 'version_conflict', 'Conflict');
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function shape(
  value: unknown,
  allowed: string[],
  required: string[] = [],
): Record<string, unknown> {
  const data = object(value);
  if (
    Object.keys(data).some((key) => !allowed.includes(key)) ||
    required.some((key) => !(key in data))
  )
    return invalid();
  return data;
}
function str(value: unknown, min = 1, max = 200): string {
  if (typeof value !== 'string') return invalid();
  const result = value.trim();
  if (result.length < min || result.length > max) return invalid();
  return result;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) return invalid();
  return value;
}
function point(longitude: unknown, latitude: unknown): string {
  if (
    typeof longitude !== 'number' ||
    typeof latitude !== 'number' ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  )
    return invalid();
  return 'SRID=4326;POINT(' + longitude + ' ' + latitude + ')';
}
function optionalPoint(data: Record<string, unknown>): string | null {
  const lon = 'longitude' in data;
  const lat = 'latitude' in data;
  if (lon !== lat) return invalid();
  return lon ? point(data.longitude, data.latitude) : null;
}
function etag(resource: string, row: Row): string {
  return '"catalog:' + resource + ':' + row.id + ':' + row.version + '"';
}
function dbError(error: unknown): Error {
  if (error instanceof ApiError) return error;
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === '23505') return new ApiError(409, 'catalog_conflict', 'Conflict');
  if (['23503', '23514', '22P02', '22003'].includes(code))
    return new ApiError(422, 'invalid_relation', 'Invalid request');
  return error instanceof Error ? error : new Error('Catalog operation failed');
}
function insertSql(table: string, fields: Fields): { sql: string; values: unknown[] } {
  const entries = Object.entries(fields);
  return {
    sql:
      'INSERT INTO ' +
      table +
      '(' +
      entries.map(([key]) => key).join(',') +
      ') VALUES(' +
      entries.map((_, index) => '$' + (index + 1)).join(',') +
      ')',
    values: entries.map(([, value]) => value),
  };
}

export class CatalogService {
  constructor(private readonly pool: Pool) {}

  private async recordDenial(
    actorId: string,
    requestId: string,
    operation: string,
    resource: string,
    resourceId: string | null,
    reasonCode: string,
  ): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO audit_event(id,actor_type,actor_id,action,outcome,correlation_id,metadata_redacted) ' +
          "SELECT $1,'ADMIN',$2,'catalog.access.denied','rejected',$3," +
          "jsonb_build_object('company_scope','SINGLE_COMPANY'," +
          "'operating_tenant_id',(SELECT tenant_id FROM geops_operating_tenant WHERE singleton=true)," +
          "'operation',$4::text,'resource',$5::text,'resource_id',$6::text,'reason_code',$7::text) " +
          'ON CONFLICT DO NOTHING',
        [randomUUID(), actorId, requestId, operation, resource, resourceId, reasonCode],
      );
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
      process.stderr.write('GEOPS catalog audit persistence failed: ' + code + '\n');
      throw new ApiError(503, 'catalog_audit_unavailable', 'Service unavailable');
    }
  }

  async revision(actorId: string, requestId: string): Promise<{ version: string }> {
    await this.permission(actorId, 'catalog.import.read', requestId);
    const result = await this.pool.query<{ version: string }>(
      'SELECT version FROM catalog_revision WHERE singleton=true',
    );
    return result.rows[0] ?? notFound();
  }

  private async permission(
    actorId: string,
    capability: 'catalog.import.read' | 'catalog.import.write',
    requestId: string,
    db: Pool | PoolClient = this.pool,
    lock = false,
    auditOnDeny = true,
  ): Promise<void> {
    const found = await db.query(
      'SELECT 1 FROM admin_user u JOIN admin_permission p ON p.admin_id=u.id ' +
        'AND p.permission=$2 AND p.revoked_at IS NULL WHERE u.id=$1 AND u.state=$3 ' +
        (lock ? 'FOR SHARE OF u,p' : ''),
      [actorId, capability, 'ACTIVE'],
    );
    if (found.rowCount) return;
    if (auditOnDeny)
      await this.recordDenial(
        actorId,
        requestId,
        'catalog.read',
        capability,
        null,
        'catalog_forbidden',
      );
    throw new ApiError(403, 'catalog_forbidden', 'Forbidden');
  }

  private async write(
    actorId: string,
    requestId: string,
    action: string,
    work: (db: PoolClient) => Promise<CatalogResult>,
    resourceId: string | null = null,
  ): Promise<CatalogResult> {
    const db = await this.pool.connect();
    let failure: unknown;
    try {
      await db.query('BEGIN');
      await this.permission(actorId, 'catalog.import.write', requestId, db, true, false);
      const result = await work(db);
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId,
        action: 'catalog.' + action,
        outcome: 'success',
        correlationId: requestId,
        metadata: {
          resource_id: String(result.body.id ?? ''),
          version: String(result.body.version ?? ''),
        },
      });
      await db.query('COMMIT');
      return result;
    } catch (error) {
      failure = error;
      try {
        await db.query('ROLLBACK');
      } catch {
        process.stderr.write('GEOPS catalog rollback failed\n');
      }
    } finally {
      db.release();
    }
    const normalized = dbError(failure);
    if (normalized instanceof ApiError && [403, 409].includes(normalized.statusCode))
      await this.recordDenial(
        actorId,
        requestId,
        action,
        action.split('.')[0] ?? 'catalog',
        resourceId,
        normalized.code,
      );
    throw normalized;
  }

  private async row(
    db: Pool | PoolClient,
    resource: CatalogResource,
    recordId: string,
    lock = false,
  ): Promise<Row> {
    const spec = resources[resource];
    const found = await db.query<Row>(
      'SELECT ' +
        spec.columns +
        ' FROM ' +
        spec.table +
        ' WHERE id=$1 AND ' +
        spec.active +
        (lock ? ' FOR UPDATE' : ''),
      [id(recordId)],
    );
    return found.rows[0] ?? notFound();
  }

  async list(
    resource: CatalogResource,
    actorId: string,
    requestId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: Row[]; next_cursor: string | null }> {
    await this.permission(actorId, 'catalog.import.read', requestId);
    if (cursor !== undefined) id(cursor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid();
    const spec = resources[resource];
    const result = await this.pool.query<Row>(
      'SELECT ' +
        spec.columns +
        ' FROM ' +
        spec.table +
        ' WHERE ' +
        spec.active +
        ' AND ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT $2',
      [cursor ?? null, limit + 1],
    );
    const items = result.rows.slice(0, limit);
    return { items, next_cursor: result.rows.length > limit ? (items.at(-1)?.id ?? null) : null };
  }

  async get(
    resource: CatalogResource,
    recordId: string,
    actorId: string,
    requestId: string,
  ): Promise<CatalogResult> {
    await this.permission(actorId, 'catalog.import.read', requestId);
    const found = await this.row(this.pool, resource, recordId);
    return { status: 200, body: found, etag: etag(resource, found) };
  }

  async create(
    resource: CatalogResource,
    input: unknown,
    actorId: string,
    requestId: string,
  ): Promise<CatalogResult> {
    const data = object(input);
    const why = str(data.reason, 8, 240);
    let fields: Fields;
    switch (resource) {
      case 'sources': {
        shape(
          data,
          ['kind', 'namespace', 'label', 'reason'],
          ['kind', 'namespace', 'label', 'reason'],
        );
        if (!['AUTHORIZED_CSV', 'AUTHORIZED_XLSX', 'KMZ_GEO', 'MANUAL'].includes(String(data.kind)))
          return invalid();
        const namespace = str(data.namespace, 1, 80);
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(namespace)) return invalid();
        fields = { kind: data.kind, namespace, label: str(data.label, 1, 160) };
        break;
      }
      case 'customers':
        shape(data, ['name', 'reason'], ['name', 'reason']);
        fields = { name: str(data.name), identity_status: 'CANDIDATE' };
        break;
      case 'establishments': {
        shape(
          data,
          ['name', 'longitude', 'latitude', 'source_id', 'source_key', 'reason'],
          ['name', 'reason'],
        );
        if ('source_id' in data !== 'source_key' in data) return invalid();
        fields = { name: str(data.name) };
        const location = optionalPoint(data);
        if (location) fields.geog = location;
        if ('source_id' in data) {
          fields.source_id = id(data.source_id);
          fields.source_key = str(data.source_key, 1, 240);
        }
        break;
      }
      case 'pins':
        shape(
          data,
          ['establishment_id', 'longitude', 'latitude', 'reason'],
          ['establishment_id', 'longitude', 'latitude', 'reason'],
        );
        fields = {
          establishment_id: id(data.establishment_id),
          geog: point(data.longitude, data.latitude),
        };
        break;
      case 'groups':
        shape(data, ['name', 'reason'], ['name', 'reason']);
        fields = { name: str(data.name, 1, 160) };
        break;
      case 'routes':
        shape(data, ['name', 'reason'], ['name', 'reason']);
        fields = { name: str(data.name, 1, 160) };
        break;
    }
    return this.write(actorId, requestId, resource + '.create', async (db) => {
      const recordId = randomUUID();
      const query = insertSql(resources[resource].table, {
        id: recordId,
        ...fields,
        created_by: actorId,
      });
      await db.query(query.sql, query.values);
      let routeVersionId: string | undefined;
      if (resource === 'routes') {
        routeVersionId = randomUUID();
        await db.query(
          'INSERT INTO catalog_route_version(id,route_id,revision,created_by) VALUES($1,$2,1,$3)',
          [routeVersionId, recordId, actorId],
        );
      }
      const created = await this.row(db, resource, recordId);
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId,
        action: 'catalog.change.reason',
        outcome: 'success',
        correlationId: requestId,
        metadata: { reason: why, resource, resource_id: recordId },
      });
      return {
        status: 201,
        body: { ...created, ...(routeVersionId ? { route_version_id: routeVersionId } : {}) },
        etag: etag(resource, created),
      };
    });
  }

  async patch(
    resource: CatalogResource,
    recordId: string,
    input: unknown,
    ifMatch: string | undefined,
    actorId: string,
    requestId: string,
  ): Promise<CatalogResult> {
    const data = shape(input, ['changes', 'reason'], ['changes', 'reason']);
    const changes = object(data.changes);
    const why = str(data.reason, 8, 240);
    if (!Object.keys(changes).length || !ifMatch) return invalid();
    const updates: Fields = {};
    switch (resource) {
      case 'sources':
        shape(changes, ['label']);
        if ('label' in changes) updates.label = str(changes.label, 1, 160);
        break;
      case 'customers':
        shape(changes, ['name']);
        if ('name' in changes) updates.name = str(changes.name);
        break;
      case 'establishments':
        shape(changes, ['name', 'classification', 'longitude', 'latitude']);
        if ('name' in changes) updates.name = str(changes.name);
        if ('classification' in changes) {
          if (!['PENDING', 'CONFIRMED', 'DUPLICATE'].includes(String(changes.classification)))
            return invalid();
          updates.classification = changes.classification;
        }
        if ('longitude' in changes || 'latitude' in changes)
          updates.geog = point(changes.longitude, changes.latitude);
        break;
      case 'pins':
        shape(changes, ['longitude', 'latitude', 'state']);
        if ('longitude' in changes || 'latitude' in changes)
          updates.geog = point(changes.longitude, changes.latitude);
        if ('state' in changes) {
          if (!['CANDIDATE', 'CONFIRMED'].includes(String(changes.state))) return invalid();
          updates.state = changes.state;
        }
        break;
      case 'groups':
      case 'routes':
        shape(changes, ['name']);
        if ('name' in changes) updates.name = str(changes.name, 1, 160);
        break;
    }
    if (!Object.keys(updates).length) return invalid();
    return this.write(
      actorId,
      requestId,
      resource + '.update',
      async (db) => {
        const previous = await this.row(db, resource, recordId, true);
        if (ifMatch !== etag(resource, previous)) return conflict();
        const entries = Object.entries(updates);
        const assignments = entries.map(([key], index) => key + '=$' + (index + 3)).join(',');
        const changed = await db.query(
          'UPDATE ' +
            resources[resource].table +
            ' SET ' +
            assignments +
            ',version=version+1,updated_at=now() WHERE id=$1 AND version=$2',
          [recordId, previous.version, ...entries.map(([, value]) => value)],
        );
        if (changed.rowCount !== 1) return conflict();
        const current = await this.row(db, resource, recordId);
        await appendAudit(db, {
          actorType: 'ADMIN',
          actorId,
          action: 'catalog.change.detail',
          outcome: 'success',
          correlationId: requestId,
          previousState: JSON.stringify(previous),
          nextState: JSON.stringify(current),
          metadata: { reason: why, fields: Object.keys(updates).join(','), resource_id: recordId },
        });
        return { status: 200, body: current, etag: etag(resource, current) };
      },
      recordId,
    );
  }

  async archive(
    resource: CatalogResource,
    recordId: string,
    input: unknown,
    ifMatch: string | undefined,
    actorId: string,
    requestId: string,
  ): Promise<CatalogResult> {
    const data = shape(input, ['reason'], ['reason']);
    const why = str(data.reason, 8, 240);
    if (!ifMatch) return invalid();
    const dependencies: Record<CatalogResource, string> = {
      sources:
        'SELECT 1 FROM catalog_customer WHERE source_id=$1 UNION ALL SELECT 1 FROM catalog_establishment WHERE source_id=$1',
      customers:
        'SELECT 1 FROM catalog_customer_establishment WHERE customer_id=$1 UNION ALL SELECT 1 FROM catalog_route_stop WHERE customer_id=$1',
      establishments:
        'SELECT 1 FROM catalog_customer_establishment WHERE establishment_id=$1 UNION ALL SELECT 1 FROM catalog_pin WHERE establishment_id=$1 UNION ALL SELECT 1 FROM catalog_territory_member WHERE establishment_id=$1 UNION ALL SELECT 1 FROM catalog_route_stop WHERE establishment_id=$1',
      pins: 'SELECT 1 FROM catalog_route_stop WHERE pin_id=$1',
      groups: 'SELECT 1 FROM catalog_territory_member WHERE group_id=$1 AND valid_until IS NULL',
      routes:
        'SELECT 1 FROM catalog_route_stop s JOIN catalog_route_version v ON v.id=s.route_version_id WHERE v.route_id=$1',
    };
    return this.write(
      actorId,
      requestId,
      resource + '.archive',
      async (db) => {
        const previous = await this.row(db, resource, recordId, true);
        if (ifMatch !== etag(resource, previous)) return conflict();
        const refs = await db.query(dependencies[resource] + ' LIMIT 1', [recordId]);
        if (refs.rowCount) throw new ApiError(409, 'catalog_referenced', 'Conflict');
        const assignment = ['sources', 'customers', 'establishments'].includes(resource)
          ? 'archived_at=now()'
          : "state='ARCHIVED'";
        const changed = await db.query(
          'UPDATE ' +
            resources[resource].table +
            ' SET ' +
            assignment +
            ',version=version+1,updated_at=now() WHERE id=$1 AND version=$2',
          [recordId, previous.version],
        );
        if (changed.rowCount !== 1) return conflict();
        await appendAudit(db, {
          actorType: 'ADMIN',
          actorId,
          action: 'catalog.change.reason',
          outcome: 'success',
          correlationId: requestId,
          metadata: { reason: why, resource, resource_id: recordId },
        });
        return {
          status: 200,
          body: { id: recordId, version: String(Number(previous.version) + 1) },
        };
      },
      recordId,
    );
  }

  async linkCustomer(
    establishmentId: string,
    input: unknown,
    ifMatch: string | undefined,
    actorId: string,
    requestId: string,
  ): Promise<CatalogResult> {
    const data = shape(input, ['customer_id', 'reason'], ['customer_id', 'reason']);
    const customerId = id(data.customer_id);
    const why = str(data.reason, 8, 240);
    if (!ifMatch) return invalid();
    return this.write(
      actorId,
      requestId,
      'customer.link',
      async (db) => {
        const establishment = await this.row(db, 'establishments', establishmentId, true);
        if (ifMatch !== etag('establishments', establishment)) return conflict();
        await this.row(db, 'customers', customerId);
        const linked = await db.query<{ linked_at: Date }>(
          'INSERT INTO catalog_customer_establishment(customer_id,establishment_id,approved_by,reason) VALUES($1,$2,$3,$4) RETURNING linked_at',
          [customerId, establishmentId, actorId, why],
        );
        await db.query(
          'UPDATE catalog_establishment SET version=version+1,updated_at=now() WHERE id=$1',
          [establishmentId],
        );
        const current = await this.row(db, 'establishments', establishmentId);
        await appendAudit(db, {
          actorType: 'ADMIN',
          actorId,
          action: 'catalog.customer.link.history',
          outcome: 'success',
          correlationId: requestId,
          previousState: JSON.stringify({
            customer_id: customerId,
            establishment_id: establishmentId,
            state: 'UNLINKED',
          }),
          nextState: JSON.stringify({
            customer_id: customerId,
            establishment_id: establishmentId,
            state: 'LINKED',
            linked_at: linked.rows[0]?.linked_at,
            approved_by: actorId,
            reason: why,
          }),
          metadata: { customer_id: customerId, establishment_id: establishmentId },
        });
        return {
          status: 201,
          body: { id: establishmentId, customer_id: customerId, version: current.version },
          etag: etag('establishments', current),
        };
      },
      establishmentId,
    );
  }

  async customersForEstablishment(
    establishmentId: string,
    actorId: string,
    requestId: string,
  ): Promise<{ items: Row[] }> {
    await this.permission(actorId, 'catalog.import.read', requestId);
    await this.row(this.pool, 'establishments', establishmentId);
    const found = await this.pool.query<Row>(
      'SELECT c.id,c.name,c.identity_status,c.version,l.linked_at ' +
        'FROM catalog_customer_establishment l JOIN catalog_customer c ON c.id=l.customer_id ' +
        'WHERE l.establishment_id=$1 AND c.archived_at IS NULL ORDER BY c.id',
      [establishmentId],
    );
    return { items: found.rows };
  }

  async unlinkCustomer(
    establishmentId: string,
    customerId: string,
    input: unknown,
    ifMatch: string | undefined,
    actorId: string,
    requestId: string,
  ): Promise<CatalogResult> {
    const data = shape(input, ['reason'], ['reason']);
    const why = str(data.reason, 8, 240);
    if (!ifMatch) return invalid();
    return this.write(
      actorId,
      requestId,
      'customer.unlink',
      async (db) => {
        const establishment = await this.row(db, 'establishments', establishmentId, true);
        if (ifMatch !== etag('establishments', establishment)) return conflict();
        const refs = await db.query(
          'SELECT 1 FROM catalog_route_stop WHERE customer_id=$1 AND establishment_id=$2 LIMIT 1',
          [id(customerId), establishmentId],
        );
        if (refs.rowCount) throw new ApiError(409, 'catalog_referenced', 'Conflict');
        const link = await db.query<{ approved_by: string; reason: string; linked_at: Date }>(
          'SELECT approved_by,reason,linked_at FROM catalog_customer_establishment ' +
            'WHERE customer_id=$1 AND establishment_id=$2 FOR UPDATE',
          [customerId, establishmentId],
        );
        if (!link.rowCount) return notFound();
        const removed = await db.query(
          'DELETE FROM catalog_customer_establishment WHERE customer_id=$1 AND establishment_id=$2',
          [customerId, establishmentId],
        );
        if (removed.rowCount !== 1) return notFound();
        await db.query(
          'UPDATE catalog_establishment SET version=version+1,updated_at=now() WHERE id=$1',
          [establishmentId],
        );
        const current = await this.row(db, 'establishments', establishmentId);
        const unlinkedAt = await db.query<{ at: Date }>('SELECT now() AS at');
        await appendAudit(db, {
          actorType: 'ADMIN',
          actorId,
          action: 'catalog.customer.unlink.history',
          outcome: 'success',
          correlationId: requestId,
          previousState: JSON.stringify({
            customer_id: customerId,
            establishment_id: establishmentId,
            state: 'LINKED',
            linked_at: link.rows[0]?.linked_at,
            approved_by: link.rows[0]?.approved_by,
            reason: link.rows[0]?.reason,
          }),
          nextState: JSON.stringify({
            customer_id: customerId,
            establishment_id: establishmentId,
            state: 'UNLINKED',
            unlinked_at: unlinkedAt.rows[0]?.at,
            unlinked_by: actorId,
            reason: why,
          }),
          metadata: { customer_id: customerId, establishment_id: establishmentId },
        });
        return {
          status: 200,
          body: { id: establishmentId, customer_id: customerId, version: current.version },
          etag: etag('establishments', current),
        };
      },
      establishmentId,
    );
  }

  async groupMembers(
    groupId: string,
    actorId: string,
    requestId: string,
  ): Promise<{ items: Row[] }> {
    await this.permission(actorId, 'catalog.import.read', requestId);
    await this.row(this.pool, 'groups', groupId);
    const found = await this.pool.query<Row>(
      'SELECT e.id,e.name,e.classification,e.version,m.valid_from ' +
        'FROM catalog_territory_member m JOIN catalog_establishment e ON e.id=m.establishment_id ' +
        'WHERE m.group_id=$1 AND m.valid_until IS NULL AND e.archived_at IS NULL ORDER BY e.id',
      [groupId],
    );
    return { items: found.rows };
  }

  async changeMember(
    groupId: string,
    establishmentId: string,
    remove: boolean,
    input: unknown,
    ifMatch: string | undefined,
    actorId: string,
    requestId: string,
  ): Promise<CatalogResult> {
    const data = shape(input, ['reason'], ['reason']);
    const why = str(data.reason, 8, 240);
    if (!ifMatch) return invalid();
    return this.write(
      actorId,
      requestId,
      'group.member',
      async (db) => {
        const group = await this.row(db, 'groups', groupId, true);
        if (ifMatch !== etag('groups', group)) return conflict();
        await this.row(db, 'establishments', establishmentId);
        if (remove) {
          const result = await db.query(
            'UPDATE catalog_territory_member SET valid_until=now() WHERE group_id=$1 AND establishment_id=$2 AND valid_until IS NULL',
            [groupId, establishmentId],
          );
          if (!result.rowCount) return notFound();
        } else {
          await db.query(
            'INSERT INTO catalog_territory_member(group_id,establishment_id,valid_from,added_by) VALUES($1,$2,now(),$3)',
            [groupId, establishmentId, actorId],
          );
        }
        await db.query(
          'UPDATE catalog_territory_group SET version=version+1,updated_at=now() WHERE id=$1',
          [groupId],
        );
        const current = await this.row(db, 'groups', groupId);
        await appendAudit(db, {
          actorType: 'ADMIN',
          actorId,
          action: 'catalog.change.reason',
          outcome: 'success',
          correlationId: requestId,
          metadata: { reason: why, resource: 'group_member', resource_id: establishmentId },
        });
        return {
          status: remove ? 200 : 201,
          body: { id: groupId, establishment_id: establishmentId, version: current.version },
          etag: etag('groups', current),
        };
      },
      groupId,
    );
  }

  private async routeVersion(db: Pool | PoolClient, routeId: string): Promise<string> {
    await this.row(db, 'routes', routeId);
    const found = await db.query<{ id: string }>(
      'SELECT id FROM catalog_route_version WHERE route_id=$1 AND revision=1 AND state=$2',
      [routeId, 'DRAFT'],
    );
    return found.rows[0]?.id ?? notFound();
  }

  private async stopRow(
    db: Pool | PoolClient,
    routeVersionId: string,
    stopId: string,
    lock = false,
  ): Promise<Row> {
    const found = await db.query<Row>(
      'SELECT ' +
        stopColumns +
        ' FROM catalog_route_stop WHERE id=$1 AND route_version_id=$2' +
        (lock ? ' FOR UPDATE' : ''),
      [id(stopId), routeVersionId],
    );
    return found.rows[0] ?? notFound();
  }

  async listStops(
    routeId: string,
    actorId: string,
    requestId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: Row[]; next_cursor: string | null }> {
    await this.permission(actorId, 'catalog.import.read', requestId);
    if (cursor !== undefined) id(cursor);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid();
    const versionId = await this.routeVersion(this.pool, id(routeId));
    const found = await this.pool.query<Row>(
      'SELECT ' +
        stopColumns +
        ' FROM catalog_route_stop WHERE route_version_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3',
      [versionId, cursor ?? null, limit + 1],
    );
    const items = found.rows.slice(0, limit);
    return { items, next_cursor: found.rows.length > limit ? (items.at(-1)?.id ?? null) : null };
  }

  async getStop(
    routeId: string,
    stopId: string,
    actorId: string,
    requestId: string,
  ): Promise<CatalogResult> {
    await this.permission(actorId, 'catalog.import.read', requestId);
    const versionId = await this.routeVersion(this.pool, id(routeId));
    const row = await this.stopRow(this.pool, versionId, stopId);
    return { status: 200, body: row, etag: etag('stops', row) };
  }

  async createStop(
    routeId: string,
    input: unknown,
    actorId: string,
    requestId: string,
  ): Promise<CatalogResult> {
    const data = shape(
      input,
      [
        'label',
        'longitude',
        'latitude',
        'customer_id',
        'establishment_id',
        'pin_id',
        'stop_order',
        'reason',
      ],
      ['label', 'reason'],
    );
    const why = str(data.reason, 8, 240);
    const fields: Fields = { label: str(data.label) };
    const location = optionalPoint(data);
    if (location) fields.geog = location;
    if ('customer_id' in data)
      fields.customer_id = data.customer_id === null ? null : id(data.customer_id);
    if ('establishment_id' in data)
      fields.establishment_id = data.establishment_id === null ? null : id(data.establishment_id);
    if ('pin_id' in data) fields.pin_id = data.pin_id === null ? null : id(data.pin_id);
    if ('stop_order' in data) {
      if (
        data.stop_order !== null &&
        (!Number.isInteger(data.stop_order) ||
          Number(data.stop_order) < 1 ||
          Number(data.stop_order) > 10000)
      )
        return invalid();
      fields.stop_order = data.stop_order;
    }
    return this.write(
      actorId,
      requestId,
      'route.stop.create',
      async (db) => {
        const versionId = await this.routeVersion(db, id(routeId));
        const stopId = randomUUID();
        const query = insertSql('catalog_route_stop', {
          id: stopId,
          route_version_id: versionId,
          ...fields,
          created_by: actorId,
        });
        await db.query(query.sql, query.values);
        const row = await this.stopRow(db, versionId, stopId);
        await appendAudit(db, {
          actorType: 'ADMIN',
          actorId,
          action: 'catalog.change.reason',
          outcome: 'success',
          correlationId: requestId,
          metadata: { reason: why, resource: 'route_stop', resource_id: stopId },
        });
        return { status: 201, body: row, etag: etag('stops', row) };
      },
      routeId,
    );
  }

  async patchStop(
    routeId: string,
    stopId: string,
    input: unknown,
    ifMatch: string | undefined,
    actorId: string,
    requestId: string,
  ): Promise<CatalogResult> {
    const data = shape(input, ['changes', 'reason'], ['changes', 'reason']);
    const changes = shape(data.changes, [
      'label',
      'longitude',
      'latitude',
      'customer_id',
      'establishment_id',
      'pin_id',
      'stop_order',
    ]);
    const why = str(data.reason, 8, 240);
    if (!ifMatch || !Object.keys(changes).length) return invalid();
    const updates: Fields = {};
    if ('label' in changes) updates.label = str(changes.label);
    if ('longitude' in changes || 'latitude' in changes)
      updates.geog = point(changes.longitude, changes.latitude);
    for (const key of ['customer_id', 'establishment_id', 'pin_id']) {
      if (key in changes) updates[key] = changes[key] === null ? null : id(changes[key]);
    }
    if ('stop_order' in changes) {
      if (
        changes.stop_order !== null &&
        (!Number.isInteger(changes.stop_order) ||
          Number(changes.stop_order) < 1 ||
          Number(changes.stop_order) > 10000)
      )
        return invalid();
      updates.stop_order = changes.stop_order;
    }
    return this.write(
      actorId,
      requestId,
      'route.stop.update',
      async (db) => {
        const versionId = await this.routeVersion(db, id(routeId));
        const previous = await this.stopRow(db, versionId, stopId, true);
        if (ifMatch !== etag('stops', previous)) return conflict();
        const entries = Object.entries(updates);
        const assignments = entries.map(([key], index) => key + '=$' + (index + 3)).join(',');
        const changed = await db.query(
          'UPDATE catalog_route_stop SET ' +
            assignments +
            ',version=version+1,updated_at=now() WHERE id=$1 AND version=$2',
          [stopId, previous.version, ...entries.map(([, value]) => value)],
        );
        if (changed.rowCount !== 1) return conflict();
        const current = await this.stopRow(db, versionId, stopId);
        await appendAudit(db, {
          actorType: 'ADMIN',
          actorId,
          action: 'catalog.change.detail',
          outcome: 'success',
          correlationId: requestId,
          previousState: JSON.stringify(previous),
          nextState: JSON.stringify(current),
          metadata: { reason: why, fields: Object.keys(updates).join(','), resource_id: stopId },
        });
        return { status: 200, body: current, etag: etag('stops', current) };
      },
      stopId,
    );
  }

  async deleteStop(
    routeId: string,
    stopId: string,
    input: unknown,
    ifMatch: string | undefined,
    actorId: string,
    requestId: string,
  ): Promise<CatalogResult> {
    const data = shape(input, ['reason'], ['reason']);
    const why = str(data.reason, 8, 240);
    if (!ifMatch) return invalid();
    return this.write(
      actorId,
      requestId,
      'route.stop.delete',
      async (db) => {
        const versionId = await this.routeVersion(db, id(routeId));
        const previous = await this.stopRow(db, versionId, stopId, true);
        if (ifMatch !== etag('stops', previous)) return conflict();
        const removed = await db.query(
          'DELETE FROM catalog_route_stop WHERE id=$1 AND version=$2',
          [stopId, previous.version],
        );
        if (removed.rowCount !== 1) return conflict();
        await appendAudit(db, {
          actorType: 'ADMIN',
          actorId,
          action: 'catalog.change.reason',
          outcome: 'success',
          correlationId: requestId,
          previousState: JSON.stringify(previous),
          metadata: { reason: why, resource: 'route_stop', resource_id: stopId },
        });
        return { status: 200, body: { id: stopId, deleted: true } };
      },
      stopId,
    );
  }
}
