#!/usr/bin/env node
/** Verify an operator-approved Ed25519 public key before building a READY bundle. */
import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

const LAB_ONLY_SHA256 = '1c67f9d01fde7228edc10ccc2c421d34bce85f8ad7bb088de80e465506d33051';
const [path, approvedSha256] = process.argv.slice(2);
if (!path || !/^[a-f0-9]{64}$/.test(approvedSha256 ?? '') || process.argv.length !== 4) {
  console.error('Usage: verify-trust-key.mjs PUBLIC_PEM OPERATOR_APPROVED_SHA256');
  process.exit(2);
}

try {
  assert.ok(lstatSync(path).isFile(), 'Regular public-key file required');
  const pem = readFileSync(path);
  assert.ok(pem.length <= 4096, 'Oversized public-key file');
  assert.match(
    pem.toString('ascii'),
    /^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PUBLIC KEY-----\r?\n?$/,
    'Single public-key PEM block required',
  );
  const observedSha256 = createHash('sha256').update(pem).digest('hex');
  assert.notEqual(observedSha256, LAB_ONLY_SHA256, 'LAB_ONLY key is forbidden for staging');
  assert.equal(observedSha256, approvedSha256, 'Operator-approved SHA-256 differs');
  assert.equal(createPublicKey(pem).asymmetricKeyType, 'ed25519', 'Ed25519 public key required');
  console.log(
    JSON.stringify({ result: 'STAGING_ED25519_PUBLIC_KEY_VERIFIED', sha256: observedSha256 }),
  );
} catch (error) {
  console.error(`Staging trust key BLOCKED: ${error.message}`);
  process.exitCode = 1;
}
