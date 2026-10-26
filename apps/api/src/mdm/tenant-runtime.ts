import type { Pool } from 'pg';
import { ApiError } from '../errors.js';
import { RealMdmGrantStore } from './real-grants.js';
import { MdmOAuthRuntime } from './oauth-runtime.js';
import { MdmConnectionControl } from './connection-control.js';
import { ManageEngineReadOnly, type MdmStatus } from './provider.js';
import { MdmInventoryService } from './inventory.js';
import { discoverCustomers } from './web-oauth.js';
import type { MdmOAuthClientStore, OAuthClient } from './oauth-client-store.js';

interface Tenant {
  region: string;
  customer_id: string;
}

export interface TenantRuntimeConfig {
  region: string;
  clientId?: string;
  clientSecret?: string;
  clientStore?: MdmOAuthClientStore;
  grantKey: Buffer;
  mountedCustomerId?: string;
  mountedRefreshToken?: string;
  fetchImpl?: typeof fetch;
}

/** Resolves the authorized customer from PostgreSQL for each operation, never from a browser ID. */
export class MdmTenantRuntime {
  private nameCache: { key: string; name: string | null; expiresAt: number } | null = null;
  constructor(
    private readonly pool: Pool,
    private readonly config: TenantRuntimeConfig,
  ) {}

  private async tenant(): Promise<Tenant | null> {
    const result = await this.pool.query<Tenant>(
      `SELECT region,customer_id FROM mdm_integration
       WHERE provider='manageengine' AND region=$1 AND status='REAL_CONNECTED'
       ORDER BY updated_at DESC LIMIT 2`,
      [this.config.region],
    );
    if (result.rows.length > 1) throw new ApiError(503, 'mdm_multiple_tenants', 'MDM unavailable');
    if (result.rows[0]) return result.rows[0];
    return this.config.mountedCustomerId && this.config.mountedRefreshToken
      ? { region: this.config.region, customer_id: this.config.mountedCustomerId }
      : null;
  }

  private async context() {
    const client = await this.credentials();
    if (!client) return null;
    const tenant = await this.tenant();
    if (!tenant) return null;
    const grants = new RealMdmGrantStore(
      this.pool,
      this.config.grantKey,
      tenant.region,
      tenant.customer_id,
    );
    const oauth = new MdmOAuthRuntime({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      region: tenant.region,
      grantStore: grants,
      ...(client.source === 'legacy' &&
      this.config.mountedCustomerId === tenant.customer_id &&
      this.config.mountedRefreshToken
        ? { refreshToken: this.config.mountedRefreshToken }
        : {}),
      ...(this.config.fetchImpl ? { fetchImpl: this.config.fetchImpl } : {}),
    });
    const control = new MdmConnectionControl(this.pool, tenant.region, tenant.customer_id, () =>
      oauth.refreshGrant(),
    );
    const origin = `https://mdm.manageengine.${tenant.region}`;
    const provider = new ManageEngineReadOnly({
      enabled: true,
      origin: `${origin}/`,
      expectedOrigin: origin,
      region: tenant.region,
      token: () => oauth.token(),
      refresh: () => oauth.refresh(),
      ...(this.config.fetchImpl ? { fetchImpl: this.config.fetchImpl } : {}),
    });
    const inventory = new MdmInventoryService(
      this.pool,
      provider,
      { region: tenant.region, customerId: tenant.customer_id },
      undefined,
      control,
    );
    return { tenant, grants, oauth, control, provider, inventory };
  }

  private async credentials(): Promise<OAuthClient | null> {
    if (this.config.clientStore) return this.config.clientStore.load();
    return this.config.clientId && this.config.clientSecret
      ? {
          clientId: this.config.clientId,
          clientSecret: this.config.clientSecret,
          generation: 'legacy',
          source: 'legacy',
        }
      : null;
  }

  private async required() {
    const context = await this.context();
    if (!context)
      throw new ApiError(
        503,
        (await this.credentials()) ? 'mdm_disconnected' : 'mdm_oauth_unconfigured',
        'MDM unavailable',
      );
    return context;
  }

  async status(): Promise<
    MdmStatus & {
      customer_id?: string;
      customer_name?: string;
      device_count?: number;
      last_sync_at?: string | null;
    }
  > {
    const context = await this.context();
    const configured = Boolean(await this.credentials());
    if (!context)
      return {
        provider: 'manageengine',
        connected: false,
        authorized: false,
        oauth_configured: configured,
        authorization_state: 'never',
        edition_evidence: 'UNVERIFIED',
        region: this.config.region,
        last_checked_at: null,
        last_http_status: null,
        sanitized_error_code: configured ? 'mdm_disconnected' : 'mdm_oauth_unconfigured',
      };
    const status = await context.provider.integrationStatus();
    status.authorized = await context.control.isConnected();
    status.authorization_state = await context.control.authorizationState();
    status.connected = status.authorized;
    if (!status.authorized) status.sanitized_error_code = 'mdm_disconnected';
    const key = `${context.tenant.region}:${context.tenant.customer_id}`;
    if (
      status.authorized &&
      (this.nameCache?.key !== key || this.nameCache.expiresAt < Date.now())
    ) {
      let name: string | null = null;
      try {
        const customers = await discoverCustomers(
          context.tenant.region,
          await context.oauth.token(),
          this.config.fetchImpl ?? fetch,
        );
        name =
          customers.find((item) => item.customer_id === context.tenant.customer_id)
            ?.customer_name ?? null;
      } catch {
        /* A name lookup cannot make local connection status unavailable. */
      }
      this.nameCache = { key, name, expiresAt: Date.now() + 5 * 60_000 };
    }
    const inventory = await this.pool.query<{ device_count: number; last_sync_at: string | null }>(
      `SELECT
         (SELECT count(*)::int FROM mdm_inventory_device
          WHERE provider='manageengine' AND region=$1 AND customer_id=$2) AS device_count,
         (SELECT max(finished_at)::text FROM mdm_sync_run
          WHERE region=$1 AND customer_id=$2 AND outcome='SUCCESS') AS last_sync_at`,
      [context.tenant.region, context.tenant.customer_id],
    );
    return {
      ...status,
      oauth_configured: true,
      customer_id: context.tenant.customer_id,
      ...(this.nameCache?.key === key && this.nameCache.name
        ? { customer_name: this.nameCache.name }
        : {}),
      device_count: inventory.rows[0]?.device_count ?? 0,
      last_sync_at: inventory.rows[0]?.last_sync_at ?? null,
    };
  }

  async devices(cursor: string | undefined, limit: number) {
    const { tenant, provider, control } = await this.required();
    return control.withConnected(() => provider.listDevices(tenant.customer_id, cursor, limit));
  }
  async inventory(limit: number, after?: string) {
    const { inventory, control } = await this.required();
    return control.withConnected(() => inventory.list(limit, after));
  }
  async sync(actorId: string | null, correlationId?: string) {
    const { inventory } = await this.required();
    return inventory.sync(actorId, correlationId);
  }
  async link(deviceId: string, mdmId: string, actorId: string, correlationId: string) {
    const { inventory, control } = await this.required();
    return control.withConnected(() => inventory.link(deviceId, mdmId, actorId, correlationId));
  }
  async unlink(deviceId: string, actorId: string, correlationId: string) {
    const { inventory, control } = await this.required();
    return control.withConnected(() => inventory.unlink(deviceId, actorId, correlationId));
  }
  async disconnect(actorId: string, correlationId: string) {
    const { control, oauth } = await this.required();
    const revoked = await control.disconnect(actorId, correlationId, () => oauth.revoke());
    if (revoked) await oauth.removePersistedGrant();
    return { local_disconnected: true, remote_revoked: revoked };
  }
}
