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
    if (!request.url.startsWith('/v1/device/')) {
      done(null, payload);
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    payload.on('data', (piece: Buffer) => {
      length += piece.length;
      if (length > 64 * 1024) payload.destroy(new Error('Body too large'));
      else chunks.push(Buffer.from(piece));
    });
    payload.on('error', (error) => done(error));
    payload.on('end', () => {
      const body = Buffer.concat(chunks);
      bodies.set(request, body);
      const replay = Readable.from(body.length ? [body] : []);
      Object.assign(replay, { receivedEncodedLength: body.length });
      done(null, replay);
    });
  });
}
