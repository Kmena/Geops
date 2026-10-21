import type { FastifyInstance } from 'fastify';
import { requireAdmin } from './admin-auth/routes.js';
import type { AdminAuthService } from './admin-auth/service.js';
import { ApiError } from './errors.js';
import type { ContinuityAlertFilters, GpsContinuityMonitor } from './gps-continuity-monitor.js';

const keys = new Set([
  'device_id',
  'status',
  'severity',
  'reason_code',
  'opened_from',
  'opened_before',
  'limit',
  'cursor',
]);

export function registerGpsContinuityRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  monitor: GpsContinuityMonitor,
): void {
  app.get<{ Querystring: Record<string, string | string[]> }>(
    '/v1/admin/gps-continuity/alerts',
    async (request, reply) => {
      const admin = await requireAdmin(request, auth);
      if (
        Object.keys(request.query).some((key) => !keys.has(key)) ||
        Object.values(request.query).some((value) => Array.isArray(value))
      ) {
        await monitor.auditRejectedRead(admin.id, request.id, 'invalid_request');
        throw new ApiError(422, 'invalid_request', 'Invalid request');
      }
      const query = request.query as Record<string, string | undefined>;
      const reason = request.headers['x-geops-access-reason'];
      if (typeof reason !== 'string') {
        await monitor.auditRejectedRead(admin.id, request.id, 'access_reason_required');
        throw new ApiError(422, 'access_reason_required', 'Invalid request');
      }
      const filters: ContinuityAlertFilters = {
        ...(query.device_id !== undefined ? { device_id: query.device_id } : {}),
        ...(query.status !== undefined
          ? { status: query.status as NonNullable<ContinuityAlertFilters['status']> }
          : {}),
        ...(query.severity !== undefined
          ? { severity: query.severity as NonNullable<ContinuityAlertFilters['severity']> }
          : {}),
        ...(query.reason_code !== undefined
          ? { reason_code: query.reason_code as NonNullable<ContinuityAlertFilters['reason_code']> }
          : {}),
        ...(query.opened_from !== undefined ? { opened_from: query.opened_from } : {}),
        ...(query.opened_before !== undefined ? { opened_before: query.opened_before } : {}),
        ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}),
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      };
      reply.header('Cache-Control', 'no-store').header('Vary', 'Cookie');
      try {
        return await monitor.listPageForAdmin(admin.id, request.id, reason, filters);
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 429)
          reply.header('Retry-After', '60');
        throw error;
      }
    },
  );
}
