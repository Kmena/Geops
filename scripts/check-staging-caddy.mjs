import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const file = resolve(import.meta.dirname, '../infrastructure/staging/Caddyfile.poc-proposed');
const args = [
  'run',
  '--rm',
  '--network',
  'none',
  '-e',
  'POC_PUBLIC_HOST=18.209.159.208',
  '-v',
  `${file}:/etc/caddy/Caddyfile:ro`,
  'caddy:2.10.2-alpine',
  'caddy',
  'adapt',
  '--config',
  '/etc/caddy/Caddyfile',
  '--adapter',
  'caddyfile',
];
const adapted = JSON.parse(execFileSync('docker', args, { encoding: 'utf8' }));
const server = adapted.apps.http.servers.srv0;
assert.deepEqual(server.listen, [':443']);
assert.deepEqual(server.routes[0].match[0].host, ['18.209.159.208']);
const routes = server.routes[0].handle[0].routes[0].handle[1].routes;
assert.deepEqual(routes[0].match[0].path, ['/staging']);
assert.equal(routes[0].handle[0].status_code, 308);
assert.deepEqual(routes[0].handle[0].headers.Location, ['/staging/']);
assert.deepEqual(routes[1].match[0].path, ['/staging/*']);
assert.equal(routes[1].handle[0].routes[0].handle[0].strip_path_prefix, '/staging');
assert.equal(
  routes[1].handle[0].routes[1].handle[0].upstreams[0].dial,
  'geops-spec02-stage-web:8080',
);
assert.deepEqual(routes[2].match[0].path, ['/api/*', '/health/*']);
assert.equal(routes[2].handle[0].routes[0].handle[0].upstreams[0].dial, 'poc-api:3600');
assert.equal(routes[3].handle[0].routes.at(-1).handle[0].handler, 'file_server');
assert.ok(server.tls_connection_policies.length > 0);

// Exercise the same matcher order with synthetic responders on loopback only.
// The production candidate above is validated separately with Caddy's adapter.
let probe = readFileSync(file, 'utf8');
const changes = [
  [/^\{\s*default_sni \{\$POC_PUBLIC_HOST\}\s*\}\s*/m, ''],
  [/\{\$POC_PUBLIC_HOST\} \{/, ':8080 {'],
  [/\ttls \{\s*issuer acme \{[\s\S]*?\n\t\t\}\n\t\}/, ''],
  [/reverse_proxy geops-spec02-stage-web:8080/, 'reverse_proxy 127.0.0.1:8081'],
  [/reverse_proxy poc-api:3600/, 'reverse_proxy 127.0.0.1:3600'],
  [/root \* \/srv\s*try_files \{path\} \/index.html\s*file_server/, 'respond "POC_WEB:{path}" 200'],
];
for (const [pattern, replacement] of changes) {
  assert.match(probe, pattern);
  probe = probe.replace(pattern, replacement);
}
probe +=
  '\n:8081 {\n  @proof path /v1/device/config\n  handle @proof {\n    respond "PROOF:{http.request.header.Authorization}|{http.request.header.Origin}|{http.request.header.X-GEOPS-Nonce}|{http.request.header.Cookie}" 200\n  }\n  handle {\n    respond "STAGE:{path}" 200\n  }\n}\n:3600 {\n  respond "POC_API:{path}" 200\n}\n';
const temp = mkdtempSync(join(tmpdir(), 'geops-caddy-routing-'));
if (!resolve(temp).startsWith(`${resolve(tmpdir())}${sep}`)) throw new Error('Unsafe temp path');
try {
  const probeFile = join(temp, 'Caddyfile');
  writeFileSync(probeFile, probe);
  const shell =
    'set -e; caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null; caddy start --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null; sleep 1; for path in / /api/synthetic /health/live /staging/ /staging/v1/admin/auth/me /staging/assets/synthetic /staging/api/synthetic; do printf "%s=" "$path"; wget -q -O - "http://127.0.0.1:8080$path"; printf "\\n"; done; printf "headers="; wget -q -O - --header="Authorization: Bearer synthetic-token" --header="Origin: https://18.209.159.208" --header="X-GEOPS-Nonce: synthetic-nonce" --header="Cookie: geops_stage_admin=synthetic" http://127.0.0.1:8080/staging/v1/device/config; printf "\\n"';
  const output = execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${probeFile}:/etc/caddy/Caddyfile:ro`,
      '--entrypoint',
      'sh',
      'caddy:2.10.2-alpine',
      '-c',
      shell,
    ],
    { encoding: 'utf8' },
  );
  assert.deepEqual(output.trim().split(/\r?\n/), [
    '/=POC_WEB:/',
    '/api/synthetic=POC_API:/api/synthetic',
    '/health/live=POC_API:/health/live',
    '/staging/=STAGE:/',
    '/staging/v1/admin/auth/me=STAGE:/v1/admin/auth/me',
    '/staging/assets/synthetic=STAGE:/assets/synthetic',
    '/staging/api/synthetic=STAGE:/api/synthetic',
    'headers=PROOF:Bearer synthetic-token|https://18.209.159.208|synthetic-nonce|geops_stage_admin=synthetic',
  ]);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log('GEOPS Caddy 2.10.2 PoC/Staging routes: PASS (adapted config and isolated HTTP probe)');
