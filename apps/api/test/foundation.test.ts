import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

test('liveness succeeds and readiness fails closed without database', async () => {
  const app = createApp({ readinessProbe: async () => false, logLevel: 'silent' });
  try {
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), { status: 'ok' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    assert.equal(ready.statusCode, 503);
    assert.equal(ready.json().error.code, 'dependency_unavailable');
    assert.ok(ready.json().error.request_id);
  } finally {
    await app.close();
  }
});

test('readiness succeeds when probe passes and stays sanitized on throw', async () => {
  let available = true;
  const app = createApp({
    readinessProbe: async () => {
      if (!available) throw new Error('synthetic secret must not leak');
      return true;
    },
    logLevel: 'silent',
  });
  try {
    assert.equal((await app.inject('/health/ready')).statusCode, 200);
    available = false;
    const response = await app.inject('/health/ready');
    assert.equal(response.statusCode, 503);
    assert.ok(!response.body.includes('synthetic secret'));
  } finally {
    await app.close();
  }
});

test('configuration requires synthetic mode and refuses OAuth variables', () => {
  const base = {
    GEOPS_DATA_MODE: 'synthetic',
    DATABASE_URL: 'postgresql://fake:fake@localhost:5432/geops',
    GEOPS_ADMIN_SESSION_KEY: Buffer.alloc(32, 1).toString('base64url'),
    GEOPS_ADMIN_CSRF_KEY: Buffer.alloc(32, 2).toString('base64url'),
    GEOPS_INVITATION_HMAC_KEY: Buffer.alloc(32, 3).toString('base64url'),
    GEOPS_MDM_GRANT_KEY: Buffer.alloc(32, 4).toString('base64url'),
  };
  assert.equal(loadConfig(base).port, 3500);
  assert.throws(() => loadConfig({ ...base, GEOPS_DATA_MODE: 'real' }));
  assert.throws(() => loadConfig({ ...base, MDM_CLIENT_SECRET: 'synthetic-test-value' }));
  assert.throws(() => loadConfig({ GEOPS_DATA_MODE: 'synthetic' }));
});

test('unknown route and handler errors never echo request path or internals', async () => {
  const app = createApp({ readinessProbe: async () => true, logLevel: 'silent' });
  try {
    const response = await app.inject('/nonexistent?secret=synthetic-test-value');
    assert.equal(response.statusCode, 404);
    assert.ok(!response.body.includes('synthetic-test-value'));
  } finally {
    await app.close();
  }
});
