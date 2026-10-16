import type { FastifyInstance } from 'fastify';

export function registerSanitizedLogging(app: FastifyInstance): void {
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        request_id: request.id,
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        status: reply.statusCode,
      },
      'HTTP request completed',
    );
  });
}
