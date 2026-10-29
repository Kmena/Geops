#!/usr/bin/python3 -I
"""Root-only B32 staging bundle installer; never starts maintenance."""
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
PROJECT = 'geops-spec02-staging'
TRUST_SHA = 'd01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27'
CANDIDATE_SHA = 'c1011f3235d9efd25fdee1336f3a882babd0cbb640d05e3494b27ccc3b176e3f'
APP_COMMIT = '06b6599779bbf95a45576d9bda581119ddce27de'
B31 = '17cf75b6e88193552efb799ab33b94d44d3a17bc19c0eb15e6c9f0a77d7e9ea0'
B32 = 'd4730ee35c02af8976f1b7a642c305ea0304448742f9d54a5ff829336752074a'
SOURCE = {
    'wrapperSha256': '8dabed2dee1e82e994295e71952ee3f6f2cf140fd6d16e0063977153c7a4297c',
    'policySha256': '89b5de6f15cc547244982fb1af250fa6dc9fff3a12ce1b0b2298de64401dc3eb',
}
RULE = (b'Defaults!/usr/local/sbin/geops-b32-staging env_reset\n'
        b'Defaults!/usr/local/sbin/geops-b32-staging secure_path="/usr/sbin:/usr/bin:/sbin:/bin"\n'
        b'abi ALL=(root) NOPASSWD: /usr/local/sbin/geops-b32-staging\n')
REQUIRED = {
    'scripts/deploy/b32-staging/controller.py',
    'scripts/deploy/b32-staging/guard.py',
    'scripts/deploy/b32-staging/install.py',
    'scripts/deploy/b32-staging/package.py',
    'scripts/deploy/b32-staging/sign-package.mjs',
    'scripts/deploy/b32-staging/candidate.py',
    'scripts/deploy/b32-staging/sudoers-ready',
    'scripts/deploy/b32-staging/maintenance-recovery.ts',
    'scripts/deploy/b32-staging/api-b32-recovery.Dockerfile',
    'scripts/deploy/b32-staging/backup-restore-staging.sh',
    'scripts/deploy/b30-staging/controller.py',
    'specs/spec-03-clients-geofences-routes/b32-staging-candidate.json',
    'infrastructure/nginx/geops-staging-web.conf',
    'public.pem',
}

class Blocked(Exception):
    pass


def sha(body):
    return hashlib.sha256(body).hexdigest()


def secure(path, regular=False):
    for part in (path, *path.parents):
        info = os.lstat(part)
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise Blocked('Unprotected administrative path')
    if regular and not stat.S_ISREG(os.lstat(path).st_mode):
        raise Blocked('Protected regular file required')


def atomic(path, body, mode):
    fd, temporary = tempfile.mkstemp(prefix='.geops-b32-', dir=path.parent)
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


def verify_signature(archive, signature, public, expected):
    if (not SHA.fullmatch(expected) or sha(archive) != expected or
            len(signature) != 64 or sha(public.read_bytes()) != TRUST_SHA):
        raise Blocked('B32 bundle, key or signature identity differs')
    with tempfile.TemporaryDirectory(prefix='geops-b32-sign-') as folder:
        message = Path(folder) / 'message'
        sig = Path(folder) / 'signature'
        message.write_bytes(('GEOPS-B32-STAGING-PACKAGE-SHA256\n' + expected + '\n').encode())
        sig.write_bytes(signature)
        result = subprocess.run(['/usr/bin/openssl', 'pkeyutl', '-verify', '-pubin',
                                 '-inkey', str(public), '-rawin', '-in', str(message),
                                 '-sigfile', str(sig)], stdin=subprocess.DEVNULL,
                                capture_output=True, timeout=10, check=False)
        if result.returncode:
            raise Blocked('B32 Ed25519 signature invalid')


def archive_items(archive):
    if len(archive) > 15_000_000:
        raise Blocked('Oversized B32 bundle')
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as source:
        members = source.getmembers()
        names = [item.name for item in members]
        if (len(names) != len(set(names)) or len(names) > 2500 or
                any(not item.isfile() or item.size > 2_000_000 or item.mode != 0o444 or
                    item.uid != 0 or item.gid != 0 or item.mtime != 0 or
                    item.name.startswith('/') or '..' in Path(item.name).parts
                    for item in members)):
            raise Blocked('B32 archive metadata invalid')
        items = {item.name: source.extractfile(item).read() for item in members}
    if not REQUIRED.issubset(items) or 'policy.json' not in items:
        raise Blocked('Required B32 package member missing')
    policy = json.loads(items['policy.json'])
    refs = policy.get('registryDigests')
    if (policy.get('schemaVersion') != 1 or policy.get('kind') != 'B32_STAGING_READY' or
            policy.get('environment') != PROJECT or policy.get('activation') != 'READY' or
            policy.get('publicationReady') is not True or
            policy.get('applicationCommit') != APP_COMMIT or
            policy.get('candidateManifestSha256') != CANDIDATE_SHA or
            policy.get('trustKeySha256') != TRUST_SHA or
            policy.get('sourceB31') != SOURCE or
            not re.fullmatch(r'[a-f0-9]{40}', policy.get('promotionCommit', '')) or
            policy.get('migrations') != {'sourceCount': 31, 'sourceListSha256': B31,
                                         'targetCount': 33, 'targetListSha256': B32} or
            policy.get('mdmRegion') != 'com' or not isinstance(refs, dict) or
            set(refs) != {'api', 'web', 'recovery'} or
            any(not re.fullmatch(rf'ghcr\.io/kmena/geops-{"web" if kind == "web" else "api"}@sha256:[a-f0-9]{{64}}',
                                 refs[kind]) for kind in ('api', 'web', 'recovery')) or
            not isinstance(policy.get('files'), dict) or
            set(policy['files']) != set(items) - {'policy.json'} or
            sha(items['public.pem']) != TRUST_SHA or
            items['scripts/deploy/b32-staging/sudoers-ready'] != RULE or
            sha(items['specs/spec-03-clients-geofences-routes/b32-staging-candidate.json']) !=
            CANDIDATE_SHA or
            sha(items['infrastructure/nginx/geops-staging-web.conf']) !=
            '1915dcbdcb77673d7caa61fdaec5ffceb675135499c712afca71fe6c49e0a734' or
            b'\r\n' in items['infrastructure/nginx/geops-staging-web.conf']):
        raise Blocked('B32 policy or compatibility invalid')
    for name, body in items.items():
        if name == 'policy.json':
            continue
        if (not re.fullmatch(r'(?:public\.pem|(?:scripts/deploy|infrastructure|specs)/[a-zA-Z0-9_./-]+)', name) or
                not SHA.fullmatch(policy['files'][name]) or
                sha(body) != policy['files'][name]):
            raise Blocked('B32 package inventory checksum invalid')
    if items['scripts/deploy/b32-staging/install.py'] != Path(__file__).read_bytes():
        raise Blocked('Running installer differs from signed package')
    return items, policy


def preflight(policy):
    paths = (Path('/usr/local/sbin/geops-b31-staging'),
             Path('/opt/geops-b31-staging/policy.json'),
             Path('/var/lib/geops-b31-staging/install.json'),
             Path('/var/lib/geops-b31-staging/promotion.json'),
             Path('/etc/sudoers.d/geops-b31-staging'),
             Path('/opt/geops-b31-staging/public.pem'))
    for path in paths:
        secure(path, regular=True)
    if (sha(paths[0].read_bytes()) != SOURCE['wrapperSha256'] or
            sha(paths[1].read_bytes()) != SOURCE['policySha256'] or
            json.loads(paths[2].read_bytes()).get('phase') != 'prepared-complete' or
            json.loads(paths[3].read_bytes()).get('phase') != 'complete' or
            sha(paths[5].read_bytes()) != TRUST_SHA or
            paths[4].read_bytes() !=
            (b'Defaults!/usr/local/sbin/geops-b31-staging env_reset\n'
             b'Defaults!/usr/local/sbin/geops-b31-staging secure_path="/usr/sbin:/usr/bin:/sbin:/bin"\n'
             b'abi ALL=(root) NOPASSWD: /usr/local/sbin/geops-b31-staging\n')):
        raise Blocked('Installed B31 source differs')
    env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C'}
    for command, expected in (('verify', 'B31_STAGING_VERIFIED'), ('status', 'B31_STAGING_STATUS')):
        result = subprocess.run([str(paths[0]), command], env=env, stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=120, check=False)
        if result.returncode or json.loads(result.stdout).get('result') != expected:
            raise Blocked('B31 controller preflight failed')
        if command == 'status':
            status = json.loads(result.stdout)
            if (status.get('gate') != 'open' or status.get('ledger') !=
                    {'count': 31, 'sha256': B31} or
                    status.get('journal', {}).get('phase') != 'complete'):
                raise Blocked('B31 is not complete and healthy')
    return {'sourceController': 'B31_STAGING_VERIFIED', 'sourceSchema': 31}


def install(archive_path, signature_path, public_path, expected_sha):
    if os.geteuid() != 0:
        raise Blocked('Linux root required')
    for path in (archive_path, signature_path, public_path, Path(__file__).resolve()):
        secure(Path(path), regular=True)
    archive = Path(archive_path).read_bytes()
    public = Path(public_path)
    verify_signature(archive, Path(signature_path).read_bytes(), public, expected_sha)
    items, policy = archive_items(archive)
    preflight(policy)
    bundle = Path('/opt/geops-b32-staging')
    wrapper = Path('/usr/local/sbin/geops-b32-staging')
    sudoers = Path('/etc/sudoers.d/geops-b32-staging')
    state = Path('/var/lib/geops-b32-staging')
    for parent in (bundle.parent, wrapper.parent, sudoers.parent, state.parent):
        secure(parent)
    state.mkdir(mode=0o700, exist_ok=True)
    secure(state)
    fd = os.open(state / 'install.lock', os.O_WRONLY | os.O_CREAT |
                 getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if bundle.exists():
            secure(bundle)
            if (bundle / 'policy.sha256').read_bytes() != (sha(items['policy.json']) + '\n').encode():
                raise Blocked('Already installed B32 policy differs')
            for name, body in items.items():
                path = bundle / name
                secure(path, regular=True)
                if path.read_bytes() != body:
                    raise Blocked('Already installed B32 bundle differs')
        else:
            temporary = Path(tempfile.mkdtemp(prefix='.geops-b32-', dir=bundle.parent))
            os.chmod(temporary, 0o700)
            try:
                for name, body in items.items():
                    path = temporary / name
                    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    path.write_bytes(body)
                    os.chmod(path, 0o444)
                pin = temporary / 'policy.sha256'
                pin.write_bytes((sha(items['policy.json']) + '\n').encode())
                os.chmod(pin, 0o444)
                os.replace(temporary, bundle)
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
        guard = items['scripts/deploy/b32-staging/guard.py']
        if wrapper.exists():
            secure(wrapper, regular=True)
            if wrapper.read_bytes() != guard:
                raise Blocked('B32 wrapper differs')
        else:
            atomic(wrapper, guard, 0o500)
        with tempfile.NamedTemporaryFile(dir=state, delete=False) as candidate:
            candidate.write(RULE)
            candidate_path = Path(candidate.name)
        try:
            result = subprocess.run(['/usr/sbin/visudo', '-cf', str(candidate_path)],
                                    capture_output=True, timeout=15, check=False)
            if result.returncode:
                raise Blocked('B32 sudoers rule invalid')
        finally:
            candidate_path.unlink(missing_ok=True)
        if sudoers.exists():
            secure(sudoers, regular=True)
            if sudoers.read_bytes() != RULE:
                raise Blocked('B32 sudoers differs')
        else:
            atomic(sudoers, RULE, 0o440)
        record = {'schemaVersion': 1, 'phase': 'prepared-complete',
                  'packageSha256': expected_sha, 'source': 'from-b31'}
        journal = state / 'install.json'
        if journal.exists():
            secure(journal, regular=True)
            if json.loads(journal.read_bytes()) != record:
                raise Blocked('B32 installer journal differs')
        else:
            atomic(journal, (json.dumps(record, sort_keys=True) + '\n').encode(), 0o600)
        return {'result': 'B32_STAGING_PACKAGE_READY', 'packageSha256': expected_sha,
                'source': 'from-b31', 'sourceSchema': 31}
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 5:
            raise Blocked('Usage: install.py PACKAGE.tar.gz PACKAGE.sig APPROVED_PUBLIC.pem PACKAGE_SHA256')
        print(json.dumps(install(Path(sys.argv[1]), Path(sys.argv[2]),
                                 Path(sys.argv[3]), sys.argv[4]), sort_keys=True))
    except Exception as error:
        print('GEOPS B32 staging installer BLOCKED: ' + str(error), file=sys.stderr)
        sys.exit(1)
