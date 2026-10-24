#!/usr/bin/python3 -I
"""Root-only, resumable v1→v2 controller installation. Never changes GEOPS services."""

import fcntl
import hashlib
import importlib.util
from importlib.machinery import SourceFileLoader
import io
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path


A21_HASH = 'cd308f751512b86926116856185b7aa870f849235161e5e23c904c4d28813d8e'
B22_HASH = 'aca17d3d9155351596a98ca412fe02b37dca575f2b8b6e8441d7466ed81abaf2'
HEX64 = re.compile(r'^[a-f0-9]{64}$')
SQL_LINE = re.compile(r'^\d{4}_[a-z0-9_]+\.sql\|[a-f0-9]{64}$')
SECRETS = ('db_password', 'admin_session_key', 'admin_csrf_key',
           'invitation_hmac_key', 'mdm_grant_key', 'gps_quarantine_key')
BUNDLE = (
    'infrastructure/compose/compose.staging.yaml',
    'infrastructure/compose/compose.staging.digest.override.yaml',
    'infrastructure/nginx/geops-staging-web.conf',
    'infrastructure/staging/api-entrypoint.sh',
    'infrastructure/staging/backup.sh',
    'infrastructure/compose/compose.staging.mdm-web-oauth.override.yaml',
    'infrastructure/compose/compose.staging.migrate.digest.override.yaml',
)
FILES = {'policy.json', 'lib/geops_deploy.py', 'controller/geops_deploy_v2.py',
         'geops-deploy-v2.sudoers'} | {'bundle/' + name for name in BUNDLE}
V1_SUDOERS = (b'Defaults!/usr/local/sbin/geops-deploy env_reset\n'
              b'Defaults!/usr/local/sbin/geops-deploy secure_path="/usr/sbin:/usr/bin:/sbin:/bin"\n'
              b'abi ALL=(root) NOPASSWD: /usr/local/sbin/geops-deploy\n')
V2_SUDOERS = (b'Defaults!/usr/local/sbin/geops-deploy-v2 env_reset\n'
              b'Defaults!/usr/local/sbin/geops-deploy-v2 secure_path="/usr/sbin:/usr/bin:/sbin:/bin"\n'
              b'abi ALL=(root) NOPASSWD: /usr/local/sbin/geops-deploy-v2\n')
PROFILES = {
    'A21': {'sqlCount': 21, 'sqlListSha256': A21_HASH,
            'variant': 'gps-base', 'mdmEnabled': False},
    'B22-safe': {'sqlCount': 22, 'sqlListSha256': B22_HASH,
                 'variant': 'gps-base', 'mdmEnabled': False},
    'B22-mdm': {'sqlCount': 22, 'sqlListSha256': B22_HASH,
                'variant': 'mdm-qa', 'mdmEnabled': True},
}


class Blocked(Exception):
    pass


class Layout:
    def __init__(self, base=Path('/')):
        self.base = Path(base).resolve()
        self.old = self.base / 'etc/geops-deploy'
        self.new = self.base / 'etc/geops-deploy-v2'
        self.state = self.base / 'var/lib/geops-deploy'
        self.old_wrapper = self.base / 'usr/local/sbin/geops-deploy'
        self.new_wrapper = self.base / 'usr/local/sbin/geops-deploy-v2'
        self.sudoers = self.base / 'etc/sudoers.d/geops-deploy'
        self.journal = self.state / 'v2-install.json'
        self.gate = self.base / 'var/lib/docker/volumes/geops_spec02_stage_security/_data/security-gate.json'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def protected(path, *, mode=None, regular=False):
    for part in (path, *path.parents):
        info = os.lstat(part)
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise Blocked('Administrative path is not root-protected')
    info = os.lstat(path)
    if regular and not stat.S_ISREG(info.st_mode):
        raise Blocked('Protected regular file required')
    if mode is not None and stat.S_IMODE(info.st_mode) != mode:
        raise Blocked('Protected mode changed')


def read_file(path, limit=15_000_000, *, mode=None):
    protected(path, mode=mode, regular=True)
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise Blocked('Invalid protected file size')
        data = os.read(fd, limit + 1)
        if len(data) != info.st_size:
            raise Blocked('Protected file changed during read')
        return data
    finally:
        os.close(fd)


def ensure_dir(path, mode):
    if not path.exists():
        if not path.parent.exists():
            ensure_dir(path.parent, 0o755)
        else:
            protected(path.parent)
            if not stat.S_ISDIR(os.lstat(path.parent).st_mode):
                raise Blocked('Protected parent directory required')
        path.mkdir(mode=mode)
        os.chown(path, 0, 0)
        os.chmod(path, mode)
        sync_dir(path.parent)
    protected(path, mode=mode)
    if not stat.S_ISDIR(os.lstat(path).st_mode):
        raise Blocked('Protected directory required')


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_replace(path, data, mode, *, expected_old=None):
    protected(path.parent)
    if expected_old is not None and read_file(path, mode=mode) != expected_old:
        raise Blocked('Atomic switch source changed')
    fd, name = tempfile.mkstemp(prefix='.geops-v2-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchown(stream.fileno(), 0, 0)
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        sync_dir(path.parent)
    except Exception:
        Path(name).unlink(missing_ok=True)
        raise


def write_exact(path, data, mode, gid=0):
    if not path.parent.exists():
        ensure_dir(path.parent, 0o755)
    else:
        protected(path.parent)
        if not stat.S_ISDIR(os.lstat(path.parent).st_mode):
            raise Blocked('Protected parent directory required')
    if os.path.lexists(path):
        protected(path, mode=mode, regular=True)
        if os.stat(path).st_gid != gid or read_file(path, mode=mode) != data:
            raise Blocked('Existing v2 installation file differs')
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                 getattr(os, 'O_NOFOLLOW', 0), mode)
    try:
        os.fchown(fd, 0, gid)
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        path.unlink(missing_ok=True)
        raise
    sync_dir(path.parent)


def checked(args, *, limit=45):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True,
                            text=True, timeout=limit, check=False,
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin',
                                 'HOME': '/root', 'LANG': 'C'})
    if result.returncode:
        raise Blocked('Read-only preflight or validation failed: ' + args[0])
    return result.stdout.strip()


def archive_items(data):
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        if len(members) != len(FILES) or {item.name for item in members} != FILES:
            raise Blocked('V2 archive inventory differs')
        if any(not item.isfile() or item.size > 1_000_000 for item in members):
            raise Blocked('V2 archive contains special or oversized file')
        return {item.name: archive.extractfile(item).read() for item in members}


def verify_signature(layout, archive, expected, signature):
    if not HEX64.fullmatch(expected) or sha(archive) != expected:
        raise Blocked('Reviewed package SHA-256 differs')
    if len(signature) != 64:
        raise Blocked('Ed25519 package signature required')
    protected(layout.old / 'public.pem', mode=0o444, regular=True)
    message = f'GEOPS-V2-PACKAGE-SHA256\n{expected}\n'.encode()
    with tempfile.TemporaryDirectory(prefix='geops-v2-verify-', dir=layout.state / 'tmp') as folder:
        msg, sig = Path(folder) / 'message', Path(folder) / 'signature'
        msg.write_bytes(message)
        sig.write_bytes(signature)
        checked(['/usr/bin/openssl', 'pkeyutl', '-verify', '-pubin', '-inkey',
                 str(layout.old / 'public.pem'), '-rawin', '-in', str(msg),
                 '-sigfile', str(sig)], limit=10)


def validate_policy(items, old_policy):
    policy = json.loads(items['policy.json'])
    if (set(policy) != {'schemaVersion', 'environment', 'origin', 'secretGid',
                        'imageTag', 'backupMaxAgeSeconds', 'profiles', 'mdm',
                        'files', 'controllers'} or
            policy['schemaVersion'] != 2 or policy['environment'] != 'geops-spec02-staging' or
            policy['origin'] != old_policy['origin'] or
            policy['secretGid'] != old_policy['secretGid'] or
            policy['imageTag'] != old_policy['imageTag'] or
            policy['profiles'] != PROFILES or
            type(policy['backupMaxAgeSeconds']) is not int or
            not 0 < policy['backupMaxAgeSeconds'] <= 86400 or
            set(policy['files']) != set(BUNDLE) or
            set(policy['controllers']) != {'geops_deploy.py', 'geops_deploy_v2.py'}):
        raise Blocked('V2 policy is incompatible with installed A21')
    mdm = policy['mdm']
    if (set(mdm) != {'region', 'edition', 'customerId'} or
            mdm['region'] not in ('com', 'eu', 'in', 'com.au', 'jp', 'ca', 'cn', 'sa', 'uk') or
            mdm['edition'] not in ('TRIAL', 'FREE', 'LICENSED') or
            not isinstance(mdm['customerId'], str) or
            not re.fullmatch(r'[0-9]{1,30}', mdm['customerId'])):
        raise Blocked('Invalid v2 MDM tenant')
    for name in BUNDLE:
        if sha(items['bundle/' + name]) != policy['files'][name]:
            raise Blocked('V2 bundle hash mismatch')
    for name, path in (('geops_deploy.py', 'lib/geops_deploy.py'),
                       ('geops_deploy_v2.py', 'controller/geops_deploy_v2.py')):
        if sha(items[path]) != policy['controllers'][name]:
            raise Blocked('V2 controller hash mismatch')
    if items['geops-deploy-v2.sudoers'] != V2_SUDOERS:
        raise Blocked('V2 sudoers command inventory changed')
    return policy


def read_v1(layout, wrapper_sha, policy_sha, *, preserved_state=False):
    if not HEX64.fullmatch(wrapper_sha) or not HEX64.fullmatch(policy_sha):
        raise Blocked('Reviewed v1 SHA-256 values required')
    old = {
        'wrapper': read_file(layout.old_wrapper, mode=0o755),
        'policy': read_file(layout.old / 'policy.json', mode=0o444),
        'public': read_file(layout.old / 'public.pem', mode=0o444),
        'state': read_file(layout.new / 'legacy/state', mode=0o400) if preserved_state
                 else read_file(layout.state / 'state.json', mode=0o600),
    }
    if sha(old['wrapper']) != wrapper_sha or sha(old['policy']) != policy_sha:
        raise Blocked('Installed v1 differs from operator-reviewed hashes')
    policy, state = json.loads(old['policy']), json.loads(old['state'])
    if (policy.get('schemaVersion') != 1 or policy.get('sqlCount') != 21 or
            policy.get('sqlListSha256') != A21_HASH or policy.get('variant') != 'gps-base'):
        raise Blocked('Installed v1 policy is not A21')
    if (state.get('schemaVersion') != 1 or state.get('previous') is not None or
            not isinstance(state.get('active'), dict) or
            state['active'].get('commit') != policy.get('imageTag')):
        raise Blocked('Installed v1 state is not steady A21')
    return old, policy, state


def observe_live(layout, state):
    endpoint = checked(['/usr/bin/docker', 'context', 'inspect', '--format',
                        '{{.Endpoints.docker.Host}}'])
    if endpoint not in ('unix:///var/run/docker.sock', 'unix:///run/docker.sock'):
        raise Blocked('Only local Docker is allowed')
    result = {}
    for kind in ('api', 'web', 'db'):
        service = f'geops-spec02-staging-geops-{kind}-1'
        value = json.loads(checked(['/usr/bin/docker', 'inspect', '--format', '{{json .}}', service]))
        labels = value['Config'].get('Labels') or {}
        if (labels.get('com.docker.compose.project') != 'geops-spec02-staging' or
                labels.get('com.docker.compose.service') != 'geops-' + kind or
                value['State'].get('Status') != 'running' or
                value['State'].get('Health', {}).get('Status') != 'healthy'):
            raise Blocked('Staging service identity or health changed')
        if kind in ('api', 'web') and value['Image'] != state['active'][kind + 'Id']:
            raise Blocked('A21 image differs from protected state')
        result[kind] = {'containerId': value['Id'], 'imageId': value['Image'],
                        'health': 'healthy'}
    rows = checked(['/usr/bin/docker', 'exec', 'geops-spec02-staging-geops-db-1',
                    'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'geops_stage',
                    '-d', 'geops_dev', '-Atq', '-c',
                    'SELECT version,checksum FROM geops_schema_migrations ORDER BY version'])
    lines = [line for line in rows.splitlines() if line]
    if len(lines) != 21 or any(not SQL_LINE.fullmatch(line) for line in lines) or sha('\n'.join(lines).encode()) != A21_HASH:
        raise Blocked('A21 PostgreSQL ledger required')
    gate_bytes = layout.gate.read_bytes()
    gate = json.loads(gate_bytes)
    if gate.get('phase') != 'open':
        raise Blocked('External gate must be open')
    result['ledger'] = {'count': 21, 'sha256': A21_HASH}
    result['gateSha256'] = sha(gate_bytes)
    result['stateSha256'] = sha(read_file(layout.state / 'state.json', mode=0o600))
    return result


def validate_installed_v2(layout):
    loader = SourceFileLoader('geops_reviewed_v2', str(layout.new_wrapper))
    spec = importlib.util.spec_from_loader('geops_reviewed_v2', loader)
    if spec is None or spec.loader is None:
        raise Blocked('V2 controller could not be loaded')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    control = module.ControllerV2()
    state = control.preflight()
    if state['active']['profile'] != 'A21':
        raise Blocked('V2 preflight did not retain A21')
    control.smoke()


def materialize(layout, items, old, fault):
    ensure_dir(layout.new, 0o700)
    ensure_dir(layout.new / 'secrets', 0o700)
    ensure_dir(layout.new / 'runtime-secrets', 0o700)
    ensure_dir(layout.new / 'docker', 0o700)
    ensure_dir(layout.new / 'legacy', 0o700)
    for name, body in sorted(items.items()):
        if name == 'geops-deploy-v2.sudoers':
            continue
        target = (layout.new_wrapper if name == 'controller/geops_deploy_v2.py'
                  else layout.new / name)
        write_exact(target, body, 0o755 if target == layout.new_wrapper else 0o444)
        fault('after-file:' + name)
    for name in ('wrapper', 'policy', 'public', 'state'):
        write_exact(layout.new / 'legacy' / name, old[name], 0o400)
    write_exact(layout.new / 'legacy' / 'sudoers', V1_SUDOERS, 0o400)
    write_exact(layout.new / 'public.pem', old['public'], 0o444)
    for name in SECRETS:
        master = read_file(layout.old / 'secrets' / name, 4096, mode=0o600)
        runtime = read_file(layout.old / 'runtime-secrets' / name, 4096, mode=0o640)
        if not master or master != runtime or os.stat(layout.old / 'runtime-secrets' / name).st_gid != 24001:
            raise Blocked('Installed v1 secret copies differ')
        write_exact(layout.new / 'secrets' / name, master, 0o600)
        write_exact(layout.new / 'runtime-secrets' / name, master, 0o640, 24001)
    link = layout.new / 'bundle/infrastructure/compose/.local/staging/secrets'
    ensure_dir(link.parent, 0o755)
    if os.path.lexists(link):
        if not link.is_symlink() or os.readlink(link) != str(layout.new / 'runtime-secrets'):
            raise Blocked('V2 secret link changed')
    else:
        os.symlink(layout.new / 'runtime-secrets', link)
        sync_dir(link.parent)


def verify_materialized(layout, items, old):
    for name, body in items.items():
        if name == 'geops-deploy-v2.sudoers':
            continue
        target = (layout.new_wrapper if name == 'controller/geops_deploy_v2.py'
                  else layout.new / name)
        if read_file(target, mode=0o755 if target == layout.new_wrapper else 0o444) != body:
            raise Blocked('Materialized v2 file differs')
    for name in ('wrapper', 'policy', 'public', 'state'):
        if read_file(layout.new / 'legacy' / name, mode=0o400) != old[name]:
            raise Blocked('Preserved v1 evidence differs')
    if read_file(layout.new / 'legacy/sudoers', mode=0o400) != V1_SUDOERS:
        raise Blocked('Preserved v1 sudoers differs')
    if read_file(layout.new / 'public.pem', mode=0o444) != old['public']:
        raise Blocked('Trusted public key differs')
    link = layout.new / 'bundle/infrastructure/compose/.local/staging/secrets'
    if not link.is_symlink() or os.readlink(link) != str(layout.new / 'runtime-secrets'):
        raise Blocked('V2 secret mount link differs')
    for name in SECRETS:
        original = read_file(layout.old / 'secrets' / name, 4096, mode=0o600)
        master = read_file(layout.new / 'secrets' / name, 4096, mode=0o600)
        runtime_path = layout.new / 'runtime-secrets' / name
        runtime = read_file(runtime_path, 4096, mode=0o640)
        if original != master or master != runtime or os.stat(runtime_path).st_gid != 24001:
            raise Blocked('V2 secret copy differs from installed v1')


def write_journal(layout, value):
    atomic_replace(layout.journal, (json.dumps(value, sort_keys=True) + '\n').encode(), 0o600)


def read_journal(layout):
    if not os.path.lexists(layout.journal):
        return None
    value = json.loads(read_file(layout.journal, 16384, mode=0o600))
    if (set(value) != {'schemaVersion', 'phase', 'packageSha256', 'v1WrapperSha256',
                       'v1PolicySha256', 'v1StateSha256', 'v1PublicSha256',
                       'baseline'} or value['schemaVersion'] != 1 or
            value['phase'] not in ('staging', 'ready', 'active', 'returning', 'returned') or
            any(not HEX64.fullmatch(value[key]) for key in
                ('packageSha256', 'v1WrapperSha256', 'v1PolicySha256',
                 'v1StateSha256', 'v1PublicSha256'))):
        raise Blocked('Invalid installation journal')
    return value


def lock_state(layout):
    protected(layout.state, mode=0o700)
    fd = os.open(layout.state / 'lock', os.O_WRONLY | os.O_CREAT |
                 getattr(os, 'O_NOFOLLOW', 0), 0o600)
    info = os.fstat(fd)
    if info.st_uid != 0 or info.st_mode & 0o022:
        os.close(fd)
        raise Blocked('Shared controller lock changed')
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except Exception:
        os.close(fd)
        raise Blocked('Another GEOPS controller operation is running')
    return fd


def install(layout, archive_path, expected, signature_path, v1_wrapper_sha,
            v1_policy_sha, *, observe=observe_live, validate=validate_installed_v2,
            preflight=None, visudo=None, fault=lambda _: None):
    if os.geteuid() != 0:
        raise Blocked('Root on Linux required')
    archive = read_file(archive_path)
    signature = read_file(signature_path, 4096)
    verify_signature(layout, archive, expected, signature)
    items = archive_items(archive)
    prior = read_journal(layout)
    if prior and prior['phase'] == 'active':
        old, old_policy, _ = read_v1(layout, v1_wrapper_sha, v1_policy_sha,
                                     preserved_state=True)
        validate_policy(items, old_policy)
        lock = lock_state(layout)
        try:
            if (read_journal(layout) != prior or
                    prior['packageSha256'] != expected or
                    prior['v1WrapperSha256'] != sha(old['wrapper']) or
                    prior['v1PolicySha256'] != sha(old['policy']) or
                    prior['v1StateSha256'] != sha(old['state']) or
                    prior['v1PublicSha256'] != sha(old['public']) or
                    read_file(layout.sudoers, mode=0o440) != V2_SUDOERS):
                raise Blocked('Active v2 installation identity changed')
            verify_materialized(layout, items, old)
            return {'result': 'ALREADY_ACTIVE', 'packageSha256': expected}
        finally:
            os.close(lock)
    old, old_policy, state = read_v1(layout, v1_wrapper_sha, v1_policy_sha)
    validate_policy(items, old_policy)
    if preflight is None:
        preflight = lambda: checked([str(layout.old_wrapper), 'verify'], limit=120)
    if visudo is None:
        visudo = lambda path: checked(['/usr/sbin/visudo', '-cf', str(path)])
    preflight()
    lock = lock_state(layout)
    try:
        baseline = observe(layout, state)
        if baseline['stateSha256'] != sha(old['state']):
            raise Blocked('A21 state changed before lock')
        rule = read_file(layout.sudoers, mode=0o440)
        journal = read_journal(layout)
        if journal is None:
            if rule != V1_SUDOERS:
                raise Blocked('Installed v1 sudoers differs')
            journal = {'schemaVersion': 1, 'phase': 'staging',
                       'packageSha256': expected,
                       'v1WrapperSha256': sha(old['wrapper']),
                       'v1PolicySha256': sha(old['policy']),
                       'v1StateSha256': sha(old['state']),
                       'v1PublicSha256': sha(old['public']),
                       'baseline': baseline}
            write_journal(layout, journal)
            fault('after-journal')
        elif (journal['packageSha256'] != expected or
              journal['v1WrapperSha256'] != sha(old['wrapper']) or
              journal['v1PolicySha256'] != sha(old['policy']) or
              journal['v1PublicSha256'] != sha(old['public']) or
              journal['phase'] in ('returning', 'returned')):
            raise Blocked('V2 installation journal differs or was returned')
        if journal['phase'] == 'active':
            if rule != V2_SUDOERS:
                raise Blocked('Active v2 sudoers differs')
            verify_materialized(layout, items, old)
            return {'result': 'ALREADY_ACTIVE', 'packageSha256': expected}
        if journal['baseline'] != baseline or journal['v1StateSha256'] != sha(old['state']):
            raise Blocked('Operational baseline changed during pending installation')
        if rule not in (V1_SUDOERS, V2_SUDOERS):
            raise Blocked('Unknown active sudoers rule')
        materialize(layout, items, old, fault)
        verify_materialized(layout, items, old)
        with tempfile.TemporaryDirectory(prefix='geops-v2-sudo-', dir=layout.state / 'tmp') as folder:
            candidate = Path(folder) / 'sudoers'
            candidate.write_bytes(V2_SUDOERS)
            visudo(candidate)
        validate(layout)
        if observe(layout, state) != baseline:
            raise Blocked('GEOPS state changed during v2 preparation')
        if journal['phase'] == 'staging':
            journal['phase'] = 'ready'
            write_journal(layout, journal)
            fault('before-switch')
        if rule == V1_SUDOERS:
            atomic_replace(layout.sudoers, V2_SUDOERS, 0o440, expected_old=V1_SUDOERS)
        fault('after-switch')
        if read_file(layout.sudoers, mode=0o440) != V2_SUDOERS:
            raise Blocked('V2 sudoers activation failed')
        if observe(layout, state) != baseline:
            raise Blocked('GEOPS state changed after v2 activation')
        journal['phase'] = 'active'
        write_journal(layout, journal)
        fault('after-active')
        return {'result': 'V2_ACTIVE', 'packageSha256': expected}
    finally:
        os.close(lock)


def return_v1(layout, expected, *, observe=observe_live,
              preflight=None, visudo=None, fault=lambda _: None):
    if os.geteuid() != 0 or not HEX64.fullmatch(expected):
        raise Blocked('Root and reviewed package SHA-256 required')
    journal = read_journal(layout)
    if not journal or journal['packageSha256'] != expected:
        raise Blocked('Reviewed v2 installation journal required')
    if preflight is None:
        preflight = lambda: checked([str(layout.old_wrapper), 'verify'], limit=120)
    if visudo is None:
        visudo = lambda path: checked(['/usr/sbin/visudo', '-cf', str(path)])
    preflight()
    lock = lock_state(layout)
    try:
        old, _, state = read_v1(layout, journal['v1WrapperSha256'],
                                journal['v1PolicySha256'])
        baseline = observe(layout, state)  # Requires ledger 21 and live A21 images.
        if sha(old['state']) != journal['v1StateSha256']:
            raise Blocked('A21 state changed; v1 return forbidden')
        if read_file(layout.new / 'legacy/wrapper', mode=0o400) != old['wrapper'] or \
           read_file(layout.new / 'legacy/policy', mode=0o400) != old['policy'] or \
           read_file(layout.new / 'legacy/sudoers', mode=0o400) != V1_SUDOERS:
            raise Blocked('Preserved v1 snapshot differs')
        rule = read_file(layout.sudoers, mode=0o440)
        if journal['phase'] == 'returned':
            if rule != V1_SUDOERS:
                raise Blocked('Returned sudoers differs')
            return {'result': 'ALREADY_V1'}
        if journal['phase'] not in ('active', 'returning') or rule not in (V1_SUDOERS, V2_SUDOERS):
            raise Blocked('V2 was not safely activated')
        with tempfile.TemporaryDirectory(prefix='geops-v1-sudo-', dir=layout.state / 'tmp') as folder:
            candidate = Path(folder) / 'sudoers'
            candidate.write_bytes(V1_SUDOERS)
            visudo(candidate)
        if observe(layout, state) != baseline:
            raise Blocked('A21 changed before controller return')
        journal['phase'] = 'returning'
        write_journal(layout, journal)
        fault('before-return-switch')
        if rule == V2_SUDOERS:
            atomic_replace(layout.sudoers, V1_SUDOERS, 0o440, expected_old=V2_SUDOERS)
        fault('after-return-switch')
        if observe(layout, state) != baseline:
            atomic_replace(layout.sudoers, V2_SUDOERS, 0o440, expected_old=V1_SUDOERS)
            journal['phase'] = 'active'
            write_journal(layout, journal)
            raise Blocked('A21 changed after return; v2 rule restored')
        journal['phase'] = 'returned'
        write_journal(layout, journal)
        return {'result': 'V1_ACTIVE'}
    finally:
        os.close(lock)


def main(argv):
    protected(Path(__file__).absolute(), regular=True)
    layout = Layout()
    if len(argv) == 6 and argv[0] == 'install':
        result = install(layout, Path(argv[1]), argv[2], Path(argv[3]), argv[4], argv[5])
    elif len(argv) == 2 and argv[0] == 'return-v1':
        result = return_v1(layout, argv[1])
    else:
        raise Blocked('Allowed: install PACKAGE SHA256 SIG V1_WRAPPER_SHA V1_POLICY_SHA; return-v1 PACKAGE_SHA')
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as error:
        print('GEOPS v2 installation BLOCKED: ' + str(error), file=sys.stderr)
        sys.exit(1)
