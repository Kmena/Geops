#!/usr/bin/python3 -I
"""Fixed-scope GEOPS Staging deployment controller; installed root-owned."""

import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

try:
    import fcntl
except ImportError:  # imported by tests on Windows, never used by the installed CLI
    fcntl = None

ROOT = Path('/etc/geops-deploy')
STATE_DIR = Path('/var/lib/geops-deploy')
LOG = Path('/var/log/geops-deploy/audit.jsonl')
DOCKER = '/usr/bin/docker'
OPENSSL = '/usr/bin/openssl'
COMPOSE_PLUGIN = Path('/usr/libexec/docker/cli-plugins/docker-compose')
ENVIRONMENT = 'geops-spec02-staging'
IDENT = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$')
SHA = re.compile(r'^[a-f0-9]{40}$')
HEX64 = re.compile(r'^[a-f0-9]{64}$')
IMAGE_ID = re.compile(r'^sha256:[a-f0-9]{64}$')
SQL_LINE = re.compile(r'^\d{4}_[a-z0-9_]+\.sql\|[a-f0-9]{64}$')
SERVICES = {'api': 'geops-spec02-staging-geops-api-1',
            'web': 'geops-spec02-staging-geops-web-1',
            'db': 'geops-spec02-staging-geops-db-1'}
GATE = Path('/var/lib/docker/volumes/geops_spec02_stage_security/_data/security-gate.json')
BACKUPS = Path('/var/lib/docker/volumes/geops_spec02_stage_backups/_data')
SECRET_NAMES = ('db_password', 'admin_session_key', 'admin_csrf_key',
                'invitation_hmac_key', 'mdm_grant_key', 'gps_quarantine_key')
BUNDLE_FILES = (
    'infrastructure/compose/compose.staging.yaml',
    'infrastructure/compose/compose.staging.digest.override.yaml',
    'infrastructure/nginx/geops-staging-web.conf',
    'infrastructure/staging/api-entrypoint.sh',
    'infrastructure/staging/backup.sh',
)


class Blocked(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def exact_keys(value, keys):
    if not isinstance(value, dict) or set(value) != set(keys):
        raise Blocked('Unexpected document fields')


def utc(value):
    if not isinstance(value, str) or not value.endswith('Z'):
        raise Blocked('UTC timestamp required')
    try:
        return datetime.fromisoformat(value[:-1] + '+00:00')
    except ValueError as exc:
        raise Blocked('Invalid UTC timestamp') from exc


def regular_bytes(path, limit=65536, trusted=False, owner=None, group=None, mode=None):
    """Read one inode; never follow a final symlink."""
    flags = (os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) |
             getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_BINARY', 0))
    fd = os.open(path, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise Blocked('Invalid input file')
        if trusted and (info.st_uid != 0 or info.st_mode & 0o022):
            raise Blocked('Trusted file is not root-protected')
        if ((owner is not None and info.st_uid != owner) or
                (group is not None and info.st_gid != group) or
                (mode is not None and stat.S_IMODE(info.st_mode) != mode)):
            raise Blocked('Data file ownership or mode changed')
        chunks = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(fd, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b''.join(chunks)
        if len(data) > limit:
            raise Blocked('Input too large')
        return data
    finally:
        os.close(fd)


def secure_tree(path):
    """No privileged code/config path may traverse an abi-writable ancestor."""
    target = Path(path).absolute()
    for part in (target, *target.parents):
        info = os.lstat(part)
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise Blocked('Privileged path is not root-protected')


def gate_bytes(path, enforce_root):
    """The writable gate volume belongs to the fixed non-root container UID."""
    if enforce_root:
        secure_tree(path.parent.parent)
        directory = os.lstat(path.parent)
        if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != 1000 or
                directory.st_gid != 1000 or stat.S_IMODE(directory.st_mode) != 0o755):
            raise Blocked('Gate volume ownership or mode changed')
        return regular_bytes(path, 256, owner=1000, group=1000, mode=0o600)
    return regular_bytes(path, 256)


def image_ref(value, service):
    registry = rf'ghcr\.io/kmena/geops-{service}@sha256:[a-f0-9]{{64}}'
    local = rf'geops-spec02-{service}:[a-f0-9]{{40}}'
    return isinstance(value, str) and bool(re.fullmatch(registry, value) or re.fullmatch(local, value))


class Controller:
    def __init__(self, root=ROOT, state_dir=STATE_DIR, log=LOG, docker=DOCKER,
                 openssl=OPENSSL, enforce_root=True, runner=None):
        self.root, self.state_dir, self.log = Path(root), Path(state_dir), Path(log)
        self.docker, self.openssl = docker, openssl
        self.enforce_root = enforce_root
        self.runner = runner or subprocess.run
        self.env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root',
                    'LANG': 'C', 'DOCKER_CONFIG': str(self.root / 'docker')}
        self.bundle = self.root / 'bundle'
        self.policy_bytes = b''
        self.policy = None

    def call(self, args, timeout=30, env=None):
        try:
            done = self.runner(args, cwd=self.bundle, env=env or self.env,
                               stdin=subprocess.DEVNULL, capture_output=True,
                               text=True, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Blocked('Fixed command unavailable or timed out') from exc
        if done.returncode:
            raise Blocked('Fixed command failed; consult private host logs')
        if len(done.stdout) > 1000000:
            raise Blocked('Command output exceeded limit')
        return done.stdout.strip()

    def audit(self, event, result, detail=''):
        record = {'at': datetime.now(timezone.utc).isoformat(), 'event': event,
                  'result': result, 'detail': detail[:120]}
        flags = os.O_WRONLY | os.O_APPEND | getattr(os, 'O_NOFOLLOW', 0)
        fd = os.open(self.log, flags)
        try:
            if self.enforce_root:
                info = os.fstat(fd)
                if info.st_uid != 0 or info.st_mode & 0o022:
                    raise Blocked('Audit log is not root-protected')
            os.write(fd, (json.dumps(record, sort_keys=True) + '\n').encode())
            os.fsync(fd)
        finally:
            os.close(fd)

    def timed(self, name, function):
        started = time.monotonic()
        try:
            result = function()
        except Exception:
            self.audit(name, 'FAIL', f'{time.monotonic()-started:.3f}s')
            raise
        self.audit(name, 'PASS', f'{time.monotonic()-started:.3f}s')
        return result

    def load_policy(self):
        if self.enforce_root:
            for path in (self.root, self.state_dir, self.log.parent,
                         self.root / 'public.pem', self.root / 'policy.json',
                         self.state_dir / 'state.json', self.state_dir / 'used',
                         self.state_dir / 'tmp', self.bundle, Path(self.docker),
                         Path(self.openssl), COMPOSE_PLUGIN, Path(__file__)):
                secure_tree(path)
            inbox = os.stat(self.state_dir / 'inbox')
            if inbox.st_uid != 0 or inbox.st_mode & 0o002:
                raise Blocked('Approval inbox is not root-controlled')
            regular_bytes(self.root / 'public.pem', 4096, True)
        self.policy_bytes = regular_bytes(self.root / 'policy.json', trusted=self.enforce_root)
        policy = json.loads(self.policy_bytes)
        exact_keys(policy, ('schemaVersion', 'environment', 'origin', 'secretGid',
                            'imageTag', 'sqlCount', 'sqlListSha256', 'variant',
                            'files', 'backupMaxAgeSeconds'))
        if policy['schemaVersion'] != 1 or policy['environment'] != ENVIRONMENT:
            raise Blocked('Wrong policy environment')
        if policy['variant'] != 'gps-base' or policy['sqlCount'] != 21:
            raise Blocked('Staging policy requires gps-base and 21 SQL files')
        if not isinstance(policy['sqlListSha256'], str) or not HEX64.fullmatch(policy['sqlListSha256']):
            raise Blocked('Invalid SQL list hash')
        if policy['origin'] != 'https://geops-staging.duckdns.org':
            raise Blocked('Unexpected origin')
        if policy['secretGid'] != '24001':
            raise Blocked('Invalid secret group')
        if not isinstance(policy['imageTag'], str) or not SHA.fullmatch(policy['imageTag']):
            raise Blocked('Invalid base image tag')
        if not isinstance(policy['backupMaxAgeSeconds'], int) or not 0 < policy['backupMaxAgeSeconds'] <= 86400:
            raise Blocked('Invalid backup age limit')
        if not isinstance(policy['files'], dict) or set(policy['files']) != set(BUNDLE_FILES):
            raise Blocked('Bundle file inventory changed')
        for name in BUNDLE_FILES:
            target = self.bundle / name
            if self.enforce_root:
                secure_tree(target)
            if digest(regular_bytes(target, 1_000_000, self.enforce_root)) != policy['files'][name]:
                raise Blocked('Approved bundle checksum mismatch: ' + name)
        secret_dir = self.bundle / 'infrastructure/compose/.local/staging/secrets'
        if self.enforce_root:
            link = os.lstat(secret_dir)
            if not stat.S_ISLNK(link.st_mode) or os.readlink(secret_dir) != str(self.root / 'runtime-secrets'):
                raise Blocked('Secret directory link changed')
            secure_tree(self.root / 'secrets')
            secure_tree(self.root / 'runtime-secrets')
            if (stat.S_IMODE(os.stat(self.root / 'secrets').st_mode) != 0o700 or
                    os.stat(self.root / 'secrets').st_gid != 0 or
                    stat.S_IMODE(os.stat(self.root / 'runtime-secrets').st_mode) != 0o700 or
                    os.stat(self.root / 'runtime-secrets').st_gid != 0):
                raise Blocked('Secret directory permissions changed')
            for name in SECRET_NAMES:
                master = self.root / 'secrets' / name
                runtime = self.root / 'runtime-secrets' / name
                secure_tree(master)
                secure_tree(runtime)
                master_info, runtime_info = os.stat(master), os.stat(runtime)
                if (not stat.S_ISREG(master_info.st_mode) or master_info.st_gid != 0 or
                        stat.S_IMODE(master_info.st_mode) != 0o600 or
                        not stat.S_ISREG(runtime_info.st_mode) or
                        runtime_info.st_gid != int(policy['secretGid']) or
                        stat.S_IMODE(runtime_info.st_mode) != 0o640 or
                        digest(regular_bytes(master, 4096, True)) !=
                        digest(regular_bytes(runtime, 4096, True))):
                    raise Blocked('Protected and runtime secret copies differ')
        self.policy = policy
        return policy

    @staticmethod
    def check_version(version):
        exact_keys(version, ('commit', 'apiRef', 'webRef', 'apiId', 'webId', 'releaseSha256'))
        if not isinstance(version['commit'], str) or not SHA.fullmatch(version['commit']):
            raise Blocked('Invalid version commit')
        if not image_ref(version['apiRef'], 'api') or not image_ref(version['webRef'], 'web'):
            raise Blocked('Invalid version image reference')
        if not all(isinstance(version[key], str) and IMAGE_ID.fullmatch(version[key])
                   for key in ('apiId', 'webId')):
            raise Blocked('Invalid version image ID')
        if version['releaseSha256'] is not None and (
                not isinstance(version['releaseSha256'], str) or
                not HEX64.fullmatch(version['releaseSha256'])):
            raise Blocked('Invalid release identity')

    def state(self):
        value = json.loads(regular_bytes(self.state_dir / 'state.json', trusted=self.enforce_root))
        exact_keys(value, ('schemaVersion', 'active', 'previous'))
        if value['schemaVersion'] != 1:
            raise Blocked('Invalid state schema')
        self.check_version(value['active'])
        if value['previous'] is not None:
            self.check_version(value['previous'])
        return value

    def verify_signature(self, payload, signature):
        with tempfile.TemporaryDirectory(prefix='verify-', dir=self.state_dir / 'tmp') as folder:
            message, sig = Path(folder) / 'message', Path(folder) / 'signature'
            message.write_bytes(payload)
            sig.write_bytes(signature)
            self.call([self.openssl, 'pkeyutl', '-verify', '-pubin', '-inkey',
                       str(self.root / 'public.pem'), '-rawin', '-in', str(message),
                       '-sigfile', str(sig)], timeout=10)

    def signed(self, kind, identity):
        if not isinstance(identity, str) or not IDENT.fullmatch(identity):
            raise Blocked('Invalid approval identifier')
        folder = self.state_dir / 'inbox'
        payload = regular_bytes(folder / f'{identity}.{kind}.json', 16384)
        signature = regular_bytes(folder / f'{identity}.{kind}.sig', 4096)
        self.verify_signature(payload, signature)
        data = json.loads(payload)
        if data.get('id') != identity or data.get('environment') != ENVIRONMENT:
            raise Blocked('Signed document identity mismatch')
        start, end, now = utc(data.get('notBefore')), utc(data.get('expiresAt')), datetime.now(timezone.utc)
        maximum = timedelta(days=30) if kind == 'release' else timedelta(minutes=30)
        if start > now or end <= now or end - start > maximum or end <= start:
            raise Blocked('Signed document outside approval window')
        return data, digest(payload)

    def release(self, identity):
        value, sha = self.signed('release', identity)
        exact_keys(value, ('schemaVersion', 'id', 'environment', 'notBefore', 'expiresAt',
                           'commit', 'api', 'web', 'variant', 'sqlCount', 'sqlListSha256',
                           'policySha256'))
        if value['schemaVersion'] != 1 or not isinstance(value['commit'], str) or not SHA.fullmatch(value['commit']):
            raise Blocked('Invalid release')
        if not image_ref(value['api'], 'api') or '@sha256:' not in value['api']:
            raise Blocked('API registry not authorized')
        if not image_ref(value['web'], 'web') or '@sha256:' not in value['web']:
            raise Blocked('Web registry not authorized')
        if (value['variant'] != self.policy['variant'] or
                value['sqlCount'] != self.policy['sqlCount'] or
                value['sqlListSha256'] != self.policy['sqlListSha256'] or
                value['policySha256'] != digest(self.policy_bytes)):
            raise Blocked('Release differs from approved environment policy')
        return value, sha

    def approval(self, identity, action, release_sha, source, target):
        value, _ = self.signed('approval', identity)
        exact_keys(value, ('schemaVersion', 'id', 'environment', 'notBefore', 'expiresAt',
                           'action', 'releaseSha256', 'releaseCommit', 'apiDigest',
                           'webDigest', 'policySha256',
                           'sourceApiId', 'sourceWebId', 'targetApiId', 'targetWebId'))
        release_version = target if action == 'deploy' else source
        if (value['schemaVersion'] != 1 or value['action'] != action or
                value['releaseSha256'] != release_sha or
                value['releaseCommit'] != release_version['commit'] or
                value['apiDigest'] != release_version['apiRef'] or
                value['webDigest'] != release_version['webRef'] or
                value['policySha256'] != digest(self.policy_bytes) or
                value['sourceApiId'] != source['apiId'] or
                value['sourceWebId'] != source['webId'] or
                value['targetApiId'] != target['apiId'] or
                value['targetWebId'] != target['webId']):
            raise Blocked('Approval not bound to this action, release and image transition')
        if (self.state_dir / 'used' / identity).exists():
            raise Blocked('Approval already used')

    def consume(self, identity):
        path = self.state_dir / 'used' / identity
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
        try:
            os.write(fd, datetime.now(timezone.utc).isoformat().encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        self.audit('approval-consumed', 'PASS', identity)

    def docker_json(self, args, env=None):
        return json.loads(self.call([self.docker, *args], timeout=30, env=env))

    def container(self, service):
        value = self.docker_json(['inspect', '--format', '{{json .}}', SERVICES[service]])
        labels = value.get('Config', {}).get('Labels') or {}
        if (labels.get('com.docker.compose.project') != ENVIRONMENT or
                labels.get('com.docker.compose.service') != f'geops-{service}'):
            raise Blocked('Container is not the approved GEOPS service')
        return {'id': value['Id'], 'image': value['Image'],
                'health': (value['State'].get('Health') or {}).get('Status'),
                'status': value['State']['Status']}

    def database_ledger(self):
        lines = self.call([self.docker, 'exec', SERVICES['db'], 'psql', '-X', '-v',
                           'ON_ERROR_STOP=1', '-U', 'geops_stage', '-d', 'geops_dev',
                           '-Atq', '-c', 'SELECT version,checksum FROM geops_schema_migrations ORDER BY version'],
                          timeout=15).splitlines()
        if len(lines) != self.policy['sqlCount'] or not all(SQL_LINE.fullmatch(x) for x in lines):
            raise Blocked('Migration ledger inventory mismatch')
        if digest('\n'.join(lines).encode()) != self.policy['sqlListSha256']:
            raise Blocked('Migration ledger checksum mismatch')

    def secret_integrity(self):
        for name in SECRET_NAMES:
            expected = digest(regular_bytes(self.root / 'secrets' / name, 4096,
                                            trusted=self.enforce_root))
            observed = self.call([self.docker, 'exec', SERVICES['api'], 'node', '-e',
                                  "const c=require('node:crypto'),f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))",
                                  '/run/secrets/' + name], timeout=15)
            if observed != expected:
                raise Blocked('Mounted GEOPS secret differs from protected copy')

    def gate_and_backup(self):
        if self.enforce_root:
            secure_tree(BACKUPS)
        gate = json.loads(gate_bytes(GATE, self.enforce_root))
        if gate.get('phase') != 'open' or not re.fullmatch(
                r'[a-f0-9-]{36}', gate.get('epoch', '')):
            raise Blocked('External gate is not open')
        epoch = self.call([self.docker, 'exec', SERVICES['db'], 'psql', '-X', '-v',
                           'ON_ERROR_STOP=1', '-U', 'geops_stage', '-d', 'geops_dev',
                           '-Atq', '-c', 'SELECT epoch FROM security_epoch WHERE singleton=true'],
                          timeout=15)
        if epoch != gate['epoch']:
            raise Blocked('External gate epoch mismatch')
        backups = sorted(BACKUPS.glob('geops-stage-*.dump'), key=lambda p: p.stat().st_mtime)
        if not backups:
            raise Blocked('No Staging backup')
        latest = backups[-1]
        info = os.lstat(latest)
        if not stat.S_ISREG(info.st_mode) or info.st_size == 0:
            raise Blocked('Invalid backup file')
        if time.time() - latest.stat().st_mtime > self.policy['backupMaxAgeSeconds']:
            raise Blocked('Latest backup is too old')
        expected = regular_bytes(Path(str(latest) + '.sha256'), 256).decode().split()[0]
        if not HEX64.fullmatch(expected):
            raise Blocked('Invalid backup checksum')
        h = hashlib.sha256()
        with latest.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                h.update(chunk)
        if h.hexdigest() != expected:
            raise Blocked('Backup checksum mismatch')

    def current(self, expected=None, require_healthy=True):
        result = {name: self.container(name) for name in ('api', 'web', 'db')}
        if require_healthy and any(x['health'] != 'healthy' for x in result.values()):
            raise Blocked('GEOPS service not healthy')
        if expected and (result['api']['image'] != expected['apiId'] or
                         result['web']['image'] != expected['webId']):
            raise Blocked('Active images changed from root-owned state')
        return result

    def compose_env(self, api, web):
        return self.env | {
            'GEOPS_STAGE_SECRET_GID': self.policy['secretGid'],
            'GEOPS_STAGE_IMAGE_TAG': self.policy['imageTag'],
            'GEOPS_STAGE_ORIGIN': self.policy['origin'],
            'GEOPS_STAGE_API_IMAGE_REF': api,
            'GEOPS_STAGE_WEB_IMAGE_REF': web,
        }

    def compose_args(self):
        return [self.docker, 'compose', '-f', str(self.bundle / BUNDLE_FILES[0]),
                '-f', str(self.bundle / BUNDLE_FILES[1])]

    def check_compose(self, api, web):
        config = json.loads(self.call([*self.compose_args(), 'config', '--format', 'json'],
                                      env=self.compose_env(api, web)))
        if config.get('name') != ENVIRONMENT:
            raise Blocked('Compose project changed')
        services = config.get('services', {})
        if (services.get('geops-api', {}).get('image') != api or
                services.get('geops-web', {}).get('image') != web or
                services.get('geops-db', {}).get('image') != 'postgis/postgis:18-3.6'):
            raise Blocked('Compose service image selection changed')
        if services['geops-api']['environment']['MDM_ENABLED'] != 'false':
            raise Blocked('API MDM mode changed')
        if services['geops-web']['build']['args']['MDM_ENABLED'] != 'false':
            raise Blocked('Web MDM variant changed')

    def image(self, ref, commit=None, variant=None, expected_id=None):
        value = self.docker_json(['image', 'inspect', ref, '--format', '{{json .}}'])
        if expected_id and value['Id'] != expected_id:
            raise Blocked('Stable local image ID changed')
        if '@sha256:' in ref:
            if ref not in value.get('RepoDigests', []):
                raise Blocked('Registry digest unavailable locally')
            labels = value.get('Config', {}).get('Labels') or {}
            if labels.get('org.opencontainers.image.revision') != commit:
                raise Blocked('Image commit label mismatch')
            if variant and (labels.get('org.geops.web.variant') != variant or
                            labels.get('org.geops.web.mdm_enabled') != 'false'):
                raise Blocked('Web variant label mismatch')
        return value['Id']

    def embedded_sql(self, ref):
        script = ('const fs=require("node:fs"),c=require("node:crypto"),p="/work/apps/api/dist/db/migrations";'
                  'const n=fs.readdirSync(p).filter(x=>/^[0-9]{4}_[a-z0-9_]+\\.sql$/.test(x)).sort();'
                  'const b=n.map(x=>x+"|"+c.createHash("sha256").update(fs.readFileSync(p+"/"+x)).digest("hex")).join("\\n");'
                  'console.log(JSON.stringify({count:n.length,sha256:c.createHash("sha256").update(b).digest("hex")}));')
        value = self.docker_json(['run', '--rm', '--network', 'none', '--read-only',
                                  '--pull', 'never', '--entrypoint', 'node', ref, '-e', script])
        if value != {'count': self.policy['sqlCount'], 'sha256': self.policy['sqlListSha256']}:
            raise Blocked('API image SQL differs from approved ledger')

    def preflight(self, release_id=None, require_images=False):
        self.load_policy()
        endpoint = self.call([self.docker, 'context', 'inspect', '--format',
                              '{{.Endpoints.docker.Host}}'], timeout=10)
        if endpoint not in ('unix:///var/run/docker.sock', 'unix:///run/docker.sock'):
            raise Blocked('Only the local Docker daemon is allowed')
        state = self.state()
        self.current(state['active'])
        self.secret_integrity()
        self.database_ledger()
        self.gate_and_backup()
        if release_id:
            release, release_sha = self.release(release_id)
            self.check_compose(release['api'], release['web'])
            if require_images:
                self.image(release['api'], release['commit'])
                self.image(release['web'], release['commit'], release['variant'])
                self.embedded_sql(release['api'])
            return state, release, release_sha
        return state

    def switch(self, target):
        self.check_compose(target['apiRef'], target['webRef'])
        env = self.compose_env(target['apiRef'], target['webRef'])
        for service, key in (('geops-api', 'apiId'), ('geops-web', 'webId')):
            self.timed('activate-' + service, lambda service=service: self.call(
                [*self.compose_args(), 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', service],
                timeout=120, env=env))
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                status = self.container('api' if service == 'geops-api' else 'web')
                if status['image'] != target[key]:
                    raise Blocked('Service started with wrong image ID')
                if status['health'] == 'healthy':
                    break
                if status['health'] == 'unhealthy' or status['status'] == 'exited':
                    raise Blocked('Service readiness failed')
                time.sleep(1)
            else:
                raise Blocked('Service readiness timed out')

    def smoke(self):
        self.call([self.docker, 'exec', SERVICES['api'], 'node', '-e',
                   "Promise.all(['/health/live','/health/ready'].map(p=>fetch('http://127.0.0.1:3500'+p).then(r=>{if(!r.ok)throw Error(p)}))).catch(()=>process.exit(1))"],
                  timeout=15)
        self.call([self.docker, 'exec', SERVICES['web'], 'wget', '-q', '-O', '/dev/null',
                   'http://127.0.0.1:8080/health'], timeout=15)

    def save_state(self, value):
        fd, name = tempfile.mkstemp(prefix='.state-', dir=self.state_dir)
        try:
            os.fchmod(fd, 0o600)
            os.write(fd, (json.dumps(value, sort_keys=True) + '\n').encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(name, self.state_dir / 'state.json')

    def execute(self, command, release_id=None, approval_id=None):
        self.load_policy()
        if command == 'status':
            endpoint = self.call([self.docker, 'context', 'inspect', '--format',
                                  '{{.Endpoints.docker.Host}}'], timeout=10)
            if endpoint not in ('unix:///var/run/docker.sock', 'unix:///run/docker.sock'):
                raise Blocked('Only the local Docker daemon is allowed')
            state = self.state()
            live = self.current(state['active'], False)
            return {'active': state['active']['commit'],
                    'activeApiId': state['active']['apiId'],
                    'activeWebId': state['active']['webId'],
                    'activeReleaseSha256': state['active']['releaseSha256'],
                    'previousApiId': state['previous']['apiId'] if state['previous'] else None,
                    'previousWebId': state['previous']['webId'] if state['previous'] else None,
                    'api': live['api']['health'], 'web': live['web']['health'],
                    'db': live['db']['health'], 'imageMatch':
                    live['api']['image'] == state['active']['apiId'] and
                    live['web']['image'] == state['active']['webId']}
        if command == 'verify':
            state = self.timed('preflight', self.preflight)
            self.timed('smoke', self.smoke)
            return {'result': 'VERIFIED', 'active': state['active']['commit']}
        if command in ('preflight', 'prepare', 'deploy'):
            state, release, release_sha = self.timed('preflight',
                lambda: self.preflight(release_id, command == 'deploy'))
            if command == 'preflight':
                return {'result': 'PREFLIGHT', 'commit': release['commit']}
            if command == 'prepare':
                self.timed('pull-api', lambda: self.call([self.docker, 'pull', release['api']], timeout=180))
                self.timed('pull-web', lambda: self.call([self.docker, 'pull', release['web']], timeout=180))
                api_id, web_id, _ = self.timed('verify-images', lambda: (
                    self.image(release['api'], release['commit']),
                    self.image(release['web'], release['commit'], release['variant']),
                    self.embedded_sql(release['api'])))
                return {'result': 'PREPARED', 'commit': release['commit'],
                        'releaseSha256': release_sha, 'apiId': api_id, 'webId': web_id}
            old = state['active']
            target = {'commit': release['commit'], 'apiRef': release['api'],
                      'webRef': release['web'],
                      'apiId': self.image(release['api'], release['commit']),
                      'webId': self.image(release['web'], release['commit'], release['variant']),
                      'releaseSha256': release_sha}
            self.approval(approval_id, 'deploy', release_sha, old, target)
            before = self.current(old)
            self.consume(approval_id)
            try:
                self.switch(target)
                self.smoke()
                self.database_ledger()
                self.gate_and_backup()
                after = self.current(target)
                if after['db']['id'] != before['db']['id']:
                    raise Blocked('Database container changed')
                self.save_state({'schemaVersion': 1, 'active': target, 'previous': old})
            except Exception:
                try:
                    self.image(old['apiRef'], expected_id=old['apiId'])
                    self.image(old['webRef'], expected_id=old['webId'])
                    self.switch(old)
                    self.smoke()
                    self.current(old)
                    self.audit('automatic-recovery', 'PASS')
                except Exception:
                    self.audit('automatic-recovery', 'FAIL')
                    raise Blocked('Deployment and recovery failed; operator required')
                raise Blocked('Deployment failed; previous application recovered')
            return {'result': 'DEPLOYED', 'commit': target['commit']}
        if command == 'rollback':
            state = self.timed('preflight', self.preflight)
            source, target = state['active'], state['previous']
            if target is None:
                raise Blocked('No previous version recorded')
            self.image(target['apiRef'], expected_id=target['apiId'])
            self.image(target['webRef'], expected_id=target['webId'])
            self.approval(approval_id, 'rollback', source['releaseSha256'], source, target)
            before = self.current(source)
            self.consume(approval_id)
            try:
                self.switch(target)
                self.smoke()
                self.database_ledger()
                self.gate_and_backup()
                after = self.current(target)
                if after['db']['id'] != before['db']['id']:
                    raise Blocked('Database container changed')
                self.save_state({'schemaVersion': 1, 'active': target, 'previous': source})
            except Exception:
                try:
                    self.switch(source)
                    self.smoke()
                    self.current(source)
                    self.audit('rollback-recovery', 'PASS')
                except Exception:
                    self.audit('rollback-recovery', 'FAIL')
                    raise Blocked('Rollback and recovery failed; operator required')
                raise Blocked('Rollback failed; source application recovered')
            return {'result': 'ROLLED_BACK', 'commit': target['commit']}
        raise Blocked('Unknown operation')


def main(argv):
    if os.geteuid() != 0 or fcntl is None:
        raise Blocked('Root on Linux required')
    if not argv or argv[0] not in ('status', 'preflight', 'prepare', 'deploy', 'rollback', 'verify'):
        raise Blocked('Unknown operation')
    command = argv[0]
    expected = {'status': 1, 'preflight': 2, 'prepare': 2, 'deploy': 3,
                'rollback': 2, 'verify': 1}[command]
    if len(argv) != expected or not all(IDENT.fullmatch(x) for x in argv[1:]):
        raise Blocked('Invalid arguments')
    secure_tree(STATE_DIR)
    control = Controller()
    lock = os.open(STATE_DIR / 'lock', os.O_WRONLY | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        info = os.fstat(lock)
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise Blocked('Lock is not root-protected')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise Blocked('Another GEOPS operation is running') from exc
        control.audit('requested-' + command, 'START')
        approval_id = argv[2] if command == 'deploy' else (argv[1] if command == 'rollback' else None)
        release_id = argv[1] if command in ('preflight', 'prepare', 'deploy') else None
        result = control.execute(command, release_id, approval_id)
        control.audit('completed-' + command, 'PASS')
        print(json.dumps(result, sort_keys=True))
    except Exception:
        control.audit('completed-' + command, 'FAIL')
        raise
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as error:
        print(f'GEOPS remote operation BLOCKED: {error}', file=sys.stderr)
        sys.exit(1)
