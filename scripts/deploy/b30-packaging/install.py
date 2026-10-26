#!/usr/bin/python3 -I
"""Root-only, signed installation of the disposable B30 privileged lab controller."""

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
MINIMUM = {
    'scripts/deploy/b30-lab/controller.mjs',
    'scripts/deploy/b30-lab/seed-b23.mjs',
    'scripts/deploy/spec03-upgrade-supervisor.mjs',
    'infrastructure/compose/compose.b30-deployment-lab.yaml',
    'specs/spec-03-clients-geofences-routes/release-candidate-manifest.json',
    'scripts/deploy/b30-packaging/privileged.py',
    'scripts/deploy/b30-packaging/install.py',
    'scripts/deploy/b30-packaging/package.py',
    'scripts/deploy/b30-packaging/sign.mjs',
    'scripts/deploy/b30-packaging/verify-publication.mjs',
    'scripts/deploy/b30-packaging/verify-image-archive.py',
    'scripts/deploy/b30-packaging/sudoers',
}


class Blocked(Exception):
    pass


class Layout:
    def __init__(self, base=Path('/')):
        self.base = Path(base).resolve()
        self.bundle = self.base / 'opt/geops-b30-lab'
        self.wrapper = self.base / 'usr/local/sbin/geops-b30-lab'
        self.sudoers = self.base / 'etc/sudoers.d/geops-b30-lab'
        self.state = self.base / 'var/lib/geops-b30-lab'
        self.journal = self.state / 'install.json'
        self.lock = self.state / 'install.lock'
        self.v2_wrapper = self.base / 'usr/local/sbin/geops-deploy-v2'
        self.v2_policy = self.base / 'etc/geops-deploy-v2/policy.json'
        self.v2_rule = self.base / 'etc/sudoers.d/geops-deploy'
        self.v2_state = self.base / 'var/lib/geops-deploy/state.json'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def secure(path, *, regular=False):
    for part in (path, *path.parents):
        if not part.exists():
            raise Blocked('Required protected path is missing')
        info = os.lstat(part)
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise Blocked('Protected path ownership or mode differs')
    if regular and not stat.S_ISREG(os.lstat(path).st_mode):
        raise Blocked('Protected regular file required')


def verify_signature(archive, signature, public_key, digest):
    if not SHA.fullmatch(digest) or sha(archive) != digest or len(signature) != 64:
        raise Blocked('Package hash or Ed25519 signature differs')
    with tempfile.TemporaryDirectory(prefix='geops-b30-signature-') as directory:
        path = Path(directory)
        (path / 'message').write_bytes(f'GEOPS-B30-LAB-PACKAGE-SHA256\n{digest}\n'.encode())
        (path / 'signature').write_bytes(signature)
        result = subprocess.run(
            ['/usr/bin/openssl', 'pkeyutl', '-verify', '-pubin', '-inkey', str(public_key),
             '-rawin', '-in', str(path / 'message'), '-sigfile', str(path / 'signature')],
            stdin=subprocess.DEVNULL, capture_output=True, check=False, timeout=10)
        if result.returncode:
            raise Blocked('Signed B30 package did not verify')


def archive_items(archive):
    if len(archive) > 15_000_000:
        raise Blocked('Oversized B30 package')
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as source:
        members = source.getmembers()
        names = [item.name for item in members]
        if (len(names) != len(set(names)) or len(names) > 2500 or
                'policy.json' not in names or
                any(not item.isfile() or item.size > 2_000_000 or
                    item.mode != 0o444 or item.uid != 0 or item.gid != 0 or
                    item.mtime != 0 or item.name.startswith('/') or
                    '..' in Path(item.name).parts for item in members)):
            raise Blocked('B30 archive inventory or metadata invalid')
        items = {item.name: source.extractfile(item).read() for item in members}
    policy = json.loads(items['policy.json'])
    if (policy.get('schemaVersion') != 3 or
            policy.get('kind') != 'B30_PRIVILEGED_LAB_ONLY' or
            policy.get('environment') != 'synthetic-b30-local' or
            policy.get('applicationCommit') !=
            '15f77a0d1904b77833972d8e2fd628a6cb97678f' or
            policy.get('candidateManifestSha256') !=
            '02c83a5293db7a5e6452342c5b1649bcd85d3b9ac334647b5489564257200a5f' or
            policy.get('migrations') != {
                'sourceCount': 23,
                'sourceListSha256': '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d',
                'targetCount': 30,
                'targetListSha256': '64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6',
            } or
            not isinstance(policy.get('localImageIds'), dict) or
            set(policy['localImageIds']) != {'b23Api', 'b23Web', 'b30Api', 'b30Web'} or
            not all(re.fullmatch(r'sha256:[a-f0-9]{64}', value)
                    for value in policy['localImageIds'].values()) or
            policy.get('publicationReady') is not False or
            policy.get('registryDigests') != {'api': None, 'web': None} or
            not isinstance(policy.get('files'), dict) or
            set(policy['files']) != set(items) - {'policy.json'} or
            not MINIMUM.issubset(items) or
            'node_modules/pg/package.json' not in items):
        raise Blocked('B30 lab policy or package inventory invalid')
    if sha(items['specs/spec-03-clients-geofences-routes/release-candidate-manifest.json']) != \
            policy['candidateManifestSha256']:
        raise Blocked('B30 source manifest differs from approved candidate')
    for name, body in items.items():
        if name == 'policy.json':
            continue
        if not SHA.fullmatch(policy['files'][name]) or sha(body) != policy['files'][name]:
            raise Blocked('B30 package file checksum differs')
    if items['scripts/deploy/b30-packaging/install.py'] != Path(__file__).read_bytes():
        raise Blocked('Running installer differs from signed package')
    return items, policy


def atomic(path, body, mode):
    fd, temporary = tempfile.mkstemp(prefix='.geops-b30-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchown(stream.fileno(), 0, 0)
            os.fchmod(stream.fileno(), mode)
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except Exception:
        Path(temporary).unlink(missing_ok=True)
        raise


def old_b23(layout, wrapper_sha, policy_sha):
    if not SHA.fullmatch(wrapper_sha) or not SHA.fullmatch(policy_sha):
        raise Blocked('Reviewed B23 controller and policy hashes required')
    for path in (layout.v2_wrapper, layout.v2_policy, layout.v2_rule, layout.v2_state):
        secure(path, regular=True)
    if (sha(layout.v2_wrapper.read_bytes()) != wrapper_sha or
            sha(layout.v2_policy.read_bytes()) != policy_sha or
            layout.v2_rule.read_bytes() != V2_RULE):
        raise Blocked('Installed B23 controller identity differs')
    policy = json.loads(layout.v2_policy.read_bytes())
    state = json.loads(layout.v2_state.read_bytes())
    if (policy.get('schemaVersion') != 2 or
            policy.get('profiles', {}).get('B23-mdm', {}).get('sqlCount') != 23 or
            state.get('schemaVersion') != 2 or state.get('phase') != 'steady' or
            state.get('pending') is not None or
            state.get('active', {}).get('profile') not in ('B23-safe', 'B23-mdm')):
        raise Blocked('Steady B23 privileged controller required')
    return {'wrapperSha256': wrapper_sha, 'policySha256': policy_sha,
            'activeProfile': state['active']['profile']}


def install(layout, archive_path, signature_path, public_key, expected_sha,
            *, source='clean', old_wrapper_sha=None, old_policy_sha=None,
            visudo=None, preflight=None, fault=lambda _: None):
    if os.geteuid() != 0:
        raise Blocked('Root on Linux required')
    for path in (archive_path, signature_path, public_key):
        secure(Path(path), regular=True)
    archive = Path(archive_path).read_bytes()
    signature = Path(signature_path).read_bytes()
    verify_signature(archive, signature, public_key, expected_sha)
    items, policy = archive_items(archive)
    if source not in ('clean', 'from-b23'):
        raise Blocked('Unknown B30 lab installation source')
    previous = (old_b23(layout, old_wrapper_sha, old_policy_sha)
                if source == 'from-b23' else None)
    if source == 'from-b23' and preflight is None:
        preflight = lambda: subprocess.run(
            [str(layout.v2_wrapper), 'verify'], stdin=subprocess.DEVNULL,
            capture_output=True, check=True, timeout=120,
            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C'})
    if preflight:
        preflight()
    for path in (layout.bundle.parent, layout.wrapper.parent,
                 layout.sudoers.parent, layout.state.parent):
        secure(path)
    layout.state.mkdir(mode=0o700, exist_ok=True)
    secure(layout.state)
    lock = os.open(layout.lock, os.O_WRONLY | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if source == 'from-b23' and old_b23(layout, old_wrapper_sha, old_policy_sha) != previous:
            raise Blocked('B23 source changed after privileged preflight')
        journal = (json.loads(layout.journal.read_bytes()) if layout.journal.exists() else None)
        identity = {'packageSha256': expected_sha, 'source': source, 'previous': previous}
        if journal and any(journal.get(key) != value for key, value in identity.items()):
            raise Blocked('Pending B30 installer identity changed')
        if layout.bundle.exists():
            secure(layout.bundle)
            policy_pin = layout.bundle / 'policy.sha256'
            secure(policy_pin, regular=True)
            if policy_pin.read_bytes() != (sha(items['policy.json']) + '\n').encode():
                raise Blocked('Installed B30 policy pin differs')
            for name, body in items.items():
                target = layout.bundle / name
                secure(target, regular=True)
                if target.read_bytes() != body:
                    raise Blocked('Installed B30 bundle differs')
        else:
            temporary = Path(tempfile.mkdtemp(prefix='.geops-b30-', dir=layout.bundle.parent))
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
        wrapper_body = items['scripts/deploy/b30-packaging/privileged.py']
        if layout.wrapper.exists():
            secure(layout.wrapper, regular=True)
            if layout.wrapper.read_bytes() != wrapper_body:
                raise Blocked('Installed privileged wrapper differs')
        else:
            atomic(layout.wrapper, wrapper_body, 0o500)
        fault('after-wrapper')
        sudo_body = items['scripts/deploy/b30-packaging/sudoers']
        if visudo is None:
            visudo = lambda file: subprocess.run(
                ['/usr/sbin/visudo', '-cf', str(file)], check=True,
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
                raise Blocked('B30 sudoers rule differs')
        else:
            atomic(layout.sudoers, sudo_body, 0o440)
        fault('after-sudoers')
        journal['phase'] = 'active'
        atomic(layout.journal, (json.dumps(journal, sort_keys=True) + '\n').encode(), 0o600)
        return {'result': 'B30_PRIVILEGED_LAB_INSTALLED', **identity,
                'publicationReady': policy['publicationReady']}
    finally:
        os.close(lock)


def main(argv):
    if len(argv) not in (5, 7) or argv[0] not in ('clean', 'from-b23'):
        raise Blocked('Usage: install.py clean|from-b23 PACKAGE SIG PUB SHA [OLD_WRAPPER_SHA OLD_POLICY_SHA]')
    source, package, signature, public, expected = argv[:5]
    old = argv[5:]
    if (source == 'clean' and old) or (source == 'from-b23' and len(old) != 2):
        raise Blocked('Incorrect B23 review hash arguments')
    secure(Path(__file__).absolute(), regular=True)
    result = install(Layout(), Path(package), Path(signature), Path(public), expected,
                     source=source, old_wrapper_sha=old[0] if old else None,
                     old_policy_sha=old[1] if old else None)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as error:
        print('GEOPS B30 lab install BLOCKED: ' + str(error), file=sys.stderr)
        sys.exit(1)
