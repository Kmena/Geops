import { ApiError } from '../errors.js';
import { refreshAccess, revokeRefresh } from '../../mdm-oauth-core.mjs';
import { createHash } from 'node:crypto';
import type { RealMdmGrantStore } from './real-grants.js';

export interface MdmOAuthOptions {
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  grantStore?: RealMdmGrantStore;
  region: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Backend-only access cache. An encrypted browser grant takes precedence over the mounted grant. */
export class MdmOAuthRuntime {
  private accessToken: string | null = null;
  private cacheDigest: string | null = null;
  private expiresAt = 0;
  private inFlight: Promise<string> | null = null;
  private inFlightDigest: string | null = null;
  private revokedDigest: string | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: MdmOAuthOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private config() {
    return {
      clientId: this.options.clientId,
      clientSecret: this.options.clientSecret,
      authOrigin: `https://accounts.zoho.${this.options.region}`,
    };
  }

  async refreshGrant(): Promise<string | null> {
    return (await this.options.grantStore?.load()) ?? this.options.refreshToken ?? null;
  }

  clearCache(): void {
    this.accessToken = null;
    this.cacheDigest = null;
    this.expiresAt = 0;
  }

  async token(force = false): Promise<string> {
    const grant = await this.refreshGrant();
    if (!grant) throw new ApiError(401, 'mdm_disconnected', 'MDM unavailable');
    const digest = createHash('sha256').update(grant).digest('hex');
    if (this.revokedDigest === digest)
      throw new ApiError(401, 'mdm_disconnected', 'MDM unavailable');
    if (
      !force &&
      this.cacheDigest === digest &&
      this.accessToken &&
      this.expiresAt > this.now() + 30_000
    )
      return this.accessToken;
    if (this.inFlight && this.inFlightDigest === digest) return this.inFlight;
    const pending = (async () => {
      try {
        const result = await refreshAccess(this.config(), grant, this.fetchImpl);
        if (this.revokedDigest === digest)
          throw new ApiError(401, 'mdm_disconnected', 'MDM unavailable');
        if (
          result.grantedScope &&
          !result.grantedScope.split(/[,\s]+/).includes('MDMOnDemand.MDMInventory.READ')
        )
          throw new ApiError(403, 'mdm_scope_insufficient', 'MDM unavailable');
        if (result.refreshToken && result.refreshToken !== grant) {
          if (!this.options.grantStore)
            throw new ApiError(503, 'mdm_refresh_grant_rotated', 'MDM unavailable');
          await this.options.grantStore.rotate(grant, result.refreshToken);
        }
        if ((await this.refreshGrant()) !== (result.refreshToken ?? grant))
          throw new ApiError(503, 'mdm_grant_changed', 'MDM unavailable');
        this.accessToken = result.accessToken;
        this.cacheDigest = createHash('sha256')
          .update(result.refreshToken ?? grant)
          .digest('hex');
        this.expiresAt = this.now() + result.expiresIn * 1000;
        return result.accessToken;
      } catch (error) {
        this.clearCache();
        if (error instanceof ApiError) throw error;
        throw new ApiError(503, 'mdm_oauth_failed', 'MDM unavailable');
      }
    })();
    this.inFlight = pending;
    this.inFlightDigest = digest;
    try {
      return await pending;
    } finally {
      if (this.inFlight === pending) {
        this.inFlight = null;
        this.inFlightDigest = null;
      }
    }
  }

  async refresh(): Promise<string> {
    this.clearCache();
    return this.token(true);
  }

  async revoke(): Promise<boolean> {
    const grant = await this.refreshGrant();
    if (!grant) return true;
    this.revokedDigest = createHash('sha256').update(grant).digest('hex');
    this.clearCache();
    try {
      return await revokeRefresh(this.config(), grant, this.fetchImpl);
    } catch {
      return false;
    }
  }

  async removePersistedGrant(): Promise<void> {
    await this.options.grantStore?.remove();
  }
}
