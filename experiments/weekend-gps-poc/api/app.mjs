import Fastify from 'fastify';
import {
  ENV_ID,
  MAX_BODY,
  POCError,
  dateRange,
  secret,
  validId,
  validateBatch,
  validateEnrollment,
  verifyPassword,
} from './validation.mjs';

export function createApp({
  store,
  origin,
  passwordHash,
  retentionHours = 72,
  secureCookie = true,
  captureEnabled = false,
  enrollmentAudit = () => {},
}) {
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error('Invalid POC origin');
  }
  if (
    parsedOrigin.origin !== origin ||
    parsedOrigin.pathname !== '/' ||
    parsedOrigin.username ||
    parsedOrigin.password ||
    parsedOrigin.search ||
    parsedOrigin.hash ||
    !(parsedOrigin.protocol === 'https:' || (origin === 'http://127.0.0.1:3601' && !secureCookie))
  )
    throw new Error('Invalid POC origin');
  const app = Fastify({ logger: false, bodyLimit: MAX_BODY });
  app.addHook('onRequest', async (request) => {
    if (request.url === '/api/device/enroll')
      enrollmentAudit({ event: 'enrollment_request_started', request_id: request.id });
  });
  app.addHook('onResponse', async (request, reply) => {
    if (request.url === '/api/device/enroll')
      enrollmentAudit({
        event: 'enrollment_response',
        request_id: request.id,
        status: reply.statusCode,
      });
  });
  app.addHook('onSend', async (_request, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('Pragma', 'no-cache')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff');
  });
  const sessions = new Map();
  const attempts = new Map();
  const cookieName = 'poc_admin';
  const now = () => Date.now();
  function limit(key, max = 20) {
    const current = attempts.get(key);
    const entry = !current || current.until < now() ? { count: 0, until: now() + 60_000 } : current;
    entry.count++;
    attempts.set(key, entry);
    if (entry.count > max) throw new POCError(429, 'rate_limited');
  }
  function sameOrigin(request) {
    if (request.headers.origin !== origin) throw new POCError(403, 'invalid_origin');
  }
  function session(request, mutate = false) {
    const raw = request.headers.cookie ?? '';
    const match = raw.match(/(?:^|;\s*)poc_admin=([A-Za-z0-9_-]{43})(?:;|$)/);
    const entry = match && sessions.get(match[1]);
    if (!entry || entry.until <= now() || entry.lastUsed + 30 * 60_000 <= now())
      throw new POCError(401, 'unauthorized');
    entry.lastUsed = now();
    if (mutate) {
      sameOrigin(request);
      if (request.headers['x-poc-csrf'] !== entry.csrf) throw new POCError(403, 'invalid_csrf');
    }
    return entry;
  }
  async function device(request) {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header))
      throw new POCError(401, 'unauthorized');
    const found = await store.deviceForToken(header.slice(7));
    if (!found) throw new POCError(401, 'unauthorized');
    if (found.revoked_at) throw new POCError(403, 'device_revoked');
    return found;
  }
  function requireId(request) {
    if (!validId(request.params?.deviceId)) throw new POCError(400, 'invalid_device_id');
    return request.params.deviceId;
  }
  app.setErrorHandler((error, request, reply) => {
    const status =
      error instanceof POCError
        ? error.status
        : [400, 413, 429].includes(error.statusCode)
          ? error.statusCode
          : 500;
    const code =
      error instanceof POCError
        ? error.code
        : status === 413
          ? 'batch_too_large'
          : status === 400
            ? 'invalid_json'
            : status === 429
              ? 'rate_limited'
              : 'internal_error';
    reply.code(status).send({ error: code, request_id: request.id });
  });
  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    await store.health();
    return { status: 'ok' };
  });
  app.post('/api/admin/login', async (request, reply) => {
    sameOrigin(request);
    limit(request.ip + ':login', 5);
    if (
      !request.body ||
      typeof request.body.password !== 'string' ||
      request.body.password.length > 1024 ||
      !verifyPassword(request.body.password, passwordHash)
    )
      throw new POCError(401, 'invalid_login');
    const token = secret(),
      csrf = secret();
    sessions.set(token, { csrf, until: now() + 8 * 3_600_000, lastUsed: now() });
    reply.header(
      'Set-Cookie',
      cookieName +
        '=' +
        token +
        '; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=28800' +
        (secureCookie ? '; Secure' : ''),
    );
    return { csrf };
  });
  app.get('/api/admin/me', async (request) => ({
    csrf: session(request).csrf,
    environment_id: ENV_ID,
  }));
  app.post('/api/admin/logout', async (request, reply) => {
    session(request, true);
    const match = (request.headers.cookie ?? '').match(/poc_admin=([A-Za-z0-9_-]{43})/);
    if (match) sessions.delete(match[1]);
    reply.header(
      'Set-Cookie',
      cookieName +
        '=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0' +
        (secureCookie ? '; Secure' : ''),
    );
    return { status: 'signed_out' };
  });
  app.post('/api/admin/invitations', async (request) => {
    session(request, true);
    limit(request.ip + ':invite', 5);
    const invitation = await store.issueInvitation();
    return {
      ...invitation,
      qr_payload: JSON.stringify({
        api_base: origin,
        environment_id: ENV_ID,
        invitation_id: invitation.invitation_id,
        invitation_secret: invitation.invitation_secret,
      }),
    };
  });
  app.get('/api/admin/devices', async (request) => {
    session(request);
    return { items: await store.devices() };
  });
  app.post('/api/admin/devices/:deviceId/revoke', async (request) => {
    session(request, true);
    return store.revoke(requireId(request));
  });
  app.get('/api/admin/devices/:deviceId/latest', async (request) => {
    session(request);
    return { item: await store.latest(requireId(request)) };
  });
  app.get('/api/admin/devices/:deviceId/history', async (request) => {
    session(request);
    return {
      items: await store.history(
        requireId(request),
        dateRange(request.query, now(), retentionHours),
      ),
    };
  });
  app.get('/api/admin/devices/:deviceId/metrics', async (request) => {
    session(request);
    return store.metrics(requireId(request), dateRange(request.query, now(), retentionHours));
  });
  app.get('/api/admin/devices/:deviceId/sync-status', async (request) => {
    session(request);
    const item = await store.latest(requireId(request));
    return {
      last_received: item?.received_at ?? null,
      last_capture: item?.captured_at ?? null,
      communication: item && now() - Date.parse(item.received_at) < 180_000 ? 'recent' : 'unknown',
    };
  });
  app.post('/api/device/enroll', async (request, reply) => {
    limit(request.ip + ':enroll', 10);
    const result = await store.enroll(validateEnrollment(request.body));
    reply.code(201);
    return result;
  });
  app.get('/api/device/status', async (request) => {
    const found = await device(request);
    return { environment_id: ENV_ID, device_id: found.id, capture_enabled: captureEnabled };
  });
  app.post('/api/device/locations/batches', async (request) => {
    const found = await device(request);
    if (!captureEnabled) throw new POCError(403, 'capture_disabled');
    limit(found.id + ':ingest', 12);
    return store.ingest(found.id, validateBatch(request.body, now(), retentionHours));
  });
  return app;
}
