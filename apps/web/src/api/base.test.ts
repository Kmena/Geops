import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiPath } from './base.js';

test('browser API path stays local at root and scoped in staging', () => {
  assert.equal(apiPath('/v1/admin/auth/me', '/'), '/v1/admin/auth/me');
  assert.equal(apiPath('/v1/admin/auth/me', '/staging/'), '/staging/v1/admin/auth/me');
  assert.equal(apiPath('/v1/device/config', '/staging/'), '/staging/v1/device/config');
  assert.throws(() => apiPath('/v1/admin/auth/me', '/wrong/'));
});
