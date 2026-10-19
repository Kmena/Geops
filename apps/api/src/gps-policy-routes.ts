import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAdmin } from './admin-auth/routes.js';
import type { AdminAuthService } from './admin-auth/service.js';
import { exactBody } from './device-identity/raw-body.js';
import { ApiError } from './errors.js';
import type { GpsPolicyService, MutationContext, MutationResult } from './gps-policy-service.js';

type Params = { id: string };
type Query = { cursor?: string; limit?: string };
const header = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

function send(reply: FastifyReply, result: MutationResult): void {
  if (result.etag) reply.header('ETag', result.etag);
  reply.code(result.status).send(result.body);
}

function page(query: Query): { cursor?: string; limit: number } {
  if (Object.keys(query).some((key) => key !== 'cursor' && key !== 'limit'))
    throw new ApiError(422, 'invalid_request', 'Invalid request');
  const limit = query.limit === undefined ? 25 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ApiError(422, 'invalid_request', 'Invalid request');
  return { ...(query.cursor === undefined ? {} : { cursor: query.cursor }), limit };
}

export function registerGpsPolicyRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  service: GpsPolicyService,
): void {
  const context = async (request: FastifyRequest): Promise<MutationContext> => {
    const admin = await requireAdmin(request, auth, true);
    if (request.url.includes('?')) throw new ApiError(422, 'invalid_request', 'Invalid request');
    const key = header(request.headers['idempotency-key']);
    if (!key) throw new ApiError(422, 'invalid_request', 'Invalid request');
    const path = request.url.split('?')[0]!;
    const ifMatch = header(request.headers['if-match']);
    return {
      adminId: admin.id,
      requestId: request.id,
      method: request.method,
      path,
      key,
      rawBody: exactBody(request),
      ...(ifMatch ? { ifMatch } : {}),
    };
  };
  app.get<{ Querystring: Query }>('/v1/admin/gps-policies', async (request) => {
    const admin = await requireAdmin(request, auth);
    const args = page(request.query);
    return service.listPolicies(admin.id, request.id, args.cursor, args.limit);
  });
  app.post('/v1/admin/gps-policies', async (request, reply) =>
    send(reply, await service.createPolicy(await context(request), request.body)),
  );
  app.get<{ Params: Params }>('/v1/admin/gps-policies/:id', async (request, reply) => {
    const admin = await requireAdmin(request, auth);
    const body = await service.getPolicy(admin.id, request.id, request.params.id);
    reply.header('ETag', body.etag);
    return body;
  });
  app.patch<{ Params: Params }>('/v1/admin/gps-policies/:id', async (request, reply) =>
    send(reply, await service.patchPolicy(await context(request), request.params.id, request.body)),
  );
  app.put<{ Params: Params }>('/v1/admin/gps-policies/:id/assignments', async (request, reply) =>
    send(
      reply,
      await service.replaceAssignments(await context(request), request.params.id, request.body),
    ),
  );
  for (const mode of ['publish', 'resume', 'pause', 'revoke'] as const) {
    app.post<{ Params: Params }>(`/v1/admin/gps-policies/:id/${mode}`, async (request, reply) => {
      const ctx = await context(request);
      if (
        !request.body ||
        typeof request.body !== 'object' ||
        Array.isArray(request.body) ||
        Object.keys(request.body).some((key) => key !== 'reason')
      )
        throw new ApiError(422, 'invalid_request', 'Invalid request');
      const reason = (request.body as { reason?: unknown }).reason;
      const result =
        mode === 'publish'
          ? await service.publishPolicy(ctx, request.params.id, reason)
          : mode === 'resume'
            ? await service.resumePolicy(ctx, request.params.id, reason)
            : mode === 'pause'
              ? await service.pausePolicy(ctx, request.params.id, reason)
              : await service.revokePolicy(ctx, request.params.id, reason);
      send(reply, result);
    });
  }
  app.get<{ Querystring: Query }>('/v1/admin/gps-groups', async (request) => {
    const admin = await requireAdmin(request, auth);
    const args = page(request.query);
    return service.listGroups(admin.id, request.id, args.cursor, args.limit);
  });
  app.post('/v1/admin/gps-groups', async (request, reply) =>
    send(reply, await service.createGroup(await context(request), request.body)),
  );
  app.put<{ Params: Params }>('/v1/admin/gps-groups/:id/members', async (request, reply) =>
    send(
      reply,
      await service.replaceMembers(await context(request), request.params.id, request.body),
    ),
  );
}
