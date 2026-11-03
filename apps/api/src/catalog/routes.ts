import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAdmin } from '../admin-auth/routes.js';
import type { AdminAuthService } from '../admin-auth/service.js';
import { ApiError } from '../errors.js';
import type { CatalogResource, CatalogResult, CatalogService } from './service.js';

type Params = { id: string };
type StopParams = { id: string; stopId: string };
type MemberParams = { id: string; establishmentId: string };
type LinkParams = { id: string; customerId: string };
type Query = { cursor?: string; limit?: string };
const resources: CatalogResource[] = [
  'sources',
  'customers',
  'establishments',
  'pins',
  'groups',
  'routes',
];
function header(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function page(query: Query): { cursor?: string; limit: number } {
  if (Object.keys(query).some((key) => key !== 'cursor' && key !== 'limit'))
    throw new ApiError(422, 'invalid_request', 'Invalid request');
  const limit = query.limit === undefined ? 25 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ApiError(422, 'invalid_request', 'Invalid request');
  return { ...(query.cursor === undefined ? {} : { cursor: query.cursor }), limit };
}
function send(reply: FastifyReply, result: CatalogResult): Record<string, unknown> {
  reply.header('cache-control', 'no-store');
  if (result.etag) reply.header('ETag', result.etag);
  reply.code(result.status);
  return result.body;
}
function match(request: FastifyRequest): string | undefined {
  return header(request.headers['if-match']);
}

export function registerCatalogRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  catalog: CatalogService,
): void {
  app.get('/v1/admin/catalog/revision', async (request, reply) => {
    const actor = await requireAdmin(request, auth);
    reply.header('cache-control', 'no-store');
    return catalog.revision(actor.id, request.id);
  });
  for (const resource of resources) {
    const base = '/v1/admin/catalog/' + resource;
    app.get<{ Querystring: Query }>(base, async (request, reply) => {
      const actor = await requireAdmin(request, auth);
      const args = page(request.query);
      reply.header('cache-control', 'no-store');
      return catalog.list(resource, actor.id, request.id, args.cursor, args.limit);
    });
    app.post(base, async (request, reply) => {
      const actor = await requireAdmin(request, auth, true);
      return send(reply, await catalog.create(resource, request.body, actor.id, request.id));
    });
    app.get<{ Params: Params }>(base + '/:id', async (request, reply) => {
      const actor = await requireAdmin(request, auth);
      return send(reply, await catalog.get(resource, request.params.id, actor.id, request.id));
    });
    app.patch<{ Params: Params }>(base + '/:id', async (request, reply) => {
      const actor = await requireAdmin(request, auth, true);
      return send(
        reply,
        await catalog.patch(
          resource,
          request.params.id,
          request.body,
          match(request),
          actor.id,
          request.id,
        ),
      );
    });
    app.delete<{ Params: Params }>(base + '/:id', async (request, reply) => {
      const actor = await requireAdmin(request, auth, true);
      return send(
        reply,
        await catalog.archive(
          resource,
          request.params.id,
          request.body,
          match(request),
          actor.id,
          request.id,
        ),
      );
    });
  }
  app.post<{ Params: Params }>(
    '/v1/admin/catalog/establishments/:id/customers',
    async (request, reply) => {
      const actor = await requireAdmin(request, auth, true);
      return send(
        reply,
        await catalog.linkCustomer(
          request.params.id,
          request.body,
          match(request),
          actor.id,
          request.id,
        ),
      );
    },
  );
  app.get<{ Params: Params }>(
    '/v1/admin/catalog/establishments/:id/customers',
    async (request, reply) => {
      const actor = await requireAdmin(request, auth);
      reply.header('cache-control', 'no-store');
      return catalog.customersForEstablishment(request.params.id, actor.id, request.id);
    },
  );
  app.delete<{ Params: LinkParams }>(
    '/v1/admin/catalog/establishments/:id/customers/:customerId',
    async (request, reply) => {
      const actor = await requireAdmin(request, auth, true);
      return send(
        reply,
        await catalog.unlinkCustomer(
          request.params.id,
          request.params.customerId,
          request.body,
          match(request),
          actor.id,
          request.id,
        ),
      );
    },
  );
  app.get<{ Params: Params }>('/v1/admin/catalog/groups/:id/members', async (request, reply) => {
    const actor = await requireAdmin(request, auth);
    reply.header('cache-control', 'no-store');
    return catalog.groupMembers(request.params.id, actor.id, request.id);
  });
  app.post<{ Params: MemberParams }>(
    '/v1/admin/catalog/groups/:id/members/:establishmentId',
    async (request, reply) => {
      const actor = await requireAdmin(request, auth, true);
      return send(
        reply,
        await catalog.changeMember(
          request.params.id,
          request.params.establishmentId,
          false,
          request.body,
          match(request),
          actor.id,
          request.id,
        ),
      );
    },
  );
  app.delete<{ Params: MemberParams }>(
    '/v1/admin/catalog/groups/:id/members/:establishmentId',
    async (request, reply) => {
      const actor = await requireAdmin(request, auth, true);
      return send(
        reply,
        await catalog.changeMember(
          request.params.id,
          request.params.establishmentId,
          true,
          request.body,
          match(request),
          actor.id,
          request.id,
        ),
      );
    },
  );
  app.get<{ Params: Params; Querystring: Query }>(
    '/v1/admin/catalog/routes/:id/stops',
    async (request, reply) => {
      const actor = await requireAdmin(request, auth);
      const args = page(request.query);
      reply.header('cache-control', 'no-store');
      return catalog.listStops(request.params.id, actor.id, request.id, args.cursor, args.limit);
    },
  );
  app.post<{ Params: Params }>('/v1/admin/catalog/routes/:id/stops', async (request, reply) => {
    const actor = await requireAdmin(request, auth, true);
    return send(
      reply,
      await catalog.createStop(request.params.id, request.body, actor.id, request.id),
    );
  });
  app.get<{ Params: StopParams }>(
    '/v1/admin/catalog/routes/:id/stops/:stopId',
    async (request, reply) => {
      const actor = await requireAdmin(request, auth);
      return send(
        reply,
        await catalog.getStop(request.params.id, request.params.stopId, actor.id, request.id),
      );
    },
  );
  app.patch<{ Params: StopParams }>(
    '/v1/admin/catalog/routes/:id/stops/:stopId',
    async (request, reply) => {
      const actor = await requireAdmin(request, auth, true);
      return send(
        reply,
        await catalog.patchStop(
          request.params.id,
          request.params.stopId,
          request.body,
          match(request),
          actor.id,
          request.id,
        ),
      );
    },
  );
  app.delete<{ Params: StopParams }>(
    '/v1/admin/catalog/routes/:id/stops/:stopId',
    async (request, reply) => {
      const actor = await requireAdmin(request, auth, true);
      return send(
        reply,
        await catalog.deleteStop(
          request.params.id,
          request.params.stopId,
          request.body,
          match(request),
          actor.id,
          request.id,
        ),
      );
    },
  );
}
