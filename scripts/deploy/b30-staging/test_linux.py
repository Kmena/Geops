"""Disposable Linux root/sudo exercise; the Ed25519 key exists only inside this test."""

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def command(*args, success=True):
    result = subprocess.run(args, capture_output=True, text=True, timeout=30)
    if (result.returncode == 0) != success:
        raise AssertionError(f'{args}: {result.returncode}: {result.stderr[-800:]}')
    return result


def fixture(installer, base):
    layout = installer.Layout(base)
    for parent in (layout.bundle.parent, layout.wrapper.parent, layout.sudoers.parent,
                   layout.state.parent, layout.v2_policy.parent, layout.v2_state.parent):
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(parent, 0o700)
    return layout


def run(package, installer_source):
    if os.geteuid() != 0 or sys.platform != 'linux':
        raise RuntimeError('Disposable Linux root required')
    home = Path('/root/geops-b30-stage-test')
    home.mkdir(mode=0o700, exist_ok=True)
    archive = home / 'package.tar.gz'
    source = home / 'install.py'
    shutil.copyfile(package, archive)
    shutil.copyfile(installer_source, source)
    os.chmod(source, 0o500)
    key = home / 'synthetic-test-only-private.pem'
    pub = home / 'synthetic-test-only-public.pem'
    sig = home / 'synthetic-test-only.sig'
    command('openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(key))
    command('openssl', 'pkey', '-in', str(key), '-pubout', '-out', str(pub))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    message = home / 'message'
    message.write_bytes(f'GEOPS-B30-STAGING-PACKAGE-SHA256\n{digest}\n'.encode())
    command('openssl', 'pkeyutl', '-sign', '-inkey', str(key), '-rawin',
            '-in', str(message), '-out', str(sig))
    key.unlink()
    os.chmod(home, 0o700)
    for path in (archive, pub, sig):
        os.chmod(path, 0o600)
    spec = importlib.util.spec_from_file_location('stage_installer', source)
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    pub_sha = hashlib.sha256(pub.read_bytes()).hexdigest()
    checks = []

    installer.verify_signature(archive.read_bytes(), sig.read_bytes(), pub, digest, pub_sha)
    checks.append('ephemeral-ed25519-valid')
    for name, signature, package_sha, key_sha in (
        ('forged-signature', b'0' * 64, digest, pub_sha),
        ('wrong-package-sha', sig.read_bytes(), '0' * 64, pub_sha),
        ('wrong-public-key-pin', sig.read_bytes(), digest, '0' * 64),
    ):
        try:
            installer.verify_signature(archive.read_bytes(), signature, pub, package_sha, key_sha)
        except installer.Blocked:
            checks.append(name + '-rejected')
        else:
            raise AssertionError(name + ' accepted')

    command('useradd', '-m', 'abi')
    result = installer.install(installer.Layout(), archive, sig, pub, digest, pub_sha)
    assert result['result'] == 'B30_STAGING_PACKAGE_PREPARED'
    checks.append('clean-root-install-prepared')
    command('/usr/sbin/visudo', '-c')
    checks.append('real-visudo')
    doctor = command('sudo', '-u', 'abi', 'sudo', '-n',
                     '/usr/local/sbin/geops-b30-staging', 'doctor')
    assert json.loads(doctor.stdout)['activation'] == 'DISABLED'
    checks.append('sudo-doctor')
    command('sudo', '-u', 'abi', 'sudo', '-n',
            '/usr/local/sbin/geops-b30-staging', 'upgrade', success=False)
    command('sudo', '-u', 'abi', 'sudo', '-n', '/bin/sh', success=False)
    checks.append('sudo-upgrade-and-shell-denied')
    assert installer.install(installer.Layout(), archive, sig, pub, digest, pub_sha) == result
    checks.append('idempotent-reinstall')
    policy = Path('/opt/geops-b30-staging/policy.json')
    body = policy.read_bytes()
    policy.write_bytes(body + b' ')
    command('sudo', '-u', 'abi', 'sudo', '-n',
            '/usr/local/sbin/geops-b30-staging', 'doctor', success=False)
    policy.write_bytes(body)
    checks.append('guard-detects-tamper')

    with tempfile.TemporaryDirectory(prefix='geops-b30-stage-fixture-', dir='/opt') as folder:
        layout = fixture(installer, Path(folder))
        def interrupt(phase):
            if phase == 'after-bundle':
                raise RuntimeError('INJECTED_AFTER_BUNDLE')
        try:
            installer.install(layout, archive, sig, pub, digest, pub_sha, fault=interrupt)
        except RuntimeError as error:
            assert str(error) == 'INJECTED_AFTER_BUNDLE'
        else:
            raise AssertionError('Missing injected failure')
        assert not layout.sudoers.exists()
        installer.install(layout, archive, sig, pub, digest, pub_sha)
        checks.append('recover-after-bundle')
        target = layout.bundle / 'policy.json'
        target.write_bytes(target.read_bytes() + b' ')
        try:
            installer.install(layout, archive, sig, pub, digest, pub_sha)
        except installer.Blocked:
            checks.append('installer-detects-tamper')
        else:
            raise AssertionError('Tampered bundle accepted')

    with tempfile.TemporaryDirectory(prefix='geops-b30-stage-sudo-', dir='/opt') as folder:
        layout = fixture(installer, Path(folder))
        def interrupt(phase):
            if phase == 'after-sudoers':
                raise RuntimeError('INJECTED_AFTER_SUDOERS')
        try:
            installer.install(layout, archive, sig, pub, digest, pub_sha, fault=interrupt)
        except RuntimeError as error:
            assert str(error) == 'INJECTED_AFTER_SUDOERS'
        else:
            raise AssertionError('Missing injected failure')
        assert json.loads(layout.journal.read_bytes())['phase'] == 'prepared'
        installer.install(layout, archive, sig, pub, digest, pub_sha)
        assert json.loads(layout.journal.read_bytes())['phase'] == 'prepared-complete'
        checks.append('recover-after-sudoers')

    with tempfile.TemporaryDirectory(prefix='geops-b30-stage-b23-', dir='/opt') as folder:
        layout = fixture(installer, Path(folder))
        layout.v2_wrapper.write_bytes(b'#!/bin/sh\n[ "$1" = verify ]\n')
        os.chmod(layout.v2_wrapper, 0o755)
        layout.v2_policy.write_bytes(json.dumps({
            'schemaVersion': 2, 'profiles': {'B23-mdm': {'sqlCount': 23}}}).encode())
        layout.v2_rule.write_bytes(installer.V2_RULE)
        layout.v2_state.write_bytes(json.dumps({
            'schemaVersion': 2, 'phase': 'steady', 'pending': None,
            'active': {'profile': 'B23-mdm'}}).encode())
        wrapper_sha = hashlib.sha256(layout.v2_wrapper.read_bytes()).hexdigest()
        policy_sha = hashlib.sha256(layout.v2_policy.read_bytes()).hexdigest()
        result = installer.install(layout, archive, sig, pub, digest, pub_sha,
                                   source='from-b23', old_wrapper_sha=wrapper_sha,
                                   old_policy_sha=policy_sha)
        assert result['previous']['activeProfile'] == 'B23-mdm'
        assert layout.v2_rule.read_bytes() == installer.V2_RULE
        checks.append('b23-source-preserved')
        try:
            installer.install(layout, archive, sig, pub, digest, pub_sha,
                              source='clean')
        except installer.Blocked:
            checks.append('clean-mode-over-b23-rejected')
        else:
            raise AssertionError('Clean mode accepted installed B23')
        layout.v2_rule.write_bytes(b'abi ALL=(root) NOPASSWD: ALL\n')
        try:
            installer.install(layout, archive, sig, pub, digest, pub_sha,
                              source='from-b23', old_wrapper_sha=wrapper_sha,
                              old_policy_sha=policy_sha)
        except installer.Blocked:
            checks.append('b23-permission-drift-rejected')
        else:
            raise AssertionError('B23 sudoers drift accepted')

    return {'result': 'B30_STAGING_INSTALLER_LINUX_PREPARED_PASS',
            'checks': len(checks), 'cases': checks, 'packageSha256': digest,
            'stagingChanged': False}


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: test_linux.py PACKAGE INSTALLER')
    print(json.dumps(run(Path(sys.argv[1]), Path(sys.argv[2])), sort_keys=True))
