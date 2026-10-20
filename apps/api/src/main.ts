import { AdminAuthService } from './admin-auth/service.js';
import { AdminUserAdministrationService } from './admin-auth/user-administration.js';
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
import { GpsPolicyService } from './gps-policy-service.js';
import { GpsHealthService } from './gps-health-service.js';
import { GpsDeviceConfigService } from './gps-device-config.js';
import { GpsEventService } from './gps-event-service.js';
import { GpsAdministrationService } from './gps-administration.js';
import { GpsScheduler } from './gps-scheduler.js';

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
    cookieName: config.adminCookieName,
  });
  const devices = new DeviceRepository(pool);
  const gpsPolicies = new GpsPolicyService(pool);
  const gpsHealth = new GpsHealthService(pool, gpsPolicies);
  const gpsEvents = new GpsEventService(pool, gpsPolicies, config.gpsQuarantineKey);
  const gpsScheduler = new GpsScheduler(pool, gpsPolicies, gpsEvents, gpsHealth);
  const app = createApp({
    readinessProbe: async () => (await restoreGate()) && (await checkReadiness(pool)),
    restoreGate,
    logLevel: config.logLevel,
    adminAuth: auth,
    adminUsers: new AdminUserAdministrationService(pool),
    gpsPolicies,
    gpsHealth,
    gpsDeviceConfig: new GpsDeviceConfigService(pool),
    gpsEvents,
    gpsAdministration: new GpsAdministrationService(pool, gpsPolicies),
    devices,
    enrollment: new EnrollmentService(pool, devices, config.invitationHmacKey),
    deviceSessions: new DeviceSessionService(pool),
    deviceLifecycle: new DeviceLifecycleService(pool, devices),
    mdm: new FakeMdmProvider(),
    secureCookie: config.secureCookie,
    adminCookiePath: config.adminCookiePath,
  });
  app.addHook('onClose', async () => pool.end());
  let ticking = false;
  const runGpsMaintenance = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      if (!(await restoreGate())) return;
      await gpsScheduler.tick();
    } catch {
      process.stderr.write('GEOPS GPS maintenance failed; details withheld\n');
    } finally {
      ticking = false;
    }
  };
  const gpsTimer = setInterval(() => void runGpsMaintenance(), 60_000);
  gpsTimer.unref();
  app.addHook('onClose', async () => clearInterval(gpsTimer));
  await app.listen({ host: config.host, port: config.port });
  void runGpsMaintenance();
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
