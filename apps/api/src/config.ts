export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: 'silent' | 'info';
  dataMode: 'synthetic';
  adminSessionKey: Buffer;
  adminCsrfKey: Buffer;
  invitationHmacKey: Buffer;
  mdmGrantKey: Buffer;
  gpsQuarantineKey: Buffer;
  allowedOrigins: string[];
  secureCookie: boolean;
  adminCookieName: 'geops_admin' | '__Host-geops_stage_admin';
  adminCookiePath: '/';
  mdm: {
    region: string;
    customerId?: string;
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    webOrigin: string;
    configuredEdition?: 'TRIAL' | 'FREE' | 'LICENSED';
  } | null;
}

const oauthVariables = [
  'MDM_CLIENT_ID',
  'MDM_CLIENT_SECRET',
  'MDM_OAUTH_REDIRECT_URI',
  'MDM_ACCESS_TOKEN',
  'MDM_REFRESH_TOKEN',
] as const;

function localKey(env: NodeJS.ProcessEnv, name: string): Buffer {
  const value = env[name];
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte synthetic key`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== value) {
    throw new Error(`${name} is invalid`);
  }
  return bytes;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  if (env.GEOPS_DATA_MODE !== 'synthetic') {
    throw new Error('GEOPS_DATA_MODE must be synthetic for Wave 0A');
  }
  if (oauthVariables.some((name) => env[name])) {
    throw new Error('OAuth credentials are not accepted by the Wave 0A API');
  }
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  let parsed: URL;
  try {
    parsed = new URL(env.DATABASE_URL);
  } catch {
    throw new Error('DATABASE_URL is invalid');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use PostgreSQL');
  }
  if (!/^\/(geops_dev|geops_verify_[0-9]+_restore)$/.test(parsed.pathname)) {
    throw new Error('DATABASE_URL must name a GEOPS synthetic database');
  }
  const port = Number(env.PORT ?? '3500');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT is invalid');
  const host = env.HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new Error('HOST is invalid');
  const origins = (env.GEOPS_ALLOWED_ORIGINS ?? 'http://localhost:3501,http://127.0.0.1:3501')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (origins.length === 0 || origins.some((origin) => !/^https?:\/\/[^/]+$/.test(origin))) {
    throw new Error('GEOPS_ALLOWED_ORIGINS is invalid');
  }
  const secureCookie = env.GEOPS_INSECURE_LOCAL_COOKIE !== '1';
  const cookiePath = env.GEOPS_ADMIN_COOKIE_PATH ?? '/';
  const cookieName = env.GEOPS_ADMIN_COOKIE_NAME ?? 'geops_admin';
  const stageOrigin = 'https://geops-staging.duckdns.org';
  const usesStageOrigin = origins.includes(stageOrigin);
  const localMdmOrigin =
    origins.length === 1 &&
    /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origins[0] ?? '') &&
    !secureCookie &&
    cookieName === 'geops_admin';
  if (
    cookiePath !== '/' ||
    (usesStageOrigin && cookieName !== '__Host-geops_stage_admin') ||
    !(
      cookieName === 'geops_admin' ||
      (cookieName === '__Host-geops_stage_admin' &&
        secureCookie &&
        origins.length === 1 &&
        origins[0] === stageOrigin)
    )
  )
    throw new Error('GEOPS admin cookie scope is invalid');
  if (
    !secureCookie &&
    (env.GEOPS_DATA_MODE !== 'synthetic' ||
      origins.some((origin) => !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)))
  ) {
    throw new Error('Insecure cookie only allowed on synthetic localhost');
  }
  let mdm: AppConfig['mdm'] = null;
  if (env.GEOPS_MDM_ENABLED && env.GEOPS_MDM_ENABLED !== '0')
    throw new Error('Legacy MDM enablement is not supported');
  if (env.MDM_ENABLED === 'true') {
    const region = env.GEOPS_MDM_REGION ?? '';
    const customerId = env.GEOPS_MDM_CUSTOMER_ID ?? '';
    const edition = env.GEOPS_MDM_EDITION ?? '';
    const clientId = env.GEOPS_MDM_CLIENT_ID;
    const clientSecret = env.GEOPS_MDM_CLIENT_SECRET;
    const validClientValue = (value: string | undefined): value is string => {
      if (!value?.trim() || value.length > 2048) return false;
      return [...value].every((character) => {
        const code = character.charCodeAt(0);
        return code > 31 && code !== 127;
      });
    };
    const oauthConfigured = validClientValue(clientId) && validClientValue(clientSecret);
    if (
      !['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'cn', 'sa', 'uk'].includes(region) ||
      (customerId !== '' && !/^[0-9]{1,30}$/.test(customerId)) ||
      (edition !== '' && !['TRIAL', 'FREE', 'LICENSED'].includes(edition)) ||
      (Boolean(env.GEOPS_MDM_REFRESH_TOKEN) && !customerId) ||
      env.GEOPS_MDM_TEST_TENANT !== '1' ||
      !((usesStageOrigin && secureCookie) || localMdmOrigin)
    )
      throw new Error('Real MDM requires explicit staging test-tenant configuration');
    mdm = {
      region,
      ...(customerId ? { customerId } : {}),
      ...(edition ? { configuredEdition: edition as 'TRIAL' | 'FREE' | 'LICENSED' } : {}),
      ...(oauthConfigured ? { clientId, clientSecret } : {}),
      ...(env.GEOPS_MDM_REFRESH_TOKEN ? { refreshToken: env.GEOPS_MDM_REFRESH_TOKEN } : {}),
      webOrigin: usesStageOrigin ? stageOrigin : (origins[0] ?? stageOrigin),
    };
  } else {
    if (env.MDM_ENABLED && env.MDM_ENABLED !== 'false') throw new Error('MDM_ENABLED is invalid');
    if (
      ['GEOPS_MDM_CLIENT_ID', 'GEOPS_MDM_CLIENT_SECRET', 'GEOPS_MDM_REFRESH_TOKEN'].some(
        (name) => env[name],
      )
    )
      throw new Error('Real MDM credentials require explicit enablement');
  }
  return {
    host,
    port,
    databaseUrl: env.DATABASE_URL,
    logLevel: env.LOG_LEVEL === 'silent' ? 'silent' : 'info',
    dataMode: 'synthetic',
    adminSessionKey: localKey(env, 'GEOPS_ADMIN_SESSION_KEY'),
    adminCsrfKey: localKey(env, 'GEOPS_ADMIN_CSRF_KEY'),
    invitationHmacKey: localKey(env, 'GEOPS_INVITATION_HMAC_KEY'),
    mdmGrantKey: localKey(env, 'GEOPS_MDM_GRANT_KEY'),
    gpsQuarantineKey: localKey(env, 'GEOPS_GPS_QUARANTINE_KEY'),
    allowedOrigins: origins,
    secureCookie,
    adminCookieName: cookieName,
    adminCookiePath: cookiePath,
    mdm,
  };
}
