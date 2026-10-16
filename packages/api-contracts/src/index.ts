export * from './identity.js';

export const healthSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string', enum: ['ok', 'unavailable'] } },
} as const;

export const adminErrorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message', 'request_id'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        request_id: { type: 'string' },
      },
    },
  },
} as const;
