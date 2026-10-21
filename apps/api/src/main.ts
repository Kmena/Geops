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
import { FakeMdmProvider, ManageEngineReadOnly } from './mdm/provider.js';
import { MdmOAuthRuntime } from './mdm/oauth-runtime.js';
import { MdmInventoryService } from './mdm/inventory.js';
import { GpsPolicyService } from './gps-policy-service.js';
import { GpsHealthService } from './gps-health-service.js';
import { GpsDeviceConfigService } from './gps-device-config.js';
import { GpsEventService } from './gps-event-service.js';
import { GpsAdministrationService } from './gps-administration.js';
import { GpsScheduler } from './gps-scheduler.js';
import { GpsContinuityMonitor } from './gps-continuity-monitor.js';

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
  const mdmOAuth = config.mdm ? new MdmOAuthRuntime(config.mdm) : undefined;
  const mdmOrigin = config.mdm ? `https://mdm.manageengine.${config.mdm.region}` : null;
  const mdm =
    config.mdm && mdmOAuth && mdmOrigin
      ? new ManageEngineReadOnly({
          enabled: true,
          origin: `${mdmOrigin}/`,
          expectedOrigin: mdmOrigin,
          region: config.mdm.region,
          editionEvidence: 'UNVERIFIED',
          configuredEdition: config.mdm.configuredEdition,
          token: () => mdmOAuth.token(),
          refresh: () => mdmOAuth.refresh(),
        })
      : new FakeMdmProvider();
  const mdmInventory = config.mdm
    ? new MdmInventoryService(pool, mdm, {
        region: config.mdm.region,
        customerId: config.mdm.customerId,
      })
    : undefined;
  const gpsPolicies = new GpsPolicyService(pool);
  const gpsHealth = new GpsHealthService(pool, gpsPolicies);
  const gpsEvents = new GpsEventService(pool, gpsPolicies, config.gpsQuarantineKey);
  const gpsScheduler = new GpsScheduler(pool, gpsPolicies, gpsEvents, gpsHealth);
  const gpsContinuity = new GpsContinuityMonitor(pool, undefined, config.adminSessionKey);
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
    gpsContinuity,
    devices,
    enrollment: new EnrollmentService(pool, devices, config.invitationHmacKey),
    deviceSessions: new DeviceSessionService(pool),
    deviceLifecycle: new DeviceLifecycleService(pool, devices),
    mdm,
    ...(mdmInventory ? { mdmInventory } : {}),
    ...(mdmOAuth ? { mdmOAuth } : {}),
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
      await gpsContinuity.tick();
    } catch {
      process.stderr.write('GEOPS GPS maintenance failed; details withheld\n');
    } finally {
      ticking = false;
    }
  };
  const gpsTimer = setInterval(() => void runGpsMaintenance(), 60_000);
  gpsTimer.unref();
  app.addHook('onClose', async () => clearInterval(gpsTimer));
  const mdmTimer = mdmInventory
    ? setInterval(() => {
        void restoreGate()
          .then(async (open) => {
            if (open) await mdmInventory.sync(null);
          })
          .catch(() =>
            process.stderr.write('GEOPS MDM synchronization failed; details withheld\n'),
          );
      }, 15 * 60_000)
    : null;
  mdmTimer?.unref();
  if (mdmTimer) app.addHook('onClose', async () => clearInterval(mdmTimer));
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
