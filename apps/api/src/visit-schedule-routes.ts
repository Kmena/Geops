import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAdmin } from './admin-auth/routes.js';
import type { AdminAuthService } from './admin-auth/service.js';
import { ApiError } from './errors.js';
import type { VisitScheduleService } from './visit-schedule.js';

type Params = { id: string; date: string };
type Query = {
  q?: string;
  state?: string;
  cursor?: string;
  limit?: string;
  from?: string;
  to?: string;
  agent_id?: string;
  route_id?: string;
};
const header = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;
const send = (
  reply: FastifyReply,
  result: { status: number; body: Record<string, unknown>; etag?: string },
) => {
  if (result.etag) reply.header('ETag', result.etag);
  reply.code(result.status).send(result.body);
};
const query = (value: Query, allowed: string[]) => {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new ApiError(422, 'invalid_request', 'Invalid request');
  const limit = value.limit === undefined ? 25 : Number(value.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new ApiError(422, 'invalid_request', 'Invalid request');
  return limit;
};
export function registerVisitScheduleRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  service: VisitScheduleService,
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
  app.get('/v1/admin/schedule-capabilities', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.capabilities(admin.id);
  });
  app.get<{ Querystring: Query }>('/v1/admin/agents', async (request) => {
    const admin = await requireAdmin(request, auth);
    const limit = query(request.query, ['q', 'state', 'cursor', 'limit']);
    return service.listAgents(admin.id, { ...request.query, limit });
  });
  app.post('/v1/admin/agents', async (request, reply) =>
    send(reply, await service.createAgent(await mutation(request), request.body)),
  );
  app.get<{ Params: Params }>('/v1/admin/agents/:id', async (request, reply) => {
    const admin = await requireAdmin(request, auth);
    const body = await service.getAgent(admin.id, request.params.id);
    reply.header('ETag', `"${body.version}"`);
    return body;
  });
  app.patch<{ Params: Params }>('/v1/admin/agents/:id', async (request, reply) =>
    send(reply, await service.patchAgent(await mutation(request), request.params.id, request.body)),
  );
  app.get<{ Querystring: Query }>('/v1/admin/assignments', async (request) => {
    const admin = await requireAdmin(request, auth);
    const limit = query(request.query, [
      'from',
      'to',
      'agent_id',
      'route_id',
      'state',
      'cursor',
      'limit',
    ]);
    return service.listAssignments(admin.id, {
      ...request.query,
      from: request.query.from ?? '',
      to: request.query.to ?? '',
      limit,
    });
  });
  app.post('/v1/admin/assignments', async (request, reply) =>
    send(reply, await service.createAssignment(await mutation(request), request.body)),
  );
  app.get<{ Params: Params }>('/v1/admin/assignments/:id', async (request, reply) => {
    const admin = await requireAdmin(request, auth);
    const body = await service.getAssignment(admin.id, request.params.id);
    reply.header('ETag', `"${body.version}"`);
    return body;
  });
  app.post<{ Params: Params }>('/v1/admin/assignments/:id/cancel', async (request, reply) =>
    send(
      reply,
      await service.cancelAssignment(await mutation(request), request.params.id, request.body),
    ),
  );
  app.get<{ Querystring: Query }>('/v1/admin/calendar', async (request) => {
    const admin = await requireAdmin(request, auth);
    const limit = query(request.query, [
      'from',
      'to',
      'agent_id',
      'route_id',
      'state',
      'cursor',
      'limit',
    ]);
    return service.listAssignments(admin.id, {
      ...request.query,
      from: request.query.from ?? '',
      to: request.query.to ?? '',
      limit,
    });
  });
  app.get<{ Querystring: Query }>('/v1/admin/schedule-rules', async (request) => {
    const admin = await requireAdmin(request, auth);
    const limit = query(request.query, ['agent_id', 'route_id', 'state', 'cursor', 'limit']);
    return service.listRules(admin.id, { ...request.query, limit });
  });
  app.post('/v1/admin/schedule-rules', async (request, reply) =>
    send(reply, await service.createRule(await mutation(request), request.body)),
  );
  app.get<{ Params: Params }>('/v1/admin/schedule-rules/:id', async (request, reply) => {
    const admin = await requireAdmin(request, auth);
    const body = await service.getRule(admin.id, request.params.id);
    reply.header('ETag', `"${body.version}"`);
    return body;
  });
  app.patch<{ Params: Params }>('/v1/admin/schedule-rules/:id', async (request, reply) =>
    send(reply, await service.patchRule(await mutation(request), request.params.id, request.body)),
  );
  app.put<{ Params: Params }>(
    '/v1/admin/schedule-rules/:id/exceptions/:date',
    async (request, reply) =>
      send(
        reply,
        await service.putException(
          await mutation(request),
          request.params.id,
          request.params.date,
          request.body,
        ),
      ),
  );
  app.post<{ Params: Params }>('/v1/admin/schedule-rules/:id/materialize', async (request, reply) =>
    send(
      reply,
      await service.materialize(await mutation(request), request.params.id, request.body),
    ),
  );
}
