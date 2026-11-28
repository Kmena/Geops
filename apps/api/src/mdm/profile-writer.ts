import { ApiError } from '../errors.js';

export interface LabProfileWriteAuthorization {
  customerId: string;
  deviceId: string;
  profileId: string;
  expiresAt: Date;
  evidenceRef: string;
}

/** Single-device profile association only. Never publish, update_all or modify a shared profile. */
export class ManageEngineProfileWriter {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly options: {
      origin: string;
      expectedOrigin: string;
      token: () => Promise<string>;
      refresh?: () => Promise<string>;
      fetchImpl?: typeof fetch;
      authorization?: LabProfileWriteAuthorization;
    },
  ) {
    const origin = new URL(options.origin);
    if (
      origin.protocol !== 'https:' ||
      origin.origin !== options.expectedOrigin ||
      origin.pathname !== '/'
    )
      throw new Error('MDM origin not allowlisted');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  isAuthorized(customerId: string, deviceId: string, profileId: string): boolean {
    const gate = this.options.authorization;
    return Boolean(
      gate &&
        gate.expiresAt.getTime() > Date.now() &&
        gate.customerId === customerId &&
        gate.deviceId === deviceId &&
        gate.profileId === profileId &&
        gate.evidenceRef.trim().length >= 8,
    );
  }

  async associateProfile(customerId: string, deviceId: string, profileId: string): Promise<void> {
    if (!this.isAuthorized(customerId, deviceId, profileId))
      throw new ApiError(503, 'mdm_write_disabled', 'MDM write unavailable');
    if (![customerId, deviceId, profileId].every((value) => /^[0-9]{1,30}$/.test(value)))
      throw new ApiError(422, 'invalid_mdm_id', 'Invalid request');
    const url = new URL(`/api/v1/mdm/devices/${deviceId}/profiles`, this.options.origin);
    if (url.origin !== this.options.expectedOrigin)
      throw new ApiError(503, 'mdm_write_disabled', 'MDM write unavailable');
    // IDs are validated decimal strings; preserve all digits in the vendor JSON body.
    const body = `{"profile_ids":[${profileId}]}`;
    const send = async (token: string) => {
      try {
        return await this.fetchImpl(url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000),
          body,
          headers: {
            Authorization: `Zoho-oauthtoken ${token}`,
            'X-CUSTOMER': customerId,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
        });
      } catch {
        throw new ApiError(503, 'mdm_connection_error', 'MDM unavailable');
      }
    };
    let response = await send(await this.options.token());
    if (response.status === 401 && this.options.refresh)
      response = await send(await this.options.refresh());
    if (response.status === 401) throw new ApiError(401, 'mdm_unauthorized', 'MDM unavailable');
    if (response.status === 403) throw new ApiError(403, 'mdm_forbidden', 'MDM unavailable');
    if (response.status === 429) throw new ApiError(429, 'mdm_rate_limited', 'MDM unavailable');
    if (response.status >= 300 && response.status < 400)
      throw new ApiError(503, 'mdm_redirect_rejected', 'MDM unavailable');
    if (response.status !== 202 && response.status !== 204)
      throw new ApiError(503, 'mdm_upstream_error', 'MDM unavailable');
    await response.body?.cancel().catch(() => {});
  }
}
