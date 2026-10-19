import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { requestProofBytes } from '../dist/index.js';

const vector = JSON.parse(
  readFileSync(
    new URL(
      '../../../apps/android-agent/src/test/resources/staging-pop-vector.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const sha = (value) => createHash('sha256').update(value).digest('base64url');

test('Kotlin/DuckDNS PoP vector verifies the canonical public and backend path', () => {
  const fields = {
    method: vector.method,
    absolutePath: vector.canonical_path,
    bodySha256: sha(vector.body),
    tokenSha256: sha(vector.token),
    timestamp: vector.timestamp,
    nonce: vector.nonce,
    keyId: vector.key_id,
  };
  assert.equal(new URL(vector.public_path, vector.base_url).pathname, vector.public_path);
  assert.equal(new URL(vector.base_url).hostname, 'geops-staging.duckdns.org');
  assert.equal(vector.public_path, vector.canonical_path);
  assert.equal(
    Buffer.from(requestProofBytes(fields)).toString('base64url'),
    vector.proof_base64url,
  );
  assert.notEqual(
    Buffer.from(requestProofBytes({ ...fields, absolutePath: '/v1/device/config' })).toString(
      'base64url',
    ),
    vector.proof_base64url,
  );
  assert.throws(() =>
    requestProofBytes({ ...fields, absolutePath: `${vector.canonical_path}?x=1` }),
  );
});
