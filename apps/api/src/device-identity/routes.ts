import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireAdmin } from '../admin-auth/routes.js';
import type { AdminAuthService } from '../admin-auth/service.js';
import { ApiError } from '../errors.js';
import type { EnrollmentService } from './enrollment.js';
import type { DeviceLifecycleService } from './lifecycle.js';
import { exactBody } from './raw-body.js';
import type { DeviceSessionService } from './session.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'invalid_request', 'Invalid request', true);
  }
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((name) => !allowed.includes(name))) {
    throw new ApiError(400, 'invalid_request', 'Invalid request', true);
  }
  return data;
}

function string(data: Record<string, unknown>, name: string, max = 2048): string {
  const value = data[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new ApiError(400, 'invalid_request', 'Invalid request', true);
  }
  return value;
}

function uuid(value: string): string {
  if (!UUID.test(value)) throw new ApiError(400, 'invalid_id', 'Invalid request', true);
  return value;
}

class LocalLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();
  check(request: FastifyRequest, action: string): void {
    const key = `${request.ip}:${action}`;
    const now = Date.now();
    const current = this.attempts.get(key);
    const record =
      !current || current.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : current;
    record.count++;
    this.attempts.set(key, record);
    if (record.count > 20) throw new ApiError(429, 'rate_limited', 'Try again later', true);
  }
}

export function registerIdentityRoutes(
  app: FastifyInstance,
  auth: AdminAuthService,
  enrollment: EnrollmentService,
  sessions: DeviceSessionService,
  lifecycle: DeviceLifecycleService,
): void {
  const limiter = new LocalLimiter();

  app.post<{ Params: { device_id: string }; Body: unknown }>(
    '/v1/admin/devices/:device_id/invitations',
    async (request, reply) => {
      const admin = await requireAdmin(request, auth, true);
      const data = object(request.body, ['mdm_binding_id', 'delivery_mode']);
      const result = await enrollment.issueInvitation(
        uuid(request.params.device_id),
        uuid(string(data, 'mdm_binding_id')),
        string(data, 'delivery_mode'),
        admin.id,
        request.id,
      );
      reply.code(201);
      return result;
    },
  );

  app.delete<{ Params: { device_id: string; invitation_id: string } }>(
    '/v1/admin/devices/:device_id/invitations/:invitation_id',
    async (request) => {
      const admin = await requireAdmin(request, auth, true);
      return enrollment.cancelInvitation(
        uuid(request.params.device_id),
        uuid(request.params.invitation_id),
        admin.id,
        request.id,
      );
    },
  );

  app.post<{ Body: unknown }>('/v1/device/enrollment/claims', async (request, reply) => {
    limiter.check(request, 'claim');
    const data = object(request.body, [
      'invitation_id',
      'invitation_secret',
      'geops_device_id',
      'mdm_device_id',
      'public_key_spki',
      'client_nonce',
    ]);
    const result = await enrollment.claim(
      {
        invitation_id: uuid(string(data, 'invitation_id')),
        invitation_secret: string(data, 'invitation_secret'),
        geops_device_id: uuid(string(data, 'geops_device_id')),
        mdm_device_id: string(data, 'mdm_device_id'),
        public_key_spki: string(data, 'public_key_spki'),
        client_nonce: string(data, 'client_nonce'),
      },
      request.id,
    );
    reply.code(201);
    return result;
  });

  app.post<{ Params: { claim_id: string }; Body: unknown }>(
    '/v1/device/enrollment/claims/:claim_id/proof',
    async (request) => {
      limiter.check(request, 'proof');
      const data = object(request.body, ['challenge_id', 'signature', 'attestation_chain']);
      const chain = data.attestation_chain;
      if (
        chain !== undefined &&
        (!Array.isArray(chain) || chain.some((part) => typeof part !== 'string'))
      ) {
        throw new ApiError(400, 'invalid_request', 'Invalid request', true);
      }
      return enrollment.prove(
        uuid(request.params.claim_id),
        uuid(string(data, 'challenge_id')),
        string(data, 'signature'),
        chain as string[] | undefined,
        request.id,
      );
    },
  );

  app.post<{ Params: { device_id: string }; Body: unknown }>(
    '/v1/admin/devices/:device_id/synthetic-evidence',
    async (request) => {
      const admin = await requireAdmin(request, auth, true);
      const data = object(request.body, [
        'claim_id',
        'physical_confirmed',
        'attestation_exception',
      ]);
      if (data.physical_confirmed !== true || typeof data.attestation_exception !== 'boolean') {
        throw new ApiError(403, 'physical_confirmation_required', 'Forbidden', true);
      }
      const id = await enrollment.recordSyntheticEvidence(
        uuid(string(data, 'claim_id')),
        uuid(request.params.device_id),
        admin.id,
        true,
        data.attestation_exception,
        request.id,
      );
      return { evidence_ref: id, source: 'fake' };
    },
  );

  app.post<{ Params: { device_id: string }; Body: unknown }>(
    '/v1/admin/devices/:device_id/activate',
    async (request) => {
      const admin = await requireAdmin(request, auth, true);
      const data = object(request.body, [
        'claim_id',
        'pairing_code',
        'mdm_verification_method',
        'evidence_ref',
      ]);
      return enrollment.activate(
        uuid(request.params.device_id),
        uuid(string(data, 'claim_id')),
        string(data, 'pairing_code'),
        string(data, 'mdm_verification_method'),
        uuid(string(data, 'evidence_ref')),
        admin.id,
        request.id,
      );
    },
  );

  app.post<{ Body: unknown }>('/v1/device/sessions/challenge', async (request) => {
    limiter.check(request, 'session-challenge');
    const data = object(request.body, ['geops_device_id', 'key_id']);
    return sessions.challenge(uuid(string(data, 'geops_device_id')), uuid(string(data, 'key_id')));
  });

  app.post<{ Body: unknown }>('/v1/device/sessions', async (request, reply) => {
    limiter.check(request, 'session');
    const data = object(request.body, ['geops_device_id', 'key_id', 'challenge_id', 'signature']);
    const result = await sessions.create(
      uuid(string(data, 'geops_device_id')),
      uuid(string(data, 'key_id')),
      uuid(string(data, 'challenge_id')),
      string(data, 'signature'),
    );
    reply.code(201);
    return result;
  });

  app.post('/v1/device/keys/rotate/challenge', async (request) => {
    const principal = await sessions.verifyRequest(request, exactBody(request));
    return lifecycle.rotationChallenge(principal);
  });

  app.post<{ Body: unknown }>('/v1/device/keys/rotate', async (request) => {
    const principal = await sessions.verifyRequest(request, exactBody(request));
    const data = object(request.body, [
      'challenge_id',
      'new_public_key_spki',
      'old_signature',
      'new_signature',
      'attestation_chain',
    ]);
    const chain = data.attestation_chain;
    if (
      chain !== undefined &&
      (!Array.isArray(chain) || chain.some((part) => typeof part !== 'string'))
    ) {
      throw new ApiError(400, 'invalid_request', 'Invalid request', true);
    }
    return lifecycle.rotate(
      principal,
      {
        challenge_id: uuid(string(data, 'challenge_id')),
        new_public_key_spki: string(data, 'new_public_key_spki'),
        old_signature: string(data, 'old_signature'),
        new_signature: string(data, 'new_signature'),
        ...(chain ? { attestation_chain: chain as string[] } : {}),
      },
      request.id,
    );
  });

  app.post<{ Params: { device_id: string }; Body: unknown }>(
    '/v1/admin/devices/:device_id/revoke',
    async (request) => {
      const admin = await requireAdmin(request, auth, true);
      const data = object(request.body, ['reason']);
      const reason = string(data, 'reason', 240).trim();
      if (reason.length < 8) throw new ApiError(400, 'invalid_request', 'Invalid request', true);
      await lifecycle.revoke(uuid(request.params.device_id), admin.id, request.id, reason);
      return { status: 'REVOKED' };
    },
  );
  for (const action of ['suspend', 'reactivate', 'retire'] as const) {
    app.post<{ Params: { device_id: string }; Body: unknown }>(
      `/v1/admin/devices/:device_id/${action}`,
      async (request) => {
        const admin = await requireAdmin(request, auth, true);
        const data = object(request.body, ['reason']);
        const reason = string(data, 'reason', 240).trim();
        if (reason.length < 8) throw new ApiError(400, 'reason_required', 'Invalid request', true);
        const deviceId = uuid(request.params.device_id);
        await lifecycle[action](deviceId, admin.id, request.id, reason);
        return {
          status: { suspend: 'SUSPENDED', reactivate: 'ACTIVE', retire: 'RETIRED' }[action],
        };
      },
    );
  }
}
