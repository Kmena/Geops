import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from '../errors.js';
import { appendAudit } from '../audit/index.js';
import { requireInstallationAccess } from './admin-scope.js';

export interface DeviceRecord {
  id: string;
  display_label: string;
  status: string;
  mdm_binding_id: string;
}

export interface DeviceInventoryRecord extends DeviceRecord {
  tenant_id: string;
  mdm_device_id: string;
  enrolled_at: string | null;
  last_communication_at: string | null;
  invitation_id: string | null;
  invitation_status: string | null;
  invitation_expires_at: string | null;
  claim_id: string | null;
  claim_status: string | null;
  key_id: string | null;
  installation_id: string | null;
}

export interface BindingRecord {
  id: string;
  geops_device_id: string;
  provider: string;
  customer_id: string;
  mdm_device_id: string;
  state: string;
}

export async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export class DeviceRepository {
  constructor(readonly pool: Pool) {}

  async createDraft(
    label: string,
    adminId?: string,
    correlationId: string = randomUUID(),
  ): Promise<DeviceRecord> {
    if (label.trim().length < 1 || label.length > 120) {
      throw new ApiError(400, 'invalid_request', 'Invalid request');
    }
    return transaction(this.pool, async (db) => {
      if (adminId) {
        await requireInstallationAccess(db, adminId, 'synthetic');
      }
      const id = randomUUID();
      const bindingId = randomUUID();
      await db.query("INSERT INTO geops_device(id,status,display_label) VALUES($1,'DRAFT',$2)", [
        id,
        label.trim(),
      ]);
      await db.query(
        "INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake','synthetic',$3,'PENDING')",
        [bindingId, id, `fake-${id}`],
      );
      await appendAudit(db, {
        actorType: adminId ? 'ADMIN' : 'SYSTEM',
        ...(adminId ? { actorId: adminId } : {}),
        deviceId: id,
        action: 'device.draft.create',
        outcome: 'success',
        correlationId,
        nextState: 'DRAFT',
        metadata: { tenant_id: 'synthetic' },
      });
      return {
        id,
        display_label: label.trim(),
        status: 'DRAFT',
        mdm_binding_id: bindingId,
      };
    });
  }

  async list(
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: DeviceRecord[]; next_cursor: string | null; source: 'geops' }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ApiError(400, 'invalid_limit', 'Invalid limit');
    let after: string | null = null;
    if (cursor) {
      try {
        after = Buffer.from(cursor, 'base64url').toString('utf8');
      } catch {
        throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
      }
      if (!/^[0-9a-f-]{36}$/.test(after))
        throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
    }
    const result = await this.pool.query<DeviceRecord>(
      "SELECT d.id,d.display_label,d.status,b.id AS mdm_binding_id FROM geops_device d JOIN mdm_binding b ON b.geops_device_id=d.id AND b.state IN ('PENDING','ACTIVE') WHERE b.provider='fake' AND b.customer_id='synthetic' AND ($1::uuid IS NULL OR d.id>$1::uuid) ORDER BY d.id LIMIT $2",
      [after, limit + 1],
    );
    const items = result.rows.slice(0, limit);
    const last = items.at(-1);
    const next_cursor =
      result.rows.length > limit && last ? Buffer.from(last.id).toString('base64url') : null;
    return { items, next_cursor, source: 'geops' };
  }

  async listEnrollment(
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: DeviceInventoryRecord[]; next_cursor: string | null; source: 'geops' }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApiError(400, 'invalid_limit', 'Invalid limit');
    }
    let after: string | null = null;
    if (cursor) {
      try {
        after = Buffer.from(cursor, 'base64url').toString('utf8');
      } catch {
        throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
      }
      if (!/^[0-9a-f-]{36}$/.test(after))
        throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
    }
    const result = await this.pool.query<DeviceInventoryRecord>(
      `SELECT d.id,d.display_label,d.status,b.id AS mdm_binding_id,
        b.customer_id AS tenant_id,b.mdm_device_id,b.verified_at AS enrolled_at,
        i.id AS invitation_id,i.status AS invitation_status,i.expires_at AS invitation_expires_at,
        c.id AS claim_id,c.status AS claim_status,k.id AS key_id,g.installation_id,
        (SELECT max(received_at) FROM (
          SELECT max(received_at) AS received_at FROM gps_device_health_event WHERE device_id=d.id
          UNION ALL SELECT max(received_at) FROM gps_session_event WHERE device_id=d.id
          UNION ALL SELECT max(received_at) FROM position_event WHERE device_id=d.id
          UNION ALL SELECT max(issued_at) FROM device_session WHERE geops_device_id=d.id
        ) communication) AS last_communication_at
      FROM geops_device d JOIN mdm_binding b ON b.geops_device_id=d.id AND b.state IN ('PENDING','ACTIVE')
      LEFT JOIN LATERAL (SELECT id,status,expires_at FROM device_invitation WHERE geops_device_id=d.id ORDER BY issued_at DESC LIMIT 1) i ON true
      LEFT JOIN LATERAL (SELECT id,status FROM enrollment_claim WHERE invitation_id=i.id AND status IN ('CLAIMED','PENDING_CONFIRMATION') LIMIT 1) c ON true
      LEFT JOIN LATERAL (SELECT id FROM device_key WHERE geops_device_id=d.id AND status='ACTIVE' LIMIT 1) k ON true
      LEFT JOIN LATERAL (SELECT installation_id FROM gps_device_installation WHERE device_id=d.id AND retired_at IS NULL LIMIT 1) g ON true
      WHERE b.provider='fake' AND b.customer_id='synthetic' AND ($1::uuid IS NULL OR d.id>$1::uuid)
      ORDER BY d.id LIMIT $2`,
      [after, limit + 1],
    );
    const items = result.rows.slice(0, limit);
    const last = items.at(-1);
    const next_cursor =
      result.rows.length > limit && last ? Buffer.from(last.id).toString('base64url') : null;
    return { items, next_cursor, source: 'geops' };
  }

  async getDeviceForUpdate(
    db: PoolClient,
    id: string,
  ): Promise<{ id: string; status: string; version: string }> {
    const result = await db.query<{ id: string; status: string; version: string }>(
      'SELECT id,status,version FROM geops_device WHERE id=$1 FOR UPDATE',
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new ApiError(404, 'device_missing', 'Not found', true);
    return row;
  }

  async getBinding(db: PoolClient, bindingId: string, deviceId: string): Promise<BindingRecord> {
    const result = await db.query<BindingRecord>(
      'SELECT id,geops_device_id,provider,customer_id,mdm_device_id,state FROM mdm_binding WHERE id=$1 AND geops_device_id=$2 FOR UPDATE',
      [bindingId, deviceId],
    );
    const row = result.rows[0];
    if (!row || row.state === 'REVOKED')
      throw new ApiError(409, 'binding_unavailable', 'Conflict', true);
    return row;
  }

  async revoke(
    deviceId: string,
    adminId?: string,
    correlationId: string = randomUUID(),
  ): Promise<void> {
    try {
      await transaction(this.pool, async (db) => {
        if (adminId) await requireInstallationAccess(db, adminId, 'synthetic');
        const device = await this.getDeviceForUpdate(db, deviceId);
        if (device.status === 'REVOKED') {
          if (adminId) {
            const previous = await db.query<{ count: number; valid: boolean }>(
              "SELECT count(*)::int AS count,bool_and(provider='fake' AND customer_id='synthetic' AND state='REVOKED') AS valid FROM mdm_binding WHERE geops_device_id=$1",
              [deviceId],
            );
            if (!previous.rows[0]?.count || !previous.rows[0].valid)
              throw new ApiError(409, 'binding_conflict', 'Conflict', true);
          }
          return;
        }
        if (adminId) {
          const binding = await db.query<{ customer_id: string }>(
            "SELECT customer_id FROM mdm_binding WHERE geops_device_id=$1 AND state IN ('PENDING','ACTIVE') FOR SHARE",
            [deviceId],
          );
          const activeBinding = binding.rows[0];
          if (binding.rows.length !== 1 || !activeBinding)
            throw new ApiError(409, 'binding_conflict', 'Conflict', true);
          await requireInstallationAccess(db, adminId, activeBinding.customer_id);
        }
        await db.query(
          "UPDATE geops_device SET status='REVOKED',version=version+1,updated_at=now() WHERE id=$1",
          [deviceId],
        );
        await db.query(
          "UPDATE mdm_binding SET state='REVOKED',version=version+1 WHERE geops_device_id=$1",
          [deviceId],
        );
        await db.query(
          "UPDATE device_invitation SET status='CANCELLED',version=version+1 WHERE geops_device_id=$1 AND status IN ('ISSUED','CLAIMED')",
          [deviceId],
        );
        await db.query(
          "UPDATE enrollment_claim SET status='CANCELLED',version=version+1 WHERE geops_device_id=$1 AND status IN ('CLAIMED','PENDING_CONFIRMATION')",
          [deviceId],
        );
        await db.query(
          "UPDATE device_key SET status='REVOKED',revoked_at=now(),version=version+1 WHERE geops_device_id=$1 AND status<>'REVOKED'",
          [deviceId],
        );
        await db.query(
          'UPDATE device_session SET revoked_at=now() WHERE geops_device_id=$1 AND revoked_at IS NULL',
          [deviceId],
        );
        await appendAudit(db, {
          actorType: adminId ? 'ADMIN' : 'SYSTEM',
          ...(adminId ? { actorId: adminId } : {}),
          deviceId,
          action: 'device.revoke',
          outcome: 'success',
          correlationId,
          previousState: device.status,
          nextState: 'REVOKED',
        });
      });
    } catch (error) {
      if (adminId)
        await appendAudit(this.pool, {
          actorType: 'ADMIN',
          actorId: adminId,
          deviceId,
          action: 'device.revoke',
          outcome: 'rejected',
          correlationId,
          metadata: { code: error instanceof ApiError ? error.code : 'dependency_unavailable' },
        }).catch(() => {});
      throw error;
    }
  }
}
