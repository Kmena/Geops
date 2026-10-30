import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAdmin } from './admin-auth/routes.js';
import type { AdminAuthService } from './admin-auth/service.js';
import { ApiError } from './errors.js';
import type { VisitEvaluationService } from './visit-evaluation.js';

type Params = { id: string; stopId: string; evaluationId: string; date: string };
const header = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;
export function registerVisitEvaluationRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  service: VisitEvaluationService,
): void {
  const mutation = async (request: FastifyRequest) => {
    const admin = await requireAdmin(request, auth, true);
    const key = header(request.headers['idempotency-key']);
    if (!key || request.url.includes('?'))
      throw new ApiError(422, 'invalid_request', 'Invalid request');
    return {
      actorId: admin.id,
      requestId: request.id,
      key,
      method: request.method,
      path: request.url,
    };
  };
  app.post<{ Params: Params }>('/v1/admin/assignments/:id/evaluations', async (request, reply) => {
    const result = await service.enqueueAssignment(
      await mutation(request),
      request.params.id,
      request.body,
    );
    reply.code(202).send(result);
  });
  app.post<{ Params: Params }>(
    '/v1/admin/evaluation-days/:date/reprocess',
    async (request, reply) => {
      const result = await service.enqueueDay(
        await mutation(request),
        request.params.date,
        request.body,
      );
      reply.code(202).send(result);
    },
  );
  app.get<{ Params: Params }>('/v1/admin/assignments/:id/evaluations', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.assignmentResults(admin.id, request.params.id);
  });
  app.get<{ Params: Params }>(
    '/v1/admin/assignments/:id/visits/:stopId/evaluations',
    async (request) => {
      const admin = await requireAdmin(request, auth);
      return service.history(admin.id, request.params.id, request.params.stopId);
    },
  );
  app.get<{ Params: Params }>(
    '/v1/admin/assignments/:id/visits/:stopId/technical-preview',
    async (request, reply) => {
      const admin = await requireAdmin(request, auth);
      reply.header('cache-control', 'no-store');
      return service.technicalPreview(
        admin.id,
        request.id,
        request.params.id,
        request.params.stopId,
        header(request.headers['x-geops-access-reason']) ?? '',
      );
    },
  );
  app.get<{ Params: Params }>('/v1/admin/assignments/:id/visits/:stopId/map', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.visitMap(
      admin.id,
      request.id,
      request.params.id,
      request.params.stopId,
      header(request.headers['x-geops-access-reason']) ?? '',
    );
  });
  app.get<{ Params: Params }>(
    '/v1/admin/assignments/:id/visits/:stopId/evaluations/:evaluationId/evidence',
    async (request) => {
      const admin = await requireAdmin(request, auth);
      return service.evidence(
        admin.id,
        request.id,
        request.params.id,
        request.params.stopId,
        request.params.evaluationId,
        header(request.headers['x-geops-access-reason']) ?? '',
      );
    },
  );
}
