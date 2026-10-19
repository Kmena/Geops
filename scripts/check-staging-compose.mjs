import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
  'geops-https',
  'geops-migrate',
  'geops-web',
]);
for (const [name, service] of Object.entries(compose.services)) {
  if (name !== 'geops-https') assert.equal(service.ports?.length ?? 0, 0, `${name} exposed`);
}
assert.deepEqual(compose.services['geops-https'].ports, [
  {
    mode: 'ingress',
    host_ip: '127.0.0.1',
    target: 8443,
    published: '8443',
    protocol: 'tcp',
  },
]);
assert.equal(compose.services['geops-api'].environment.GEOPS_DATA_MODE, 'synthetic');
assert.equal(compose.services['geops-api'].environment.GEOPS_INSECURE_LOCAL_COOKIE, undefined);
assert.equal(compose.services['geops-api'].environment.MDM_CLIENT_SECRET, undefined);
for (const [key, name] of [
  ['stage_db', 'geops_spec02_stage_db'],
  ['stage_app', 'geops_spec02_stage_app'],
  ['stage_edge', 'geops_spec02_stage_edge'],
]) {
  assert.equal(compose.networks[key].name, name);
  assert.equal(compose.networks[key].external, undefined);
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
assert.deepEqual(Object.keys(compose.services['geops-https'].networks), ['stage_edge']);
console.log('GEOPS Staging Compose isolation: PASS (static configuration only)');
