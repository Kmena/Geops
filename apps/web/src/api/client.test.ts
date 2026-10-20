import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, ApiClientError, type Device } from './client.js';

const device: Device = {
  id: '00000000-0000-4000-8000-000000000001',
  display_label: 'Android sintético',
  status: 'DRAFT',
  mdm_binding_id: '00000000-0000-4000-8000-000000000002',
  tenant_id: 'synthetic',
  mdm_device_id: 'synthetic-mdm-01',
  enrolled_at: null,
  last_communication_at: null,
  invitation_id: null,
  invitation_status: null,
  invitation_expires_at: null,
  claim_id: null,
  claim_status: null,
  key_id: null,
  installation_id: null,
};

async function withFetch(response: Response, run: () => Promise<void>) {
  const prior = globalThis.fetch;
  globalThis.fetch = async () => response;
  try {
    await run();
  } finally {
    globalThis.fetch = prior;
  }
}

test('a valid 201 invitation retains the one-time code for the caller', async () => {
  const body = {
    invitation_id: '00000000-0000-4000-8000-000000000003',
    geops_device_id: device.id,
    invitation_secret: 'A'.repeat(43),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  };
  const prior = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    return Response.json(body, { status: 201 });
  };
  try {
    assert.deepEqual(await api.issueInvitation(device, 'synthetic-csrf'), body);
    const request = requests[0];
    assert.ok(request);
    assert.equal(request.url, `/v1/admin/devices/${device.id}/invitations`);
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.credentials, 'same-origin');
    assert.equal(
      (request.init.headers as Record<string, string>)['x-csrf-token'],
      'synthetic-csrf',
    );
    assert.doesNotMatch(request.url, /synthetic-csrf|A{43}/);
  } finally {
    globalThis.fetch = prior;
  }
});

test('invalid or mismatched invitation responses cannot be displayed as credentials', async () => {
  for (const body of [
    null,
    {},
    { invitation_secret: 'A'.repeat(43) },
    {
      invitation_id: '00000000-0000-4000-8000-000000000003',
      geops_device_id: '00000000-0000-4000-8000-000000000099',
      invitation_secret: 'A'.repeat(43),
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    },
  ]) {
    await withFetch(Response.json(body, { status: 201 }), async () => {
      await assert.rejects(
        api.issueInvitation(device, 'synthetic-csrf'),
        (error: unknown) =>
          error instanceof ApiClientError && error.code === 'invalid_invitation_response',
      );
    });
  }
});

test('invitation HTTP errors preserve authorization and server status without exposing secrets', async () => {
  for (const status of [403, 409, 500]) {
    await withFetch(Response.json({ error: { code: 'synthetic_error' } }, { status }), async () => {
      await assert.rejects(
        api.issueInvitation(device, 'synthetic-csrf'),
        (error: unknown) =>
          error instanceof ApiClientError &&
          error.status === status &&
          error.code === 'synthetic_error',
      );
    });
  }
});
