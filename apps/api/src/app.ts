import { randomUUID } from 'node:crypto';
import fastify, { LogController, type FastifyInstance } from 'fastify';
import { handleError, sanitizedError } from './errors.js';
import { registerHealth, type ReadinessProbe } from './health.js';
import { registerSanitizedLogging } from './logging.js';

export interface AppOptions {
  readinessProbe: ReadinessProbe;
  logLevel?: 'silent' | 'info';
}

export function createApp(options: AppOptions): FastifyInstance {
  const app = fastify({
    logger: options.logLevel === 'silent' ? false : { level: 'info' },
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    bodyLimit: 64 * 1024,
  });
  registerSanitizedLogging(app);
  registerHealth(app, options.readinessProbe);
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send(sanitizedError('not_found', 'Not found', request.id));
  });
  app.setErrorHandler(handleError);
  return app;
}
