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
import { MdmWebOAuth } from './mdm/web-oauth.js';
import { MdmTenantRuntime } from './mdm/tenant-runtime.js';
import { MdmOAuthClientStore } from './mdm/oauth-client-store.js';
import { GpsPolicyService } from './gps-policy-service.js';
import { GpsHealthService } from './gps-health-service.js';
import { GpsDeviceConfigService } from './gps-device-config.js';
import { GpsEventService } from './gps-event-service.js';
import { GpsAdministrationService } from './gps-administration.js';
import { GpsScheduler } from './gps-scheduler.js';
import { VisitEvaluationScheduler } from './visit-evaluation-scheduler.js';
import { GpsContinuityMonitor } from './gps-continuity-monitor.js';
import { ClientCatalogService } from './client-catalog.js';
import { GeocodingSearchService } from './geocoding-search.js';
import { RouteCatalogService } from './route-catalog.js';
import { VisitScheduleService } from './visit-schedule.js';
import { VisitEvaluationService } from './visit-evaluation.js';
import { AgentDeviceLinkService } from './agent-device-links.js';
import { ComplianceDashboardService } from './compliance-dashboard.js';

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
  const mdmClientStore = config.mdm
    ? new MdmOAuthClientStore(
        pool,
        config.mdmGrantKey,
        config.mdm.region,
        config.mdm.clientId && config.mdm.clientSecret
          ? { clientId: config.mdm.clientId, clientSecret: config.mdm.clientSecret }
          : undefined,
        config.mdm.webOrigin,
      )
    : undefined;
  const mdmTenant = config.mdm
    ? new MdmTenantRuntime(pool, {
        region: config.mdm.region,
        ...(config.mdm.clientId ? { clientId: config.mdm.clientId } : {}),
        ...(config.mdm.clientSecret ? { clientSecret: config.mdm.clientSecret } : {}),
        grantKey: config.mdmGrantKey,
        ...(mdmClientStore ? { clientStore: mdmClientStore } : {}),
        ...(config.mdm.customerId ? { mountedCustomerId: config.mdm.customerId } : {}),
        ...(config.mdm.refreshToken ? { mountedRefreshToken: config.mdm.refreshToken } : {}),
      })
    : undefined;
  const mdmConfig = config.mdm;
  const mdmWebOAuth =
    mdmConfig && mdmClientStore
      ? async () => {
          const client = await mdmClientStore.load();
          return client
            ? new MdmWebOAuth(pool, {
                region: mdmConfig.region,
                clientId: client.clientId,
                clientSecret: client.clientSecret,
                clientGeneration: client.generation,
                clientStore: mdmClientStore,
                webOrigin: mdmConfig.webOrigin,
                grantKey: config.mdmGrantKey,
                mountedGrantPresent: client.source === 'legacy' && Boolean(mdmConfig.refreshToken),
              })
            : undefined;
        }
      : undefined;
  const gpsPolicies = new GpsPolicyService(pool);
  const gpsHealth = new GpsHealthService(pool, gpsPolicies);
  const gpsEvents = new GpsEventService(pool, gpsPolicies, config.gpsQuarantineKey);
  const gpsScheduler = new GpsScheduler(pool, gpsPolicies, gpsEvents, gpsHealth);
  const gpsContinuity = new GpsContinuityMonitor(pool, undefined, config.adminSessionKey);
  const visitEvaluation = new VisitEvaluationService(pool);
  const visitScheduler = new VisitEvaluationScheduler(pool, visitEvaluation);
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
    clientCatalog: new ClientCatalogService(pool),
    geocoding: new GeocodingSearchService(pool),
    routeCatalog: new RouteCatalogService(pool),
    visitSchedule: new VisitScheduleService(pool),
    visitEvaluation,
    agentDeviceLinks: new AgentDeviceLinkService(pool),
    complianceDashboard: new ComplianceDashboardService(pool),
    devices,
    enrollment: new EnrollmentService(pool, devices, config.invitationHmacKey),
    deviceSessions: new DeviceSessionService(pool),
    deviceLifecycle: new DeviceLifecycleService(pool, devices),
    ...(mdmTenant ? { mdmTenant } : {}),
    ...(mdmWebOAuth ? { mdmWebOAuth } : {}),
    ...(mdmClientStore ? { mdmOAuthClientStore: mdmClientStore } : {}),
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
  let evaluating = false;
  const runVisitMaintenance = async (): Promise<void> => {
    if (evaluating) return;
    evaluating = true;
    try {
      if (!(await restoreGate())) return;
      const result = await visitScheduler.tick();
      process.stdout.write(`GEOPS visit evaluation ${JSON.stringify(result)}\n`);
    } catch (error) {
      const errorCode =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'scheduler_error';
      process.stderr.write(
        `GEOPS visit evaluation ${JSON.stringify({ status: 'failed', error_code: errorCode })}\n`,
      );
    } finally {
      evaluating = false;
    }
  };
  const visitTimer = setInterval(() => void runVisitMaintenance(), 60_000);
  visitTimer.unref();
  app.addHook('onClose', async () => clearInterval(visitTimer));
  const mdmTimer = mdmTenant
    ? setInterval(() => {
        void restoreGate()
          .then(async (open) => {
            if (open && (await mdmTenant.status()).authorized) await mdmTenant.sync(null);
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
  void runVisitMaintenance();
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
