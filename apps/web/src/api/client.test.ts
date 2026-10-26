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
  last_installation_retired_at: null,
  policy_name: null,
  session_state: null,
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

test('device lifecycle mutations use the canonical route, CSRF and a reason', async () => {
  const prior = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    return Response.json({ status: 'SUSPENDED' });
  };
  try {
    await api.changeDeviceState(device.id, 'suspend', 'synthetic-csrf', 'Synthetic pause');
    const request = requests[0];
    assert.ok(request);
    assert.equal(request.url, `/v1/admin/devices/${device.id}/suspend`);
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.credentials, 'same-origin');
    assert.equal(
      (request.init.headers as Record<string, string>)['x-csrf-token'],
      'synthetic-csrf',
    );
    assert.deepEqual(JSON.parse(request.init.body as string), { reason: 'Synthetic pause' });
  } finally {
    globalThis.fetch = prior;
  }
});

test('enrollment inventory requests the next bounded page', async () => {
  const prior = globalThis.fetch;
  let requested = '';
  globalThis.fetch = async (url) => {
    requested = String(url);
    return Response.json({ items: [], next_cursor: null, source: 'geops' });
  };
  try {
    await api.enrollmentDevices('cursor+value');
    assert.equal(requested, '/v1/admin/enrollment/devices?limit=100&cursor=cursor%2Bvalue');
  } finally {
    globalThis.fetch = prior;
  }
});

test('MDM admin mutations use session credentials and CSRF without browser OAuth tokens', async () => {
  const prior = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    return Response.json({ linked: true, run_id: device.id, device_count: 1 });
  };
  try {
    await api.mdmSync('synthetic-csrf');
    await api.mdmLink(device.id, '9007199254740995123', 'synthetic-csrf');
    await api.mdmUnlink(device.id, 'synthetic-csrf');
    assert.deepEqual(
      requests.map((request) => [request.init.method, request.url]),
      [
        ['POST', '/v1/admin/mdm/sync'],
        ['PUT', `/v1/admin/devices/${device.id}/mdm-link`],
        ['DELETE', `/v1/admin/devices/${device.id}/mdm-link`],
      ],
    );
    for (const request of requests) {
      assert.equal(request.init.credentials, 'same-origin');
      assert.equal(
        (request.init.headers as Record<string, string>)['x-csrf-token'],
        'synthetic-csrf',
      );
      assert.doesNotMatch(JSON.stringify(request), /refresh_token|client_secret|Zoho-oauthtoken/i);
    }
    assert.deepEqual(JSON.parse(requests[1]?.init.body as string), {
      mdm_device_id: '9007199254740995123',
    });
  } finally {
    globalThis.fetch = prior;
  }
});

test('OAuth application status never transmits client credentials', async () => {
  const prior = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    return Response.json({
      configured: true,
      source: 'admin',
      region: 'com',
      callback_url: 'https://example.invalid/v1/admin/mdm/oauth/callback',
    });
  };
  try {
    const status = await api.mdmOAuthConfig();
    assert.equal(status.configured, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, '/v1/admin/mdm/oauth/config');
    assert.equal(requests[0]?.init.credentials, 'same-origin');
    assert.equal(requests[0]?.init.body, undefined);
    assert.doesNotMatch(JSON.stringify(requests), /client_secret|synthetic-secret/i);
  } finally {
    globalThis.fetch = prior;
  }
});

test('MDM OAuth controls keep grants off Web and inventory uses a bounded cursor', async () => {
  const prior = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    return Response.json({
      authorization_url: 'https://accounts.zoho.com/oauth/v2/auth?state=synthetic',
      local_disconnected: true,
      remote_revoked: true,
      items: [],
      next_cursor: null,
    });
  };
  try {
    await api.mdmOAuthStart('synthetic-csrf');
    await api.mdmInventory('9007199254740995123');
    await api.mdmDisconnect('synthetic-csrf');
    assert.deepEqual(
      requests.map((request) => [request.init.method ?? 'GET', request.url]),
      [
        ['POST', '/v1/admin/mdm/oauth/start'],
        ['GET', '/v1/admin/mdm/inventory?after=9007199254740995123'],
        ['POST', '/v1/admin/mdm/disconnect'],
      ],
    );
    assert.equal(
      requests.every((request) => request.init.credentials === 'same-origin'),
      true,
    );
    assert.equal(
      requests
        .filter((request) => request.init.method === 'POST')
        .every(
          (request) =>
            (request.init.headers as Record<string, string>)['x-csrf-token'] === 'synthetic-csrf',
        ),
      true,
    );
    assert.doesNotMatch(JSON.stringify(requests), /refresh_token|client_secret|Zoho-oauthtoken/i);
  } finally {
    globalThis.fetch = prior;
  }
});

test('catalog geofence save sends CSRF, revision precondition and meter values', async () => {
  const prior = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init: init ?? {} });
    return Response.json({ revision: 2, radius_m: 200, min_dwell_s: 900 }, { status: 201 });
  };
  try {
    await api.saveGeofence(
      'client-id',
      'site-id',
      1,
      {
        latitude: 14.63,
        longitude: -90.51,
        radius_m: 200,
        min_dwell_s: 900,
        state: 'ACTIVE',
        reason: 'Synthetic adjustment',
      },
      'synthetic-csrf',
    );
    const request = requests[0];
    assert.ok(request);
    assert.equal(request.url, '/v1/admin/clients/client-id/sites/site-id/geofences');
    assert.equal(request.init.method, 'POST');
    const headers = request.init.headers as Record<string, string>;
    assert.equal(headers['x-csrf-token'], 'synthetic-csrf');
    assert.equal(headers['if-match'], '"1"');
    assert.match(headers['idempotency-key'] ?? '', /^[0-9a-f-]{36}$/);
    assert.deepEqual(JSON.parse(request.init.body as string), {
      latitude: 14.63,
      longitude: -90.51,
      radius_m: 200,
      min_dwell_s: 900,
      state: 'ACTIVE',
      reason: 'Synthetic adjustment',
    });
  } finally {
    globalThis.fetch = prior;
  }
});

test('catalog site loader follows bounded opaque cursors', async () => {
  const prior = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return Response.json(
      urls.length === 1
        ? { items: [{ id: 'first' }], next_cursor: 'cursor+value' }
        : { items: [{ id: 'second' }], next_cursor: null },
    );
  };
  try {
    const result = await api.sites('client-id');
    assert.deepEqual(
      result.items.map((item) => item.id),
      ['first', 'second'],
    );
    assert.deepEqual(urls, [
      '/v1/admin/clients/client-id/sites?limit=100',
      '/v1/admin/clients/client-id/sites?limit=100&cursor=cursor%2Bvalue',
    ]);
  } finally {
    globalThis.fetch = prior;
  }
});
