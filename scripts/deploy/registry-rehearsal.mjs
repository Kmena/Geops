import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { connect } from 'node:net';

const sources = [
  ['api', 'a', 'geops-deploy-p0-api-a:e3f086e'],
  ['web', 'a', 'geops-deploy-p0-web-a:e3f086e'],
  ['api', 'b', 'geops-deploy-p0-api-b:e2b0af7'],
  ['web', 'b', 'geops-deploy-p0-web-b:e2b0af7'],
];

function docker(args, timeout = 180_000) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 2_000_000,
  }).trim();
}

function timed(name, fn, records) {
  const startedAt = new Date().toISOString();
  const t = process.hrtime.bigint();
  let result = 'PASS';
  try {
    return fn();
  } catch {
    result = 'FAIL';
    throw new Error(`${name} failed`);
  } finally {
    records.push({
      stage: name,
      startedAt,
      durationMs: Number((process.hrtime.bigint() - t) / 1_000_000n),
      result,
    });
  }
}

async function manifestDigest(registry, repository, tag) {
  const url = `http://${registry}/v2/${repository}/manifests/${tag}`;
  return new Promise((resolve, reject) => {
    get(
      url,
      {
        headers: { Accept: 'application/vnd.docker.distribution.manifest.v2+json' },
        timeout: 10_000,
      },
      (response) => {
        response.resume();
        if (response.statusCode !== 200) return reject(new Error('Registry manifest unavailable'));
        resolve(response.headers['docker-content-digest']);
      },
    ).on('error', reject);
  });
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function main() {
  const [registry, container, output] = process.argv.slice(2);
  assert.match(registry ?? '', /^127\.0\.0\.1:\d{2,5}$/, 'Loopback registry required');
  assert.match(container ?? '', /^geops-p0-reg-[a-z0-9-]+$/, 'Owned registry container required');
  assert.ok(output, 'Evidence output required');
  const metadata = JSON.parse(docker(['inspect', container, '--format', '{{json .}}']));
  assert.equal(metadata.Config.Labels['geops.deploy-p0'], 'registry-rehearsal');
  assert.equal(metadata.State.Running, true);
  assert.ok(
    metadata.HostConfig.PortBindings['5000/tcp']?.some(
      (item) => item.HostIp === '127.0.0.1' && item.HostPort === registry.split(':')[1],
    ),
  );
  const unrelatedBefore = docker(['ps', '--format', '{{.ID}} {{.Names}}'])
    .split('\n')
    .filter((line) => !line.includes(container));
  const records = [];
  const images = {};
  for (const [service, version, source] of sources) {
    const repository = `geops-${service}`;
    const tag = `${version}-${version === 'a' ? 'e3f086e' : 'e2b0af7'}`;
    const tagged = `${registry}/${repository}:${tag}`;
    assert.ok(docker(['image', 'inspect', source, '--format', '{{.Id}}']));
    timed(`tag_${service}_${version}`, () => docker(['tag', source, tagged]), records);
    const output = timed(`publish_${service}_${version}`, () => docker(['push', tagged]), records);
    const digest = output.match(/digest: (sha256:[a-f0-9]{64})/)?.[1];
    assert.ok(digest, 'Registry push did not return digest');
    const remote = await manifestDigest(registry, repository, tag);
    assert.equal(remote, digest, 'Registry digest mismatch');
    const ref = `${registry}/${repository}@${digest}`;
    const pull = timed(`pull_cached_${service}_${version}`, () => docker(['pull', ref]), records);
    assert.ok(/Image is up to date|Downloaded newer image/.test(pull));
    const localDigests = JSON.parse(
      docker(['image', 'inspect', ref, '--format', '{{json .RepoDigests}}']),
    );
    assert.ok(localDigests.includes(ref), 'Pulled digest not present locally');
    images[`${service}_${version}`] = {
      ref,
      sourceId: docker(['image', 'inspect', source, '--format', '{{.Id}}']),
    };
  }
  for (const [name, ref] of [
    ['missing_image', `${registry}/geops-api@sha256:${'f'.repeat(64)}`],
    ['network_unreachable', `127.0.0.1:50358/geops-api@sha256:${'f'.repeat(64)}`],
  ]) {
    if (name === 'network_unreachable')
      assert.equal(
        await isPortOpen(50358),
        false,
        'Fault port is occupied; refusing to contact another service',
      );
    const startedAt = new Date().toISOString();
    const t = process.hrtime.bigint();
    let rejected = false;
    try {
      docker(['pull', ref], 10_000);
    } catch {
      rejected = true;
    }
    assert.ok(rejected, `${name} should fail`);
    records.push({
      stage: name,
      startedAt,
      durationMs: Number((process.hrtime.bigint() - t) / 1_000_000n),
      result: 'EXPECTED_FAILURE',
    });
  }
  const unrelatedAfter = docker(['ps', '--format', '{{.ID}} {{.Names}}'])
    .split('\n')
    .filter((line) => !line.includes(container));
  assert.deepEqual(unrelatedAfter, unrelatedBefore, 'Unrelated running containers changed');
  writeFileSync(
    output,
    `${JSON.stringify(
      {
        result: 'PASS_LOCAL_REGISTRY',
        registry,
        container,
        images,
        records,
        unrelatedContainersUnchanged: true,
        limitations: [
          'cached-layer pulls only',
          'no registry authentication',
          'no Staging deployment',
        ],
      },
      null,
      2,
    )}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.log(JSON.stringify({ result: 'PASS_LOCAL_REGISTRY', evidence: output }));
}

main().catch((error) => {
  console.error(`Registry rehearsal BLOCKED: ${error.message}`);
  process.exitCode = 1;
});
