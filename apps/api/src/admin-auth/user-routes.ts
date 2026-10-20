import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.js';
import { requireAdmin } from './routes.js';
import type { AdminAuthService } from './service.js';
import type { AdminUserAdministrationService } from './user-administration.js';

function body(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(422, 'invalid_request', 'Invalid request');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !keys.includes(key)) || keys.some((key) => !(key in data)))
    throw new ApiError(422, 'invalid_request', 'Invalid request');
  return data;
}

function value(data: Record<string, unknown>, key: string): string {
  if (typeof data[key] !== 'string') throw new ApiError(422, 'invalid_request', 'Invalid request');
  return data[key] as string;
}

export function registerUserAdministrationRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  users: AdminUserAdministrationService,
): void {
  app.get('/v1/admin/users', async (request, reply) => {
    const actor = await requireAdmin(request, auth);
    reply.header('cache-control', 'no-store');
    return users.list(actor.id, request.id);
  });

  app.post('/v1/admin/users', async (request, reply) => {
    const actor = await requireAdmin(request, auth, true);
    const data = body(request.body, ['email', 'reason']);
    const result = await users.create(
      actor.id,
      request.id,
      value(data, 'email'),
      value(data, 'reason'),
    );
    reply.header('cache-control', 'no-store');
    reply.code(201);
    return result;
  });

  app.post('/v1/admin/users/invitations/accept', async (request, reply) => {
    if (!auth.isAllowedOrigin(request.headers.origin))
      throw new ApiError(403, 'origin_rejected', 'Forbidden');
    const data = body(request.body, ['invitation_id', 'invitation_token', 'password']);
    await users.acceptInvitation(
      value(data, 'invitation_id'),
      value(data, 'invitation_token'),
      value(data, 'password'),
      request.id,
    );
    reply.header('cache-control', 'no-store');
    reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>(
    '/v1/admin/users/:id/invitations',
    async (request, reply) => {
      const actor = await requireAdmin(request, auth, true);
      const data = body(request.body, ['reason']);
      const result = await users.reissueInvitation(
        actor.id,
        request.params.id,
        request.id,
        value(data, 'reason'),
      );
      reply.header('cache-control', 'no-store');
      reply.code(201);
      return result;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/admin/users/:id/capabilities',
    async (request, reply) => {
      const actor = await requireAdmin(request, auth, true);
      const data = body(request.body, ['request_id', 'action', 'capabilities', 'reason']);
      if (
        (data.action !== 'GRANT' && data.action !== 'REVOKE') ||
        !Array.isArray(data.capabilities)
      )
        throw new ApiError(422, 'invalid_request', 'Invalid request');
      await users.capabilities(
        actor.id,
        request.params.id,
        value(data, 'request_id'),
        data.action,
        data.capabilities,
        value(data, 'reason'),
      );
      reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/admin/users/:id/tenant-access',
    async (request, reply) => {
      const actor = await requireAdmin(request, auth, true);
      const data = body(request.body, ['request_id', 'action', 'reason']);
      if (data.action !== 'GRANT' && data.action !== 'REVOKE')
        throw new ApiError(422, 'invalid_request', 'Invalid request');
      await users.tenantAccess(
        actor.id,
        request.params.id,
        value(data, 'request_id'),
        data.action,
        value(data, 'reason'),
      );
      reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>('/v1/admin/users/:id/revoke', async (request, reply) => {
    const actor = await requireAdmin(request, auth, true);
    const data = body(request.body, ['request_id', 'reason']);
    await users.revokeUser(
      actor.id,
      request.params.id,
      value(data, 'request_id'),
      value(data, 'reason'),
    );
    reply.code(204).send();
  });
}
