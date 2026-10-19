import type { FastifyInstance } from 'fastify';
import { requireAdmin } from './admin-auth/routes.js';
import type { AdminAuthService } from './admin-auth/service.js';
import { exactBody } from './device-identity/raw-body.js';
import type { DeviceSessionService } from './device-identity/session.js';
import { ApiError } from './errors.js';
import {
  type GpsHealthService,
  HealthRateLimited,
  HealthValidationError,
  parseHealthBatch,
} from './gps-health-service.js';

type HistoryQuery = { cursor?: string; limit?: string };
const single = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

export function registerGpsHealthRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  sessions: DeviceSessionService,
  health: GpsHealthService,
): void {
  app.post('/v1/device/health/batches', { bodyLimit: 128 * 1024 }, async (request, reply) => {
    const principal = await sessions.verifyRequest(request, exactBody(request));
    try {
      await health.checkQuota(principal.deviceId);
      const batch = parseHealthBatch(request.body, exactBody(request).length);
      const result = await health.ingest(principal, batch, request.id);
      reply.code(200);
      return result;
    } catch (error) {
      if (error instanceof HealthRateLimited) reply.header('Retry-After', error.retryAfter);
      if (error instanceof HealthValidationError) {
        reply.code(422);
        return {
          code: error.code,
          correlation_id: request.id,
          invalid_event_ids: error.invalidIds,
        };
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string }; Querystring: HistoryQuery }>(
    '/v1/admin/devices/:id/health',
    async (request) => {
      const admin = await requireAdmin(request, auth);
      const query = request.query;
      if (Object.keys(query).some((key) => key !== 'cursor' && key !== 'limit'))
        throw new ApiError(422, 'invalid_request', 'Invalid request');
      const limit = query.limit === undefined ? 25 : Number(query.limit);
      const reason = single(request.headers['x-geops-access-reason']);
      if (!reason) throw new ApiError(422, 'access_reason_required', 'Invalid request');
      return health.read(admin.id, request.id, request.params.id, reason, query.cursor, limit);
    },
  );
}
