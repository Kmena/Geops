import type { FastifyInstance } from 'fastify';
import type { AdminAuthService } from '../admin-auth/service.js';
import { requireAdmin } from '../admin-auth/routes.js';
import { ApiError } from '../errors.js';
import type { MdmPolicyService } from './policy-service.js';
import type { WorkspaceQuery } from './workspace-service.js';

export function registerMdmPolicyRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  service: MdmPolicyService,
): void {
  app.get('/v1/admin/mdm/workspace/summary', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.workspace.summary(admin.id, request.id);
  });
  app.get<{ Querystring: WorkspaceQuery }>('/v1/admin/mdm/workspace/devices', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.workspace.devices(admin.id, request.query, request.id);
  });
  app.get<{ Querystring: WorkspaceQuery }>('/v1/admin/mdm/workspace/report', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.workspace.report(admin.id, request.query, request.id);
  });
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; kind?: string } }>(
    '/v1/admin/mdm/workspace/devices/:id/timeline',
    async (request) => {
      const admin = await requireAdmin(request, auth);
      if (
        Object.keys(request.query).some((key) => !['from', 'to', 'kind'].includes(key)) ||
        Object.values(request.query).some((value) => typeof value !== 'string')
      )
        throw new ApiError(422, 'invalid_timeline_query', 'Invalid request');
      return service.workspace.timeline(
        admin.id,
        request.params.id,
        request.id,
        request.query.from,
        request.query.to,
        request.query.kind,
      );
    },
  );
  app.get('/v1/admin/mdm/capabilities', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.capabilities(admin.id, request.id);
  });
  app.get<{ Params: { id: string } }>(
    '/v1/admin/mdm/devices/:id/configuration',
    async (request) => {
      const admin = await requireAdmin(request, auth);
      return service.device(admin.id, request.params.id, request.id);
    },
  );
  app.post<{ Body: { device_id: string; profile_id: string } }>(
    '/v1/admin/mdm/remediations/preview',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['device_id', 'profile_id'],
          properties: {
            device_id: { type: 'string', format: 'uuid' },
            profile_id: { type: 'string', pattern: '^[0-9]{1,30}$' },
          },
        },
      },
    },
    async (request) => {
      const admin = await requireAdmin(request, auth, true);
      await auth.assertRecentLogin(admin);
      return service.preview(admin.id, request.body.device_id, request.body.profile_id, request.id);
    },
  );
  app.post<{
    Body: {
      device_id: string;
      profile_id: string;
      preview_digest: string;
      idempotency_key: string;
      reason: string;
    };
  }>(
    '/v1/admin/mdm/remediations/requests',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['device_id', 'profile_id', 'preview_digest', 'idempotency_key', 'reason'],
          properties: {
            device_id: { type: 'string', format: 'uuid' },
            profile_id: { type: 'string', pattern: '^[0-9]{1,30}$' },
            preview_digest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            idempotency_key: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,80}$' },
            reason: { type: 'string', minLength: 8, maxLength: 240 },
          },
        },
      },
    },
    async (request) => {
      const admin = await requireAdmin(request, auth, true);
      await auth.assertRecentLogin(admin);
      const body = request.body;
      return service.requestRemediation(
        admin.id,
        body.device_id,
        body.profile_id,
        body.preview_digest,
        body.idempotency_key,
        body.reason,
        request.id,
      );
    },
  );
  app.get<{ Params: { id: string } }>('/v1/admin/mdm/devices/:id/remediations', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.remediationHistory(admin.id, request.params.id, request.id);
  });
  app.post<{ Params: { id: string } }>(
    '/v1/admin/mdm/remediations/requests/:id/submit',
    async (request) => {
      const admin = await requireAdmin(request, auth, true);
      await auth.assertRecentLogin(admin);
      return service.submit(admin.id, request.params.id, request.id);
    },
  );
}
