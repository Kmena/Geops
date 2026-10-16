import type { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import fastify, { LogController, type FastifyInstance } from 'fastify';
import { registerAdminRoutes } from './admin-auth/routes.js';
import type { AdminAuthService } from './admin-auth/service.js';
import type { DeviceRepository } from './device-identity/repository.js';
import type { EnrollmentService } from './device-identity/enrollment.js';
import type { DeviceSessionService } from './device-identity/session.js';
import type { DeviceLifecycleService } from './device-identity/lifecycle.js';
import { registerDeviceBodyCapture } from './device-identity/raw-body.js';
import { registerIdentityRoutes } from './device-identity/routes.js';
import { ApiError, handleError, sanitizedError } from './errors.js';
import { registerHealth, type ReadinessProbe } from './health.js';
import { registerSanitizedLogging } from './logging.js';
import { registerInventoryRoutes } from './mdm/routes.js';
import type { MdmProvider } from './mdm/provider.js';

export interface AppOptions {
  readinessProbe: ReadinessProbe;
  restoreGate?: () => Promise<boolean>;
  logLevel?: 'silent' | 'info';
  logStream?: Writable;
  adminAuth?: AdminAuthService;
  devices?: DeviceRepository;
  mdm?: MdmProvider;
  enrollment?: EnrollmentService;
  deviceSessions?: DeviceSessionService;
  deviceLifecycle?: DeviceLifecycleService;
  secureCookie?: boolean;
}

export function createApp(options: AppOptions): FastifyInstance {
  const app = fastify({
    logger:
      options.logLevel === 'silent'
        ? false
        : { level: 'info', ...(options.logStream ? { stream: options.logStream } : {}) },
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024,
  });
  registerSanitizedLogging(app);
  if (options.restoreGate) {
    app.addHook('onRequest', async (request) => {
      if (request.url === '/health/live') return;
      if (!(await options.restoreGate?.()))
        throw new ApiError(503, 'restore_maintenance', 'Service unavailable');
    });
  }
  registerDeviceBodyCapture(app);
  registerHealth(app, options.readinessProbe);
  if (options.adminAuth) {
    registerAdminRoutes(app, options.adminAuth, options.secureCookie ?? true);
    if (options.devices && options.mdm) {
      registerInventoryRoutes(app, options.adminAuth, options.devices, options.mdm);
      if (options.enrollment && options.deviceSessions && options.deviceLifecycle) {
        registerIdentityRoutes(
          app,
          options.adminAuth,
          options.enrollment,
          options.deviceSessions,
          options.deviceLifecycle,
        );
      }
    }
  }
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(sanitizedError('not_found', 'Not found', request.id));
  });
  app.setErrorHandler(handleError);
  return app;
}
