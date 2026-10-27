"""Lab-only READY installer exercise with synthetic trust and registry inputs."""

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def sha(body):
    return hashlib.sha256(body).hexdigest()


def run(package, installer_source, private_key, public_key):
    if sys.platform != 'linux' or os.geteuid() != 0:
        raise RuntimeError('Disposable Linux root required')
    spec = importlib.util.spec_from_file_location('stage_installer', installer_source)
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    with tempfile.TemporaryDirectory(prefix='b30-stage-ready-', dir='/opt') as folder:
        base = Path(folder)
        for part in ('usr/local/sbin', 'etc/geops-deploy-v2', 'etc/sudoers.d',
                     'var/lib/geops-deploy', 'var/lib', 'opt'):
            (base / part).mkdir(parents=True, exist_ok=True)
        layout = installer.Layout(base)
        for path in (layout.bundle.parent, layout.wrapper.parent, layout.sudoers.parent,
                     layout.state.parent, layout.v2_policy.parent, layout.v2_state.parent):
            os.chmod(path, 0o700)
        layout.v2_wrapper.write_bytes(b'#!/bin/sh\n[ "$1" = verify ]\n')
        os.chmod(layout.v2_wrapper, 0o755)
        layout.v2_policy.write_bytes(json.dumps({
            'schemaVersion': 2, 'profiles': {'B23-mdm': {'sqlCount': 23}}}).encode())
        layout.v2_rule.write_bytes(installer.V2_RULE)
        layout.v2_state.write_bytes(json.dumps({
            'schemaVersion': 2, 'phase': 'steady', 'pending': None,
            'active': {'profile': 'B23-mdm'}}).encode())
        old_wrapper = sha(layout.v2_wrapper.read_bytes())
        old_policy = sha(layout.v2_policy.read_bytes())
        archive = base / 'ready.tar.gz'
        pub = base / 'public.pem'
        sig = base / 'ready.sig'
        shutil.copyfile(package, archive)
        shutil.copyfile(public_key, pub)
        policy = installer.archive_items(archive.read_bytes())[1]
        assert policy['sourceB23'] == {'wrapperSha256': old_wrapper,
                                       'policySha256': old_policy}
        digest = sha(archive.read_bytes())
        msg = base / 'message'
        msg.write_bytes(f'GEOPS-B30-STAGING-PACKAGE-SHA256\n{digest}\n'.encode())
        subprocess.run(['openssl', 'pkeyutl', '-sign', '-inkey', str(private_key),
                        '-rawin', '-in', str(msg), '-out', str(sig)], check=True)
        for file in (archive, pub, sig):
            os.chmod(file, 0o600)
        checks = []
        try:
            installer.install(layout, archive, sig, pub, digest, sha(pub.read_bytes()),
                              source='clean')
        except installer.Blocked:
            checks.append('ready-clean-over-b23-rejected')
        else:
            raise AssertionError('READY clean mode accepted')
        result = installer.install(layout, archive, sig, pub, digest, sha(pub.read_bytes()),
                                   source='from-b23', old_wrapper_sha=old_wrapper,
                                   old_policy_sha=old_policy)
        assert result['activation'] == 'READY' and result['result'] == 'B30_STAGING_PACKAGE_READY'
        checks.append('signed-ready-from-b23-installed')
        assert layout.sudoers.read_bytes() == installer.STAGING_READY_RULE
        checks.append('ready-sudoers-exact')
        assert layout.v2_rule.read_bytes() == installer.V2_RULE
        checks.append('legacy-b23-preserved-before-promotion')
        assert installer.install(layout, archive, sig, pub, digest, sha(pub.read_bytes()),
                                 source='from-b23', old_wrapper_sha=old_wrapper,
                                 old_policy_sha=old_policy) == result
        checks.append('ready-install-idempotent')
        try:
            installer.install(layout, archive, sig, pub, digest, '0' * 64,
                              source='from-b23', old_wrapper_sha=old_wrapper,
                              old_policy_sha=old_policy)
        except installer.Blocked:
            checks.append('different-trust-key-rejected')
        else:
            raise AssertionError('Wrong trust key accepted')
        live = installer.Layout()
        for parent in (live.bundle.parent, live.wrapper.parent, live.sudoers.parent,
                       live.state.parent, live.v2_policy.parent, live.v2_state.parent):
            parent.mkdir(parents=True, exist_ok=True)
        live.v2_wrapper.write_bytes(layout.v2_wrapper.read_bytes())
        os.chmod(live.v2_wrapper, 0o755)
        live.v2_policy.write_bytes(layout.v2_policy.read_bytes())
        live.v2_rule.write_bytes(installer.V2_RULE)
        os.chmod(live.v2_rule, 0o440)
        live.v2_state.write_bytes(layout.v2_state.read_bytes())
        installer.install(live, archive, sig, pub, digest, sha(pub.read_bytes()),
                          source='from-b23', old_wrapper_sha=old_wrapper,
                          old_policy_sha=old_policy)
        subprocess.run(['useradd', '-m', 'abi'], check=True)
        checked = subprocess.run(['/usr/sbin/visudo', '-c'], capture_output=True, text=True)
        assert checked.returncode == 0, checked.stderr
        checks.append('ready-sudoers-real-visudo')
        checked = subprocess.run(['sudo', '-u', 'abi', 'sudo', '-n',
                                  '/usr/local/sbin/geops-b30-staging', 'doctor'],
                                 capture_output=True, text=True)
        assert checked.returncode == 0 and json.loads(checked.stdout)['activation'] == 'READY'
        checks.append('ready-sudo-doctor')
        for command in (['sudo', '-u', 'abi', 'sudo', '-n', '/bin/sh'],
                        ['sudo', '-u', 'abi', 'sudo', '-n',
                         '/usr/local/sbin/geops-b30-staging', 'upgrade']):
            assert subprocess.run(command, capture_output=True).returncode != 0
        checks.append('ready-shell-and-unknown-command-denied')
        return {'result': 'B30_STAGING_READY_INSTALLER_ISOLATED_PASS',
                'checks': len(checks), 'cases': checks, 'stagingChanged': False}


if __name__ == '__main__':
    if len(sys.argv) != 5:
        raise SystemExit('Usage: test_ready_linux.py PACKAGE INSTALLER LAB_PRIVATE LAB_PUBLIC')
    print(json.dumps(run(*map(Path, sys.argv[1:])), sort_keys=True))
