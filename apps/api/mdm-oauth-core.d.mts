export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  authOrigin: string;
  redirectUri?: string;
}
export const INVENTORY_SCOPE: string;
export const CUSTOMER_SCOPE: string;
export function buildAuthorizationUrl(config: OAuthConfig, flow: {
  scope: string; state: string; verifier: string;
}): string;
export function exchangeCode(config: OAuthConfig & { redirectUri: string }, code: string,
  verifier: string, fetchImpl?: typeof fetch): Promise<TokenResult>;
export function locationMatches(region: string, location: string | null): boolean;
export interface TokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  grantedScope: string | null;
  httpStatus: number;
}
export function refreshAccess(config: OAuthConfig, refreshToken: string, fetchImpl?: typeof fetch): Promise<TokenResult>;
export function revokeRefresh(config: OAuthConfig, refreshToken: string, fetchImpl?: typeof fetch): Promise<boolean>;
