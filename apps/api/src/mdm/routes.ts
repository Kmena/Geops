import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../admin-auth/routes.js';
import type { AdminAuthService } from '../admin-auth/service.js';
import { ApiError } from '../errors.js';
import { appendAudit } from '../audit/index.js';
import type { DeviceRepository } from '../device-identity/repository.js';
import type { MdmProvider } from './provider.js';

interface PageQuery {
  cursor?: string;
  limit?: string;
}

function page(query: PageQuery): { cursor: string | undefined; limit: number } {
  const limit = query.limit === undefined ? 25 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApiError(400, 'invalid_limit', 'Invalid limit');
  }
  if (query.cursor && query.cursor.length > 2048)
    throw new ApiError(400, 'invalid_cursor', 'Invalid cursor');
  return { cursor: query.cursor, limit };
}

export function registerInventoryRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  devices: DeviceRepository,
  mdm: MdmProvider,
): void {
  app.get<{ Querystring: PageQuery }>('/v1/admin/devices', async (request) => {
    await requireAdmin(request, auth);
    const args = page(request.query);
    return devices.list(args.cursor, args.limit);
  });

  app.post<{ Body: { display_label: string } }>(
    '/v1/admin/devices',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['display_label'],
          properties: { display_label: { type: 'string', minLength: 1, maxLength: 120 } },
        },
      },
    },
    async (request, reply) => {
      await requireAdmin(request, auth, true);
      const record = await devices.createDraft(request.body.display_label);
      reply.code(201);
      return record;
    },
  );

  app.get('/v1/admin/mdm/status', async (request) => {
    const admin = await requireAdmin(request, auth);
    const status = await mdm.integrationStatus();
    await appendAudit(devices.pool, {
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'mdm.status.read',
      outcome: 'success',
      correlationId: request.id,
      metadata: { source: status.provider },
    });
    return status;
  });

  app.get<{ Querystring: PageQuery }>('/v1/admin/mdm/devices', async (request) => {
    const admin = await requireAdmin(request, auth);
    const args = page(request.query);
    const result = await mdm.listDevices('synthetic', args.cursor, args.limit);
    await appendAudit(devices.pool, {
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'mdm.inventory.read',
      outcome: 'success',
      correlationId: request.id,
      metadata: { source: result.source, count: result.items.length },
    });
    return result;
  });
}
