import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { api } from './api/client.js';
import { ActivateAdmin } from './AdminUsers.js';

test('activation form asks for token in the body and a new password', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ActivateAdmin />
    </MemoryRouter>,
  );
  assert.match(html, /name="invitation_id"/);
  assert.match(html, /name="token"/);
  assert.match(html, /name="password"/);
  assert.doesNotMatch(html, /invitation_token=/);
});

test('invitation transport omits cookies and administrative mutations send CSRF', async () => {
  const prior = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 204 });
  };
  try {
    await api.acceptAdminInvitation(
      '00000000-0000-4000-8000-000000000001',
      'synthetic-token',
      'synthetic-password-12345678',
    );
    await api.changeAdminCapabilities(
      '00000000-0000-4000-8000-000000000002',
      'GRANT',
      ['gps.policy.read', 'gps.session.read'],
      'Approved synthetic user',
      'csrf-fixture',
    );
    assert.equal(requests[0]?.init.credentials, 'omit');
    assert.equal(requests[0]?.url, '/v1/admin/users/invitations/accept');
    assert.equal((requests[0].init.body as string).includes('synthetic-token'), true);
    assert.equal(requests[1]?.init.credentials, 'same-origin');
    assert.equal(
      (requests[1].init.headers as Record<string, string>)['x-csrf-token'],
      'csrf-fixture',
    );
    assert.deepEqual(JSON.parse(requests[1]?.init.body as string).capabilities, [
      'gps.policy.read',
      'gps.session.read',
    ]);
  } finally {
    globalThis.fetch = prior;
  }
});
