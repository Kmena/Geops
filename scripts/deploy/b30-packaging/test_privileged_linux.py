"""Disposable Linux root/sudoers exercise for the signed B30 lab package."""

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def command(args, *, success=True):
    result = subprocess.run(args, capture_output=True, text=True, check=False, timeout=30)
    if (result.returncode == 0) != success:
        raise AssertionError(f'{args}: {result.returncode}: {result.stderr[-1000:]}')
    return result


def copy_protected(source, target, mode):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    os.chown(target, 0, 0)
    os.chmod(target, mode)
    return target


def fixture_layout(installer, base):
    layout = installer.Layout(base)
    for path in (layout.bundle.parent, layout.wrapper.parent,
                 layout.sudoers.parent, layout.state.parent,
                 layout.v2_policy.parent, layout.v2_state.parent):
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(path, 0o700)
    return layout


def run(package, signature, public, installer_source):
    if os.geteuid() != 0 or os.name != 'posix':
        raise RuntimeError('Disposable Linux root required')
    protected = Path('/root/geops-b30-test-input')
    protected.mkdir(mode=0o700, exist_ok=True)
    archive = copy_protected(package, protected / 'package.tar.gz', 0o600)
    sig = copy_protected(signature, protected / 'package.sig', 0o600)
    pub = copy_protected(public, protected / 'public.pem', 0o600)
    installed_source = copy_protected(installer_source, protected / 'install.py', 0o500)
    spec = importlib.util.spec_from_file_location('b30_installer', installed_source)
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checks = []

    installer.verify_signature(archive.read_bytes(), sig.read_bytes(), pub, digest)
    checks.append('valid-signature')
    try:
        installer.verify_signature(archive.read_bytes(), b'0' * 64, pub, digest)
    except installer.Blocked:
        checks.append('forged-signature-rejected')
    else:
        raise AssertionError('Forged signature was accepted')
    try:
        installer.verify_signature(archive.read_bytes(), sig.read_bytes(), pub, '0' * 64)
    except installer.Blocked:
        checks.append('wrong-hash-rejected')
    else:
        raise AssertionError('Wrong package digest was accepted')

    if not command(['id', 'abi'], success=False).returncode:
        raise AssertionError('Test user unexpectedly exists')
    command(['useradd', '-m', 'abi'])
    actual = installer.install(installer.Layout(), archive, sig, pub, digest, source='clean')
    assert actual['result'] == 'B30_PRIVILEGED_LAB_INSTALLED'
    checks.append('clean-root-install')
    command(['/usr/sbin/visudo', '-c'])
    checks.append('real-visudo')
    doctor = command(['sudo', '-u', 'abi', 'sudo', '-n',
                      '/usr/local/sbin/geops-b30-lab', 'doctor'])
    assert json.loads(doctor.stdout)['publicationReady'] is False
    checks.append('real-sudo-doctor')
    command(['sudo', '-u', 'abi', 'sudo', '-n', '/usr/local/sbin/geops-b30-lab', 'init'],
            success=False)
    command(['sudo', '-u', 'abi', 'sudo', '-n', '/bin/sh'], success=False)
    checks.append('sudo-command-boundary')
    assert installer.install(installer.Layout(), archive, sig, pub, digest,
                             source='clean')['result'] == 'B30_PRIVILEGED_LAB_INSTALLED'
    checks.append('idempotent-reinstall')
    policy = Path('/opt/geops-b30-lab/policy.json')
    original = policy.read_bytes()
    policy.write_bytes(original + b' ')
    command(['sudo', '-u', 'abi', 'sudo', '-n',
             '/usr/local/sbin/geops-b30-lab', 'doctor'], success=False)
    policy.write_bytes(original)
    checks.append('runtime-tamper-rejected')

    with tempfile.TemporaryDirectory(prefix='geops-b30-fixture-', dir='/opt') as tmp:
        base = Path(tmp)
        layout = fixture_layout(installer, base)
        def interrupt(phase):
            if phase == 'after-bundle':
                raise RuntimeError('INJECTED_AFTER_BUNDLE')
        try:
            installer.install(layout, archive, sig, pub, digest, fault=interrupt)
        except RuntimeError as error:
            assert str(error) == 'INJECTED_AFTER_BUNDLE'
        else:
            raise AssertionError('Injected installer interruption did not occur')
        assert not layout.sudoers.exists()
        installer.install(layout, archive, sig, pub, digest)
        assert layout.journal.exists() and layout.sudoers.exists()
        checks.append('resume-after-bundle')
        package_policy = layout.bundle / 'policy.json'
        package_policy.write_bytes(package_policy.read_bytes() + b' ')
        try:
            installer.install(layout, archive, sig, pub, digest)
        except installer.Blocked:
            checks.append('installed-tamper-rejected')
        else:
            raise AssertionError('Installed bundle tamper was accepted')

    with tempfile.TemporaryDirectory(prefix='geops-b30-sudo-', dir='/opt') as tmp:
        layout = fixture_layout(installer, Path(tmp))
        def interrupt_sudo(phase):
            if phase == 'after-sudoers':
                raise RuntimeError('INJECTED_AFTER_SUDOERS')
        try:
            installer.install(layout, archive, sig, pub, digest, fault=interrupt_sudo)
        except RuntimeError as error:
            assert str(error) == 'INJECTED_AFTER_SUDOERS'
        else:
            raise AssertionError('Injected sudoers interruption did not occur')
        assert layout.sudoers.exists() and \
            json.loads(layout.journal.read_bytes())['phase'] == 'prepared'
        installer.install(layout, archive, sig, pub, digest)
        assert json.loads(layout.journal.read_bytes())['phase'] == 'active'
        checks.append('resume-after-sudoers')

    with tempfile.TemporaryDirectory(prefix='geops-b30-b23-', dir='/opt') as tmp:
        base = Path(tmp)
        layout = fixture_layout(installer, base)
        layout.v2_wrapper.write_bytes(b'#!/bin/sh\n[ "$1" = verify ]\n')
        os.chmod(layout.v2_wrapper, 0o755)
        old_policy = {'schemaVersion': 2, 'profiles': {'B23-mdm': {'sqlCount': 23}}}
        layout.v2_policy.write_bytes((json.dumps(old_policy) + '\n').encode())
        os.chmod(layout.v2_policy, 0o444)
        layout.v2_rule.write_bytes(installer.V2_RULE)
        os.chmod(layout.v2_rule, 0o440)
        layout.v2_state.write_bytes((json.dumps({
            'schemaVersion': 2, 'phase': 'steady', 'pending': None,
            'active': {'profile': 'B23-mdm'}}) + '\n').encode())
        os.chmod(layout.v2_state, 0o600)
        old_wrapper_sha = hashlib.sha256(layout.v2_wrapper.read_bytes()).hexdigest()
        old_policy_sha = hashlib.sha256(layout.v2_policy.read_bytes()).hexdigest()
        result = installer.install(layout, archive, sig, pub, digest, source='from-b23',
                                   old_wrapper_sha=old_wrapper_sha,
                                   old_policy_sha=old_policy_sha)
        assert result['previous']['activeProfile'] == 'B23-mdm'
        assert layout.v2_rule.read_bytes() == installer.V2_RULE
        checks.append('b23-source-preserved')
        layout.v2_rule.write_bytes(b'abi ALL=(root) NOPASSWD: ALL\n')
        try:
            installer.install(layout, archive, sig, pub, digest, source='from-b23',
                              old_wrapper_sha=old_wrapper_sha,
                              old_policy_sha=old_policy_sha)
        except installer.Blocked:
            checks.append('b23-permission-drift-rejected')
        else:
            raise AssertionError('Changed B23 sudoers rule was accepted')

    return {'result': 'B30_PRIVILEGED_LINUX_LAB_PASS',
            'checks': len(checks), 'cases': checks, 'packageSha256': digest}


if __name__ == '__main__':
    if len(sys.argv) != 5:
        raise SystemExit('Usage: test_privileged_linux.py PACKAGE SIG PUB INSTALLER')
    print(json.dumps(run(*(Path(arg) for arg in sys.argv[1:])), sort_keys=True))
