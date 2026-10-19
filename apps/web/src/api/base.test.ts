import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiPath } from './base.js';

test('browser API path remains canonical on the dedicated hostname', () => {
  assert.equal(apiPath('/v1/admin/auth/me', '/'), '/v1/admin/auth/me');
  assert.equal(apiPath('/v1/device/config', '/'), '/v1/device/config');
  assert.throws(() => apiPath('/v1/admin/auth/me', '/staging/'));
  assert.throws(() => apiPath('/v1/admin/auth/me', '/wrong/'));
});
