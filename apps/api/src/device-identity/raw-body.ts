import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';

const bodies = new WeakMap<FastifyRequest, Buffer>();

export function exactBody(request: FastifyRequest): Buffer {
  return bodies.get(request) ?? Buffer.alloc(0);
}

export function registerDeviceBodyCapture(app: FastifyInstance): void {
  app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/v1/device/') && request.url.includes('?')) {
      throw new ApiError(400, 'query_rejected', 'Invalid request', true);
    }
  });
  app.addHook('preParsing', (request, _reply, payload, done) => {
    if (!request.url.startsWith('/v1/device/') && !request.url.startsWith('/v1/admin/gps-')) {
      done(null, payload);
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    let failed = false;
    payload.on('data', (piece: Buffer) => {
      if (failed) return;
      length += piece.length;
      const limit =
        request.url === '/v1/device/locations/batches'
          ? 256 * 1024
          : request.url === '/v1/device/health/batches' ||
              request.url === '/v1/device/gps-session-events/batches'
            ? 128 * 1024
            : 64 * 1024;
      if (length > limit) {
        failed = true;
        payload.pause();
        done(new ApiError(413, 'batch_too_large', 'Request too large', true));
      } else chunks.push(Buffer.from(piece));
    });
    payload.on('error', (error) => {
      if (!failed) {
        failed = true;
        done(error);
      }
    });
    payload.on('end', () => {
      if (failed) return;
      const body = Buffer.concat(chunks);
      bodies.set(request, body);
      const replay = Readable.from(body.length ? [body] : []);
      Object.assign(replay, { receivedEncodedLength: body.length });
      done(null, replay);
    });
  });
}
