import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from '../errors.js';
import { appendAudit } from '../audit/index.js';
import { requireInstallationAccess } from '../device-identity/admin-scope.js';
import { transaction } from '../device-identity/repository.js';
import type { MdmDevice, MdmProvider } from './provider.js';

export interface InventoryConfig {
  region: string;
  customerId: string;
}

export class MdmInventoryService {
  private running = false;
  constructor(
    private readonly pool: Pool,
    private readonly provider: MdmProvider,
    readonly config: InventoryConfig,
    private readonly pause: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  private async withRetry<T>(read: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await read();
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'mdm_unknown_failure';
        if (
          attempt === 2 ||
          !['mdm_rate_limited', 'mdm_connection_error', 'mdm_upstream_error'].includes(code)
        )
          throw error;
        const retry = error as ApiError & { retryAfter?: string };
        const seconds =
          retry.retryAfter && /^\d{1,5}$/.test(retry.retryAfter)
            ? Math.min(Number(retry.retryAfter), 60)
            : 2 ** attempt;
        await this.pause(seconds * 1000);
      }
    }
    throw new ApiError(503, 'mdm_upstream_error', 'MDM unavailable');
  }

  async sync(
    actorId: string | null,
    correlationId: string = randomUUID(),
  ): Promise<{ run_id: string; device_count: number }> {
    if (this.running) throw new ApiError(409, 'mdm_sync_running', 'Conflict');
    this.running = true;
    let connection: PoolClient | null = null;
    let locked = false;
    let runId: string | null = null;
    try {
      connection = await this.pool.connect();
      const client = connection;
      const lock = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(350018) AS acquired',
      );
      locked = lock.rows[0]?.acquired === true;
      if (!locked) throw new ApiError(409, 'mdm_sync_running', 'Conflict');
      runId = randomUUID();
      await client.query(
        "INSERT INTO mdm_sync_run(id,region,customer_id,outcome) VALUES($1,$2,$3,'RUNNING')",
        [runId, this.config.region, this.config.customerId],
      );
      let cursor: string | undefined;
      const cursors = new Set<string>();
      const seen = new Set<string>();
      let pages = 0;
      do {
        if (++pages > 200) throw new ApiError(503, 'mdm_pagination_limit', 'MDM unavailable');
        const response = await this.withRetry(() =>
          this.provider.listDevices(this.config.customerId, cursor, 50),
        );
        if (response.source !== 'manageengine')
          throw new ApiError(503, 'mdm_real_source_required', 'MDM unavailable');
        for (const candidate of response.items) {
          let item = candidate;
          if (item.platform !== 'android') {
            if (!item.removed) continue;
            const prior = await client.query<{ platform: string }>(
              `SELECT platform FROM mdm_inventory_device
               WHERE provider='manageengine' AND region=$1 AND customer_id=$2 AND mdm_device_id=$3`,
              [this.config.region, this.config.customerId, item.mdm_device_id],
            );
            if (prior.rows[0]?.platform !== 'android') continue;
            item = { ...item, platform: 'android' };
          }
          if (seen.has(item.mdm_device_id)) {
            if (item.removed) await this.upsert(client, item);
            continue;
          }
          seen.add(item.mdm_device_id);
          if (seen.size > 10000) throw new ApiError(503, 'mdm_inventory_limit', 'MDM unavailable');
          let device = item;
          if (!item.removed) {
            const detail = await this.withRetry(() =>
              this.provider.getDevice(this.config.customerId, item.mdm_device_id),
            );
            device =
              detail && detail.mdm_device_id === item.mdm_device_id
                ? {
                    ...item,
                    ...detail,
                    platform:
                      detail.platform === 'unknown'
                        ? (item.platform ?? 'unknown')
                        : (detail.platform ?? item.platform ?? 'unknown'),
                  }
                : { ...item, status: 'unknown' };
          }
          await this.upsert(client, device);
        }
        cursor = response.next_cursor ?? undefined;
        if (cursor) {
          if (cursors.has(cursor))
            throw new ApiError(503, 'mdm_pagination_loop', 'MDM unavailable');
          cursors.add(cursor);
        }
      } while (cursor);
      await client.query(
        "UPDATE mdm_sync_run SET outcome='SUCCESS',finished_at=now(),device_count=$2 WHERE id=$1",
        [runId, seen.size],
      );
      await appendAudit(client, {
        actorType: actorId ? 'ADMIN' : 'SYSTEM',
        ...(actorId ? { actorId } : {}),
        action: 'mdm.inventory.sync',
        outcome: 'success',
        correlationId,
        metadata: { count: seen.size, pages },
      });
      return { run_id: runId, device_count: seen.size };
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'mdm_sync_failure';
      if (runId && connection) {
        await connection
          .query(
            "UPDATE mdm_sync_run SET outcome='FAILED',finished_at=now(),error_code=$2 WHERE id=$1",
            [runId, code],
          )
          .catch(() => {});
        await appendAudit(connection, {
          actorType: actorId ? 'ADMIN' : 'SYSTEM',
          ...(actorId ? { actorId } : {}),
          action: 'mdm.inventory.sync',
          outcome: 'failure',
          correlationId,
          metadata: { code },
        }).catch(() => {});
      }
      throw error;
    } finally {
      if (connection) {
        if (locked) await connection.query('SELECT pg_advisory_unlock(350018)').catch(() => {});
        connection.release();
      }
      this.running = false;
    }
  }

  private async upsert(db: Pick<Pool, 'query'>, item: MdmDevice): Promise<void> {
    await db.query(
      `INSERT INTO mdm_inventory_device
       (provider,region,customer_id,mdm_device_id,platform,status,removed,display_name,model,os_version,serial_number,udid,last_seen_at)
       VALUES('manageengine',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
       ON CONFLICT(provider,region,customer_id,mdm_device_id) DO UPDATE SET
         platform=EXCLUDED.platform,status=EXCLUDED.status,removed=EXCLUDED.removed,
         display_name=EXCLUDED.display_name,model=EXCLUDED.model,os_version=EXCLUDED.os_version,
         serial_number=EXCLUDED.serial_number,udid=EXCLUDED.udid,last_seen_at=now(),updated_at=now()`,
      [
        this.config.region,
        this.config.customerId,
        item.mdm_device_id,
        item.platform ?? 'unknown',
        item.status,
        item.removed ?? false,
        item.display_name ?? null,
        item.model ?? null,
        item.os_version ?? null,
        item.serial_number ?? null,
        item.udid ?? null,
      ],
    );
  }

  async list(limit: number, after?: string) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (after !== undefined && !/^[0-9]{1,30}$/.test(after))
    )
      throw new ApiError(400, 'invalid_pagination', 'Invalid request');
    const result = await this.pool.query(
      `SELECT mdm_device_id,platform,status,removed,display_name,model,os_version,
         serial_number,udid,geops_device_id,last_seen_at
       FROM mdm_inventory_device
       WHERE provider='manageengine' AND region=$1 AND customer_id=$2
         AND ($3::text IS NULL OR mdm_device_id>$3)
       ORDER BY mdm_device_id LIMIT $4`,
      [this.config.region, this.config.customerId, after ?? null, limit + 1],
    );
    const items = result.rows.slice(0, limit);
    return { items, next_cursor: result.rows.length > limit ? items.at(-1)?.mdm_device_id : null };
  }

  async link(
    deviceId: string,
    mdmId: string,
    adminId: string,
    correlationId: string,
  ): Promise<void> {
    if (!/^[0-9]{1,30}$/.test(mdmId) || !/^[0-9a-f-]{36}$/.test(deviceId))
      throw new ApiError(400, 'invalid_request', 'Invalid request');
    try {
      await transaction(this.pool, async (db) => {
        await requireInstallationAccess(db, adminId, 'synthetic');
        const geops = await db.query<{ status: string }>(
          'SELECT status FROM geops_device WHERE id=$1 FOR UPDATE',
          [deviceId],
        );
        if (!geops.rows[0] || ['REVOKED', 'RETIRED'].includes(geops.rows[0].status))
          throw new ApiError(409, 'device_unavailable', 'Conflict');
        const result = await db.query<{
          geops_device_id: string | null;
          status: string;
          removed: boolean;
          platform: string;
        }>(
          `SELECT geops_device_id,status,removed,platform FROM mdm_inventory_device
         WHERE provider='manageengine' AND region=$1 AND customer_id=$2 AND mdm_device_id=$3 FOR UPDATE`,
          [this.config.region, this.config.customerId, mdmId],
        );
        const mdm = result.rows[0];
        if (!mdm || mdm.removed || mdm.status !== 'managed' || mdm.platform !== 'android')
          throw new ApiError(409, 'mdm_device_unavailable', 'Conflict');
        if (mdm.geops_device_id && mdm.geops_device_id !== deviceId)
          throw new ApiError(409, 'mdm_already_linked', 'Conflict');
        const other = await db.query(
          `SELECT 1 FROM mdm_inventory_device WHERE geops_device_id=$1
         AND (region<>$2 OR customer_id<>$3 OR mdm_device_id<>$4) FOR UPDATE`,
          [deviceId, this.config.region, this.config.customerId, mdmId],
        );
        if (other.rowCount) throw new ApiError(409, 'geops_already_linked', 'Conflict');
        await db.query(
          `UPDATE mdm_inventory_device SET geops_device_id=$4,updated_at=now()
         WHERE provider='manageengine' AND region=$1 AND customer_id=$2 AND mdm_device_id=$3`,
          [this.config.region, this.config.customerId, mdmId, deviceId],
        );
        await appendAudit(db, {
          actorType: 'ADMIN',
          actorId: adminId,
          deviceId,
          action: 'mdm.inventory.link',
          outcome: 'success',
          correlationId,
          metadata: { provider: 'manageengine' },
        });
      });
    } catch (error) {
      await appendAudit(this.pool, {
        actorType: 'ADMIN',
        actorId: adminId,
        deviceId,
        action: 'mdm.inventory.link',
        outcome: 'rejected',
        correlationId,
        metadata: { code: error instanceof ApiError ? error.code : 'mdm_link_failure' },
      }).catch(() => {});
      throw error;
    }
  }

  async unlink(deviceId: string, adminId: string, correlationId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(deviceId))
      throw new ApiError(400, 'invalid_request', 'Invalid request');
    try {
      await transaction(this.pool, async (db) => {
        await requireInstallationAccess(db, adminId, 'synthetic');
        const result = await db.query(
          `UPDATE mdm_inventory_device SET geops_device_id=NULL,updated_at=now()
         WHERE provider='manageengine' AND region=$1 AND customer_id=$2 AND geops_device_id=$3
         RETURNING mdm_device_id`,
          [this.config.region, this.config.customerId, deviceId],
        );
        if (!result.rowCount) throw new ApiError(404, 'mdm_link_missing', 'Not found');
        await appendAudit(db, {
          actorType: 'ADMIN',
          actorId: adminId,
          deviceId,
          action: 'mdm.inventory.unlink',
          outcome: 'success',
          correlationId,
          metadata: { provider: 'manageengine' },
        });
      });
    } catch (error) {
      await appendAudit(this.pool, {
        actorType: 'ADMIN',
        actorId: adminId,
        deviceId,
        action: 'mdm.inventory.unlink',
        outcome: 'rejected',
        correlationId,
        metadata: { code: error instanceof ApiError ? error.code : 'mdm_unlink_failure' },
      }).catch(() => {});
      throw error;
    }
  }
}
