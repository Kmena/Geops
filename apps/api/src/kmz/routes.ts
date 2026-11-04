import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAdmin } from '../admin-auth/routes.js';
import type { AdminAuthService } from '../admin-auth/service.js';
import { ApiError } from '../errors.js';
import { HARD_LIMITS } from './parser.js';
import type { KmzService } from './service.js';

type Params = { id: string };
type RecordParams = { id: string; recordId: string };
type Query = Record<string, string | undefined>;
function header(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function registerKmzRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  service: KmzService,
): void {
  const actors = new WeakMap<FastifyRequest, string>();
  app.addContentTypeParser(
    ['application/vnd.google-earth.kmz', 'application/zip'],
    (_request, payload, done) => done(null, payload),
  );
  const read = async (request: FastifyRequest): Promise<string> => {
    const actor = await requireAdmin(request, auth);
    await service.authorize(actor.id, 'catalog.import.read', request.id);
    return actor.id;
  };
  const base = '/v1/admin/kmz-imports';
  app.route({
    method: 'POST',
    url: base,
    onRequest: async (request) => {
      const actor = await requireAdmin(request, auth, true);
      await service.authorize(actor.id, 'catalog.import.write', request.id);
      const length = Number(request.headers['content-length'] ?? 0);
      if (!Number.isFinite(length) || length > HARD_LIMITS.compressedBytes)
        throw new ApiError(413, 'file_too_large', 'File too large');
      actors.set(request, actor.id);
    },
    handler: async (request, reply) => {
      const actorId = actors.get(request);
      if (!actorId) throw new ApiError(401, 'unauthorized', 'Unauthorized');
      const content = request.headers['content-type']?.split(';')[0]?.toLowerCase();
      if (!content || !['application/vnd.google-earth.kmz', 'application/zip'].includes(content))
        throw new ApiError(415, 'unsupported_media_type', 'Unsupported media type');
      const review = header(request.headers['x-new-review']);
      if (review !== undefined && review !== 'true')
        throw new ApiError(422, 'invalid_request', 'Invalid request');
      const response = await service.upload(
        request.body as Readable,
        actorId,
        header(request.headers['idempotency-key']),
        header(request.headers['x-file-name']),
        review === 'true',
        request.id,
      );
      reply.header('cache-control', 'no-store');
      reply.code(response.status);
      return response.body;
    },
  });
  app.get<{ Querystring: Query }>(base, async (request, reply) => {
    const actorId = await read(request);
    reply.header('cache-control', 'no-store');
    return service.list(actorId, request.query);
  });
  app.get<{ Params: Params }>(`${base}/:id`, async (request, reply) => {
    const actorId = await read(request);
    reply.header('cache-control', 'no-store');
    const body = await service.status(actorId, request.params.id);
    reply.header('ETag', `"${body.import_id}:${body.state}"`);
    return body;
  });
  app.get<{ Params: Params }>(`${base}/:id/summary`, async (request, reply) => {
    const actorId = await read(request);
    reply.header('cache-control', 'no-store');
    const body = await service.status(actorId, request.params.id);
    return {
      import_id: body.import_id,
      state: body.state,
      summary: body.summary,
      record_count: body.record_count,
      errors: body.errors,
      warnings: body.warnings,
    };
  });
  app.get<{ Params: Params; Querystring: Query }>(`${base}/:id/records`, async (request, reply) => {
    const actorId = await read(request);
    reply.header('cache-control', 'no-store');
    return service.records(actorId, request.params.id, request.query);
  });
  app.get<{ Params: RecordParams }>(`${base}/:id/records/:recordId`, async (request, reply) => {
    const actorId = await read(request);
    reply.header('cache-control', 'no-store');
    return service.record(actorId, request.params.id, request.params.recordId);
  });
  app.get<{ Params: Params; Querystring: Query }>(
    `${base}/:id/diagnostics`,
    async (request, reply) => {
      const actorId = await read(request);
      reply.header('cache-control', 'no-store');
      return service.diagnostics(actorId, request.params.id, request.query);
    },
  );
}
