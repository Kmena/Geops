import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activationQrPayload } from './activation.js';

test('activation QR carries only the identifiers expected by Android', () => {
  const payload = activationQrPayload(
    {
      id: '11111111-1111-4111-8111-111111111111',
      key_id: '22222222-2222-4222-8222-222222222222',
      installation_id: '33333333-3333-4333-8333-333333333333',
    },
    'https://geops-staging.duckdns.org',
    '2026-10-20T12:15:00.000Z',
  );
  assert.deepEqual(JSON.parse(payload), {
    format: 'geops-activation-v1',
    origin: 'https://geops-staging.duckdns.org',
    geops_device_id: '11111111-1111-4111-8111-111111111111',
    key_id: '22222222-2222-4222-8222-222222222222',
    installation_id: '33333333-3333-4333-8333-333333333333',
    expires_at: '2026-10-20T12:15:00.000Z',
  });
  assert.ok(!payload.includes('invitation_secret'));
  assert.throws(() =>
    activationQrPayload(
      { id: 'device', key_id: null, installation_id: null },
      'https://geops-staging.duckdns.org',
      '2026-10-20T12:15:00.000Z',
    ),
  );
});
