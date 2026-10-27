import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAdmin } from './admin-auth/routes.js';
import type { AdminAuthService } from './admin-auth/service.js';
import type { AgentDeviceLinkService } from './agent-device-links.js';
import { ApiError } from './errors.js';

type Params = { agentId: string; linkId: string; deviceId: string };
const header = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : undefined;
const send = (
  reply: FastifyReply,
  result: { status: number; body: Record<string, unknown>; etag?: string },
) => {
  if (result.etag) reply.header('ETag', result.etag);
  reply.code(result.status).send(result.body);
};
export function registerAgentDeviceLinkRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  service: AgentDeviceLinkService,
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
  app.get('/v1/admin/agent-devices/available', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.availableDevices(admin.id);
  });
  app.get('/v1/admin/agent-devices/unassigned-agents', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.unassignedAgents(admin.id);
  });
  app.post('/v1/admin/agent-devices', async (request, reply) =>
    send(reply, await service.registerAgentDevice(await mutation(request), request.body)),
  );
  app.get<{ Params: Params }>('/v1/admin/agents/:agentId/device-link', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.current(admin.id, request.params.agentId);
  });
  app.get<{ Params: Params }>('/v1/admin/agents/:agentId/device-links', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.history(admin.id, request.params.agentId);
  });
  app.get<{ Params: Params }>('/v1/admin/agents/:agentId/identity', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.identity(admin.id, request.params.agentId);
  });
  app.get<{ Params: Params }>('/v1/admin/agents/:agentId/responsibilities', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.responsibilityHistory(admin.id, request.params.agentId);
  });
  app.post<{ Params: Params }>(
    '/v1/admin/agents/:agentId/responsibilities',
    async (request, reply) =>
      send(
        reply,
        await service.setResponsible(await mutation(request), request.params.agentId, request.body),
      ),
  );
  app.post('/v1/admin/agent-device-links', async (request, reply) =>
    send(reply, await service.link(await mutation(request), request.body)),
  );
  app.post<{ Params: Params }>(
    '/v1/admin/agent-devices/:deviceId/authorize-geops',
    async (request, reply) =>
      send(
        reply,
        await service.authorizeGeopsDevice(
          await mutation(request),
          request.params.deviceId,
          request.body,
        ),
      ),
  );
  app.post<{ Params: Params }>('/v1/admin/agent-device-links/:linkId/end', async (request, reply) =>
    send(reply, await service.end(await mutation(request), request.params.linkId, request.body)),
  );
  app.post<{ Params: Params }>(
    '/v1/admin/agent-device-links/:linkId/reassign',
    async (request, reply) =>
      send(
        reply,
        await service.reassign(await mutation(request), request.params.linkId, request.body),
      ),
  );
}
