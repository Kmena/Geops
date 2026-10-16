import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

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
  const status = error.validation ? 400 : 500;
  request.log.error({ request_id: request.id, code: 'request_failed', status }, 'Request failed');
  reply
    .code(status)
    .send(
      sanitizedError(
        status === 400 ? 'invalid_request' : 'internal_error',
        status === 400 ? 'Invalid request' : 'Internal error',
        request.id,
      ),
    );
}
