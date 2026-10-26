import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAdmin } from './admin-auth/routes.js';
import type { AdminAuthService } from './admin-auth/service.js';
import type { ClientCatalogService } from './client-catalog.js';
import { ApiError } from './errors.js';

type ClientParams = { id: string };
type SiteParams = ClientParams & { site_id: string };
type ZoneParams = SiteParams & { revision: string };
type Query = { q?: string; state?: string; cursor?: string; limit?: string };
type NestedQuery = { cursor?: string; limit?: string };
const header = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;
const send = (
  reply: FastifyReply,
  result: { status: number; body: Record<string, unknown>; etag?: string },
) => {
  if (result.etag) reply.header('ETag', result.etag);
  reply.code(result.status).send(result.body);
};
function nestedPage(query: NestedQuery): { cursor?: string; limit: number } {
  if (Object.keys(query).some((key) => key !== 'cursor' && key !== 'limit'))
    throw new ApiError(422, 'invalid_request', 'Invalid request');
  const limit = query.limit === undefined ? 25 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ApiError(422, 'invalid_request', 'Invalid request');
  return { ...(query.cursor ? { cursor: query.cursor } : {}), limit };
}

export function registerClientCatalogRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  service: ClientCatalogService,
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
  app.get('/v1/admin/client-capabilities', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.capabilities(admin.id);
  });
  app.get<{ Querystring: Query }>('/v1/admin/clients', async (request) => {
    const admin = await requireAdmin(request, auth);
    if (Object.keys(request.query).some((key) => !['q', 'state', 'cursor', 'limit'].includes(key)))
      throw new ApiError(422, 'invalid_request', 'Invalid request');
    const limit = request.query.limit === undefined ? 25 : Number(request.query.limit);
    return service.listClients(admin.id, { ...request.query, limit });
  });
  app.post('/v1/admin/clients', async (request, reply) =>
    send(reply, await service.createClient(await mutation(request), request.body)),
  );
  app.get<{ Params: ClientParams }>('/v1/admin/clients/:id', async (request, reply) => {
    const admin = await requireAdmin(request, auth);
    const body = await service.getClient(admin.id, request.params.id);
    reply.header('ETag', `"${body.version}"`);
    return body;
  });
  app.patch<{ Params: ClientParams }>('/v1/admin/clients/:id', async (request, reply) =>
    send(
      reply,
      await service.patchClient(await mutation(request), request.params.id, request.body),
    ),
  );
  app.post<{ Params: ClientParams }>('/v1/admin/clients/:id/deactivate', async (request, reply) => {
    if (
      !request.body ||
      typeof request.body !== 'object' ||
      Array.isArray(request.body) ||
      Object.keys(request.body).length
    )
      throw new ApiError(422, 'invalid_request', 'Invalid request');
    send(
      reply,
      await service.patchClient(await mutation(request), request.params.id, { state: 'INACTIVE' }),
    );
  });
  app.get<{ Params: ClientParams; Querystring: NestedQuery }>(
    '/v1/admin/clients/:id/sites',
    async (request) => {
      const admin = await requireAdmin(request, auth);
      const query = nestedPage(request.query);
      return service.listSites(admin.id, request.params.id, query.cursor, query.limit);
    },
  );
  app.post<{ Params: ClientParams }>('/v1/admin/clients/:id/sites', async (request, reply) =>
    send(reply, await service.createSite(await mutation(request), request.params.id, request.body)),
  );
  app.get<{ Params: SiteParams }>(
    '/v1/admin/clients/:id/sites/:site_id',
    async (request, reply) => {
      const admin = await requireAdmin(request, auth);
      const body = await service.getSite(admin.id, request.params.id, request.params.site_id);
      reply.header('ETag', `"${body.version}"`);
      return body;
    },
  );
  app.patch<{ Params: SiteParams }>(
    '/v1/admin/clients/:id/sites/:site_id',
    async (request, reply) =>
      send(
        reply,
        await service.patchSite(
          await mutation(request),
          request.params.id,
          request.params.site_id,
          request.body,
        ),
      ),
  );
  app.get<{ Params: SiteParams; Querystring: NestedQuery }>(
    '/v1/admin/clients/:id/sites/:site_id/geofences',
    async (request) => {
      const admin = await requireAdmin(request, auth);
      const query = nestedPage(request.query);
      return service.listGeofences(
        admin.id,
        request.params.id,
        request.params.site_id,
        query.cursor,
        query.limit,
      );
    },
  );
  app.post<{ Params: SiteParams }>(
    '/v1/admin/clients/:id/sites/:site_id/geofences',
    async (request, reply) =>
      send(
        reply,
        await service.createGeofence(
          await mutation(request),
          request.params.id,
          request.params.site_id,
          request.body,
        ),
      ),
  );
  app.get<{ Params: ZoneParams }>(
    '/v1/admin/clients/:id/sites/:site_id/geofences/:revision',
    async (request, reply) => {
      const admin = await requireAdmin(request, auth);
      const body = await service.getGeofence(
        admin.id,
        request.params.id,
        request.params.site_id,
        Number(request.params.revision),
      );
      reply.header('ETag', `"${body.revision}"`);
      return body;
    },
  );
}
