import type { FastifyInstance } from 'fastify';
import { requireAdmin } from './admin-auth/routes.js';
import type { AdminAuthService } from './admin-auth/service.js';
import { exactBody } from './device-identity/raw-body.js';
import type { DeviceSessionService } from './device-identity/session.js';
import { ApiError } from './errors.js';
import { GpsValidationError, parseGpsBatch, parseGpsV2Batch } from './gps-event-contracts.js';
import { GpsRateLimited, type GpsEventService } from './gps-event-service.js';

type Query = { cursor?: string; limit?: string; from?: string; to?: string; session_id?: string };
const single = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;
function page(query: Query, allowed: string[]): { cursor?: string; limit: number } {
  if (Object.keys(query).some((key) => !allowed.includes(key))) throw new GpsValidationError();
  const limit = query.limit === undefined ? 25 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new GpsValidationError();
  return { ...(query.cursor === undefined ? {} : { cursor: query.cursor }), limit };
}

export function registerGpsEventRoutes(
  app: FastifyInstance,
  adminAuth: AdminAuthService,
  sessions: DeviceSessionService,
  events: GpsEventService,
): void {
  app.post('/v2/device/gps/batches', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const principal = await sessions.verifyRequest(request, exactBody(request));
    try {
      // Shares the existing per-device session quota until a separately reviewed limit is needed.
      await events.checkQuota(principal.deviceId, 'SESSION');
      const batch = parseGpsV2Batch(request.body, exactBody(request).length);
      const result = await events.ingestMixed(principal, batch, request.id);
      reply.code('pending_event_ids' in result ? 202 : 200);
      return result;
    } catch (error) {
      if (error instanceof GpsRateLimited) reply.header('Retry-After', error.retryAfter);
      if (error instanceof GpsValidationError) {
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
  app.post(
    '/v1/device/gps-session-events/batches',
    { bodyLimit: 128 * 1024 },
    async (request, reply) => {
      const principal = await sessions.verifyRequest(request, exactBody(request));
      try {
        await events.checkQuota(principal.deviceId, 'SESSION');
        const batch = parseGpsBatch('SESSION', request.body, exactBody(request).length);
        const result = await events.ingestSessions(principal, batch, request.id);
        reply.code('pending_event_ids' in result ? 202 : 200);
        return result;
      } catch (error) {
        if (error instanceof GpsRateLimited) reply.header('Retry-After', error.retryAfter);
        if (error instanceof GpsValidationError) {
          reply.code(422);
          return {
            code: error.code,
            correlation_id: request.id,
            invalid_event_ids: error.invalidIds,
          };
        }
        throw error;
      }
    },
  );
  app.post('/v1/device/locations/batches', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const principal = await sessions.verifyRequest(request, exactBody(request));
    try {
      await events.checkQuota(principal.deviceId, 'POSITION');
      const batch = parseGpsBatch('POSITION', request.body, exactBody(request).length);
      const result = await events.ingestPositions(principal, batch, request.id);
      reply.code('pending_event_ids' in result ? 202 : 200);
      return result;
    } catch (error) {
      if (error instanceof GpsRateLimited) reply.header('Retry-After', error.retryAfter);
      if (error instanceof GpsValidationError) {
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
  app.get<{ Params: { device_id: string }; Querystring: Query }>(
    '/v1/admin/devices/:device_id/gps-sessions',
    async (request) => {
      const admin = await requireAdmin(request, adminAuth);
      const args = page(request.query, ['cursor', 'limit']);
      return events.readSessions(
        admin.id,
        request.id,
        request.params.device_id,
        args.cursor,
        args.limit,
      );
    },
  );
  app.get<{ Params: { device_id: string }; Querystring: Query }>(
    '/v1/admin/devices/:device_id/locations',
    async (request) => {
      const admin = await requireAdmin(request, adminAuth);
      const args = page(request.query, ['cursor', 'limit', 'from', 'to', 'session_id']);
      const reason = single(request.headers['x-geops-access-reason']);
      if (!reason) throw new ApiError(422, 'access_reason_required', 'Invalid request');
      return events.readPositions(
        admin.id,
        request.id,
        request.params.device_id,
        reason,
        request.query.from ?? '',
        request.query.to ?? '',
        args.cursor,
        args.limit,
        request.query.session_id,
      );
    },
  );
}
