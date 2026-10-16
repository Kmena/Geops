import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly identity = false,
  ) {
    super(message);
  }
}

export function sanitizedError(
  code: string,
  message: string,
  requestId: string,
): { error: { code: string; message: string; request_id: string } } {
  return { error: { code, message, request_id: requestId } };
}

export function handleError(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const known = error instanceof ApiError;
  const status = known ? error.statusCode : error.validation ? 400 : 500;
  const code = known ? error.code : status === 400 ? 'invalid_request' : 'internal_error';
  const message = known ? error.message : status === 400 ? 'Invalid request' : 'Internal error';
  request.log.error({ request_id: request.id, code, status }, 'Request failed');
  if (known && error.identity) {
    reply.code(status).send({ code, correlation_id: request.id });
    return;
  }
  reply.code(status).send(sanitizedError(code, message, request.id));
}
