import { createApp } from './app.mjs';
import { Store } from './store.mjs';
import { ENV_ID } from './validation.mjs';

const env = process.env;
if (
  env.POC_ENV_ID !== ENV_ID ||
  !env.POC_DATABASE_URL ||
  !env.POC_PUBLIC_ORIGIN ||
  !env.POC_ADMIN_PASSWORD_HASH ||
  !/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(env.POC_ADMIN_PASSWORD_HASH)
) {
  throw new Error('Missing or invalid POC configuration');
}
const retentionHours = Number(env.POC_RETENTION_HOURS);
const maxDevices = Number(env.POC_MAX_DEVICES);
if (
  !Number.isInteger(retentionHours) ||
  retentionHours < 1 ||
  retentionHours > 168 ||
  !Number.isInteger(maxDevices) ||
  maxDevices !== 1
)
  throw new Error('Invalid POC limits');
const secureCookie = env.POC_SECURE_COOKIE !== 'false';
const store = new Store(env.POC_DATABASE_URL, maxDevices);
const app = createApp({
  store,
  origin: env.POC_PUBLIC_ORIGIN,
  passwordHash: env.POC_ADMIN_PASSWORD_HASH,
  retentionHours,
  secureCookie,
  captureEnabled: env.POC_CAPTURE_ENABLED === 'true',
});
const timer = setInterval(() => {
  void store.purge(retentionHours).catch(async () => {
    process.stderr.write('POC retention purge failed; stopping API\n');
    await stop();
    process.exitCode = 1;
  });
}, 3_600_000);
timer.unref();
await store.purge(retentionHours);
await app.listen({ host: '0.0.0.0', port: Number(env.POC_PORT ?? 3600) });
async function stop() {
  clearInterval(timer);
  await app.close();
  await store.close();
}
process.once('SIGTERM', () => {
  void stop();
});
process.once('SIGINT', () => {
  void stop();
});
