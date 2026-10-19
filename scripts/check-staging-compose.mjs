import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const compose = JSON.parse(
  execFileSync(
    'docker',
    [
      'compose',
      '--env-file',
      'infrastructure/compose/.env.staging.example',
      '-f',
      'infrastructure/compose/compose.staging.yaml',
      '--profile',
      'maintenance',
      'config',
      '--format',
      'json',
    ],
    { cwd: root, encoding: 'utf8' },
  ),
);

assert.equal(compose.name, 'geops-spec02-staging');
assert.deepEqual(Object.keys(compose.services).sort(), [
  'geops-api',
  'geops-backup',
  'geops-db',
  'geops-gate-init',
  'geops-migrate',
  'geops-web',
]);
for (const [name, service] of Object.entries(compose.services))
  assert.equal(service.ports?.length ?? 0, 0, `${name} exposed`);
assert.equal(compose.services['geops-api'].environment.GEOPS_DATA_MODE, 'synthetic');
assert.equal(
  compose.services['geops-api'].environment.GEOPS_ADMIN_COOKIE_NAME,
  'geops_stage_admin',
);
assert.equal(compose.services['geops-api'].environment.GEOPS_ADMIN_COOKIE_PATH, '/staging');
assert.equal(
  compose.services['geops-api'].environment.GEOPS_ALLOWED_ORIGINS,
  'https://18.209.159.208',
);
assert.equal(compose.services['geops-web'].build.args.GEOPS_WEB_BASE, '/staging/');
assert.equal(compose.services['geops-api'].environment.GEOPS_INSECURE_LOCAL_COOKIE, undefined);
assert.equal(compose.services['geops-api'].environment.MDM_CLIENT_SECRET, undefined);
for (const [key, name] of [
  ['stage_db', 'geops_spec02_stage_db'],
  ['stage_app', 'geops_spec02_stage_app'],
  ['stage_edge', 'geops_spec02_stage_edge'],
]) {
  assert.equal(compose.networks[key].name, name);
  assert.equal(compose.networks[key].external, key === 'stage_edge' ? true : undefined);
}
assert.equal(compose.networks.stage_db.internal, true);
assert.equal(compose.networks.stage_app.internal, true);
for (const [key, name] of [
  ['stage_pgdata', 'geops_spec02_stage_pgdata'],
  ['stage_security', 'geops_spec02_stage_security'],
  ['stage_backups', 'geops_spec02_stage_backups'],
])
  assert.equal(compose.volumes[key].name, name);
for (const [key, secret] of Object.entries(compose.secrets)) {
  assert.ok(
    secret.file
      .replaceAll('\\', '/')
      .includes(`/infrastructure/compose/.local/staging/secrets/${key}`),
  );
}
assert.deepEqual(Object.keys(compose.services['geops-db'].networks), ['stage_db']);
assert.deepEqual(Object.keys(compose.services['geops-api'].networks).sort(), [
  'stage_app',
  'stage_db',
]);
assert.deepEqual(Object.keys(compose.services['geops-web'].networks).sort(), [
  'stage_app',
  'stage_edge',
]);
assert.deepEqual(compose.services['geops-web'].networks.stage_edge.aliases, [
  'geops-spec02-stage-web',
]);
assert.ok(!Object.keys(compose.secrets).some((name) => name.startsWith('tls_')));

const pocFile = readFileSync(resolve(root, 'experiments/weekend-gps-poc/infra/Caddyfile'), 'utf8');
const candidate = readFileSync(
  resolve(root, 'infrastructure/staging/Caddyfile.poc-proposed'),
  'utf8',
);
const stageBlock =
  /\s+@stagingBare path \/staging\s+redir @stagingBare \/staging\/ 308\s+handle_path \/staging\/\* \{\s+reverse_proxy geops-spec02-stage-web:8080\s+\}\s+/;
assert.match(candidate, stageBlock);
const normalized = (value) => value.replace(/\s+/g, ' ').trim();
assert.equal(
  normalized(
    candidate
      .replace('route {', '')
      .replace(stageBlock, ' ')
      .replace(/\n\t}\n}\s*$/, '\n}'),
  ),
  normalized(pocFile),
);

const pocEnv = {
  ...process.env,
  POC_DB_PASSWORD: 'synthetic-only',
  POC_ADMIN_PASSWORD_HASH: `${'0'.repeat(32)}:${'0'.repeat(128)}`,
  POC_PUBLIC_HOST: '18.209.159.208',
  POC_RETENTION_HOURS: '24',
  POC_HTTP_BIND: '127.0.0.1:18080',
  POC_HTTPS_BIND: '127.0.0.1:18443',
  GEOPS_STAGE_CADDYFILE: resolve(root, 'infrastructure/staging/Caddyfile.poc-proposed'),
};
const pocArgs = ['compose', '-f', 'experiments/weekend-gps-poc/infra/compose.cloud.yaml'];
const pocConfig = (overlay) =>
  JSON.parse(
    execFileSync(
      'docker',
      [
        ...pocArgs,
        ...(overlay ? ['-f', 'infrastructure/staging/compose.poc-edge.override.yaml'] : []),
        'config',
        '--format',
        'json',
      ],
      { cwd: root, env: pocEnv, encoding: 'utf8' },
    ),
  );
const originalPoc = pocConfig(false);
const proposedPoc = pocConfig(true);
for (const name of Object.keys(originalPoc.services)) {
  if (name === 'poc-https') continue;
  assert.deepEqual(proposedPoc.services[name], originalPoc.services[name], `${name} changed`);
}
const originalCaddy = originalPoc.services['poc-https'];
const proposedCaddy = proposedPoc.services['poc-https'];
assert.deepEqual(proposedCaddy.ports, originalCaddy.ports);
assert.deepEqual(proposedCaddy.environment, originalCaddy.environment);
assert.deepEqual(proposedCaddy.volumes.slice(0, 2), originalCaddy.volumes);
assert.deepEqual(Object.keys(proposedCaddy.networks).sort(), ['geops_stage_edge', 'poc_internal']);
assert.equal(proposedCaddy.volumes[2].target, '/etc/caddy/Caddyfile');
assert.equal(proposedCaddy.volumes[2].read_only, true);
assert.deepEqual(proposedPoc.networks.poc_internal, originalPoc.networks.poc_internal);
console.log('GEOPS Staging Compose/Caddy route isolation: PASS (static configuration only)');
