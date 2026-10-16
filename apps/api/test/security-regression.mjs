import { Writable } from 'node:stream';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { AdminAuthService } from '../dist/admin-auth/service.js';
import { createApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';
import { applyMigrations, checkReadiness } from '../dist/db/migration-manager.js';
import { createPool } from '../dist/db/pool.js';
import { DeviceRepository } from '../dist/device-identity/repository.js';
import { FakeMdmProvider } from '../dist/mdm/provider.js';

async function main() {
  const name = process.env.GEOPS_TEST_DB;
  if (!/^geops_verify_[0-9]+$/.test(name ?? '')) throw new Error('Invalid synthetic test DB');
  const config = loadConfig(process.env);
  const url = new URL(config.databaseUrl);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  let now = Date.now();
  const auth = new AdminAuthService(pool, {
    sessionKey: config.adminSessionKey,
    csrfKey: config.adminCsrfKey,
    allowedOrigins: config.allowedOrigins,
    now: () => new Date(now),
  });
  const app = createApp({
    readinessProbe: () => checkReadiness(pool),
    logLevel: 'silent',
    adminAuth: auth,
    devices: new DeviceRepository(pool),
    mdm: new FakeMdmProvider(),
    secureCookie: true,
  });
  try {
    await applyMigrations(pool);
    const password = randomBytes(24).toString('base64url');
    await auth.bootstrap('security@example.test', password);
    const sessionA = await auth.login('security@example.test', password, '192.0.2.1', randomUUID());
    const sessionB = await auth.login('security@example.test', password, '192.0.2.2', randomUUID());
    assert.notEqual(sessionA.csrfToken, sessionB.csrfToken);
    const origin = 'http://localhost:3501';
    const secretMarker = randomBytes(24).toString('base64url');
    app.get('/synthetic-error', async () => {
      throw new Error(secretMarker);
    });
    const post = (headers, payload = { display_label: 'Synthetic' }) =>
      app.inject({
        method: 'POST',
        url: '/v1/admin/devices',
        headers: { 'content-type': 'application/json', ...headers },
        payload: JSON.stringify(payload),
      });
    const cookie = `geops_admin=${sessionA.token}`;
    assert.equal(
      (await post({ origin, cookie, 'x-csrf-token': sessionB.csrfToken })).statusCode,
      403,
    );
    assert.equal(
      (
        await post({
          origin: 'http://foreign.example.test',
          cookie,
          'x-csrf-token': sessionA.csrfToken,
        })
      ).statusCode,
      403,
    );
    assert.equal((await post({ cookie, 'x-csrf-token': sessionA.csrfToken })).statusCode, 403);
    assert.equal(
      (await post({ origin, cookie, 'x-csrf-token': sessionA.csrfToken })).statusCode,
      201,
    );
    const login = await app.inject({
      method: 'POST',
      url: '/v1/admin/auth/sessions',
      headers: { origin, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'security@example.test', password }),
    });
    assert.equal(login.statusCode, 200);
    assert.match(login.headers['set-cookie'], /; Secure/);
    assert.match(login.headers['set-cookie'], /; HttpOnly/);
    assert.ok(!login.body.includes(password));
    const failure = await app.inject({ method: 'GET', url: '/synthetic-error' });
    assert.equal(failure.statusCode, 500);
    assert.ok(!failure.body.includes(secretMarker));
    assert.ok(!failure.body.includes(password));
    const logParts = [];
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logParts.push(Buffer.from(chunk).toString('utf8'));
        callback();
      },
    });
    const logged = createApp({
      readinessProbe: () => checkReadiness(pool),
      logLevel: 'info',
      logStream,
    });
    logged.post('/synthetic-log-check', async () => {
      throw new Error(secretMarker);
    });
    const loggedFailure = await logged.inject({
      method: 'POST',
      url: '/synthetic-log-check',
      headers: { authorization: `Bearer ${secretMarker}`, cookie: `synthetic=${secretMarker}` },
      payload: { secret: secretMarker },
    });
    assert.equal(loggedFailure.statusCode, 500);
    await logged.close();
    const output = logParts.join('');
    assert.ok(output.includes('internal_error'));
    assert.ok(!output.includes(secretMarker));
    assert.ok(!output.includes(password));
    now += 30 * 60_000;
    await assert.rejects(auth.authenticate(sessionA.token), { code: 'unauthorized' });
    now += 1;
    const sessionC = await auth.login('security@example.test', password, '192.0.2.3', randomUUID());
    now += 29 * 60_000;
    assert.equal((await auth.authenticate(sessionC.token)).sessionId, sessionC.sessionId);
    now += 30 * 60_000;
    await assert.rejects(auth.authenticate(sessionC.token), { code: 'unauthorized' });
    now += 1;
    const sessionD = await auth.login('security@example.test', password, '192.0.2.4', randomUUID());
    const issuedD = now;
    for (let elapsed = 29; elapsed < 8 * 60; elapsed += 29) {
      now = issuedD + elapsed * 60_000;
      assert.equal((await auth.authenticate(sessionD.token)).sessionId, sessionD.sessionId);
    }
    const absolute = new Date(sessionD.expiresAt).getTime();
    now = absolute;
    await assert.rejects(auth.authenticate(sessionD.token), { code: 'unauthorized' });
    process.stdout.write(
      'GEOPS security regression: PASS session idle/absolute, session CSRF isolation, Origin, Secure cookie, sanitized 500\n',
    );
  } finally {
    await app.close();
  }
}

main().catch(() => {
  process.stderr.write('GEOPS security regression failed; details withheld\n');
  process.exitCode = 1;
});
