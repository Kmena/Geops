import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync, randomUUID } from 'node:crypto';
import { createApp } from '../app.mjs';
import { ENV_ID, POCError, secret } from '../validation.mjs';

const ORIGIN = 'http://127.0.0.1:3601';
const salt = randomBytes(16);
const passwordHash =
  salt.toString('hex') + ':' + scryptSync('synthetic-password-only', salt, 64).toString('hex');
class MemoryStore {
  constructor() {
    this.invite = null;
    this.devicesMap = new Map();
    this.events = new Map();
    this.fail = false;
  }
  async health() {}
  async issueInvitation() {
    this.invite = {
      environment_id: ENV_ID,
      invitation_id: randomUUID(),
      invitation_secret: secret(),
      expires_at: new Date(Date.now() + 600_000),
    };
    return this.invite;
  }
  async enroll(input) {
    if (
      !this.invite ||
      input.invitation_id !== this.invite.invitation_id ||
      input.invitation_secret !== this.invite.invitation_secret
    )
      throw new POCError(401, 'invalid_invitation');
    if (this.invite.used) throw new POCError(409, 'invitation_used');
    if (new Date(this.invite.expires_at).getTime() < Date.now())
      throw new POCError(410, 'invitation_expired');
    if ([...this.devicesMap.values()].some((d) => !d.revoked_at))
      throw new POCError(409, 'device_limit');
    this.invite.used = true;
    const device = { id: randomUUID(), token: secret(), revoked_at: null };
    this.devicesMap.set(device.id, device);
    return { environment_id: ENV_ID, device_id: device.id, device_token: device.token };
  }
  async deviceForToken(token) {
    return [...this.devicesMap.values()].find((d) => d.token === token) ?? null;
  }
  async devices() {
    return [...this.devicesMap.values()].map((d) => ({ id: d.id, revoked_at: d.revoked_at }));
  }
  async revoke(id) {
    const device = this.devicesMap.get(id);
    if (!device) throw new POCError(404, 'device_not_found');
    device.revoked_at = new Date();
    return { status: 'revoked' };
  }
  async ingest(deviceId, batch) {
    if (this.fail) {
      this.fail = false;
      throw new Error('synthetic database failure');
    }
    const accepted_event_ids = [],
      duplicate_event_ids = [];
    const next = new Map(this.events);
    for (const event of batch.events) {
      const key = deviceId + ':' + event.event_id;
      if (next.has(key)) {
        if (next.get(key).digest !== event.digest) throw new POCError(409, 'event_conflict');
        duplicate_event_ids.push(event.event_id);
      } else {
        next.set(key, { ...event, received_at: new Date().toISOString() });
        accepted_event_ids.push(event.event_id);
      }
    }
    this.events = next;
    return {
      batch_id: batch.batch_id,
      accepted_event_ids,
      duplicate_event_ids,
      persisted_at: new Date().toISOString(),
    };
  }
  async latest(id) {
    return [...this.events.values()].filter((e) => e.device_id === id).at(-1) ?? null;
  }
  async history() {
    return [...this.events.values()].sort((a, b) => a.captured_at.localeCompare(b.captured_at));
  }
  async metrics() {
    return { location_count: this.events.size };
  }
  async purge(hours) {
    const limit = Date.now() - hours * 3_600_000;
    let count = 0;
    for (const [key, event] of this.events)
      if (Date.parse(event.received_at) < limit) {
        this.events.delete(key);
        count++;
      }
    return count;
  }
}
function fresh(captureEnabled = true, enrollmentAudit = () => {}) {
  const store = new MemoryStore();
  const app = createApp({
    store,
    origin: ORIGIN,
    passwordHash,
    secureCookie: false,
    captureEnabled,
    enrollmentAudit,
  });
  return { store, app };
}
async function admin(app) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/login',
    headers: { origin: ORIGIN },
    payload: { password: 'synthetic-password-only' },
  });
  assert.equal(response.statusCode, 200);
  return { cookie: response.headers['set-cookie'].split(';')[0], csrf: response.json().csrf };
}
async function enrolled(app) {
  const auth = await admin(app);
  const invite = await app.inject({
    method: 'POST',
    url: '/api/admin/invitations',
    headers: { origin: ORIGIN, cookie: auth.cookie, 'x-poc-csrf': auth.csrf },
  });
  assert.equal(invite.statusCode, 200);
  const { environment_id, invitation_id, invitation_secret } = invite.json();
  const result = await app.inject({
    method: 'POST',
    url: '/api/device/enroll',
    payload: { environment_id, invitation_id, invitation_secret },
  });
  assert.equal(result.statusCode, 201);
  return {
    auth,
    invitation: { environment_id, invitation_id, invitation_secret },
    device: result.json(),
  };
}
const event = (at = Date.now()) => ({
  event_id: randomUUID(),
  captured_at: new Date(at).toISOString(),
  latitude: 0.01,
  longitude: 0.02,
  accuracy_m: 12.5,
});
const batch = (events) => ({ schema_version: 1, batch_id: randomUUID(), events });

test('inscripción válida; QR de entorno y token individual', async () => {
  const { app } = fresh();
  try {
    const result = await enrolled(app);
    assert.equal(result.device.environment_id, ENV_ID);
    assert.equal(result.device.device_token.length, 43);
    const status = await app.inject({
      method: 'GET',
      url: '/api/device/status',
      headers: { authorization: 'Bearer ' + result.device.device_token },
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().capture_enabled, true);
  } finally {
    await app.close();
  }
});
test('invitación expirada y reutilizada se rechazan', async () => {
  const { app, store } = fresh();
  try {
    const auth = await admin(app);
    const first = await app.inject({
      method: 'POST',
      url: '/api/admin/invitations',
      headers: { origin: ORIGIN, cookie: auth.cookie, 'x-poc-csrf': auth.csrf },
    });
    const { environment_id, invitation_id, invitation_secret } = first.json();
    const invitation = { environment_id, invitation_id, invitation_secret };
    store.invite.expires_at = new Date(Date.now() - 1);
    let response = await app.inject({
      method: 'POST',
      url: '/api/device/enroll',
      payload: invitation,
    });
    assert.equal(response.statusCode, 410);
    store.invite.expires_at = new Date(Date.now() + 60_000);
    response = await app.inject({ method: 'POST', url: '/api/device/enroll', payload: invitation });
    assert.equal(response.statusCode, 201);
    response = await app.inject({ method: 'POST', url: '/api/device/enroll', payload: invitation });
    assert.equal(response.statusCode, 409);
  } finally {
    await app.close();
  }
});
test('token inválido, revocación y límite de un dispositivo', async () => {
  const { app } = fresh();
  try {
    const { auth, device } = await enrolled(app);
    const url = '/api/device/locations/batches';
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { authorization: 'Bearer ' + secret() },
          payload: batch([event()]),
        })
      ).statusCode,
      401,
    );
    const revoke = await app.inject({
      method: 'POST',
      url: '/api/admin/devices/' + device.device_id + '/revoke',
      headers: { origin: ORIGIN, cookie: auth.cookie, 'x-poc-csrf': auth.csrf },
    });
    assert.equal(revoke.statusCode, 200);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { authorization: 'Bearer ' + device.device_token },
          payload: batch([event()]),
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});
test('coordenada inválida no persiste; duplicado y fuera de orden sí', async () => {
  const { app, store } = fresh();
  try {
    const { device } = await enrolled(app);
    const url = '/api/device/locations/batches';
    const headers = { authorization: 'Bearer ' + device.device_token };
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: batch([{ ...event(), latitude: 91 }]),
        })
      ).statusCode,
      422,
    );
    assert.equal(store.events.size, 0);
    const later = event(),
      earlier = event(Date.now() - 60_000);
    const request = batch([later, earlier]);
    let response = await app.inject({ method: 'POST', url, headers, payload: request });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().accepted_event_ids.length, 2);
    response = await app.inject({ method: 'POST', url, headers, payload: request });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().duplicate_event_ids.length, 2);
    assert.equal(store.events.size, 2);
    response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: batch([{ ...earlier, longitude: -80 }]),
    });
    assert.equal(response.statusCode, 409);
    assert.equal(store.events.size, 2);
  } finally {
    await app.close();
  }
});
test('fallo de persistencia no confirma; reintento conserva ID', async () => {
  const { app, store } = fresh();
  try {
    const { device } = await enrolled(app);
    const request = batch([event()]);
    const headers = { authorization: 'Bearer ' + device.device_token };
    store.fail = true;
    const first = await app.inject({
      method: 'POST',
      url: '/api/device/locations/batches',
      headers,
      payload: request,
    });
    assert.equal(first.statusCode, 500);
    assert.equal(store.events.size, 0);
    assert.ok(!JSON.stringify(first.json()).includes(device.device_token));
    const second = await app.inject({
      method: 'POST',
      url: '/api/device/locations/batches',
      headers,
      payload: request,
    });
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json().accepted_event_ids, [request.events[0].event_id]);
  } finally {
    await app.close();
  }
});
test('retención, mapa no autorizado, Origin/CSRF y captura deshabilitada', async () => {
  const { app, store } = fresh(false);
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/devices' })).statusCode, 401);
    const { auth, device } = await enrolled(app);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/admin/invitations',
          headers: { cookie: auth.cookie, origin: ORIGIN },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/device/locations/batches',
          headers: { authorization: 'Bearer ' + device.device_token },
          payload: batch([event()]),
        })
      ).statusCode,
      403,
    );
    store.events.set('old', { received_at: new Date(Date.now() - 4 * 3_600_000).toISOString() });
    assert.equal(await store.purge(3), 1);
  } finally {
    await app.close();
  }
});

test('JSON malformado y respuestas sensibles se sanitizan y no se cachean', async () => {
  const { app } = fresh();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/device/enroll',
      headers: { 'content-type': 'application/json' },
      payload: '{"broken":',
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'invalid_json');
    assert.equal(response.headers['cache-control'], 'no-store');
    const login = await app.inject({
      method: 'POST',
      url: '/api/admin/login',
      payload: { password: 'synthetic-password-only' },
    });
    assert.equal(login.statusCode, 403);
    assert.equal(login.headers['cache-control'], 'no-store');
  } finally {
    await app.close();
  }
});

test('límite de lote, tiempo y cuerpo grande se rechazan sin persistencia', async () => {
  const { app, store } = fresh();
  try {
    const { device } = await enrolled(app);
    const headers = { authorization: 'Bearer ' + device.device_token };
    const url = '/api/device/locations/batches';
    const tooMany = Array.from({ length: 51 }, () => event());
    assert.equal(
      (await app.inject({ method: 'POST', url, headers, payload: batch(tooMany) })).statusCode,
      422,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: batch([event(Date.now() + 10 * 60_000)]),
        })
      ).statusCode,
      422,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: JSON.stringify({ padding: 'x'.repeat(70_000) }),
        })
      ).statusCode,
      413,
    );
    assert.equal(store.events.size, 0);
  } finally {
    await app.close();
  }
});

test('contrato QR y POST de inscripción coincide con Android', async () => {
  const { app } = fresh(false);
  try {
    const auth = await admin(app);
    const invitation = await app.inject({
      method: 'POST',
      url: '/api/admin/invitations',
      headers: { origin: ORIGIN, cookie: auth.cookie, 'x-poc-csrf': auth.csrf },
    });
    assert.equal(invitation.statusCode, 200);
    const qr = JSON.parse(invitation.json().qr_payload);
    assert.deepEqual(Object.keys(qr).sort(), [
      'api_base',
      'environment_id',
      'invitation_id',
      'invitation_secret',
    ]);
    assert.equal(qr.api_base, ORIGIN);
    assert.equal(qr.environment_id, ENV_ID);
    const body = {
      environment_id: qr.environment_id,
      invitation_id: qr.invitation_id,
      invitation_secret: qr.invitation_secret,
    };
    const result = await app.inject({
      method: 'POST',
      url: '/api/device/enroll',
      headers: { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' },
      payload: body,
    });
    assert.equal(result.statusCode, 201);
    assert.deepEqual(Object.keys(result.json()).sort(), [
      'device_id',
      'device_token',
      'environment_id',
    ]);
    assert.equal(result.json().environment_id, ENV_ID);
    assert.equal(result.json().device_token.length, 43);
    const reused = await app.inject({ method: 'POST', url: '/api/device/enroll', payload: body });
    assert.equal(reused.statusCode, 409);
    assert.equal(reused.json().error, 'invitation_used');
    assert.ok(!reused.body.includes(qr.invitation_secret));
  } finally {
    await app.close();
  }
});

test('trazas de inscripción incluyen solo evento, request_id y HTTP', async () => {
  const entries = [];
  const { app } = fresh(false, (entry) => entries.push(entry));
  try {
    const auth = await admin(app);
    const invite = await app.inject({
      method: 'POST',
      url: '/api/admin/invitations',
      headers: { origin: ORIGIN, cookie: auth.cookie, 'x-poc-csrf': auth.csrf },
    });
    const qr = JSON.parse(invite.json().qr_payload);
    const response = await app.inject({
      method: 'POST',
      url: '/api/device/enroll',
      payload: {
        environment_id: qr.environment_id,
        invitation_id: qr.invitation_id,
        invitation_secret: qr.invitation_secret,
      },
    });
    assert.equal(response.statusCode, 201);
    assert.deepEqual(
      entries.map((entry) => entry.event),
      ['enrollment_request_started', 'enrollment_response'],
    );
    assert.equal(entries[1].status, 201);
    assert.deepEqual(Object.keys(entries[1]).sort(), ['event', 'request_id', 'status']);
    assert.ok(!JSON.stringify(entries).includes(qr.invitation_secret));
    assert.ok(!JSON.stringify(entries).includes(response.json().device_token));
  } finally {
    await app.close();
  }
});

test('GET de estado autentica sin posiciones y sobrevive a reinicio de API con store persistente', async () => {
  const { app, store } = fresh(false);
  let restarted;
  try {
    const { auth, device } = await enrolled(app);
    const headers = { authorization: 'Bearer ' + device.device_token };
    const first = await app.inject({ method: 'GET', url: '/api/device/status', headers });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), {
      environment_id: ENV_ID,
      device_id: device.device_id,
      capture_enabled: false,
    });
    assert.equal(store.events.size, 0);
    assert.equal((await app.inject({ method: 'GET', url: '/api/device/status' })).statusCode, 401);
    await app.close();
    restarted = createApp({ store, origin: ORIGIN, passwordHash, secureCookie: false });
    const afterRestart = await restarted.inject({
      method: 'GET',
      url: '/api/device/status',
      headers,
    });
    assert.equal(afterRestart.statusCode, 200);
    assert.equal(afterRestart.json().device_id, device.device_id);
    assert.equal(store.events.size, 0);
    assert.equal(
      (
        await restarted.inject({
          method: 'GET',
          url: '/api/device/status',
          headers: { authorization: 'Bearer ' + secret() },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await restarted.inject({
          method: 'GET',
          url: '/api/admin/me',
          headers: { cookie: auth.cookie },
        })
      ).statusCode,
      401,
    );
    assert.ok(!afterRestart.body.includes(device.device_token));
    const nextAdmin = await admin(restarted);
    const revoked = await restarted.inject({
      method: 'POST',
      url: '/api/admin/devices/' + device.device_id + '/revoke',
      headers: { origin: ORIGIN, cookie: nextAdmin.cookie, 'x-poc-csrf': nextAdmin.csrf },
    });
    assert.equal(revoked.statusCode, 200);
    assert.equal(
      (await restarted.inject({ method: 'GET', url: '/api/device/status', headers })).statusCode,
      403,
    );
  } finally {
    if (restarted) await restarted.close();
    else await app.close();
  }
});
