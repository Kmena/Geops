import { adminErrorSchema, healthSchema } from '@geops/api-contracts';
import type { FastifyInstance } from 'fastify';
import { sanitizedError } from './errors.js';

export type ReadinessProbe = () => Promise<boolean>;

export function registerHealth(app: FastifyInstance, probe: ReadinessProbe): void {
  app.get(
    '/health/live',
    {
      schema: { response: { 200: healthSchema } },
    },
    async () => ({ status: 'ok' }),
  );

  app.get(
    '/health/ready',
    {
      schema: { response: { 200: healthSchema, 503: adminErrorSchema } },
    },
    async (request, reply) => {
      let ready = false;
      try {
        ready = await probe();
      } catch {
        ready = false;
      }
      if (!ready) {
        return reply
          .code(503)
          .send(sanitizedError('dependency_unavailable', 'Service unavailable', request.id));
      }
      return { status: 'ok' };
    },
  );
}
