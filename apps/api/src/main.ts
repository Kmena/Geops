import { AdminAuthService } from './admin-auth/service.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { checkReadiness } from './db/migration-manager.js';
import { createPool } from './db/pool.js';
import { gateAllowsTraffic } from './db/restore-gate.js';
import { DeviceRepository } from './device-identity/repository.js';
import { EnrollmentService } from './device-identity/enrollment.js';
import { DeviceSessionService } from './device-identity/session.js';
import { DeviceLifecycleService } from './device-identity/lifecycle.js';
import { FakeMdmProvider } from './mdm/provider.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const gatePath = process.env.GEOPS_SECURITY_GATE_PATH;
  if (!gatePath) throw new Error('External restore gate is required');
  const pool = createPool(config.databaseUrl);
  const restoreGate = () => gateAllowsTraffic(pool, gatePath);
  const auth = new AdminAuthService(pool, {
    sessionKey: config.adminSessionKey,
    csrfKey: config.adminCsrfKey,
    allowedOrigins: config.allowedOrigins,
  });
  const devices = new DeviceRepository(pool);
  const app = createApp({
    readinessProbe: async () => (await restoreGate()) && (await checkReadiness(pool)),
    restoreGate,
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
  let closing = false;
  const drain = (): void => {
    if (closing) return;
    closing = true;
    void app.close().catch(() => {
      process.stderr.write('GEOPS API drain failed; details withheld\n');
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', drain);
  process.once('SIGINT', drain);
}

main().catch(() => {
  process.stderr.write('GEOPS API startup failed; details withheld\n');
  process.exitCode = 1;
});
