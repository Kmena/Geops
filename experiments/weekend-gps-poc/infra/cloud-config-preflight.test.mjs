import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnv, validateCloudConfig } from './cloud-config-preflight.mjs';

const valid = () => ({
  POC_PUBLIC_HOST: '18.209.159.208',
  POC_HTTP_BIND: '0.0.0.0:80',
  POC_HTTPS_BIND: '0.0.0.0:443',
  POC_DB_PASSWORD: 'synthetic-only-password-123',
  POC_ADMIN_PASSWORD_HASH: 'a'.repeat(32) + ':' + 'b'.repeat(128),
  POC_RETENTION_HOURS: '72',
  POC_CAPTURE_ENABLED: 'false',
});

test('cloud preflight accepts syntactically valid public IPv4 configuration only', () => {
  assert.deepEqual(validateCloudConfig(valid()), []);
});

test('cloud preflight accepts a syntactically valid owned FQDN', () => {
  assert.deepEqual(validateCloudConfig({ ...valid(), POC_PUBLIC_HOST: 'gps.geops.org' }), []);
});

test('cloud preflight rejects numeric invalid addresses', () => {
  assert.deepEqual(validateCloudConfig({ ...valid(), POC_PUBLIC_HOST: '999.999.999.999' }), [
    'PUBLIC_HOST_INVALID_OR_PLACEHOLDER',
  ]);
});

test('cloud preflight rejects private IP, wrong ports and active capture', () => {
  const values = valid();
  values.POC_PUBLIC_HOST = '172.31.17.155';
  values.POC_HTTP_BIND = '0.0.0.0:3500';
  values.POC_HTTPS_BIND = '127.0.0.1:443';
  values.POC_CAPTURE_ENABLED = 'true';
  assert.deepEqual(validateCloudConfig(values), [
    'PUBLIC_HOST_INVALID_OR_PLACEHOLDER',
    'HTTP_BIND_INVALID',
    'HTTPS_BIND_INVALID',
    'CAPTURE_MUST_BE_DISABLED',
  ]);
});

test('cloud preflight rejects placeholders and absent secrets without echoing values', () => {
  const values = valid();
  values.POC_PUBLIC_HOST = 'gps-poc.example.invalid';
  values.POC_DB_PASSWORD = 'REPLACE_WITH_PASSWORD';
  values.POC_ADMIN_PASSWORD_HASH = '';
  assert.deepEqual(validateCloudConfig(values), [
    'PUBLIC_HOST_INVALID_OR_PLACEHOLDER',
    'DB_PASSWORD_INVALID',
    'ADMIN_HASH_INVALID',
  ]);
});

test('cloud preflight detects duplicate relevant keys', () => {
  assert.throws(
    () => parseEnv('POC_PUBLIC_HOST=one.example\nPOC_PUBLIC_HOST=two.example'),
    /Duplicate cloud setting/,
  );
});
