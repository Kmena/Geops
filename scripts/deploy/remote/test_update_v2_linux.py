"""Root-only disposable Linux test of signed B22/B23 v2 point updates."""

import importlib.util
import io
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('geops_install_v2', HERE / 'install-v2.py')
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)
OLD = Path(os.environ['GEOPS_V2_OLD_PACKAGE'])
NEW = Path(os.environ['GEOPS_V2_UPDATE_PACKAGE'])
VERSION = os.environ.get('GEOPS_V2_UPDATE_VERSION', 'B22')
if VERSION not in ('B22', 'B23'):
    raise ValueError('Unsupported test version')
SAFE = VERSION + '-safe'
MDM = VERSION + '-mdm'
LEDGER_HASH = installer.B22_HASH if VERSION == 'B22' else installer.B23_HASH
UPDATED_SAFE = 'V2_UPDATED_' + VERSION.upper() + '_SAFE'
UPDATED_MDM = 'V2_UPDATED_' + VERSION.upper() + '_MDM'


def write(path, body, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    os.chown(path, 0, 0)
    os.chmod(path, mode)


class Fixture:
    def __init__(self, profile=SAFE):
        self.temp = tempfile.TemporaryDirectory(prefix='geops-v2-update-', dir='/opt')
        self.layout = installer.Layout(self.temp.name)
        for path in (self.layout.old, self.layout.new, self.layout.state,
                     self.layout.state / 'tmp'):
            path.mkdir(parents=True, exist_ok=True)
            os.chmod(path, 0o700)
        with tarfile.open(OLD, 'r:gz') as archive:
            old = {member.name: archive.extractfile(member).read()
                   for member in archive.getmembers()}
        for name, path in installer.update_targets(self.layout).items():
            write(path, old[name], 0o755 if path == self.layout.new_wrapper else 0o444)
        write(self.layout.sudoers, installer.V2_SUDOERS, 0o440)
        self.private = Path(self.temp.name) / 'private.pem'
        public = Path(self.temp.name) / 'public.pem'
        subprocess.run(['/usr/bin/openssl', 'genpkey', '-algorithm', 'ED25519',
                        '-out', self.private], check=True, capture_output=True)
        subprocess.run(['/usr/bin/openssl', 'pkey', '-in', self.private,
                        '-pubout', '-out', public], check=True, capture_output=True)
        write(self.layout.old / 'public.pem', public.read_bytes(), 0o444)
        write(self.layout.new / 'public.pem', public.read_bytes(), 0o444)
        self.archive = Path(self.temp.name) / 'update.tar.gz'
        write(self.archive, NEW.read_bytes(), 0o600)
        message = Path(self.temp.name) / 'message'
        write(message, f'GEOPS-V2-PACKAGE-SHA256\n{installer.sha(NEW.read_bytes())}\n'.encode(), 0o600)
        self.signature = Path(self.temp.name) / 'update.sig'
        subprocess.run(['/usr/bin/openssl', 'pkeyutl', '-sign', '-inkey', self.private,
                        '-rawin', '-in', message, '-out', self.signature],
                       check=True, capture_output=True)
        os.chmod(self.signature, 0o600)
        self.state = {'schemaVersion': 2, 'active': {'profile': profile,
                      'apiId': 'sha256:' + 'a' * 64, 'webId': 'sha256:' + 'b' * 64},
                      'previous': ({'profile': SAFE} if profile == MDM else None),
                      'phase': 'steady', 'pending': None}
        self.state_body = (json.dumps(self.state) + '\n').encode()
        write(self.layout.state / 'state.json', self.state_body, 0o600)
        write(self.layout.journal, (json.dumps({'schemaVersion': 1, 'phase': 'active',
              'packageSha256': 'a' * 64, 'v1WrapperSha256': 'b' * 64,
              'v1PolicySha256': 'c' * 64, 'v1StateSha256': 'd' * 64,
              'v1PublicSha256': 'e' * 64, 'baseline': {}}) + '\n').encode(), 0o600)
        self.before = {name: installer.sha(installer.read_file(path,
                       mode=0o755 if path == self.layout.new_wrapper else 0o444))
                       for name, path in installer.update_targets(self.layout).items()}
        self.observations = 0
        self.validations = 0

    def close(self):
        self.temp.cleanup()

    def seed_active_previous_update(self):
        targets = installer.update_targets(self.layout)
        hashes = {name: installer.sha(installer.read_file(
            path, mode=0o755 if path == self.layout.new_wrapper else 0o444))
            for name, path in targets.items()}
        for name, path in targets.items():
            write(self.layout.update_backup / name, installer.read_file(
                path, mode=0o755 if path == self.layout.new_wrapper else 0o444), 0o400)
        prior = {'schemaVersion': 1, 'phase': 'active',
                 'packageSha256': installer.sha(OLD.read_bytes()),
                 'oldHashes': hashes, 'newHashes': hashes,
                 'baseline': self.observe(self.layout, self.state)}
        write(self.layout.update_journal, (json.dumps(prior) + '\n').encode(), 0o600)

    def observe(self, layout, state):
        self.observations += 1
        assert state == self.state
        assert (layout.state / 'state.json').read_bytes() == self.state_body
        return {'profile': self.state['active']['profile'], 'ledger': LEDGER_HASH,
                'api': self.state['active']['apiId'],
                'web': self.state['active']['webId'], 'db': 'healthy', 'gate': 'open'}

    def validate(self, layout):
        self.validations += 1
        with tarfile.open(self.archive, 'r:gz') as archive:
            policy = archive.extractfile('policy.json').read()
        assert (layout.new / 'policy.json').read_bytes() == policy
        assert (layout.state / 'state.json').read_bytes() == self.state_body

    def run(self, fault=lambda _: None):
        return installer.update_v2(self.layout, self.archive, self.signature,
                                   observe=self.observe, validate=self.validate,
                                   preflight=lambda: None,
                                   visudo=lambda path: subprocess.run(
                                       ['/usr/sbin/visudo', '-cf', str(path)],
                                       check=True, capture_output=True),
                                   fault=fault)


class UpdateTest(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()

    def tearDown(self):
        self.fx.close()

    def test_complete_and_idempotent(self):
        self.assertEqual(self.fx.run()['result'], UPDATED_SAFE)
        self.assertEqual(self.fx.run()['result'], 'ALREADY_UPDATED')
        self.assertEqual(self.fx.layout.sudoers.read_bytes(), installer.V2_SUDOERS)
        self.assertEqual(self.fx.state_body,
                         (self.fx.layout.state / 'state.json').read_bytes())
        self.assertGreaterEqual(self.fx.validations, 3)

    def test_mdm_point_update_preserves_running_profile(self):
        self.fx.close()
        self.fx = Fixture(MDM)
        self.assertEqual(self.fx.run()['result'], UPDATED_MDM)
        self.assertEqual(self.fx.run()['result'], 'ALREADY_UPDATED')
        self.assertEqual(json.loads((self.fx.layout.state / 'state.json').read_bytes()),
                         self.fx.state)

    def test_oauth_client_provisioning_is_protected_and_idempotent(self):
        self.fx.run()
        for name in ('secrets', 'runtime-secrets'):
            path = self.fx.layout.new / name
            path.mkdir(mode=0o700)
            os.chmod(path, 0o700)
        values = iter(('synthetic-client-id', 'synthetic-client-secret'))
        result = installer.provision_oauth(
            self.fx.layout, self.fx.archive, self.fx.signature,
            preflight=lambda: None, observe=self.fx.observe,
            prompt=lambda _: next(values))
        self.assertEqual(result, {'result': 'OAUTH_CLIENT_PROVISIONED'})
        for name, expected in (('mdm_client_id', b'synthetic-client-id'),
                               ('mdm_client_secret', b'synthetic-client-secret')):
            master = self.fx.layout.new / 'secrets' / name
            runtime = self.fx.layout.new / 'runtime-secrets' / name
            self.assertEqual(master.read_bytes(), expected)
            self.assertEqual(runtime.read_bytes(), expected)
            self.assertEqual(master.stat().st_mode & 0o777, 0o600)
            self.assertEqual(runtime.stat().st_mode & 0o777, 0o640)
            self.assertEqual(runtime.stat().st_gid, 24001)
        self.assertEqual(installer.provision_oauth(
            self.fx.layout, self.fx.archive, self.fx.signature,
            preflight=lambda: None, observe=self.fx.observe,
            prompt=lambda _: self.fail('Idempotent run must not prompt')),
            {'result': 'OAUTH_CLIENT_ALREADY_PROVISIONED'})
        self.assertEqual(self.fx.state_body,
                         (self.fx.layout.state / 'state.json').read_bytes())

    def test_oauth_provisioning_rejects_invalid_signature_before_prompt(self):
        self.fx.run()
        self.fx.signature.write_bytes(b'not-an-ed25519-signature')
        with self.assertRaises(installer.Blocked):
            installer.provision_oauth(
                self.fx.layout, self.fx.archive, self.fx.signature,
                preflight=lambda: None, observe=self.fx.observe,
                prompt=lambda _: self.fail('Invalid signature must not prompt'))
        self.assertFalse((self.fx.layout.new / 'secrets' / 'mdm_client_id').exists())

    def test_oauth_provisioning_rejects_conflicting_existing_copy(self):
        self.fx.run()
        for name in ('secrets', 'runtime-secrets'):
            path = self.fx.layout.new / name
            path.mkdir(mode=0o700)
            os.chmod(path, 0o700)
        write(self.fx.layout.new / 'secrets' / 'mdm_client_id', b'different-client', 0o600)
        values = iter(('synthetic-client-id', 'synthetic-client-secret'))
        with self.assertRaisesRegex(installer.Blocked, 'Existing OAuth client credential differs'):
            installer.provision_oauth(
                self.fx.layout, self.fx.archive, self.fx.signature,
                preflight=lambda: None, observe=self.fx.observe,
                prompt=lambda _: next(values))
        self.assertFalse((self.fx.layout.new / 'runtime-secrets' / 'mdm_client_id').exists())

    def test_second_update_reuses_journal_and_keeps_current_recovery_copy(self):
        self.fx.seed_active_previous_update()
        self.assertEqual(self.fx.run()['result'], UPDATED_SAFE)
        self.assertEqual(self.fx.run()['result'], 'ALREADY_UPDATED')
        journal = json.loads(self.fx.layout.update_journal.read_bytes())
        self.assertEqual(journal['phase'], 'active')
        self.assertEqual(journal['packageSha256'], installer.sha(NEW.read_bytes()))
        self.assertEqual(journal['oldHashes'], self.fx.before)
        self.assertEqual(self.fx.layout.sudoers.read_bytes(), installer.V2_SUDOERS)

    def test_second_update_recovers_during_backup_rotation(self):
        for point in ('after-update-journal', 'after-update-backup:policy.json',
                      'after-update-disabled'):
            with self.subTest(point=point):
                fx = Fixture()
                try:
                    fx.seed_active_previous_update()
                    with self.assertRaises(RuntimeError):
                        fx.run(lambda phase: (_ for _ in ()).throw(RuntimeError(phase))
                               if phase == point else None)
                    self.assertEqual(fx.run()['result'], UPDATED_SAFE)
                    self.assertEqual(fx.layout.sudoers.read_bytes(), installer.V2_SUDOERS)
                    self.assertEqual(fx.state_body, (fx.layout.state / 'state.json').read_bytes())
                finally:
                    fx.close()

    def test_second_update_recovers_after_abrupt_kill(self):
        for point in ('after-update-journal', 'after-update-backup:policy.json',
                      'after-update-disabled'):
            with self.subTest(point=point):
                fx = Fixture()
                try:
                    fx.seed_active_previous_update()
                    pid = os.fork()
                    if pid == 0:
                        fx.run(lambda phase: os._exit(42) if phase == point else None)
                        os._exit(0)
                    _, status = os.waitpid(pid, 0)
                    self.assertEqual(os.waitstatus_to_exitcode(status), 42)
                    self.assertEqual(fx.run()['result'], UPDATED_SAFE)
                    self.assertEqual(fx.run()['result'], 'ALREADY_UPDATED')
                    self.assertEqual(fx.layout.sudoers.read_bytes(), installer.V2_SUDOERS)
                finally:
                    fx.close()

    def test_second_update_rejects_damaged_previous_recovery_copy(self):
        self.fx.seed_active_previous_update()
        write(self.fx.layout.update_backup / 'policy.json', b'{}\n', 0o400)
        with self.assertRaisesRegex(installer.Blocked, 'Previous v2 recovery copy'):
            self.fx.run()
        self.assertEqual(self.fx.layout.sudoers.read_bytes(), installer.V2_SUDOERS)

    def test_installed_verify_takes_shared_lock_before_update(self):
        calls = []
        def preflight():
            fd = installer.lock_state(self.fx.layout)
            try:
                calls.append('verified')
            finally:
                os.close(fd)
        result = installer.update_v2(
            self.fx.layout, self.fx.archive, self.fx.signature,
            observe=self.fx.observe, validate=self.fx.validate,
            preflight=preflight,
            visudo=lambda path: subprocess.run(
                ['/usr/sbin/visudo', '-cf', str(path)],
                check=True, capture_output=True))
        self.assertEqual(result['result'], UPDATED_SAFE)
        self.assertEqual(calls, ['verified'])

    def test_recovery_after_each_switch(self):
        points = ['after-update-journal', 'after-update-disabled',
                  'after-update-file:policy.json',
                  'after-update-file:controller/geops_deploy_v2.py',
                  'before-update-enable', 'after-update-enable']
        for point in points:
            with self.subTest(point=point):
                fx = Fixture()
                try:
                    with self.assertRaises(RuntimeError):
                        fx.run(lambda phase: (_ for _ in ()).throw(RuntimeError(phase))
                               if phase == point else None)
                    if point not in ('after-update-journal',):
                        self.assertEqual(fx.layout.sudoers.read_bytes(),
                                         installer.UPDATE_SUDOERS if point != 'after-update-enable'
                                         else installer.V2_SUDOERS)
                    self.assertEqual(fx.run()['result'], UPDATED_SAFE)
                    self.assertEqual(fx.layout.sudoers.read_bytes(), installer.V2_SUDOERS)
                    self.assertEqual((fx.layout.state / 'state.json').read_bytes(), fx.state_body)
                finally:
                    fx.close()

    def test_invalid_signature_never_changes_sudoers(self):
        body = bytearray(self.fx.signature.read_bytes())
        body[0] ^= 1
        write(self.fx.signature, bytes(body), 0o600)
        with self.assertRaises(installer.Blocked):
            self.fx.run()
        self.assertEqual(self.fx.layout.sudoers.read_bytes(), installer.V2_SUDOERS)
        self.assertFalse(self.fx.layout.update_journal.exists())

    def test_abrupt_kill_and_repeated_recovery(self):
        for point in ('after-update-disabled', 'after-update-file:policy.json',
                      'after-update-enable'):
            with self.subTest(point=point):
                fx = Fixture()
                try:
                    pid = os.fork()
                    if pid == 0:
                        fx.run(lambda phase: os._exit(42) if phase == point else None)
                        os._exit(0)
                    _, status = os.waitpid(pid, 0)
                    self.assertEqual(os.waitstatus_to_exitcode(status), 42)
                    self.assertEqual(fx.run()['result'], UPDATED_SAFE)
                    self.assertEqual(fx.run()['result'], 'ALREADY_UPDATED')
                    self.assertEqual(fx.layout.sudoers.read_bytes(), installer.V2_SUDOERS)
                finally:
                    fx.close()

    def test_installed_file_drift_blocks_before_switch(self):
        path = self.fx.layout.new / 'policy.json'
        write(path, b'{}\n', 0o444)
        with self.assertRaises(installer.Blocked):
            self.fx.run()
        self.assertEqual(self.fx.layout.sudoers.read_bytes(), installer.V2_SUDOERS)
        self.assertFalse(self.fx.layout.update_journal.exists())

    def test_pending_update_with_changed_baseline_stays_closed(self):
        with self.assertRaises(RuntimeError):
            self.fx.run(lambda phase: (_ for _ in ()).throw(RuntimeError(phase))
                        if phase == 'after-update-disabled' else None)
        self.assertEqual(self.fx.layout.sudoers.read_bytes(), installer.UPDATE_SUDOERS)
        observe = self.fx.observe
        self.fx.observe = lambda layout, state: observe(layout, state) | {'api': 'changed'}
        with self.assertRaises(installer.Blocked):
            self.fx.run()
        self.assertEqual(self.fx.layout.sudoers.read_bytes(), installer.UPDATE_SUDOERS)

    def test_a21_is_not_an_update_source(self):
        invalid = self.fx.state | {'active': self.fx.state['active'] | {'profile': 'A21'}}
        with self.assertRaises(installer.Blocked):
            installer.observe_v2_live(self.fx.layout, invalid)


if __name__ == '__main__':
    unittest.main()
