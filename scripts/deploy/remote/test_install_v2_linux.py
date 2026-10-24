"""Run as root inside a disposable Linux container; never targets Staging."""

import hashlib
import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location('geops_install_v2', Path(__file__).with_name('install-v2.py'))
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)
PACKAGE = Path(os.environ.get('GEOPS_V2_TEST_PACKAGE', '/absent-package'))
SIGNER = Path(__file__).with_name('sign-package-v2.mjs')
V1_SOURCE = Path(__file__).with_name('geops_deploy.py')


def file(path, data, mode, gid=0):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    os.chown(path, 0, gid)
    os.chmod(path, mode)


class Fixture:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix='geops-install-v2-', dir='/opt')
        self.base = Path(self.temp.name)
        os.chmod(self.base, 0o755)  # Let abi reach the v2 root and test its 0700 boundary.
        self.layout = installer.Layout(self.base)
        self.events = []
        self.ledger = 21
        self.drift = False
        with tarfile.open(PACKAGE, 'r:gz') as archive:
            self.v2_policy = json.load(archive.extractfile('policy.json'))
        self.old_policy = {
            'schemaVersion': 1, 'environment': 'geops-spec02-staging',
            'origin': self.v2_policy['origin'], 'secretGid': '24001',
            'imageTag': self.v2_policy['imageTag'], 'sqlCount': 21,
            'sqlListSha256': installer.A21_HASH, 'variant': 'gps-base',
            'files': {}, 'backupMaxAgeSeconds': 86400,
        }
        self.state = {'schemaVersion': 1, 'active': {
            'commit': self.v2_policy['imageTag'],
            'apiRef': 'geops-spec02-api:' + self.v2_policy['imageTag'],
            'webRef': 'geops-spec02-web:' + self.v2_policy['imageTag'],
            'apiId': 'sha256:' + 'a' * 64, 'webId': 'sha256:' + 'b' * 64,
            'releaseSha256': None}, 'previous': None}
        for directory, mode in ((self.layout.old, 0o700),
                                (self.layout.old / 'secrets', 0o700),
                                (self.layout.old / 'runtime-secrets', 0o700),
                                (self.layout.state, 0o700),
                                (self.layout.state / 'tmp', 0o700)):
            directory.mkdir(parents=True, exist_ok=True)
            os.chmod(directory, mode)
        file(self.layout.old_wrapper, V1_SOURCE.read_bytes().replace(b'\r\n', b'\n'), 0o755)
        file(self.layout.old / 'policy.json', (json.dumps(self.old_policy) + '\n').encode(), 0o444)
        file(self.layout.state / 'state.json', (json.dumps(self.state) + '\n').encode(), 0o600)
        file(self.layout.sudoers, installer.V1_SUDOERS, 0o440)
        for name in installer.SECRETS:
            value = ('synthetic-' + name).encode()
            file(self.layout.old / 'secrets' / name, value, 0o600)
            file(self.layout.old / 'runtime-secrets' / name, value, 0o640, 24001)
        self.private = self.base / 'private.pem'
        subprocess.run(['/usr/bin/openssl', 'genpkey', '-algorithm', 'ED25519',
                        '-out', self.private], check=True, capture_output=True)
        public = self.base / 'public.pem'
        subprocess.run(['/usr/bin/openssl', 'pkey', '-in', self.private,
                        '-pubout', '-out', public], check=True, capture_output=True)
        file(self.layout.old / 'public.pem', public.read_bytes(), 0o444)
        self.archive = self.base / 'controller.tar.gz'
        file(self.archive, PACKAGE.read_bytes(), 0o600)
        self.digest = installer.sha(self.archive.read_bytes())
        self.sig = self.base / 'package.sig'
        subprocess.run(['node', SIGNER, self.archive, self.private, self.sig],
                       check=True, capture_output=True)
        os.chmod(self.sig, 0o600)
        self.wrapper_sha = installer.sha(self.layout.old_wrapper.read_bytes())
        self.policy_sha = installer.sha((self.layout.old / 'policy.json').read_bytes())
        self.old_bytes = (self.layout.old_wrapper.read_bytes(),
                          (self.layout.old / 'policy.json').read_bytes(),
                          (self.layout.state / 'state.json').read_bytes())

    def close(self):
        self.temp.cleanup()

    def observe(self, layout, state):
        self.events.append('observe')
        if self.ledger != 21:
            raise installer.Blocked('Synthetic ledger no longer A21')
        value = {'api': {'containerId': 'api-1', 'imageId': state['active']['apiId'],
                         'health': 'healthy'},
                 'web': {'containerId': 'web-1', 'imageId': state['active']['webId'],
                         'health': 'healthy'},
                 'db': {'containerId': 'db-1', 'imageId': 'sha256:' + 'c' * 64,
                        'health': 'healthy'},
                 'ledger': {'count': 21, 'sha256': installer.A21_HASH},
                 'gateSha256': 'd' * 64,
                 'stateSha256': installer.sha((layout.state / 'state.json').read_bytes())}
        if self.drift:
            value['api']['containerId'] = 'api-changed'
        return value

    def validate(self, layout):
        self.events.append('validate')
        assert (layout.new / 'policy.json').is_file()
        assert layout.new_wrapper.is_file()

    def preflight(self):
        self.events.append('v1-verify')

    def visudo(self, path):
        self.events.append('visudo')
        assert path.read_bytes() in (installer.V1_SUDOERS, installer.V2_SUDOERS)
        if os.environ.get('GEOPS_TEST_VISUDO_REAL') == 'YES':
            subprocess.run(['/usr/sbin/visudo', '-cf', path], check=True, capture_output=True)

    def install(self, fault=lambda _: None, expected=None):
        return installer.install(self.layout, self.archive, expected or self.digest,
                                 self.sig, self.wrapper_sha, self.policy_sha,
                                 observe=self.observe, validate=self.validate,
                                 preflight=self.preflight, visudo=self.visudo,
                                 fault=fault)

    def return_v1(self, fault=lambda _: None):
        return installer.return_v1(self.layout, self.digest, observe=self.observe,
                                   preflight=self.preflight, visudo=self.visudo,
                                   fault=fault)

    def assert_operational_unchanged(self):
        assert self.layout.old_wrapper.read_bytes() == self.old_bytes[0]
        assert (self.layout.old / 'policy.json').read_bytes() == self.old_bytes[1]
        assert (self.layout.state / 'state.json').read_bytes() == self.old_bytes[2]

    def resign_changed_member(self, name, change):
        target = self.base / 'changed.tar.gz'
        with tarfile.open(self.archive, 'r:gz') as source, tarfile.open(target, 'w:gz') as output:
            for member in source.getmembers():
                body = source.extractfile(member).read()
                if member.name == name:
                    body = change(body)
                member.size = len(body)
                output.addfile(member, io.BytesIO(body))
        os.chmod(target, 0o600)
        self.archive = target
        self.digest = installer.sha(target.read_bytes())
        self.sig = self.base / 'changed.sig'
        subprocess.run(['node', SIGNER, self.archive, self.private, self.sig],
                       check=True, capture_output=True)
        os.chmod(self.sig, 0o600)


@unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0 and PACKAGE.exists(),
                     'disposable root Linux container and synthetic package required')
class V2InstallerLinuxTests(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()

    def tearDown(self):
        self.fx.close()

    def kill_at(self, action, point):
        pid = os.fork()
        if pid == 0:
            try:
                action(lambda name: os._exit(86) if name == point else None)
            finally:
                os._exit(87)
        _, status = os.waitpid(pid, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 86)

    def test_install_is_idempotent_and_preserves_v1_and_geops_state(self):
        self.assertEqual(self.fx.install()['result'], 'V2_ACTIVE')
        self.assertEqual(self.fx.layout.sudoers.read_bytes(), installer.V2_SUDOERS)
        self.assertEqual(self.fx.install()['result'], 'ALREADY_ACTIVE')
        self.assertEqual(self.fx.return_v1()['result'], 'V1_ACTIVE')
        self.assertEqual(self.fx.return_v1()['result'], 'ALREADY_V1')
        self.fx.assert_operational_unchanged()
        self.assertEqual(stat.S_IMODE(self.fx.layout.new_wrapper.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((self.fx.layout.new / 'legacy/policy').stat().st_mode), 0o400)
        self.assertEqual(stat.S_IMODE((self.fx.layout.new / 'secrets/db_password').stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.fx.layout.new / 'runtime-secrets/db_password').stat().st_mode), 0o640)

    def test_sig_hash_and_policy_reject_before_materialization(self):
        with self.assertRaises(installer.Blocked):
            self.fx.install(expected='0' * 64)
        self.fx.sig.write_bytes(b'0' * 64)
        with self.assertRaises(installer.Blocked):
            self.fx.install()
        self.assertFalse(self.fx.layout.journal.exists())
        self.assertFalse(self.fx.layout.new.exists())
        self.assertEqual(self.fx.layout.sudoers.read_bytes(), installer.V1_SUDOERS)

    def test_wrong_v1_hash_blocks_and_world_writable_path_blocks(self):
        with self.assertRaises(installer.Blocked):
            installer.install(self.fx.layout, self.fx.archive, self.fx.digest,
                              self.fx.sig, '0' * 64, self.fx.policy_sha,
                              observe=self.fx.observe, validate=self.fx.validate,
                              preflight=self.fx.preflight, visudo=self.fx.visudo)
        os.chmod(self.fx.layout.old / 'policy.json', 0o666)
        with self.assertRaises(installer.Blocked):
            self.fx.install()
        self.assertFalse(self.fx.layout.journal.exists())

    def test_valid_signature_cannot_authorize_incompatible_policy_or_sudoers(self):
        def changed_policy(body):
            value = json.loads(body)
            value['imageTag'] = 'f' * 40
            return (json.dumps(value) + '\n').encode()
        self.fx.resign_changed_member('policy.json', changed_policy)
        with self.assertRaises(installer.Blocked):
            self.fx.install()
        self.assertFalse(self.fx.layout.journal.exists())
        fx = Fixture()
        try:
            fx.resign_changed_member('geops-deploy-v2.sudoers',
                                     lambda body: body + b'abi ALL=(root) NOPASSWD: /bin/sh\n')
            with self.assertRaises(installer.Blocked):
                fx.install()
            self.assertFalse(fx.layout.journal.exists())
        finally:
            fx.close()

    def test_every_install_cut_recovers_without_exposing_partial_v2(self):
        points = ('after-journal', 'after-file:policy.json',
                  'after-file:controller/geops_deploy_v2.py', 'before-switch',
                  'after-switch', 'after-active')
        for point in points:
            with self.subTest(point=point):
                fx = Fixture()
                try:
                    self.kill_at(fx.install, point)
                    rule = fx.layout.sudoers.read_bytes()
                    self.assertEqual(rule, installer.V2_SUDOERS if point in
                                     ('after-switch', 'after-active') else installer.V1_SUDOERS)
                    self.assertIn(fx.install()['result'], ('V2_ACTIVE', 'ALREADY_ACTIVE'))
                    self.assertEqual(fx.layout.sudoers.read_bytes(), installer.V2_SUDOERS)
                    self.assertEqual(installer.read_journal(fx.layout)['phase'], 'active')
                    fx.assert_operational_unchanged()
                finally:
                    fx.close()

    def test_repeated_recovery_cut_is_idempotent(self):
        self.kill_at(self.fx.install, 'after-file:policy.json')
        self.kill_at(self.fx.install, 'after-switch')
        self.assertEqual(self.fx.install()['result'], 'V2_ACTIVE')
        self.assertEqual(self.fx.install()['result'], 'ALREADY_ACTIVE')
        self.fx.assert_operational_unchanged()

    def test_return_cuts_recover_only_at_a21(self):
        for point in ('before-return-switch', 'after-return-switch'):
            with self.subTest(point=point):
                fx = Fixture()
                try:
                    fx.install()
                    self.kill_at(fx.return_v1, point)
                    self.assertEqual(fx.layout.sudoers.read_bytes(),
                                     installer.V2_SUDOERS if point == 'before-return-switch'
                                     else installer.V1_SUDOERS)
                    self.assertEqual(fx.return_v1()['result'], 'V1_ACTIVE')
                    self.assertEqual(installer.read_journal(fx.layout)['phase'], 'returned')
                    fx.assert_operational_unchanged()
                finally:
                    fx.close()

    def test_ledger22_forbids_v1_return(self):
        self.fx.install()
        self.fx.ledger = 22
        with self.assertRaises(installer.Blocked):
            self.fx.return_v1()
        self.assertEqual(self.fx.layout.sudoers.read_bytes(), installer.V2_SUDOERS)

    def test_return_restores_v2_rule_if_a21_changes_after_switch(self):
        self.fx.install()
        seen = 0

        def changing(layout, state):
            nonlocal seen
            seen += 1
            self.fx.drift = seen >= 3
            return self.fx.observe(layout, state)

        with self.assertRaises(installer.Blocked):
            installer.return_v1(self.fx.layout, self.fx.digest,
                                observe=changing, preflight=self.fx.preflight,
                                visudo=self.fx.visudo)
        self.assertEqual(self.fx.layout.sudoers.read_bytes(), installer.V2_SUDOERS)
        self.assertEqual(installer.read_journal(self.fx.layout)['phase'], 'active')

    def test_active_install_remains_idempotent_after_v2_state_advances(self):
        self.fx.install()
        (self.fx.layout.state / 'state.json').write_text('{"schemaVersion":2,"phase":"steady"}\n')
        self.assertEqual(self.fx.install()['result'], 'ALREADY_ACTIVE')
        with self.assertRaises(installer.Blocked):
            self.fx.return_v1()

    def test_return_accepts_a21_container_restart_after_install(self):
        self.fx.install()
        self.fx.drift = True  # A21 images, state, ledger and health remain valid.
        self.assertEqual(self.fx.return_v1()['result'], 'V1_ACTIVE')

    def test_mixed_v2_files_and_changed_baseline_block_activation(self):
        self.kill_at(self.fx.install, 'after-file:policy.json')
        (self.fx.layout.new / 'policy.json').write_bytes(b'changed')
        with self.assertRaises(installer.Blocked):
            self.fx.install()
        self.assertEqual(self.fx.layout.sudoers.read_bytes(), installer.V1_SUDOERS)
        fx = Fixture()
        try:
            calls = 0
            def changing(layout, state):
                nonlocal calls
                calls += 1
                fx.drift = calls > 1
                return fx.observe(layout, state)
            with self.assertRaises(installer.Blocked):
                installer.install(fx.layout, fx.archive, fx.digest, fx.sig,
                                  fx.wrapper_sha, fx.policy_sha, observe=changing,
                                  validate=fx.validate, preflight=fx.preflight,
                                  visudo=fx.visudo)
            self.assertEqual(fx.layout.sudoers.read_bytes(), installer.V1_SUDOERS)
        finally:
            fx.close()

    def test_sudo_rule_is_exact_and_no_arbitrary_controller_commands(self):
        self.fx.install()
        rule = self.fx.layout.sudoers.read_text()
        self.assertEqual(rule.count('NOPASSWD:'), 1)
        self.assertNotIn('/bin/sh', rule)
        self.assertNotIn('docker', rule)
        controller = Path(__file__).with_name('geops_deploy_v2.py').read_text()
        self.assertIn("'recover': 0", controller)
        self.assertIn("raise v1.Blocked('Invalid v2 operation or arguments')", controller)

    def test_installed_path_loader_rejects_arbitrary_command(self):
        installed = Path('/usr/local/sbin/geops-deploy-v2')
        base = Path('/etc/geops-deploy-v2')
        try:
            (base / 'lib').mkdir(parents=True, mode=0o700)
            file(base / 'lib/geops_deploy.py', V1_SOURCE.read_bytes(), 0o444)
            file(installed, Path(__file__).with_name('geops_deploy_v2.py').read_bytes(),
                 0o755)
            result = subprocess.run(['python3', '-I', installed, 'shell'],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn('Invalid v2 operation or arguments', result.stderr)
        finally:
            installed.unlink(missing_ok=True)
            shutil.rmtree(base, ignore_errors=True)

    def test_real_sudo_lists_only_fixed_v2_wrapper(self):
        if os.environ.get('GEOPS_TEST_VISUDO_REAL') != 'YES':
            self.skipTest('sudo is not installed in the base image')
        self.fx.install()
        subprocess.run(['useradd', '-M', 'abi'], check=True, capture_output=True)
        rule = Path('/etc/sudoers.d/geops-deploy')
        rule.write_bytes(installer.V2_SUDOERS)
        os.chmod(rule, 0o440)
        subprocess.run(['/usr/sbin/visudo', '-c'], check=True, capture_output=True)
        allowed = subprocess.run(['sudo', '-n', '-l', '-U', 'abi'],
                                 check=True, capture_output=True, text=True).stdout
        self.assertIn('/usr/local/sbin/geops-deploy-v2', allowed)
        self.assertNotIn('NOPASSWD: ALL', allowed)
        rejected = subprocess.run(['su', '-s', '/bin/sh', 'abi', '-c',
                                   'sudo -n /bin/sh -c true'],
                                  capture_output=True, text=True)
        self.assertNotEqual(rejected.returncode, 0)
        secret = self.fx.layout.new / 'runtime-secrets/db_password'
        denied = subprocess.run(['su', '-s', '/bin/sh', 'abi', '-c',
                                 f'test -r {secret}'], capture_output=True)
        self.assertNotEqual(denied.returncode, 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
