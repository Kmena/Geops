import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAdmin } from '../admin-auth/routes.js';
import type { AdminAuthService } from '../admin-auth/service.js';
import { ApiError } from '../errors.js';
import type { KmzService } from './service.js';
import type { KmzReviewService } from './review.js';

type Params = { id: string; recordId: string };
type Query = Record<string, string | undefined>;

export function registerKmzReviewRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  kmz: KmzService,
  review: KmzReviewService,
): void {
  const base = '/v1/admin/kmz-imports';
  const actors = new WeakMap<FastifyRequest, string>();
  const read = async (request: FastifyRequest) => {
    const actor = await requireAdmin(request, auth);
    await kmz.authorize(actor.id, 'catalog.import.read', request.id);
    return actor.id;
  };
  const write = async (request: FastifyRequest) => {
    const actor = await requireAdmin(request, auth, true);
    await kmz.authorize(actor.id, 'catalog.import.write', request.id);
    actors.set(request, actor.id);
  };
  const actor = (request: FastifyRequest) => {
    const value = actors.get(request);
    if (!value) throw new ApiError(401, 'unauthorized', 'Unauthorized');
    return value;
  };
  app.get(`${base}/capabilities`, async (request, reply) => {
    const admin = await requireAdmin(request, auth);
    reply.header('cache-control', 'no-store');
    return review.capabilities(admin.id);
  });
  app.get<{ Params: Params }>(`${base}/:id/review/summary`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return review.summary(await read(request), request.params.id);
  });
  app.get<{ Params: Params; Querystring: Query }>(
    `${base}/:id/review/records`,
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      return review.records(await read(request), request.params.id, request.query);
    },
  );
  app.get<{ Params: Params }>(`${base}/:id/review/facets`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return review.facets(await read(request), request.params.id);
  });
  app.get<{ Params: Params; Querystring: Query }>(
    `${base}/:id/review/targets`,
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      return review.targets(await read(request), request.params.id, request.query);
    },
  );
  app.get<{ Params: Params }>(`${base}/:id/review/map`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return review.map(await read(request), request.params.id);
  });
  app.get<{ Params: Params }>(`${base}/:id/review/records/:recordId`, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return review.detail(await read(request), request.params.id, request.params.recordId);
  });
  app.patch<{ Params: Params; Body: Record<string, unknown> }>(
    `${base}/:id/review/records/:recordId`,
    { onRequest: write },
    async (request, reply) => {
      const match = request.headers['if-match'];
      if (typeof match !== 'string' || !/^(0|[1-9][0-9]*)$/.test(match))
        throw new ApiError(428, 'review_revision_required', 'Revision required');
      reply.header('cache-control', 'no-store');
      return review.save(
        actor(request),
        request.params.id,
        request.params.recordId,
        Number(match),
        request.body,
        request.id,
      );
    },
  );
  app.post<{ Params: Params; Body: Record<string, unknown> }>(
    `${base}/:id/review/bulk-preview`,
    { onRequest: write },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      return review.bulkPreview(actor(request), request.params.id, request.body);
    },
  );
  app.post<{ Params: Params; Body: Record<string, unknown> }>(
    `${base}/:id/review/bulk-apply`,
    { onRequest: write },
    async (request, reply) => {
      const digest = request.headers['if-match'];
      if (typeof digest !== 'string')
        throw new ApiError(428, 'bulk_preview_required', 'Preview required');
      reply.header('cache-control', 'no-store');
      return review.bulkApply(actor(request), request.params.id, request.body, digest, request.id);
    },
  );
  app.get<{ Params: Params; Querystring: Query }>(
    `${base}/:id/review/preview`,
    async (request, reply) => {
      const page = request.query.page === undefined ? 1 : Number(request.query.page);
      reply.header('cache-control', 'no-store');
      return review.preview(await read(request), request.params.id, page);
    },
  );
}
