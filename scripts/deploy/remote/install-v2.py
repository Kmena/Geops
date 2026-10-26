#!/usr/bin/python3 -I
"""Root-only, resumable v1→v2 installation and v2 point update. Never changes services."""

import fcntl
import getpass
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
B23_HASH = '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d'
INSTALLED_V2_POLICY_SHA = 'c439e50912842d339d32705426dd028eaa23c3390d4a6c6d29a1ac14b4fc4951'
INSTALLED_B23_POLICY_SHA = '5848fe813dd267065701ab2690e8a3bf5930c78b0be16c8a4c1001f19ab80b64'
B23_OLD_ENTRYPOINT_SHA = '80cd1d782f17e67da09fb6a905a704d1405e9d46caf4f1c5c9c845f51b4e99ad'
B23_OAUTH_ENTRYPOINT_SHA = '7d6d46206cf9ee635d4da0623119c9f666bccbe5e214fed1ca617d0d7ae123a7'
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
MDM_OVERLAY = 'infrastructure/compose/compose.staging.mdm-web-oauth.override.yaml'
API_ENTRYPOINT = 'infrastructure/staging/api-entrypoint.sh'
OAUTH_SECRETS = ('mdm_client_id', 'mdm_client_secret')
FILES = {'policy.json', 'lib/geops_deploy.py', 'controller/geops_deploy_v2.py',
         'geops-deploy-v2.sudoers'} | {'bundle/' + name for name in BUNDLE}
UPDATE_INSTALLER = 'operator/install-v2.py'
V1_SUDOERS = (b'Defaults!/usr/local/sbin/geops-deploy env_reset\n'
              b'Defaults!/usr/local/sbin/geops-deploy secure_path="/usr/sbin:/usr/bin:/sbin:/bin"\n'
              b'abi ALL=(root) NOPASSWD: /usr/local/sbin/geops-deploy\n')
V2_SUDOERS = (b'Defaults!/usr/local/sbin/geops-deploy-v2 env_reset\n'
              b'Defaults!/usr/local/sbin/geops-deploy-v2 secure_path="/usr/sbin:/usr/bin:/sbin:/bin"\n'
              b'abi ALL=(root) NOPASSWD: /usr/local/sbin/geops-deploy-v2\n')
UPDATE_SUDOERS = b'# GEOPS v2 controller update in progress; retry only with reviewed root installer\n'
PROFILES = {
    'A21': {'sqlCount': 21, 'sqlListSha256': A21_HASH,
            'variant': 'gps-base', 'mdmEnabled': False},
    'B22-safe': {'sqlCount': 22, 'sqlListSha256': B22_HASH,
                 'variant': 'gps-base', 'mdmEnabled': False},
    'B22-mdm': {'sqlCount': 22, 'sqlListSha256': B22_HASH,
                'variant': 'mdm-qa', 'mdmEnabled': True},
}
LEGACY_PROFILES = dict(PROFILES)
PROFILES.update({
    'B23-safe': {'sqlCount': 23, 'sqlListSha256': B23_HASH,
                 'variant': 'gps-base', 'mdmEnabled': False},
    'B23-mdm': {'sqlCount': 23, 'sqlListSha256': B23_HASH,
                'variant': 'mdm-qa', 'mdmEnabled': True},
})


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
        self.update_journal = self.state / 'v2-update.json'
        self.update_backup = self.state / 'v2-update-backup'
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


def archive_items(data, *, update=False):
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = archive.getmembers()
        required = FILES | ({UPDATE_INSTALLER} if update else set())
        if len(members) != len(required) or {item.name for item in members} != required:
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
            policy['profiles'] not in (LEGACY_PROFILES, PROFILES) or
            type(policy['backupMaxAgeSeconds']) is not int or
            not 0 < policy['backupMaxAgeSeconds'] <= 86400 or
            set(policy['files']) != set(BUNDLE) or
            set(policy['controllers']) != {'geops_deploy.py', 'geops_deploy_v2.py'}):
        raise Blocked('V2 policy is incompatible with installed A21')
    mdm = policy['mdm']
    if (not isinstance(mdm, dict) or
            mdm.get('region') not in ('com', 'eu', 'in', 'com.au', 'jp', 'ca', 'cn', 'sa', 'uk') or
            not (set(mdm) == {'region'} or
                 (set(mdm) == {'region', 'edition', 'customerId'} and
                  mdm['edition'] is None and mdm['customerId'] is None))):
        raise Blocked('Invalid v2 MDM server region')
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


def update_targets(layout):
    return {'policy.json': layout.new / 'policy.json',
            'lib/geops_deploy.py': layout.new / 'lib/geops_deploy.py',
            'controller/geops_deploy_v2.py': layout.new_wrapper,
            **{'bundle/' + name: layout.new / 'bundle' / name for name in BUNDLE}}


def replace_once(body, old, new):
    if body.count(old) != 1:
        raise Blocked('Installed v2 source differs from reviewed OAuth dependency')
    return body.replace(old, new)


def valid_oauth_value(value):
    return bool(value) and len(value) <= 2048 and value.strip() == value and all(
        byte >= 32 and byte != 127 for byte in value)


def validate_update_policy(items, old_items):
    if sha(old_items['policy.json']) == INSTALLED_B23_POLICY_SHA:
        old_policy = json.loads(old_items['policy.json'])
        policy = json.loads(items['policy.json'])
        if (set(old_policy) != set(policy) or
                old_policy['profiles'] != PROFILES or policy['profiles'] != PROFILES or
                old_policy['mdm'] != {'region': 'com'} or policy['mdm'] != {'region': 'com'} or
                set(old_policy['files']) != set(BUNDLE) or
                set(policy['files']) != set(BUNDLE) or
                old_policy['files'][API_ENTRYPOINT] != B23_OLD_ENTRYPOINT_SHA or
                policy['files'][API_ENTRYPOINT] != B23_OAUTH_ENTRYPOINT_SHA or
                any(old_policy[key] != policy[key] for key in old_policy
                    if key != 'files') or
                any(old_policy['files'][name] != policy['files'][name]
                    for name in BUNDLE if name != API_ENTRYPOINT) or
                items['bundle/' + API_ENTRYPOINT] == old_items['bundle/' + API_ENTRYPOINT]):
            raise Blocked('B23 OAuth update must change only the reviewed API entrypoint')
        for name, body in old_items.items():
            if name == 'policy.json':
                continue
            expected = (old_policy['controllers']['geops_deploy_v2.py'] if
                        name == 'controller/geops_deploy_v2.py' else
                        old_policy['controllers']['geops_deploy.py'] if
                        name == 'lib/geops_deploy.py' else
                        old_policy['files'][name.removeprefix('bundle/')])
            if sha(body) != expected:
                raise Blocked('Installed B23 file differs from active policy')
        for name, body in items.items():
            if name in (UPDATE_INSTALLER, 'geops-deploy-v2.sudoers', 'policy.json'):
                continue
            expected = (policy['controllers']['geops_deploy_v2.py'] if
                        name == 'controller/geops_deploy_v2.py' else
                        policy['controllers']['geops_deploy.py'] if
                        name == 'lib/geops_deploy.py' else
                        policy['files'][name.removeprefix('bundle/')])
            if sha(body) != expected:
                raise Blocked('Signed B23 update file differs from policy')
        if items['geops-deploy-v2.sudoers'] != V2_SUDOERS:
            raise Blocked('B23 update changed sudo privileges')
        return policy
    if sha(old_items['policy.json']) != INSTALLED_V2_POLICY_SHA:
        raise Blocked('Installed B22 policy differs from reviewed v2 source')
    old_policy = json.loads(old_items['policy.json'])
    policy = json.loads(items['policy.json'])
    if set(old_policy) != set(policy) or set(policy) != {
            'schemaVersion', 'environment', 'origin', 'secretGid', 'imageTag',
            'backupMaxAgeSeconds', 'profiles', 'mdm', 'files', 'controllers'}:
        raise Blocked('V2 policy inventory changed')
    if any(old_policy[key] != policy[key] for key in (
            'schemaVersion', 'environment', 'origin', 'secretGid', 'imageTag',
            'backupMaxAgeSeconds')):
        raise Blocked('V2 point update changed deployment policy')
    if (set(old_policy['files']) != set(BUNDLE) or
            set(policy['files']) != set(BUNDLE) or
            any(old_policy['files'][name] != policy['files'][name]
                for name in BUNDLE if name not in (MDM_OVERLAY, API_ENTRYPOINT))):
        raise Blocked('Non-MDM bundle changed during v2 point update')
    if (policy['schemaVersion'] != 2 or
            policy['environment'] != 'geops-spec02-staging' or
            old_policy['profiles'] != LEGACY_PROFILES or
            policy['profiles'] != PROFILES or
            policy['mdm'] != {'region': 'com'} or
            not isinstance(old_policy['mdm'], dict) or
            old_policy['mdm'].get('region') != 'com' or
            set(old_policy['mdm']) not in ({'region'}, {'region', 'edition', 'customerId'}) or
            set(policy['files']) != set(BUNDLE) or
            set(policy['controllers']) != {'geops_deploy.py', 'geops_deploy_v2.py'} or
            old_policy['controllers']['geops_deploy.py'] != policy['controllers']['geops_deploy.py']):
        raise Blocked('V2 point update requires unchanged B22 policy and region com')
    old_overlay = old_items['bundle/' + MDM_OVERLAY]
    expected_overlay = old_overlay
    if b'mdm_client_id, mdm_client_secret' in expected_overlay:
        expected_overlay = replace_once(
            expected_overlay,
            b', mdm_client_id, mdm_client_secret]', b']')
        expected_overlay = replace_once(
            expected_overlay,
            b'secrets:\n  mdm_client_id:\n    file: ./.local/staging/secrets/mdm_client_id\n  mdm_client_secret:\n    file: ./.local/staging/secrets/mdm_client_secret\n', b'')
    if items['bundle/' + MDM_OVERLAY] != expected_overlay:
        raise Blocked('MDM overlay differs beyond removal of mounted OAuth client secrets')
    if items['bundle/' + API_ENTRYPOINT] != old_items['bundle/' + API_ENTRYPOINT]:
        raise Blocked('API entrypoint changed during OAuth secret mount update')
    for name, body in old_items.items():
        if name == 'policy.json':
            continue
        expected = (old_policy['controllers']['geops_deploy_v2.py'] if
                    name == 'controller/geops_deploy_v2.py' else
                    old_policy['controllers']['geops_deploy.py'] if
                    name == 'lib/geops_deploy.py' else
                    old_policy['files'][name.removeprefix('bundle/')])
        if sha(body) != expected:
            raise Blocked('Installed v2 file differs from active policy')
    for name, body in items.items():
        if name in (UPDATE_INSTALLER, 'geops-deploy-v2.sudoers', 'policy.json'):
            continue
        expected = (policy['controllers']['geops_deploy_v2.py'] if
                    name == 'controller/geops_deploy_v2.py' else
                    policy['controllers']['geops_deploy.py'] if
                    name == 'lib/geops_deploy.py' else
                    policy['files'][name.removeprefix('bundle/')])
        if sha(body) != expected:
            raise Blocked('Signed v2 update file differs from policy')
    if items['geops-deploy-v2.sudoers'] != V2_SUDOERS:
        raise Blocked('V2 sudoers rule changed')
    return policy


def observe_b2x_live(layout, state, version, sql_count, sql_hash):
    if (state.get('schemaVersion') != 2 or state.get('phase') != 'steady' or
            state.get('pending') is not None or
            state.get('active', {}).get('profile') not in (version + '-safe', version + '-mdm') or
            (state['active']['profile'] == version + '-safe' and state.get('previous') is not None) or
            (state['active']['profile'] == version + '-mdm' and
             (not isinstance(state.get('previous'), dict) or
              state['previous'].get('profile') != version + '-safe'))):
        raise Blocked('Steady compatible profile required for controller update')
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
            raise Blocked('Image differs from protected state')
        result[kind] = {'containerId': value['Id'], 'imageId': value['Image'],
                        'health': 'healthy'}
    rows = checked(['/usr/bin/docker', 'exec', 'geops-spec02-staging-geops-db-1',
                    'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'geops_stage',
                    '-d', 'geops_dev', '-Atq', '-c',
                    'SELECT version,checksum FROM geops_schema_migrations ORDER BY version'])
    lines = [line for line in rows.splitlines() if line]
    if len(lines) != sql_count or any(not SQL_LINE.fullmatch(line) for line in lines) or \
            sha('\n'.join(lines).encode()) != sql_hash:
        raise Blocked('Exact PostgreSQL ledger required')
    gate_bytes = layout.gate.read_bytes()
    if json.loads(gate_bytes).get('phase') != 'open':
        raise Blocked('External gate must be open')
    result['ledger'] = {'count': sql_count, 'sha256': sql_hash}
    result['gateSha256'] = sha(gate_bytes)
    result['stateSha256'] = sha(read_file(layout.state / 'state.json', mode=0o600))
    return result


def observe_b22_live(layout, state):
    return observe_b2x_live(layout, state, 'B22', 22, B22_HASH)


def observe_b23_live(layout, state):
    return observe_b2x_live(layout, state, 'B23', 23, B23_HASH)


def observe_v2_live(layout, state):
    profile = state.get('active', {}).get('profile')
    if profile in ('B22-safe', 'B22-mdm'):
        return observe_b22_live(layout, state)
    if profile in ('B23-safe', 'B23-mdm'):
        return observe_b23_live(layout, state)
    raise Blocked('Unsupported active profile for controller update')


def validate_updated_v2(layout):
    loader = SourceFileLoader('geops_reviewed_v2_update', str(layout.new_wrapper))
    spec = importlib.util.spec_from_loader('geops_reviewed_v2_update', loader)
    if spec is None or spec.loader is None:
        raise Blocked('Updated v2 controller could not be loaded')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    control = module.ControllerV2()
    state = control.preflight()
    if state['active']['profile'] not in ('B22-safe', 'B22-mdm', 'B23-safe', 'B23-mdm'):
        raise Blocked('Updated v2 preflight did not retain compatible profile')
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


def update_v2(layout, archive_path, signature_path, *,
              observe=observe_v2_live, validate=validate_updated_v2,
              preflight=None, visudo=None, fault=lambda _: None):
    if os.geteuid() != 0:
        raise Blocked('Root on Linux required')
    protected(Path(__file__).absolute(), regular=True)
    archive = read_file(archive_path)
    signature = read_file(signature_path, 4096)
    digest = sha(archive)
    verify_signature(layout, archive, digest, signature)
    items = archive_items(archive, update=True)
    if items[UPDATE_INSTALLER] != read_file(Path(__file__).absolute()):
        raise Blocked('Running installer is not the signed installer')
    if preflight is None:
        preflight = lambda: checked([str(layout.new_wrapper), 'verify'], limit=120)
    if visudo is None:
        visudo = lambda path: checked(['/usr/sbin/visudo', '-cf', str(path)])
    # The installed controller acquires the same shared lock in `verify`.
    # Run that read-only check before taking it; the locked observer below
    # rechecks images, ledger, gate and protected state before any switch.
    prior_update = (json.loads(read_file(layout.update_journal, 32768, mode=0o600))
                    if os.path.lexists(layout.update_journal) else None)
    if prior_update is None or (prior_update.get('phase') == 'active' and
                                prior_update.get('packageSha256') != digest):
        preflight()
    lock = lock_state(layout)
    try:
        installation = read_journal(layout)
        if installation is None or installation['phase'] != 'active':
            raise Blocked('Installed v2 has not been activated')
        targets = update_targets(layout)
        journal = None
        rotate_backup = False
        previous_journal_bytes = None
        if os.path.lexists(layout.update_journal):
            previous_journal_bytes = read_file(layout.update_journal, 32768, mode=0o600)
            journal = json.loads(previous_journal_bytes)
            if (set(journal) != {'schemaVersion', 'phase', 'packageSha256',
                                'oldHashes', 'newHashes', 'baseline'} or
                    journal['schemaVersion'] != 1 or
                    journal['phase'] not in ('preparing', 'prepared', 'switching', 'active') or
                    set(journal['oldHashes']) != set(targets) or
                    set(journal['newHashes']) != set(targets)):
                raise Blocked('Pending v2 update identity differs')
            if journal['packageSha256'] != digest:
                if (journal['phase'] != 'active' or
                        read_file(layout.sudoers, mode=0o440) != V2_SUDOERS):
                    raise Blocked('Pending v2 update identity differs')
                prior_backup = {name: read_file(layout.update_backup / name, mode=0o400)
                                for name in targets}
                if {name: sha(body) for name, body in prior_backup.items()} != journal['oldHashes']:
                    raise Blocked('Previous v2 recovery copy differs')
                old_items = {name: read_file(path, mode=0o755 if path == layout.new_wrapper else 0o444)
                             for name, path in targets.items()}
                if {name: sha(body) for name, body in old_items.items()} != journal['newHashes']:
                    raise Blocked('Installed v2 update differs from active journal')
                journal = None
                rotate_backup = True
            elif journal['newHashes'] != {name: sha(items[name]) for name in targets}:
                raise Blocked('Pending v2 update identity differs')
            elif journal['phase'] == 'preparing':
                old_items = {name: read_file(path, mode=0o755 if path == layout.new_wrapper else 0o444)
                             for name, path in targets.items()}
                if {name: sha(body) for name, body in old_items.items()} != journal['oldHashes']:
                    raise Blocked('Installed v2 changed during backup preparation')
                rotate_backup = True
            else:
                old_items = {name: read_file(layout.update_backup / name, mode=0o400)
                             for name in targets}
                if {name: sha(body) for name, body in old_items.items()} != journal['oldHashes']:
                    raise Blocked('Protected v2 recovery copy differs')
        else:
            if read_file(layout.sudoers, mode=0o440) != V2_SUDOERS:
                raise Blocked('V2 sudoers must be active before update')
            old_items = {name: read_file(path, mode=0o755 if path == layout.new_wrapper else 0o444)
                         for name, path in targets.items()}
        validate_update_policy(items, old_items)
        if read_file(layout.new / 'public.pem', mode=0o444) != \
                read_file(layout.old / 'public.pem', mode=0o444):
            raise Blocked('Operational Ed25519 identity changed')
        state = json.loads(read_file(layout.state / 'state.json', mode=0o600))
        baseline = observe(layout, state)
        if journal is None and rotate_backup:
            journal = {'schemaVersion': 1, 'phase': 'preparing',
                       'packageSha256': digest,
                       'oldHashes': {name: sha(body) for name, body in old_items.items()},
                       'newHashes': {name: sha(items[name]) for name in targets},
                       'baseline': baseline}
            atomic_replace(layout.update_journal,
                           (json.dumps(journal, sort_keys=True) + '\n').encode(), 0o600,
                           expected_old=previous_journal_bytes)
            fault('after-update-journal')
        if rotate_backup:
            if baseline != journal['baseline']:
                raise Blocked('B22-safe changed during backup preparation')
            for name, body in old_items.items():
                backup = layout.update_backup / name
                if os.path.lexists(backup):
                    prior = read_file(backup, mode=0o400)
                    if prior != body:
                        atomic_replace(backup, body, 0o400, expected_old=prior)
                else:
                    write_exact(backup, body, 0o400)
                fault('after-update-backup:' + name)
            journal['phase'] = 'prepared'
            atomic_replace(layout.update_journal,
                           (json.dumps(journal, sort_keys=True) + '\n').encode(), 0o600)
        elif journal is None:
            ensure_dir(layout.update_backup, 0o700)
            for name, body in old_items.items():
                write_exact(layout.update_backup / name, body, 0o400)
            journal = {'schemaVersion': 1, 'phase': 'prepared',
                       'packageSha256': digest,
                       'oldHashes': {name: sha(body) for name, body in old_items.items()},
                       'newHashes': {name: sha(items[name]) for name in targets},
                       'baseline': baseline}
            atomic_replace(layout.update_journal,
                           (json.dumps(journal, sort_keys=True) + '\n').encode(), 0o600)
            fault('after-update-journal')
        elif baseline != journal['baseline']:
            raise Blocked('B22-safe changed during pending controller update')
        rule = read_file(layout.sudoers, mode=0o440)
        if journal['phase'] == 'active':
            if rule != V2_SUDOERS or any(
                    read_file(path, mode=0o755 if path == layout.new_wrapper else 0o444)
                    != items[name] for name, path in targets.items()):
                raise Blocked('Active v2 update differs')
            validate(layout)
            return {'result': 'ALREADY_UPDATED', 'packageSha256': digest}
        if rule not in (V2_SUDOERS, UPDATE_SUDOERS):
            raise Blocked('Unknown controller sudoers rule during update')
        with tempfile.TemporaryDirectory(prefix='geops-v2-update-sudo-', dir=layout.state / 'tmp') as folder:
            for name, body in (('disabled', UPDATE_SUDOERS), ('active', V2_SUDOERS)):
                candidate = Path(folder) / name
                candidate.write_bytes(body)
                visudo(candidate)
        if rule == V2_SUDOERS:
            atomic_replace(layout.sudoers, UPDATE_SUDOERS, 0o440, expected_old=V2_SUDOERS)
        journal['phase'] = 'switching'
        atomic_replace(layout.update_journal,
                       (json.dumps(journal, sort_keys=True) + '\n').encode(), 0o600)
        fault('after-update-disabled')
        for name, path in targets.items():
            current = read_file(path, mode=0o755 if path == layout.new_wrapper else 0o444)
            if current not in (old_items[name], items[name]):
                raise Blocked('Unexpected controller file during update')
            if current != items[name]:
                atomic_replace(path, items[name], 0o755 if path == layout.new_wrapper else 0o444,
                               expected_old=old_items[name])
            fault('after-update-file:' + name)
        validate(layout)
        if observe(layout, state) != journal['baseline']:
            raise Blocked('B22-safe changed during controller update')
        fault('before-update-enable')
        atomic_replace(layout.sudoers, V2_SUDOERS, 0o440, expected_old=UPDATE_SUDOERS)
        fault('after-update-enable')
        validate(layout)
        if observe(layout, state) != journal['baseline']:
            atomic_replace(layout.sudoers, UPDATE_SUDOERS, 0o440, expected_old=V2_SUDOERS)
            raise Blocked('B22-safe changed after controller update')
        journal['phase'] = 'active'
        atomic_replace(layout.update_journal,
                       (json.dumps(journal, sort_keys=True) + '\n').encode(), 0o600)
        return {'result': 'V2_UPDATED_' + state['active']['profile'].replace('-', '_').upper(),
                'packageSha256': digest}
    finally:
        os.close(lock)


def provision_oauth(layout, archive_path, signature_path, *,
                    preflight=None, observe=observe_v2_live, prompt=None):
    """Add only the two OAuth client values to the existing protected secret store."""
    if os.geteuid() != 0:
        raise Blocked('Root on Linux required')
    archive = read_file(archive_path)
    signature = read_file(signature_path, 4096)
    package_sha = sha(archive)
    verify_signature(layout, archive, package_sha, signature)
    items = archive_items(archive, update=True)
    if items[UPDATE_INSTALLER] != read_file(Path(__file__).absolute()):
        raise Blocked('Running installer is not the signed installer')
    if preflight is None:
        preflight = lambda: checked([str(layout.new_wrapper), 'verify'], limit=120)
    preflight()
    lock = lock_state(layout)
    try:
        journal = json.loads(read_file(layout.update_journal, 32768, mode=0o600))
        if journal.get('phase') != 'active' or journal.get('packageSha256') != package_sha:
            raise Blocked('Signed OAuth package is not the installed v2 update')
        for name, path in update_targets(layout).items():
            if read_file(path, mode=0o755 if path == layout.new_wrapper else 0o444) != items[name]:
                raise Blocked('Installed v2 differs from signed OAuth package')
        state = json.loads(read_file(layout.state / 'state.json', mode=0o600))
        observe(layout, state)
        protected(layout.new / 'secrets', mode=0o700)
        protected(layout.new / 'runtime-secrets', mode=0o700)
        paths = [(layout.new / directory / name, mode, gid)
                 for name in OAUTH_SECRETS
                 for directory, mode, gid in (('secrets', 0o600, 0),
                                              ('runtime-secrets', 0o640, 24001))]
        if all(os.path.lexists(path) for path, _, _ in paths):
            for name in OAUTH_SECRETS:
                master = read_file(layout.new / 'secrets' / name, 2048, mode=0o600)
                runtime = read_file(layout.new / 'runtime-secrets' / name, 2048, mode=0o640)
                if (not valid_oauth_value(master) or master != runtime or
                        os.stat(layout.new / 'runtime-secrets' / name).st_gid != 24001):
                    raise Blocked('Protected OAuth client copies differ')
            return {'result': 'OAUTH_CLIENT_ALREADY_PROVISIONED'}
        if prompt is None:
            prompt = getpass.getpass
        values = {}
        for name, label in (('mdm_client_id', 'ManageEngine Client ID: '),
                            ('mdm_client_secret', 'ManageEngine Client Secret: ')):
            value = prompt(label).encode('utf-8')
            if not valid_oauth_value(value):
                raise Blocked('Invalid OAuth client credential format')
            values[name] = value
        for path, mode, gid in paths:
            value = values[path.name]
            if os.path.lexists(path):
                if os.stat(path).st_gid != gid or read_file(path, 2048, mode=mode) != value:
                    raise Blocked('Existing OAuth client credential differs')
        for path, mode, gid in paths:
            write_exact(path, values[path.name], mode, gid)
        return {'result': 'OAUTH_CLIENT_PROVISIONED'}
    finally:
        os.close(lock)


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
    elif len(argv) == 3 and argv[0] == 'update-v2':
        result = update_v2(layout, Path(argv[1]), Path(argv[2]))
    elif len(argv) == 3 and argv[0] == 'provision-oauth':
        result = provision_oauth(layout, Path(argv[1]), Path(argv[2]))
    else:
        raise Blocked('Allowed: install PACKAGE SHA256 SIG V1_WRAPPER_SHA V1_POLICY_SHA; return-v1 PACKAGE_SHA; update-v2 PACKAGE SIG; provision-oauth PACKAGE SIG')
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as error:
        print('GEOPS v2 installation BLOCKED: ' + str(error), file=sys.stderr)
        sys.exit(1)
