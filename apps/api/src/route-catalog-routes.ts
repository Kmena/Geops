import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAdmin } from './admin-auth/routes.js';
import type { AdminAuthService } from './admin-auth/service.js';
import { ApiError } from './errors.js';
import type { RouteCatalogService } from './route-catalog.js';

type Params = { id: string; revision: string };
type Query = { q?: string; state?: string; cursor?: string; limit?: string };
const header = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;
const send = (
  reply: FastifyReply,
  result: { status: number; body: Record<string, unknown>; etag?: string },
) => {
  if (result.etag) reply.header('ETag', result.etag);
  reply.code(result.status).send(result.body);
};
const validateQuery = (query: Query, allowed: string[]) => {
  if (Object.keys(query).some((key) => !allowed.includes(key)))
    throw new ApiError(422, 'invalid_request', 'Invalid request');
  const limit = query.limit === undefined ? 25 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ApiError(422, 'invalid_request', 'Invalid request');
  return limit;
};

export function registerRouteCatalogRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  service: RouteCatalogService,
): void {
  const mutation = async (request: FastifyRequest) => {
    const admin = await requireAdmin(request, auth, true);
    if (request.url.includes('?')) throw new ApiError(422, 'invalid_request', 'Invalid request');
    const key = header(request.headers['idempotency-key']);
    if (!key) throw new ApiError(422, 'invalid_request', 'Invalid request');
    const ifMatch = header(request.headers['if-match']);
    return {
      actorId: admin.id,
      requestId: request.id,
      key,
      method: request.method,
      path: request.url,
      ...(ifMatch ? { ifMatch } : {}),
    };
  };
  app.get<{ Querystring: Query }>('/v1/admin/routes', async (request) => {
    const admin = await requireAdmin(request, auth);
    const limit = validateQuery(request.query, ['q', 'state', 'cursor', 'limit']);
    return service.list(admin.id, { ...request.query, limit });
  });
  app.post('/v1/admin/routes', async (request, reply) =>
    send(reply, await service.create(await mutation(request), request.body)),
  );
  app.get<{ Params: Params }>('/v1/admin/routes/:id', async (request, reply) => {
    const admin = await requireAdmin(request, auth);
    const body = await service.get(admin.id, request.params.id);
    reply.header('ETag', `"${body.version}"`);
    return body;
  });
  app.patch<{ Params: Params }>('/v1/admin/routes/:id', async (request, reply) =>
    send(reply, await service.patch(await mutation(request), request.params.id, request.body)),
  );
  app.put<{ Params: Params }>('/v1/admin/routes/:id/draft/stops', async (request, reply) =>
    send(
      reply,
      await service.replaceStops(await mutation(request), request.params.id, request.body),
    ),
  );
  app.post<{ Params: Params }>('/v1/admin/routes/:id/publish', async (request, reply) =>
    send(reply, await service.publish(await mutation(request), request.params.id, request.body)),
  );
  app.post<{ Params: Params }>('/v1/admin/routes/:id/deactivate', async (request, reply) =>
    send(
      reply,
      await service.setState(await mutation(request), request.params.id, request.body, 'INACTIVE'),
    ),
  );
  app.post<{ Params: Params }>('/v1/admin/routes/:id/activate', async (request, reply) =>
    send(
      reply,
      await service.setState(await mutation(request), request.params.id, request.body, 'ACTIVE'),
    ),
  );
  app.get<{ Params: Params; Querystring: Query }>(
    '/v1/admin/routes/:id/revisions',
    async (request) => {
      const admin = await requireAdmin(request, auth);
      const limit = validateQuery(request.query, ['cursor', 'limit']);
      return service.revisions(admin.id, request.params.id, request.query.cursor, limit);
    },
  );
  app.get<{ Params: Params }>(
    '/v1/admin/routes/:id/revisions/:revision',
    async (request, reply) => {
      const admin = await requireAdmin(request, auth);
      const body = await service.revision(
        admin.id,
        request.params.id,
        Number(request.params.revision),
      );
      reply.header('ETag', `"${body.revision}"`);
      return body;
    },
  );
}
