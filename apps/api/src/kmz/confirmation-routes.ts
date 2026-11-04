import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAdmin } from '../admin-auth/routes.js';
import type { AdminAuthService } from '../admin-auth/service.js';
import type { KmzService } from './service.js';
import type { KmzConfirmationService } from './confirmation.js';

type Params = { id: string };

export function registerKmzConfirmationRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  kmz: KmzService,
  confirmation: KmzConfirmationService,
): void {
  const actor = async (
    request: FastifyRequest,
    permission: 'catalog.import.read' | 'catalog.import.confirm',
    write: boolean,
  ) => {
    const admin = await requireAdmin(request, auth, write);
    await kmz.authorize(admin.id, permission, request.id);
    return admin.id;
  };
  app.post<{ Params: Params }>('/v1/admin/kmz-imports/:id/validate', async (request, reply) => {
    const actorId = await actor(request, 'catalog.import.confirm', true);
    reply.header('cache-control', 'no-store');
    return confirmation.validate(actorId, request.params.id, request.id);
  });
  app.post<{ Params: Params; Body: Record<string, unknown> }>(
    '/v1/admin/kmz-imports/:id/confirm',
    async (request, reply) => {
      const actorId = await actor(request, 'catalog.import.confirm', true);
      reply.header('cache-control', 'no-store');
      const match = request.headers['if-match'];
      const key = request.headers['idempotency-key'];
      return confirmation.confirm(
        actorId,
        request.params.id,
        request.body,
        typeof match === 'string' ? match : undefined,
        typeof key === 'string' ? key : undefined,
        request.id,
      );
    },
  );
  app.get<{ Params: Params }>('/v1/admin/kmz-imports/:id/result', async (request, reply) => {
    const actorId = await actor(request, 'catalog.import.read', false);
    reply.header('cache-control', 'no-store');
    return confirmation.result(actorId, request.params.id);
  });
}
