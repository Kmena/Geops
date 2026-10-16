import type { FastifyInstance, FastifyRequest } from 'fastify';

const started = new WeakMap<FastifyRequest, bigint>();
const metrics = new Map<string, number>();

export function failureMetrics(): Readonly<Record<string, number>> {
  return Object.fromEntries(metrics);
}

export function registerSanitizedLogging(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    started.set(request, process.hrtime.bigint());
    reply.header('x-request-id', request.id);
  });
  app.addHook('onResponse', async (request, reply) => {
    const begin = started.get(request);
    const durationMs = begin ? Number(process.hrtime.bigint() - begin) / 1_000_000 : 0;
    const route = request.routeOptions.url ?? 'unmatched';
    const category =
      reply.statusCode >= 500
        ? 'server_error'
        : reply.statusCode >= 400
          ? 'client_error'
          : 'success';
    const key = `${request.method} ${route} ${category}`;
    metrics.set(key, (metrics.get(key) ?? 0) + 1);
    request.log.info(
      {
        request_id: request.id,
        method: request.method,
        route,
        status: reply.statusCode,
        duration_ms: Math.round(durationMs * 100) / 100,
      },
      'HTTP request completed',
    );
  });
}
