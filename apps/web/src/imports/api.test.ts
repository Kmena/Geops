import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importsApi } from './api.js';

test('W4 review transport includes CSRF, versions and preview digest', async () => {
  const prior = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(
      JSON.stringify({ items: [], total: 0, revision: 1, digest: 'a'.repeat(64), count: 1 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const id = '00000000-0000-4000-8000-000000000001';
    const recordId = '00000000-0000-4000-8000-000000000002';
    await importsApi.records(id, {
      page: 2,
      limit: 50,
      state: 'CONFLICT',
      group: '',
      week: '',
      type: '',
      sort: 'priority',
      search: 'Acme',
      record_id: recordId,
    });
    await importsApi.save(
      id,
      recordId,
      0,
      { action: 'CREATE', proposed: { name: 'Acme', latitude: 9.9, longitude: -84.1 } },
      'csrf-fixture',
    );
    await importsApi.bulkPreview(
      id,
      { record_ids: [recordId], action: 'EXCLUDE', reason: 'Ejemplo' },
      'csrf-fixture',
    );
    await importsApi.bulkApply(
      id,
      { record_ids: [recordId], action: 'EXCLUDE', reason: 'Ejemplo' },
      'a'.repeat(64),
      'csrf-fixture',
    );
    assert.match(calls[0]?.url ?? '', /page=2/);
    assert.match(calls[0]?.url ?? '', /state=CONFLICT/);
    assert.match(calls[0]?.url ?? '', /search=Acme/);
    assert.match(calls[0]?.url ?? '', /record_id=00000000-0000-4000-8000-000000000002/);
    assert.equal(calls[1]?.init.method, 'PATCH');
    const saveHeaders = calls[1]?.init.headers as Record<string, string> | undefined;
    const bulkHeaders = calls[3]?.init.headers as Record<string, string> | undefined;
    assert.equal(saveHeaders?.['x-csrf-token'], 'csrf-fixture');
    assert.equal(saveHeaders?.['if-match'], '0');
    assert.equal(bulkHeaders?.['if-match'], 'a'.repeat(64));
    assert.ok(calls.every((call) => call.init.credentials === 'same-origin'));
    assert.ok(calls.every((call) => !call.url.includes('confirm')));
  } finally {
    globalThis.fetch = prior;
  }
});

test('W5 confirmation transport requires a validated digest, ETag, CSRF and retry key', async () => {
  const prior = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ state: 'APPLIED', commit_id: 'synthetic' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const id = '00000000-0000-4000-8000-000000000001';
    const digest = 'b'.repeat(64);
    const plan = { plan_digest: digest, etag: `"kmz-plan:${digest}"` } as Parameters<
      typeof importsApi.confirm
    >[1];
    await importsApi.validate(id, 'csrf-fixture');
    await importsApi.confirm(id, plan, 'Revisión aprobada', 'stable-retry-key-001', 'csrf-fixture');
    await importsApi.result(id);
    assert.match(calls[0]?.url ?? '', /\/validate$/);
    assert.match(calls[1]?.url ?? '', /\/confirm$/);
    assert.match(calls[2]?.url ?? '', /\/result$/);
    assert.equal(calls[1]?.init.method, 'POST');
    const headers = calls[1]?.init.headers as Record<string, string>;
    assert.equal(headers['x-csrf-token'], 'csrf-fixture');
    assert.equal(headers['if-match'], plan.etag);
    assert.equal(headers['idempotency-key'], 'stable-retry-key-001');
    assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
      plan_digest: digest,
      reason: 'Revisión aprobada',
    });
    assert.ok(calls.every((call) => call.init.credentials === 'same-origin'));
  } finally {
    globalThis.fetch = prior;
  }
});
