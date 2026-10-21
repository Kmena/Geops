import { ApiError } from '../errors.js';
import { refreshAccess, revokeRefresh } from '../../mdm-oauth-core.mjs';

export interface MdmOAuthOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  region: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Backend-only, single-flight access-token cache. The refresh grant comes from a staging secret. */
export class MdmOAuthRuntime {
  private accessToken: string | null = null;
  private expiresAt = 0;
  private inFlight: Promise<string> | null = null;
  private revoked = false;
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

  async token(force = false): Promise<string> {
    if (this.revoked) throw new ApiError(401, 'mdm_disconnected', 'MDM unavailable');
    if (!force && this.accessToken && this.expiresAt > this.now() + 30_000) return this.accessToken;
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const result = await refreshAccess(
          this.config(),
          this.options.refreshToken,
          this.fetchImpl,
        );
        if (this.revoked) throw new ApiError(401, 'mdm_disconnected', 'MDM unavailable');
        if (
          result.grantedScope &&
          !result.grantedScope.split(/[,\s]+/).includes('MDMOnDemand.MDMInventory.READ')
        )
          throw new ApiError(403, 'mdm_scope_insufficient', 'MDM unavailable');
        // A rotated refresh token needs a new secret mount before continuing.
        if (result.refreshToken && result.refreshToken !== this.options.refreshToken)
          throw new ApiError(503, 'mdm_refresh_grant_rotated', 'MDM unavailable');
        this.accessToken = result.accessToken;
        this.expiresAt = this.now() + result.expiresIn * 1000;
        return result.accessToken;
      } catch (error) {
        this.accessToken = null;
        this.expiresAt = 0;
        if (error instanceof ApiError) throw error;
        throw new ApiError(503, 'mdm_oauth_failed', 'MDM unavailable');
      }
    })();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  async refresh(): Promise<string> {
    this.accessToken = null;
    this.expiresAt = 0;
    return this.token(true);
  }

  async revoke(): Promise<boolean> {
    this.revoked = true;
    this.accessToken = null;
    this.expiresAt = 0;
    try {
      return await revokeRefresh(this.config(), this.options.refreshToken, this.fetchImpl);
    } catch {
      return false;
    }
  }
}
