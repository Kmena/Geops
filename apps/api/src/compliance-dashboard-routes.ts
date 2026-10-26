import type { FastifyInstance } from 'fastify';
import { requireAdmin } from './admin-auth/routes.js';
import type { AdminAuthService } from './admin-auth/service.js';
import type { ComplianceDashboardService, ComplianceQuery } from './compliance-dashboard.js';

export function registerComplianceDashboardRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  service: ComplianceDashboardService,
): void {
  app.get<{ Querystring: ComplianceQuery }>('/v1/admin/compliance', async (request) => {
    const admin = await requireAdmin(request, auth);
    return service.read(admin.id, request.id, request.query);
  });
}
