import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import type { AdminAuthService, AdminIdentity } from './service.js';

function cookieToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const pair = header
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith('geops_admin='));
  return pair?.slice('geops_admin='.length);
}

function csrfHeader(request: FastifyRequest): string | undefined {
  const header = request.headers['x-csrf-token'];
  return typeof header === 'string' ? header : undefined;
}

export async function requireAdmin(
  request: FastifyRequest,
  auth: AdminAuthService,
  mutation = false,
): Promise<AdminIdentity> {
  const identity = await auth.authenticate(cookieToken(request.headers.cookie));
  if (mutation) {
    if (!auth.isAllowedOrigin(request.headers.origin))
      throw new ApiError(403, 'origin_rejected', 'Forbidden');
    auth.assertCsrf(identity, csrfHeader(request));
  }
  return identity;
}

export function registerAdminRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  secureCookie: boolean,
): void {
  app.post<{ Body: { email: string; password: string } }>(
    '/v1/admin/auth/sessions',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', maxLength: 254 },
            password: { type: 'string', minLength: 1, maxLength: 1024 },
          },
        },
      },
    },
    async (request, reply) => {
      if (!auth.isAllowedOrigin(request.headers.origin))
        throw new ApiError(403, 'origin_rejected', 'Forbidden');
      const session = await auth.login(
        request.body.email,
        request.body.password,
        request.ip,
        request.id,
      );
      const flags = `; Path=/; HttpOnly; SameSite=Lax${secureCookie ? '; Secure' : ''}`;
      reply.header('set-cookie', `geops_admin=${session.token}${flags}`);
      return { admin_id: session.id, csrf_token: session.csrfToken, expires_at: session.expiresAt };
    },
  );

  app.get('/v1/admin/auth/me', async (request) => {
    const identity = await requireAdmin(request, auth);
    return { id: identity.id, email: identity.email, csrf_token: identity.csrfToken };
  });

  app.delete('/v1/admin/auth/sessions/current', async (request, reply) => {
    const identity = await requireAdmin(request, auth, true);
    await auth.logout(identity, request.id);
    reply.header(
      'set-cookie',
      `geops_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookie ? '; Secure' : ''}`,
    );
    reply.code(204).send();
  });
}
