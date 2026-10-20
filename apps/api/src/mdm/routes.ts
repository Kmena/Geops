import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../admin-auth/routes.js';
import type { AdminAuthService } from '../admin-auth/service.js';
import { ApiError } from '../errors.js';
import { appendAudit } from '../audit/index.js';
import type { DeviceRepository } from '../device-identity/repository.js';
import { requireInstallationAccess } from '../device-identity/admin-scope.js';
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

async function requireInstallationCapability(
  devices: DeviceRepository,
  adminId: string,
  requestId: string,
  action: string,
): Promise<void> {
  try {
    await requireInstallationAccess(devices.pool, adminId, 'synthetic');
  } catch (error) {
    await appendAudit(devices.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      action,
      outcome: 'rejected',
      correlationId: requestId,
      metadata: { code: error instanceof ApiError ? error.code : 'dependency_unavailable' },
    }).catch(() => {});
    throw error;
  }
}

export function registerInventoryRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  devices: DeviceRepository,
  mdm: MdmProvider,
): void {
  app.get<{ Querystring: PageQuery }>('/v1/admin/devices', async (request) => {
    const admin = await requireAdmin(request, auth);
    await requireInstallationCapability(devices, admin.id, request.id, 'device.inventory.read');
    const args = page(request.query);
    const result = await devices.list(args.cursor, args.limit);
    await appendAudit(devices.pool, {
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'device.inventory.read',
      outcome: 'success',
      correlationId: request.id,
      metadata: { source: 'geops', count: result.items.length },
    });
    return result;
  });

  app.get<{ Querystring: PageQuery }>('/v1/admin/enrollment/devices', async (request) => {
    const admin = await requireAdmin(request, auth);
    await requireInstallationCapability(
      devices,
      admin.id,
      request.id,
      'device.enrollment.inventory.read',
    );
    const args = page(request.query);
    const result = await devices.listEnrollment(args.cursor, args.limit);
    await appendAudit(devices.pool, {
      actorType: 'ADMIN',
      actorId: admin.id,
      action: 'device.enrollment.inventory.read',
      outcome: 'success',
      correlationId: request.id,
      metadata: { tenant_id: 'synthetic', count: result.items.length },
    });
    return result;
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
      const admin = await requireAdmin(request, auth, true);
      await requireInstallationCapability(devices, admin.id, request.id, 'device.draft.create');
      const record = await devices.createDraft(request.body.display_label, admin.id, request.id);
      reply.code(201);
      return record;
    },
  );

  app.get('/v1/admin/mdm/status', async (request) => {
    const admin = await requireAdmin(request, auth);
    await requireInstallationCapability(devices, admin.id, request.id, 'mdm.status.read');
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
    await requireInstallationCapability(devices, admin.id, request.id, 'mdm.inventory.read');
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
