import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import Mock, patch

import geops_deploy as remote
from install import archive_files, FILES

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[2]
A_COMMIT = '03e582fba66c0d29eab885e109d3404e86b140a3'
B_COMMIT = '052f4bec0633f829869699e9485a0fdc61bc1964'
A_API = 'sha256:7ade7bd65f75f351c2227697f5b76f107352180d96945bbfadee47087bf82d21'
A_WEB = 'sha256:a7be25f6149e9e749ff6514640975c82870b58c8bfb0eea2187b818ab8669a0b'
B_API = 'ghcr.io/kmena/geops-api@sha256:d15c33f7e0788da0086f9ac82f4de5d9d55d8a0287104622fa9af5c78f323b99'
B_WEB = 'ghcr.io/kmena/geops-web@sha256:d01c1fe94f8644b96f51af2f0f8d94cdc4af22bebf9de8555edac9ac7a6fd19c'


def openssl_path():
    return shutil.which('openssl') or 'C:/Program Files/Git/usr/bin/openssl.exe'


class FakeDocker:
    def __init__(self):
        self.api, self.web = A_API, A_WEB
        self.fail_web = False
        self.endpoint = 'unix:///var/run/docker.sock'
        self.commands = []

    def __call__(self, args, **kwargs):
        self.commands.append(args)
        if Path(args[0]).name.lower().startswith('openssl'):
            return subprocess.run(args, **kwargs)
        text = ''
        if args[1:3] == ['inspect', '--format']:
            name = args[-1]
            kind = 'api' if name == remote.SERVICES['api'] else ('web' if name == remote.SERVICES['web'] else 'db')
            current = {'api': self.api, 'web': self.web, 'db': 'sha256:' + '6' * 64}[kind]
            health = 'unhealthy' if kind == 'web' and self.fail_web and self.web == B_WEB.split('@')[-1] else 'healthy'
            text = json.dumps({'Id': kind + '-container', 'Image': current,
                'Config': {'Labels': {'com.docker.compose.project': remote.ENVIRONMENT,
                                      'com.docker.compose.service': 'geops-' + kind}},
                'State': {'Status': 'running', 'Health': {'Status': health}}})
        elif len(args) >= 4 and args[1:3] == ['image', 'inspect']:
            ref = args[3]
            image = (B_API if ref == B_API else B_WEB) if '@sha256:' in ref else None
            value = {'Id': ref.split('@')[-1] if image else (A_API if '-api:' in ref else A_WEB),
                     'RepoDigests': [image] if image else [],
                     'Config': {'Labels': {'org.opencontainers.image.revision': B_COMMIT,
                                           'org.geops.web.variant': 'gps-base',
                                           'org.geops.web.mdm_enabled': 'false'}}}
            text = json.dumps(value)
        elif 'config' in args and '--format' in args:
            text = json.dumps({'name': remote.ENVIRONMENT, 'services': {
                'geops-api': {'image': kwargs['env']['GEOPS_STAGE_API_IMAGE_REF'],
                              'environment': {'MDM_ENABLED': 'false'}},
                'geops-web': {'image': kwargs['env']['GEOPS_STAGE_WEB_IMAGE_REF'],
                              'build': {'args': {'MDM_ENABLED': 'false'}}},
                'geops-db': {'image': 'postgis/postgis:18-3.6'}}})
        elif args[1] == 'run':
            text = json.dumps({'count': 21, 'sha256': 'cd308f751512b86926116856185b7aa870f849235161e5e23c904c4d28813d8e'})
        elif args[1] == 'exec' and 'SELECT version,checksum' in args[-1]:
            migrations = sorted((SOURCE / 'apps/api/src/db/migrations').glob('[0-9][0-9][0-9][0-9]_*.sql'))
            text = '\n'.join(f'{file.name}|{hashlib.sha256(file.read_bytes()).hexdigest()}'
                             for file in migrations)
        elif args[1] == 'exec' and args[-1].startswith('/run/secrets/'):
            name = args[-1].removeprefix('/run/secrets/')
            text = hashlib.sha256(('synthetic-' + name).encode()).hexdigest()
        elif args[1] == 'exec' and 'SELECT epoch FROM security_epoch' in args[-1]:
            text = '00000000-0000-0000-0000-000000000001'
        elif args[1:3] == ['context', 'inspect']:
            text = self.endpoint
        elif 'up' in args:
            if args[-1] == 'geops-api':
                self.api = (kwargs['env']['GEOPS_STAGE_API_IMAGE_REF'].split('@')[-1]
                            if '@' in kwargs['env']['GEOPS_STAGE_API_IMAGE_REF'] else A_API)
            if args[-1] == 'geops-web':
                self.web = (kwargs['env']['GEOPS_STAGE_WEB_IMAGE_REF'].split('@')[-1]
                            if '@' in kwargs['env']['GEOPS_STAGE_WEB_IMAGE_REF'] else A_WEB)
        return subprocess.CompletedProcess(args, 0, text, '')


class RemoteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.root, self.state = base / 'etc', base / 'state'
        self.root.mkdir()
        self.state.mkdir()
        for sub in ('inbox', 'used', 'tmp'):
            (self.state / sub).mkdir()
        self.bundle = self.root / 'bundle'
        for name in remote.BUNDLE_FILES:
            target = self.bundle / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(subprocess.check_output(
                ['git', 'show', '052f4bec0633f829869699e9485a0fdc61bc1964:' + name], cwd=SOURCE))
        (self.root / 'policy.json').write_bytes(
            (HERE / 'first-staging-policy.json').read_bytes().replace(b'\r\n', b'\n'))
        secret_dir = self.root / 'secrets'
        secret_dir.mkdir()
        for name in remote.SECRET_NAMES:
            (secret_dir / name).write_bytes(('synthetic-' + name).encode())
        shutil.copyfile(HERE / 'first-staging-state.json', self.state / 'state.json')
        self.log = base / 'audit.jsonl'
        self.log.write_text('')
        self.gate = base / 'security-gate.json'
        self.gate.write_text(json.dumps({'version': 1, 'phase': 'open',
                                         'epoch': '00000000-0000-0000-0000-000000000001'}))
        self.backups = base / 'backups'
        self.backups.mkdir()
        backup = self.backups / 'geops-stage-20261023T000000Z.dump'
        backup.write_bytes(b'isolated backup')
        Path(str(backup) + '.sha256').write_text(hashlib.sha256(backup.read_bytes()).hexdigest() + '  dump\n')
        self.private = base / 'private.pem'
        self.openssl = openssl_path()
        if not Path(self.openssl).exists():
            self.skipTest('OpenSSL not installed')
        subprocess.run([self.openssl, 'genpkey', '-algorithm', 'ED25519', '-out', self.private],
                       check=True, capture_output=True)
        subprocess.run([self.openssl, 'pkey', '-in', self.private, '-pubout',
                        '-out', self.root / 'public.pem'], check=True, capture_output=True)
        self.fake = FakeDocker()
        self.control = remote.Controller(self.root, self.state, self.log, docker='docker',
                                         openssl=self.openssl, enforce_root=False, runner=self.fake)
        self.gate_patch = patch.object(remote, 'GATE', self.gate)
        self.backup_patch = patch.object(remote, 'BACKUPS', self.backups)
        self.gate_patch.start(); self.backup_patch.start()
        self.addCleanup(self.gate_patch.stop); self.addCleanup(self.backup_patch.stop)

    def sign(self, kind, document):
        name = document['id']
        target = self.state / 'inbox' / f'{name}.{kind}.json'
        target.write_text(json.dumps(document, sort_keys=True), encoding='utf8')
        signature = self.state / 'inbox' / f'{name}.{kind}.sig'
        subprocess.run([self.openssl, 'pkeyutl', '-sign', '-inkey', self.private,
                        '-rawin', '-in', target, '-out', signature], check=True, capture_output=True)
        return target

    def release(self):
        self.control.load_policy()
        now = datetime.now(timezone.utc)
        document = {'schemaVersion': 1, 'id': 'release_052f4bec_001',
                    'environment': remote.ENVIRONMENT,
                    'notBefore': (now - timedelta(minutes=1)).isoformat().replace('+00:00', 'Z'),
                    'expiresAt': (now + timedelta(days=1)).isoformat().replace('+00:00', 'Z'),
                    'commit': B_COMMIT,
                    'api': B_API, 'web': B_WEB, 'variant': 'gps-base', 'sqlCount': 21,
                    'sqlListSha256': self.control.policy['sqlListSha256'],
                    'policySha256': remote.digest(self.control.policy_bytes)}
        path = self.sign('release', document)
        return document, remote.digest(path.read_bytes())

    def approval(self, action, release_sha, source, target):
        now = datetime.now(timezone.utc)
        document = {'schemaVersion': 1, 'id': f'approval_{action}_001',
                    'environment': remote.ENVIRONMENT,
                    'notBefore': (now - timedelta(minutes=1)).isoformat().replace('+00:00', 'Z'),
                    'expiresAt': (now + timedelta(minutes=20)).isoformat().replace('+00:00', 'Z'),
                    'action': action,
                    'releaseSha256': release_sha,
                    'policySha256': remote.digest(self.control.policy_bytes),
                    'sourceApiId': source['apiId'], 'sourceWebId': source['webId'],
                    'targetApiId': target['apiId'], 'targetWebId': target['webId']}
        self.sign('approval', document)
        return document['id']

    def test_status_and_preflight(self):
        document, _ = self.release()
        self.assertTrue(self.control.execute('status')['imageMatch'])
        self.assertEqual(self.control.execute('preflight', document['id'])['result'], 'PREFLIGHT')

    def test_prepare_verifies_without_switch(self):
        document, _ = self.release()
        self.assertEqual(self.control.execute('prepare', document['id'])['result'], 'PREPARED')
        self.assertEqual((self.fake.api, self.fake.web), (A_API, A_WEB))
        self.assertEqual(sum(len(command) > 1 and command[1] == 'pull'
                             for command in self.fake.commands), 2)

    def test_tampered_release_and_bundle_block(self):
        document, _ = self.release()
        path = self.state / 'inbox' / (document['id'] + '.release.json')
        path.write_text(path.read_text().replace(B_COMMIT, A_COMMIT))
        with self.assertRaises(remote.Blocked):
            self.control.execute('preflight', document['id'])
        (self.bundle / remote.BUNDLE_FILES[0]).write_text('tampered')
        with self.assertRaises(remote.Blocked):
            self.control.load_policy()

    def test_wrong_digest_and_approval_binding_block(self):
        document, sha = self.release()
        self.fake.commands.clear()
        self.fake.web = 'sha256:' + 'a' * 64
        with self.assertRaises(remote.Blocked):
            self.control.execute('preflight', document['id'])
        self.fake.web = A_WEB
        old = self.control.state()['active']
        target = {'apiId': B_API.split('@')[-1], 'webId': B_WEB.split('@')[-1]}
        approval_id = self.approval('rollback', sha, old, target)
        with self.assertRaises(remote.Blocked):
            self.control.execute('deploy', document['id'], approval_id)

    def test_deploy_and_rollback_use_approved_images(self):
        document, sha = self.release()
        old = self.control.state()['active']
        target = {'apiId': B_API.split('@')[-1], 'webId': B_WEB.split('@')[-1]}
        deploy_id = self.approval('deploy', sha, old, target)
        self.assertEqual(self.control.execute('deploy', document['id'], deploy_id)['result'], 'DEPLOYED')
        self.assertEqual(self.control.state()['active']['apiId'], target['apiId'])
        with self.assertRaises(remote.Blocked):
            self.control.execute('deploy', document['id'], deploy_id)
        rollback_id = self.approval('rollback', sha, self.control.state()['active'], old)
        self.assertEqual(self.control.execute('rollback', approval_id=rollback_id)['result'], 'ROLLED_BACK')
        self.assertEqual((self.fake.api, self.fake.web), (A_API, A_WEB))
        self.assertIn('approval-consumed', self.log.read_text())

    def test_readiness_failure_recovers_a(self):
        document, sha = self.release()
        old = self.control.state()['active']
        target = {'apiId': B_API.split('@')[-1], 'webId': B_WEB.split('@')[-1]}
        approval_id = self.approval('deploy', sha, old, target)
        self.fake.fail_web = True
        with self.assertRaisesRegex(remote.Blocked, 'previous application recovered'):
            self.control.execute('deploy', document['id'], approval_id)
        self.assertEqual((self.fake.api, self.fake.web), (A_API, A_WEB))
        self.assertEqual(self.control.state()['active']['apiId'], A_API)

    def test_timeout_and_invalid_identifier(self):
        with self.assertRaises(remote.Blocked):
            self.control.signed('release', '../arbitrary-command')
        with self.assertRaisesRegex(remote.Blocked, 'Unknown operation'):
            self.control.execute('docker')
        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired(args, 1)
        self.control.runner = timeout
        with self.assertRaises(remote.Blocked):
            self.control.call(['docker', 'pull', B_API], timeout=1)

    def test_secret_drift_and_remote_docker_context_block(self):
        document, _ = self.release()
        secret = self.root / 'secrets' / remote.SECRET_NAMES[0]
        secret.write_bytes(b'drifted-synthetic-secret')
        with self.assertRaisesRegex(remote.Blocked, 'Mounted GEOPS secret differs'):
            self.control.execute('preflight', document['id'])
        secret.write_bytes(('synthetic-' + remote.SECRET_NAMES[0]).encode())
        self.fake.endpoint = 'tcp://elsewhere:2375'
        with self.assertRaisesRegex(remote.Blocked, 'local Docker daemon'):
            self.control.execute('preflight', document['id'])

    def test_expired_signed_release_blocks(self):
        document, _ = self.release()
        document['notBefore'] = '2026-01-01T00:00:00Z'
        document['expiresAt'] = '2026-01-01T00:20:00Z'
        self.sign('release', document)
        with self.assertRaisesRegex(remote.Blocked, 'outside approval window'):
            self.control.execute('preflight', document['id'])

    @unittest.skipIf(remote.fcntl is None, 'POSIX flock unavailable on this host')
    def test_concurrent_operation_is_rejected(self):
        lock_path = self.state / 'lock'
        with lock_path.open('wb') as held:
            remote.fcntl.flock(held, remote.fcntl.LOCK_EX | remote.fcntl.LOCK_NB)
            with patch.object(remote, 'STATE_DIR', self.state), \
                    patch.object(remote, 'secure_tree'), \
                    patch.object(remote, 'Controller', return_value=Mock()):
                with self.assertRaisesRegex(remote.Blocked, 'Another GEOPS operation'):
                    remote.main(['status'])

    def test_package_inventory_and_sudoers_scope(self):
        package = Path(self.temp.name) / 'review.tar.gz'
        package_again = Path(self.temp.name) / 'review-again.tar.gz'
        from package import build
        build(package)
        build(package_again)
        self.assertEqual(package.read_bytes(), package_again.read_bytes())
        names = archive_files(package, hashlib.sha256(package.read_bytes()).hexdigest())
        self.assertEqual(set(names), FILES)
        sudoers = names['geops-deploy.sudoers'].decode()
        self.assertIn('NOPASSWD: /usr/local/sbin/geops-deploy', sudoers)
        for forbidden in ('sudo docker', '/bin/sh', '/bin/bash', 'systemctl'):
            self.assertNotIn(forbidden, sudoers)

    def test_packaged_compose_renders_without_docker_daemon(self):
        if not shutil.which('docker'):
            self.skipTest('Docker Compose CLI not installed')
        from package import build
        package = Path(self.temp.name) / 'compose-review.tar.gz'
        build(package)
        items = archive_files(package, hashlib.sha256(package.read_bytes()).hexdigest())
        layout = Path(self.temp.name) / 'installed-layout'
        for name, content in items.items():
            if name.startswith('bundle/'):
                target = layout / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
        secrets = layout / 'bundle/infrastructure/compose/.local/staging/secrets'
        secrets.mkdir(parents=True)
        for name in remote.SECRET_NAMES:
            (secrets / name).write_bytes(('synthetic-' + name).encode())
        env = os.environ | {
            'GEOPS_STAGE_SECRET_GID': '24001',
            'GEOPS_STAGE_IMAGE_TAG': A_COMMIT,
            'GEOPS_STAGE_ORIGIN': 'https://geops-staging.duckdns.org',
            'GEOPS_STAGE_API_IMAGE_REF': B_API,
            'GEOPS_STAGE_WEB_IMAGE_REF': B_WEB,
        }
        compose = layout / 'bundle/infrastructure/compose'
        result = subprocess.run(['docker', 'compose', '-f', compose / 'compose.staging.yaml',
                                 '-f', compose / 'compose.staging.digest.override.yaml',
                                 'config', '--format', 'json'], env=env, capture_output=True,
                                text=True, timeout=30, check=True)
        config = json.loads(result.stdout)
        self.assertEqual(config['name'], remote.ENVIRONMENT)
        self.assertEqual(config['services']['geops-api']['image'], B_API)
        self.assertEqual(config['services']['geops-web']['image'], B_WEB)

    def test_signer_produces_verifiable_release_and_approval(self):
        if not shutil.which('node'):
            self.skipTest('Node not installed')
        migrations = sorted((SOURCE / 'apps/api/src/db/migrations').glob('[0-9][0-9][0-9][0-9]_*.sql'))
        manifest = {'schemaVersion': 3, 'ci': {'result': 'success'},
                    'migration': 'none', 'commit': B_COMMIT,
                    'migrations': [{'version': f.name,
                                    'sha256': hashlib.sha256(f.read_bytes()).hexdigest()}
                                   for f in migrations],
                    'webBuild': {'gpsBase': {'variant': 'gps-base', 'mdmEnabled': False}},
                    'images': {'api': B_API, 'web': {'gpsBase': B_WEB}}}
        path = Path(self.temp.name) / 'manifest.json'
        path.write_text(json.dumps(manifest))
        identity = 'signed_release_test_001'
        output = self.state / 'inbox' / identity
        subprocess.run(['node', HERE / 'sign.mjs', 'release', '--id', identity,
                        '--policy', self.root / 'policy.json', '--manifest', path,
                        '--key', self.private, '--out', output], check=True, capture_output=True)
        self.control.load_policy()
        release, release_sha = self.control.release(identity)
        self.assertEqual(release['commit'], B_COMMIT)
        old = self.control.state()['active']
        approval_id = 'signed_approval_test_001'
        target = {'apiId': B_API.split('@')[-1], 'webId': B_WEB.split('@')[-1]}
        subprocess.run(['node', HERE / 'sign.mjs', 'approval', '--id', approval_id,
                        '--policy', self.root / 'policy.json', '--action', 'deploy',
                        '--release-sha', release_sha, '--source-api-id', old['apiId'],
                        '--source-web-id', old['webId'], '--target-api-id', target['apiId'],
                        '--target-web-id', target['webId'], '--key', self.private,
                        '--out', self.state / 'inbox' / approval_id], check=True, capture_output=True)
        self.control.approval(approval_id, 'deploy', release_sha, old, target)


if __name__ == '__main__':
    unittest.main()
