import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const required = [
  'POC_PUBLIC_HOST',
  'POC_HTTP_BIND',
  'POC_HTTPS_BIND',
  'POC_DB_PASSWORD',
  'POC_ADMIN_PASSWORD_HASH',
  'POC_RETENTION_HOURS',
  'POC_CAPTURE_ENABLED',
];

export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    if (equals < 1) continue;
    const key = trimmed.slice(0, equals).trim();
    if (!required.includes(key)) continue;
    if (Object.hasOwn(values, key)) throw new Error('Duplicate cloud setting');
    let value = trimmed.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}

function publicIPv4(value) {
  if (isIP(value) !== 4) return false;
  const [a, b, c] = value.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && c === 2))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function validHost(host) {
  if (publicIPv4(host)) return true;
  if (!host || host.length > 253 || isIP(host) || /^[0-9.]+$/.test(host)) return false;
  const lower = host.toLowerCase();
  const blocked = [
    '.invalid',
    '.test',
    '.localhost',
    '.local',
    '.internal',
    '.example',
    'example.com',
    'example.net',
    'example.org',
  ];
  if (
    blocked.some(
      (suffix) =>
        lower === suffix.replace(/^\./, '') ||
        lower.endsWith(suffix.startsWith('.') ? suffix : '.' + suffix),
    )
  )
    return false;
  const labels = lower.split('.');
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  );
}

function validBind(value, port) {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(value ?? '');
  if (!match || Number(match[3]) !== port) return false;
  const host = match[1] ?? match[2];
  return isIP(host) > 0 && host !== '127.0.0.1' && host !== '::1';
}

export function validateCloudConfig(values) {
  const failures = [];
  if (!validHost(values.POC_PUBLIC_HOST)) failures.push('PUBLIC_HOST_INVALID_OR_PLACEHOLDER');
  if (!validBind(values.POC_HTTP_BIND, 80)) failures.push('HTTP_BIND_INVALID');
  if (!validBind(values.POC_HTTPS_BIND, 443)) failures.push('HTTPS_BIND_INVALID');
  if (
    !values.POC_DB_PASSWORD ||
    values.POC_DB_PASSWORD.length < 16 ||
    values.POC_DB_PASSWORD.includes('REPLACE')
  )
    failures.push('DB_PASSWORD_INVALID');
  if (!/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(values.POC_ADMIN_PASSWORD_HASH ?? ''))
    failures.push('ADMIN_HASH_INVALID');
  const retention = Number(values.POC_RETENTION_HOURS);
  if (!Number.isInteger(retention) || retention < 1 || retention > 168)
    failures.push('RETENTION_INVALID');
  if (values.POC_CAPTURE_ENABLED !== 'false') failures.push('CAPTURE_MUST_BE_DISABLED');
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error('ENV_FILE_REQUIRED');
    const failures = validateCloudConfig(parseEnv(readFileSync(resolve(process.argv[2]), 'utf8')));
    if (failures.length) {
      process.stderr.write('Cloud preflight BLOCKED: ' + failures.join(', ') + '\n');
      process.exitCode = 1;
    } else
      process.stdout.write(
        'Cloud configuration preflight passed; EC2 address stability, TLS and runtime remain unverified\n',
      );
  } catch {
    process.stderr.write('Cloud preflight BLOCKED: ENV_FILE_INVALID\n');
    process.exitCode = 1;
  }
}
