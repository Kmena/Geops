import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAdmin } from '../admin-auth/routes.js';
import type { AdminAuthService } from '../admin-auth/service.js';
import { ApiError } from '../errors.js';
import type { KmzAnalysisService } from './analysis.js';
import type { KmzService } from './service.js';

type Params = { id: string };
type CandidateParams = { id: string; recordId: string };
type Query = Record<string, string | undefined>;

export function registerKmzAnalysisRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  kmz: KmzService,
  analysis: KmzAnalysisService,
): void {
  const base = '/v1/admin/kmz-imports';
  const actors = new WeakMap<FastifyRequest, string>();
  const read = async (request: FastifyRequest): Promise<string> => {
    const actor = await requireAdmin(request, auth);
    await kmz.authorize(actor.id, 'catalog.import.read', request.id);
    return actor.id;
  };
  app.route<{ Params: Params }>({
    method: 'POST',
    url: `${base}/:id/rematch`,
    onRequest: async (request) => {
      const actor = await requireAdmin(request, auth, true);
      await kmz.authorize(actor.id, 'catalog.import.write', request.id);
      actors.set(request, actor.id);
    },
    handler: async (request, reply) => {
      const actorId = actors.get(request);
      if (!actorId) throw new ApiError(401, 'unauthorized', 'Unauthorized');
      const result = await analysis.analyze(actorId, request.params.id, request.body, request.id);
      reply.header('cache-control', 'no-store');
      reply.code(result.status);
      return result.body;
    },
  });
  app.get<{ Params: Params }>(`${base}/:id/analysis/summary`, async (request, reply) => {
    const actorId = await read(request);
    reply.header('cache-control', 'no-store');
    return analysis.summary(actorId, request.params.id);
  });
  app.get<{ Params: Params; Querystring: Query }>(
    `${base}/:id/analysis/results`,
    async (request, reply) => {
      const actorId = await read(request);
      reply.header('cache-control', 'no-store');
      return analysis.results(actorId, request.params.id, request.query);
    },
  );
  app.get<{ Params: CandidateParams; Querystring: Query }>(
    `${base}/:id/analysis/results/:recordId/candidates`,
    async (request, reply) => {
      const actorId = await read(request);
      reply.header('cache-control', 'no-store');
      return analysis.candidates(
        actorId,
        request.params.id,
        request.params.recordId,
        request.query,
      );
    },
  );
  app.get<{ Params: Params; Querystring: Query }>(
    `${base}/:id/analysis/conflicts`,
    async (request, reply) => {
      const actorId = await read(request);
      reply.header('cache-control', 'no-store');
      return analysis.conflicts(actorId, request.params.id, request.query);
    },
  );
}
