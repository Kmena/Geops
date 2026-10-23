"""Linux-only installer and lock tests; all paths stay under a private temp tree."""

import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

import geops_deploy as remote
import install as setup


@unittest.skipUnless(os.name == 'posix' and getattr(os, 'geteuid', lambda: -1)() == 0,
                     'isolated Linux root required')
class LinuxIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='geops-p0-audit-', dir='/root')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)

    def test_nonblocking_lock_rejects_concurrent_entry(self):
        state = self.base / 'state'
        state.mkdir(mode=0o700)
        lock = state / 'lock'
        with lock.open('wb') as held:
            remote.fcntl.flock(held, remote.fcntl.LOCK_EX | remote.fcntl.LOCK_NB)
            with patch.object(remote, 'STATE_DIR', state), \
                    patch.object(remote, 'Controller', return_value=Mock()):
                with self.assertRaisesRegex(remote.Blocked, 'Another GEOPS operation'):
                    remote.main(['status'])

    def test_untrusted_symlinks_and_writable_ancestors_block(self):
        target = self.base / 'payload'
        target.write_bytes(b'harmless test data')
        link = self.base / 'payload-link'
        link.symlink_to(target)
        with self.assertRaises(OSError):
            remote.regular_bytes(link)
        with self.assertRaises(remote.Blocked):
            remote.secure_tree(link)
        with self.assertRaises(OSError):
            setup.archive_files(link, hashlib.sha256(target.read_bytes()).hexdigest())
        writable = self.base / 'writable'
        writable.mkdir(mode=0o775)
        writable.chmod(0o775)
        (writable / 'file').write_bytes(b'harmless test data')
        with self.assertRaises(remote.Blocked):
            remote.secure_tree(writable / 'file')

    def test_partial_install_rejects_tampering_then_resumes(self):
        root = self.base / 'etc/geops-deploy'
        state = self.base / 'var/lib/geops-deploy'
        log = self.base / 'var/log/geops-deploy'
        wrapper = self.base / 'usr/local/sbin/geops-deploy'
        sudoers = self.base / 'etc/sudoers.d/geops-deploy'
        for parent in (root.parent, state.parent, log.parent):
            parent.mkdir(parents=True, mode=0o755, exist_ok=True)
        root.mkdir(mode=0o700)
        secrets = root / 'secrets'
        secrets.mkdir(mode=0o700)
        for name in setup.SECRET_NAMES:
            secret = secrets / name
            secret.write_bytes(('synthetic-' + name).encode())
            os.chown(secret, 0, 0)
            secret.chmod(0o600)
        public_key = self.base / 'approval.pub'
        public_key.write_bytes(b'isolated-test-public-key')
        public_key.chmod(0o600)

        bundle = {name: ('synthetic ' + name).encode()
                  for name in setup.FILES if name.startswith('bundle/')}
        policy = {'environment': 'geops-spec02-staging', 'secretGid': '24001',
                  'files': {name.removeprefix('bundle/'): hashlib.sha256(data).hexdigest()
                            for name, data in bundle.items()}}
        items = bundle | {
            'geops_deploy.py': b'#!/usr/bin/python3 -I\n',
            'policy.json': json.dumps(policy).encode(),
            'state.json': b'{"schemaVersion":1,"active":{"apiId":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}\n',
            'geops-deploy.sudoers': b'abi ALL=(root) NOPASSWD: /usr/local/sbin/geops-deploy\n',
        }
        archive = self.base / 'reviewed.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            for name, data in sorted(items.items()):
                member = tarfile.TarInfo(name)
                member.size = len(data)
                tar.addfile(member, io.BytesIO(data))
        archive_sha = hashlib.sha256(archive.read_bytes()).hexdigest()
        attempts = {'verify': 0}
        executed = []

        def checked_command(args, **_kwargs):
            executed.append(tuple(map(str, args)))
            if args[:3] == ['/usr/bin/docker', 'run', '--rm']:
                return json.dumps([hashlib.sha256(('synthetic-' + name).encode()).hexdigest()
                                   for name in setup.SECRET_NAMES])
            if str(args[0]) == str(wrapper) and args[1] == 'verify':
                attempts['verify'] += 1
                if attempts['verify'] == 1:
                    raise ValueError('Synthetic read-only verification failure')
            return ''

        overrides = (patch.object(setup, 'ROOT', root),
                     patch.object(setup, 'STATE', state),
                     patch.object(setup, 'LOG', log),
                     patch.object(setup, 'WRAPPER', wrapper),
                     patch.object(setup, 'SUDOERS', sudoers),
                     patch.object(setup, 'SECRETS', secrets),
                     patch.object(setup, 'RUNTIME_SECRETS', root / 'runtime-secrets'),
                     patch.object(setup, 'verify_host_tool'),
                     patch.object(setup, 'inspect_baseline'),
                     patch.object(setup, 'command', side_effect=checked_command),
                     patch.object(setup.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=42)))
        for override in overrides:
            override.start()
            self.addCleanup(override.stop)

        root.chmod(0o755)
        with self.assertRaisesRegex(ValueError, 'root-only'):
            setup.verify_secrets()
        root.chmod(0o700)

        original = secrets / setup.SECRET_NAMES[0]
        os.chown(original, 0, 24001)
        original.chmod(0o640)
        with self.assertRaisesRegex(ValueError, 'Invalid provisioned secret file'):
            setup.verify_secrets()
        os.chown(original, 0, 0)
        original.chmod(0o600)

        with self.assertRaisesRegex(ValueError, 'Synthetic read-only verification failure'):
            setup.install(archive, archive_sha, public_key)
        self.assertFalse(sudoers.exists())
        self.assertTrue(wrapper.exists())
        audit = log / 'audit.jsonl'
        audit.write_text('retained audit entry\n')
        audit.chmod(0o600)

        config = root / 'bundle/infrastructure/nginx/geops-staging-web.conf'
        config.chmod(0o644)
        config.write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'differs from reviewed archive'):
            setup.install(archive, archive_sha, public_key)
        self.assertFalse(sudoers.exists())
        config.write_bytes(items['bundle/infrastructure/nginx/geops-staging-web.conf'])
        config.chmod(0o444)

        setup.install(archive, archive_sha, public_key)
        self.assertEqual(stat.S_IMODE((secrets / setup.SECRET_NAMES[0]).stat().st_mode), 0o600)
        self.assertEqual((secrets / setup.SECRET_NAMES[0]).stat().st_gid, 0)
        runtime = root / 'runtime-secrets'
        self.assertEqual(stat.S_IMODE(runtime.stat().st_mode), 0o700)
        self.assertEqual((runtime / setup.SECRET_NAMES[0]).stat().st_gid, 24001)
        self.assertEqual(stat.S_IMODE((runtime / setup.SECRET_NAMES[0]).stat().st_mode), 0o640)
        self.assertEqual((runtime / setup.SECRET_NAMES[0]).read_bytes(),
                         (secrets / setup.SECRET_NAMES[0]).read_bytes())
        (runtime / setup.SECRET_NAMES[0]).chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'Runtime secret differs'):
            setup.provision_runtime_secrets(24001)
        (runtime / setup.SECRET_NAMES[0]).chmod(0o640)
        self.assertEqual(audit.read_text(), 'retained audit entry\n')
        self.assertEqual(stat.S_IMODE(wrapper.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(sudoers.stat().st_mode), 0o440)
        self.assertEqual((state / 'inbox').stat().st_gid, 42)
        runs = [args for args in executed if args[:3] == ('/usr/bin/docker', 'run', '--rm')]
        self.assertEqual(len(runs), 2)
        self.assertTrue(all('--network' in args and 'none' in args and
                            '--pull' in args and 'never' in args and
                            args.count('--mount') == len(setup.SECRET_NAMES)
                            for args in runs))
        self.assertFalse(any(args[0] == '/usr/bin/docker' and args[1] == 'compose'
                             for args in executed))
        with self.assertRaisesRegex(ValueError, 'Sudoers already installed'):
            setup.install(archive, archive_sha, public_key)

    def test_abi_group_cannot_read_root_secrets_or_runtime_tree(self):
        with tempfile.TemporaryDirectory(prefix='geops-p0-dac-', dir='/tmp') as folder:
            root = Path(folder)
            root.chmod(0o755)
            admin = root / 'etc-geops-deploy'
            admin.mkdir(mode=0o700)
            secrets = admin / 'secrets'
            secrets.mkdir(mode=0o700)
            runtime = admin / 'runtime-secrets'
            runtime.mkdir(mode=0o700)
            master = secrets / 'db_password'
            master.write_bytes(b'synthetic-secret')
            master.chmod(0o600)
            mount_source = runtime / 'db_password'
            mount_source.write_bytes(b'synthetic-secret')
            os.chown(mount_source, 0, 24001)
            mount_source.chmod(0o640)
            mounted = root / 'container-bind-view'
            os.link(mount_source, mounted)

            child = os.fork()
            if child == 0:
                try:
                    os.setgroups([24001])
                    os.setgid(1001)
                    os.setuid(1001)
                    for path in (master, mount_source):
                        try:
                            path.read_bytes()
                        except PermissionError:
                            continue
                        os._exit(2)
                    if mounted.read_bytes() != b'synthetic-secret':
                        os._exit(3)
                    os._exit(0)
                except Exception:
                    os._exit(4)
            _, status = os.waitpid(child, 0)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0)
            self.assertEqual(master.read_bytes(), mount_source.read_bytes())
            self.assertEqual(remote.regular_bytes(master, 4096, trusted=True),
                             remote.regular_bytes(mounted, 4096, trusted=True))


if __name__ == '__main__':
    unittest.main()
