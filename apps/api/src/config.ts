export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string;
  logLevel: 'silent' | 'info';
  dataMode: 'synthetic';
}

const oauthVariables = [
  'MDM_CLIENT_ID',
  'MDM_CLIENT_SECRET',
  'MDM_OAUTH_REDIRECT_URI',
  'MDM_ACCESS_TOKEN',
  'MDM_REFRESH_TOKEN',
] as const;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  if (env.GEOPS_DATA_MODE !== 'synthetic') {
    throw new Error('GEOPS_DATA_MODE must be synthetic for Wave 0A');
  }
  if (oauthVariables.some((name) => env[name])) {
    throw new Error('OAuth credentials are not accepted by the Wave 0A API');
  }
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(env.DATABASE_URL);
  } catch {
    throw new Error('DATABASE_URL is invalid');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use PostgreSQL');
  }
  const port = Number(env.PORT ?? '3500');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT is invalid');
  }
  const host = env.HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') {
    throw new Error('HOST is invalid');
  }
  return {
    host,
    port,
    databaseUrl: env.DATABASE_URL,
    logLevel: env.LOG_LEVEL === 'silent' ? 'silent' : 'info',
    dataMode: 'synthetic',
  };
}
