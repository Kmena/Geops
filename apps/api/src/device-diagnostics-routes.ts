import type { FastifyInstance } from 'fastify';
import type { AdminAuthService } from './admin-auth/service.js';
import { requireAdmin } from './admin-auth/routes.js';
import { DiagnosticValidationError, parseDiagnostic } from './device-diagnostics-contract.js';
import type { DeviceDiagnosticsService } from './device-diagnostics-service.js';
import type { DeviceSessionService } from './device-identity/session.js';
import { exactBody } from './device-identity/raw-body.js';
import { ApiError } from './errors.js';
import { incrementDiagnosticMetric } from './logging.js';

export function registerDeviceDiagnosticsRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  sessions: DeviceSessionService,
  service: DeviceDiagnosticsService,
): void {
  app.post('/v1/device/diagnostics/snapshots', { bodyLimit: 16_384 }, async (request, reply) => {
    const principal = await sessions.verifyRequest(request, exactBody(request));
    try {
      const snapshot = parseDiagnostic(request.body, exactBody(request).length);
      const result = await service.ingest(principal, snapshot, request.id);
      reply.code(result.duplicate ? 200 : 201);
      return result;
    } catch (error) {
      if (error instanceof DiagnosticValidationError) {
        incrementDiagnosticMetric('rejected');
        throw new ApiError(422, 'invalid_diagnostic', 'Invalid request', true);
      }
      if (error instanceof ApiError && error.statusCode >= 400 && error.statusCode < 500)
        incrementDiagnosticMetric('rejected');
      if (!(error instanceof ApiError)) incrementDiagnosticMetric('processing_error');
      if (error instanceof ApiError && error.statusCode === 429) reply.header('Retry-After', '900');
      throw error;
    }
  });
  app.get('/v1/device/diagnostics/self', async (request) => {
    const principal = await sessions.verifyRequest(request, exactBody(request));
    return service.self(principal);
  });
  const device = '/v1/admin/mdm/devices/:id/diagnostics';
  app.get<{ Params: { id: string } }>(device, async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.latest(admin.id, request.params.id, request.id);
  });
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    `${device}/history`,
    async (request) => {
      const admin = await requireAdmin(request, auth);
      if (Object.keys(request.query).some((key) => key !== 'limit'))
        throw new ApiError(422, 'invalid_query', 'Invalid request');
      const limit = request.query.limit === undefined ? 25 : Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new ApiError(422, 'invalid_query', 'Invalid request');
      return service.history(admin.id, request.params.id, request.id, limit);
    },
  );
  app.get<{ Params: { id: string } }>(`${device}/permissions`, async (request) => {
    const admin = await requireAdmin(request, auth);
    const view = await service.latest(admin.id, request.params.id, request.id);
    return {
      snapshot_id: view.snapshot_id,
      effective: 'payload' in view ? view.payload.permissions : null,
      applied_manageengine: 'UNKNOWN',
      findings: view.findings.filter(
        (f) => f.code.includes('PERMISSION') || f.code.includes('LOCATION'),
      ),
    };
  });
  app.get<{ Params: { id: string } }>(`${device}/findings`, async (request) => {
    const admin = await requireAdmin(request, auth);
    const view = await service.latest(admin.id, request.params.id, request.id);
    return { snapshot_id: view.snapshot_id, findings: view.findings };
  });
  app.get<{ Params: { id: string } }>(`${device}/capture-transmission`, async (request) => {
    const admin = await requireAdmin(request, auth);
    const view = await service.latest(admin.id, request.params.id, request.id);
    return {
      snapshot_id: view.snapshot_id,
      gps: 'payload' in view ? view.payload.gps : null,
      findings: view.findings.filter(
        (f) =>
          f.code.includes('CAPTURE') || f.code.includes('TRANSMISSION') || f.code.includes('QUEUE'),
      ),
    };
  });
  app.get('/v1/admin/mdm/diagnostics/summary', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.fleet(admin.id, request.id, 'summary');
  });
  app.get('/v1/admin/mdm/diagnostics/problems', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.fleet(admin.id, request.id, 'problems');
  });
  app.get('/v1/admin/mdm/diagnostics/stale', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.fleet(admin.id, request.id, 'stale');
  });
}
