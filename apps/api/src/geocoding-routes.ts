import type { FastifyInstance } from 'fastify';
import { requireAdmin } from './admin-auth/routes.js';
import type { AdminAuthService } from './admin-auth/service.js';
import type { GeocodingSearchService } from './geocoding-search.js';
import { ApiError } from './errors.js';

export function registerGeocodingRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  service: GeocodingSearchService,
) {
  app.get<{ Querystring: { q?: string } }>('/v1/admin/geocoding/search', async (request, reply) => {
    const admin = await requireAdmin(request, auth);
    if (Object.keys(request.query).some((key) => key !== 'q'))
      throw new ApiError(422, 'invalid_geocoding_query', 'Invalid request');
    reply.header('Cache-Control', 'no-store');
    return service.search(admin.id, request.query.q ?? '');
  });
}
