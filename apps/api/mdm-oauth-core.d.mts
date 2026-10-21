export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  authOrigin: string;
}
export interface TokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  grantedScope: string | null;
  httpStatus: number;
}
export function refreshAccess(config: OAuthConfig, refreshToken: string, fetchImpl?: typeof fetch): Promise<TokenResult>;
export function revokeRefresh(config: OAuthConfig, refreshToken: string, fetchImpl?: typeof fetch): Promise<boolean>;
