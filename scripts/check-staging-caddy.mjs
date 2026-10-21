import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const file = resolve(import.meta.dirname, '../infrastructure/staging/Caddyfile.poc-proposed');
const docker = (args) => execFileSync('docker', args, { encoding: 'utf8' });
const mount = [
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
];
const adapted = JSON.parse(
  docker([...mount, 'adapt', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']),
);
docker([...mount, 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
const server = adapted.apps.http.servers.srv0;
assert.deepEqual(server.listen, [':443']);
const byHost = (host) => server.routes.find((route) => route.match?.[0]?.host?.includes(host));
const poc = byHost('18.209.159.208');
const stage = byHost('geops-staging.duckdns.org');
assert.ok(poc && stage && poc !== stage);
assert.equal(server.routes.length, 2);
assert.ok(server.tls_connection_policies.length > 0);
const proxyDials = (value) => {
  const found = [];
  const visit = (item) => {
    if (!item || typeof item !== 'object') return;
    if (item.handler === 'reverse_proxy')
      found.push(...item.upstreams.map((upstream) => upstream.dial));
    for (const child of Object.values(item)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object') visit(child);
    }
  };
  visit(value);
  return found;
};
assert.deepEqual(proxyDials(poc), ['poc-api:3600']);
assert.deepEqual(proxyDials(stage), ['geops-spec02-stage-web:8080']);
assert.ok(JSON.stringify(poc).includes('/api/*'));
assert.ok(JSON.stringify(poc).includes('/health/*'));
assert.ok(!JSON.stringify(stage).includes('poc-api'));
assert.ok(!JSON.stringify(poc).includes('geops-spec02-stage-web'));

// Probe the candidate host matchers with loopback-only synthetic upstreams.
let probe = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
const changes = [
  [/^\{\s*default_sni \{\$POC_PUBLIC_HOST\}\s*\}\s*/m, ''],
  [/\{\$POC_PUBLIC_HOST\} \{/, 'http://18.209.159.208:8080 {'],
  [/geops-staging\.duckdns\.org \{/, 'http://geops-staging.duckdns.org:8080 {'],
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
const temp = mkdtempSync(join(tmpdir(), 'geops-caddy-hosts-'));
if (!resolve(temp).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe temp path');
try {
  const probeFile = join(temp, 'Caddyfile');
  writeFileSync(probeFile, probe);
  const shell =
    'set -e; caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null; caddy start --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null; sleep 1; get() { wget -q -O - --header="Host: $1" "http://127.0.0.1:8080$2"; }; for path in / /api/synthetic /health/live /staging/v1/device/config; do printf "poc%s=" "$path"; get 18.209.159.208 "$path"; printf "\\n"; done; for path in / /v1/admin/auth/me /assets/synthetic /api/synthetic; do printf "stage%s=" "$path"; get geops-staging.duckdns.org "$path"; printf "\\n"; done; printf "headers="; wget -q -O - --header="Host: geops-staging.duckdns.org" --header="Authorization: Bearer synthetic-token" --header="Origin: https://geops-staging.duckdns.org" --header="X-GEOPS-Nonce: synthetic-nonce" --header="Cookie: __Host-geops_stage_admin=synthetic" http://127.0.0.1:8080/v1/device/config; printf "\\n"';
  const output = docker([
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
  ]);
  assert.deepEqual(output.trim().split(/\r?\n/), [
    'poc/=POC_WEB:/',
    'poc/api/synthetic=POC_API:/api/synthetic',
    'poc/health/live=POC_API:/health/live',
    'poc/staging/v1/device/config=POC_WEB:/staging/v1/device/config',
    'stage/=STAGE:/',
    'stage/v1/admin/auth/me=STAGE:/v1/admin/auth/me',
    'stage/assets/synthetic=STAGE:/assets/synthetic',
    'stage/api/synthetic=STAGE:/api/synthetic',
    'headers=PROOF:Bearer synthetic-token|https://geops-staging.duckdns.org|synthetic-nonce|__Host-geops_stage_admin=synthetic',
  ]);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log(
  'GEOPS Caddy 2.10.2 PoC/DuckDNS hosts: PASS (validated config and isolated HTTP probe)',
);
