import { AdminAuthService } from './admin-auth/service.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { checkReadiness } from './db/migration-manager.js';
import { createPool } from './db/pool.js';
import { DeviceRepository } from './device-identity/repository.js';
import { EnrollmentService } from './device-identity/enrollment.js';
import { DeviceSessionService } from './device-identity/session.js';
import { DeviceLifecycleService } from './device-identity/lifecycle.js';
import { FakeMdmProvider } from './mdm/provider.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
  const auth = new AdminAuthService(pool, {
    sessionKey: config.adminSessionKey,
    csrfKey: config.adminCsrfKey,
    allowedOrigins: config.allowedOrigins,
  });
  const devices = new DeviceRepository(pool);
  const app = createApp({
    readinessProbe: () => checkReadiness(pool),
    logLevel: config.logLevel,
    adminAuth: auth,
    devices,
    enrollment: new EnrollmentService(pool, devices, config.invitationHmacKey),
    deviceSessions: new DeviceSessionService(pool),
    deviceLifecycle: new DeviceLifecycleService(pool, devices),
    mdm: new FakeMdmProvider(),
    secureCookie: config.secureCookie,
  });
  app.addHook('onClose', async () => pool.end());
  await app.listen({ host: config.host, port: config.port });
}

main().catch(() => {
  process.stderr.write('GEOPS API startup failed; details withheld\n');
  process.exitCode = 1;
});
