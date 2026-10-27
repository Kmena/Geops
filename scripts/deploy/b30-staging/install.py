#!/usr/bin/python3 -I
"""Root-only prepared B30 staging installer. Never enables B30 upgrade commands."""

import fcntl
import hashlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

SHA = re.compile(r'^[a-f0-9]{64}$')
V2_RULE = (b'Defaults!/usr/local/sbin/geops-deploy-v2 env_reset\n'
           b'Defaults!/usr/local/sbin/geops-deploy-v2 secure_path="/usr/sbin:/usr/bin:/sbin:/bin"\n'
           b'abi ALL=(root) NOPASSWD: /usr/local/sbin/geops-deploy-v2\n')
STAGING_RULE = (b'Defaults!/usr/local/sbin/geops-b30-staging env_reset\n'
                b'Defaults!/usr/local/sbin/geops-b30-staging secure_path="/usr/sbin:/usr/bin:/sbin:/bin"\n'
                b'abi ALL=(root) NOPASSWD: /usr/local/sbin/geops-b30-staging doctor\n')
REQUIRED = {
    'scripts/deploy/b30-staging/guard.py',
    'scripts/deploy/b30-staging/install.py',
    'scripts/deploy/b30-staging/package.py',
    'scripts/deploy/b30-staging/sudoers',
    'scripts/deploy/b30-lab/controller.mjs',
    'scripts/deploy/remote/geops_deploy_v2.py',
    'scripts/deploy/remote/install-v2.py',
    'specs/spec-03-clients-geofences-routes/release-candidate-manifest.json',
    'node_modules/pg/package.json',
}


class Blocked(Exception):
    pass


class Layout:
    def __init__(self, base=Path('/')):
        self.base = Path(base).resolve()
        self.bundle = self.base / 'opt/geops-b30-staging'
        self.wrapper = self.base / 'usr/local/sbin/geops-b30-staging'
        self.sudoers = self.base / 'etc/sudoers.d/geops-b30-staging'
        self.state = self.base / 'var/lib/geops-b30-staging'
        self.journal = self.state / 'install.json'
        self.lock = self.state / 'install.lock'
        self.v2_wrapper = self.base / 'usr/local/sbin/geops-deploy-v2'
        self.v2_policy = self.base / 'etc/geops-deploy-v2/policy.json'
        self.v2_rule = self.base / 'etc/sudoers.d/geops-deploy'
        self.v2_state = self.base / 'var/lib/geops-deploy/state.json'


def sha(body):
    return hashlib.sha256(body).hexdigest()


def secure(path, regular=False):
    for part in (path, *path.parents):
        item = os.lstat(part)
        if stat.S_ISLNK(item.st_mode) or item.st_uid != 0 or item.st_mode & 0o022:
            raise Blocked('Unprotected administrative path')
    if regular and not stat.S_ISREG(os.lstat(path).st_mode):
        raise Blocked('Protected regular file required')


def atomic(path, body, mode):
    fd, temporary = tempfile.mkstemp(prefix='.geops-b30-stage-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchown(stream.fileno(), 0, 0)
            os.fchmod(stream.fileno(), mode)
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def verify_signature(archive, signature, public_key, digest, key_sha):
    if (not SHA.fullmatch(digest) or not SHA.fullmatch(key_sha) or
            sha(archive) != digest or len(signature) != 64 or
            sha(Path(public_key).read_bytes()) != key_sha):
        raise Blocked('Package, trust-key pin, or Ed25519 signature differs')
    with tempfile.TemporaryDirectory(prefix='geops-b30-stage-sig-') as folder:
        path = Path(folder)
        (path / 'message').write_bytes(
            f'GEOPS-B30-STAGING-PACKAGE-SHA256\n{digest}\n'.encode())
        (path / 'signature').write_bytes(signature)
        result = subprocess.run(
            ['/usr/bin/openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(public_key),
             '-rawin', '-in', str(path / 'message'), '-sigfile', str(path / 'signature')],
            stdin=subprocess.DEVNULL, capture_output=True, timeout=10, check=False)
        if result.returncode:
            raise Blocked('B30 staging package signature invalid')


def archive_items(archive):
    if len(archive) > 15_000_000:
        raise Blocked('Oversized staging package')
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as source:
        members = source.getmembers()
        names = [member.name for member in members]
        if (len(names) != len(set(names)) or len(names) > 2500 or
                'policy.json' not in names or
                any(not item.isfile() or item.size > 2_000_000 or
                    item.mode != 0o444 or item.uid != 0 or item.gid != 0 or
                    item.mtime != 0 or item.name.startswith('/') or
                    '..' in Path(item.name).parts or item.name == '.'
                    for item in members)):
            raise Blocked('Archive metadata or paths invalid')
        items = {item.name: source.extractfile(item).read() for item in members}
    policy = json.loads(items['policy.json'])
    if (policy.get('schemaVersion') != 1 or
            policy.get('kind') != 'B30_STAGING_PREPARED' or
            policy.get('environment') != 'geops-spec02-staging' or
            policy.get('activation') != 'DISABLED' or
            policy.get('trustKey') != 'PENDING_OPERATOR_VERIFICATION' or
            policy.get('bundleSignature') != 'PENDING' or
            policy.get('publicationReady') is not False or
            policy.get('registryDigests') != {'api': None, 'web': None} or
            policy.get('applicationCommit') !=
            '15f77a0d1904b77833972d8e2fd628a6cb97678f' or
            policy.get('candidateManifestSha256') !=
            '02c83a5293db7a5e6452342c5b1649bcd85d3b9ac334647b5489564257200a5f' or
            policy.get('migrations') != {
                'sourceCount': 23,
                'sourceListSha256': '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d',
                'targetCount': 30,
                'targetListSha256': '64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6',
            } or not isinstance(policy.get('files'), dict) or
            set(policy['files']) != set(items) - {'policy.json'} or
            items.get('scripts/deploy/b30-staging/sudoers') != STAGING_RULE or
            not REQUIRED.issubset(items)):
        raise Blocked('Unsupported B23→B30 staging compatibility policy')
    for name, body in items.items():
        if name == 'policy.json':
            continue
        if (not name.startswith(('scripts/deploy/', 'infrastructure/compose/',
                                 'specs/spec-03-clients-geofences-routes/', 'node_modules/')) or
                not SHA.fullmatch(policy['files'][name]) or
                sha(body) != policy['files'][name]):
            raise Blocked('Staging package inventory checksum invalid')
    if sha(items['specs/spec-03-clients-geofences-routes/release-candidate-manifest.json']) != \
            policy['candidateManifestSha256']:
        raise Blocked('B30 candidate manifest differs')
    if items['scripts/deploy/b30-staging/install.py'] != Path(__file__).read_bytes():
        raise Blocked('Running installer differs from signed package')
    return items, policy


def old_b23(layout, wrapper_sha, policy_sha):
    if not SHA.fullmatch(wrapper_sha or '') or not SHA.fullmatch(policy_sha or ''):
        raise Blocked('Reviewed B23 wrapper and policy hashes required')
    for path in (layout.v2_wrapper, layout.v2_policy, layout.v2_rule, layout.v2_state):
        secure(path, regular=True)
    if (sha(layout.v2_wrapper.read_bytes()) != wrapper_sha or
            sha(layout.v2_policy.read_bytes()) != policy_sha or
            layout.v2_rule.read_bytes() != V2_RULE):
        raise Blocked('B23 controller identity differs')
    policy = json.loads(layout.v2_policy.read_bytes())
    state = json.loads(layout.v2_state.read_bytes())
    if (policy.get('schemaVersion') != 2 or
            policy.get('profiles', {}).get('B23-mdm', {}).get('sqlCount') != 23 or
            state.get('schemaVersion') != 2 or state.get('phase') != 'steady' or
            state.get('pending') is not None or
            state.get('active', {}).get('profile') not in ('B23-safe', 'B23-mdm')):
        raise Blocked('Steady B23 source required')
    return {'wrapperSha256': wrapper_sha, 'policySha256': policy_sha,
            'activeProfile': state['active']['profile']}


def install(layout, archive_path, signature_path, public_key, expected_sha, key_sha,
            *, source='clean', old_wrapper_sha=None, old_policy_sha=None,
            visudo=None, preflight=None, fault=lambda _: None):
    if os.geteuid() != 0:
        raise Blocked('Root on Linux required')
    if source not in ('clean', 'from-b23'):
        raise Blocked('Unknown installation source')
    for path in (archive_path, signature_path, public_key):
        secure(Path(path), regular=True)
    archive = Path(archive_path).read_bytes()
    verify_signature(archive, Path(signature_path).read_bytes(), public_key,
                     expected_sha, key_sha)
    items, policy = archive_items(archive)
    if source == 'clean' and layout.v2_wrapper.exists():
        raise Blocked('Existing B23 controller requires from-b23 mode')
    previous = (old_b23(layout, old_wrapper_sha, old_policy_sha)
                if source == 'from-b23' else None)
    if source == 'from-b23' and preflight is None:
        preflight = lambda: subprocess.run(
            [str(layout.v2_wrapper), 'verify'], stdin=subprocess.DEVNULL,
            capture_output=True, check=True, timeout=120,
            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C'})
    if preflight:
        preflight()
    for parent in (layout.bundle.parent, layout.wrapper.parent,
                   layout.sudoers.parent, layout.state.parent):
        secure(parent)
    layout.state.mkdir(mode=0o700, exist_ok=True)
    secure(layout.state)
    fd = os.open(layout.lock, os.O_WRONLY | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if source == 'from-b23' and old_b23(layout, old_wrapper_sha, old_policy_sha) != previous:
            raise Blocked('B23 controller changed after preflight')
        identity = {'packageSha256': expected_sha, 'source': source, 'previous': previous}
        journal = json.loads(layout.journal.read_bytes()) if layout.journal.exists() else None
        if journal and any(journal.get(key) != value for key, value in identity.items()):
            raise Blocked('Pending installer identity changed')
        if layout.bundle.exists():
            secure(layout.bundle)
            pin = layout.bundle / 'policy.sha256'
            secure(pin, regular=True)
            if pin.read_bytes() != (sha(items['policy.json']) + '\n').encode():
                raise Blocked('Installed policy pin differs')
            for name, body in items.items():
                target = layout.bundle / name
                secure(target, regular=True)
                if target.read_bytes() != body:
                    raise Blocked('Installed bundle differs')
        else:
            temporary = Path(tempfile.mkdtemp(prefix='.geops-b30-stage-',
                                              dir=layout.bundle.parent))
            os.chmod(temporary, 0o700)
            try:
                for name, body in items.items():
                    target = temporary / name
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    target.write_bytes(body)
                    os.chmod(target, 0o444)
                pin = temporary / 'policy.sha256'
                pin.write_bytes((sha(items['policy.json']) + '\n').encode())
                os.chmod(pin, 0o444)
                os.replace(temporary, layout.bundle)
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
        fault('after-bundle')
        wrapper_body = items['scripts/deploy/b30-staging/guard.py']
        if layout.wrapper.exists():
            secure(layout.wrapper, regular=True)
            if layout.wrapper.read_bytes() != wrapper_body:
                raise Blocked('Installed wrapper differs')
        else:
            atomic(layout.wrapper, wrapper_body, 0o500)
        fault('after-wrapper')
        sudo_body = items['scripts/deploy/b30-staging/sudoers']
        if visudo is None:
            visudo = lambda path: subprocess.run(
                ['/usr/sbin/visudo', '-cf', str(path)], check=True,
                capture_output=True, timeout=15)
        with tempfile.NamedTemporaryFile(dir=layout.state, delete=False) as candidate:
            candidate.write(sudo_body)
            candidate_path = Path(candidate.name)
        try:
            visudo(candidate_path)
        finally:
            candidate_path.unlink(missing_ok=True)
        if journal is None:
            journal = {'schemaVersion': 1, **identity, 'phase': 'prepared'}
            atomic(layout.journal, (json.dumps(journal, sort_keys=True) + '\n').encode(), 0o600)
        fault('before-sudoers')
        if layout.sudoers.exists():
            secure(layout.sudoers, regular=True)
            if layout.sudoers.read_bytes() != sudo_body:
                raise Blocked('Installed sudoers rule differs')
        else:
            atomic(layout.sudoers, sudo_body, 0o440)
        fault('after-sudoers')
        journal['phase'] = 'prepared-complete'
        atomic(layout.journal, (json.dumps(journal, sort_keys=True) + '\n').encode(), 0o600)
        return {'result': 'B30_STAGING_PACKAGE_PREPARED', **identity,
                'activation': 'DISABLED', 'publicationReady': policy['publicationReady']}
    finally:
        os.close(fd)


def main(argv):
    if len(argv) not in (6, 8) or argv[0] not in ('clean', 'from-b23'):
        raise Blocked('Usage: install.py clean|from-b23 PACKAGE SIG PUB SHA PUB_SHA [B23_WRAPPER_SHA B23_POLICY_SHA]')
    source, package, signature, public, expected, key_sha = argv[:6]
    old = argv[6:]
    if (source == 'clean' and old) or (source == 'from-b23' and len(old) != 2):
        raise Blocked('Incorrect B23 review hashes')
    secure(Path(__file__).absolute(), regular=True)
    print(json.dumps(install(Layout(), Path(package), Path(signature), Path(public),
                             expected, key_sha, source=source,
                             old_wrapper_sha=old[0] if old else None,
                             old_policy_sha=old[1] if old else None), sort_keys=True))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as error:
        print('GEOPS B30 staging prepared install BLOCKED: ' + str(error), file=sys.stderr)
        sys.exit(1)
