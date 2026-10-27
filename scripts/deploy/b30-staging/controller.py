#!/usr/bin/python3 -I
"""Supervised B23→B30 staging promotion. Production entry is the signed guard."""

import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

B23 = '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d'
B30 = '64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6'
COMMIT = '2f89b87f1f636feb7e21d7e09af03959ee95f68d'
PROJECT = 'geops-spec02-staging'
IMAGE = re.compile(r'^ghcr\.io/kmena/geops-(api|web)@sha256:[a-f0-9]{64}$')
SHA = re.compile(r'^[a-f0-9]{64}$')
IDENT = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$')
SQL = re.compile(r'^\d{4}_[a-z0-9_]+\.sql\|[a-f0-9]{64}$')
V2_RULE = (b'Defaults!/usr/local/sbin/geops-deploy-v2 env_reset\n'
           b'Defaults!/usr/local/sbin/geops-deploy-v2 secure_path="/usr/sbin:/usr/bin:/sbin:/bin"\n'
           b'abi ALL=(root) NOPASSWD: /usr/local/sbin/geops-deploy-v2\n')
V2_DISABLED = b'# B23 controller suspended during supervised B30 promotion\n'
FILES = (
    'infrastructure/compose/compose.staging.yaml',
    'infrastructure/compose/compose.staging.digest.override.yaml',
    'infrastructure/compose/compose.staging.mdm-web-oauth.override.yaml',
    'infrastructure/compose/compose.staging.migrate.digest.override.yaml',
    'infrastructure/nginx/geops-staging-web.conf',
    'infrastructure/staging/api-entrypoint.sh',
    'infrastructure/staging/backup.sh',
)
SERVICES = {'api': 'geops-spec02-staging-geops-api-1',
            'web': 'geops-spec02-staging-geops-web-1',
            'db': 'geops-spec02-staging-geops-db-1'}
SECRETS = ('db_password', 'admin_session_key', 'admin_csrf_key',
           'invitation_hmac_key', 'mdm_grant_key', 'gps_quarantine_key')


class Blocked(Exception):
    pass


def sha(body):
    return hashlib.sha256(body).hexdigest()


def protected(path, regular=False):
    for part in (path, *path.parents):
        info = os.lstat(part)
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise Blocked('Administrative path is not root-protected')
    if regular and not stat.S_ISREG(os.lstat(path).st_mode):
        raise Blocked('Protected regular file required')


def atomic(path, body, mode=0o600):
    protected(path.parent)
    fd, name = tempfile.mkstemp(prefix='.b30-stage-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchown(stream.fileno(), 0, 0)
            os.fchmod(stream.fileno(), mode)
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        parent = os.open(path.parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        Path(name).unlink(missing_ok=True)


class Controller:
    def __init__(self, base=Path('/'), runner=None, enforce_root=True):
        self.base = Path(base).resolve()
        self.bundle = self.base / 'opt/geops-b30-staging'
        self.v2 = self.base / 'etc/geops-deploy-v2'
        self.v2_wrapper = self.base / 'usr/local/sbin/geops-deploy-v2'
        self.v2_rule = self.base / 'etc/sudoers.d/geops-deploy'
        self.v2_state = self.base / 'var/lib/geops-deploy/state.json'
        self.state_dir = self.base / 'var/lib/geops-b30-staging'
        self.journal = self.state_dir / 'promotion.json'
        self.used = self.state_dir / 'used'
        self.gate_file = self.base / 'var/lib/docker/volumes/geops_spec02_stage_security/_data/security-gate.json'
        self.backups = self.base / 'var/lib/docker/volumes/geops_spec02_stage_backups/_data'
        self.runner = runner or subprocess.run
        self.enforce_root = enforce_root
        self.policy = None
        self.policy_bytes = None
        self.old_policy = None

    def call(self, args, *, env=None, timeout=120):
        environment = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root',
                       'LANG': 'C', 'DOCKER_CONFIG': str(self.v2 / 'docker')}
        if env:
            environment.update(env)
        try:
            done = self.runner(args, cwd=self.v2 / 'bundle', env=environment,
                               stdin=subprocess.DEVNULL, capture_output=True,
                               text=True, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise Blocked('Fixed command unavailable or timed out') from error
        if done.returncode or len(done.stdout) > 1_000_000:
            raise Blocked('Fixed staging command failed; consult private operator logs')
        return done.stdout.strip()

    def docker(self, *args, env=None, timeout=120):
        return self.call(['/usr/bin/docker', *args], env=env, timeout=timeout)

    def load_policy(self):
        if self.enforce_root:
            for path in (self.bundle, self.bundle / 'policy.json',
                         self.bundle / 'policy.sha256', self.v2, self.v2_wrapper,
                         self.v2 / 'policy.json', self.v2_rule, self.v2_state, self.state_dir,
                         self.gate_file.parent.parent, self.backups):
                protected(path)
        body = (self.bundle / 'policy.json').read_bytes()
        pin = (self.bundle / 'policy.sha256').read_text().strip()
        if not SHA.fullmatch(pin) or sha(body) != pin:
            raise Blocked('Signed staging policy pin differs')
        value = json.loads(body)
        if (value.get('schemaVersion') != 1 or
                value.get('kind') != 'B30_STAGING_READY' or
                value.get('environment') != PROJECT or
                value.get('activation') != 'READY' or
                value.get('publicationReady') is not True or
                value.get('applicationCommit') != COMMIT or
                value.get('candidateManifestSha256') !=
                '3685814d172901cab4435caee5cfa6cbf17259f738d6b904df6f3b143cd74c2b' or
                value.get('migrations') != {
                    'sourceCount': 23, 'sourceListSha256': B23,
                    'targetCount': 30, 'targetListSha256': B30,
                } or not SHA.fullmatch(value.get('trustKeySha256', '')) or
                not isinstance(value.get('registryDigests'), dict) or
                set(value['registryDigests']) != {'api', 'web'} or
                any(not isinstance(value['registryDigests'][name], str) or
                    not IMAGE.fullmatch(value['registryDigests'][name]) or
                    not value['registryDigests'][name].startswith(f'ghcr.io/kmena/geops-{name}@')
                    for name in ('api', 'web')) or
                not isinstance(value.get('sourceB23'), dict) or
                set(value['sourceB23']) != {'wrapperSha256', 'policySha256'} or
                any(not SHA.fullmatch(item) for item in value['sourceB23'].values())):
            raise Blocked('B30 staging policy is not activated by reviewed inputs')
        public = self.bundle / 'public.pem'
        if self.enforce_root:
            protected(public, regular=True)
        if sha(public.read_bytes()) != value['trustKeySha256']:
            raise Blocked('Staging Ed25519 trust key differs')
        files = value.get('files')
        if not isinstance(files, dict) or not files:
            raise Blocked('Missing signed package inventory')
        for name, digest in files.items():
            member = Path(name)
            if member.is_absolute() or '..' in member.parts or not SHA.fullmatch(digest):
                raise Blocked('Invalid signed package member')
            path = self.bundle / member
            if self.enforce_root:
                protected(path, regular=True)
            if sha(path.read_bytes()) != digest:
                raise Blocked('Signed package file changed')
        self.policy, self.policy_bytes = value, body
        self.old_policy = json.loads((self.v2 / 'policy.json').read_bytes())
        if (self.old_policy.get('schemaVersion') != 2 or
                self.old_policy.get('environment') != PROJECT or
                self.old_policy.get('origin') != 'https://geops-staging.duckdns.org' or
                self.old_policy.get('secretGid') != '24001' or
                self.old_policy.get('mdm', {}).get('region') != value.get('mdmRegion') or
                not re.fullmatch(r'[a-f0-9]{40}', self.old_policy.get('imageTag', ''))):
            raise Blocked('Installed B23 staging policy differs from B30 compatibility')
        return value

    def signed(self, kind, identity):
        if not IDENT.fullmatch(identity or ''):
            raise Blocked('Invalid signed document identifier')
        payload = self.state_dir / 'inbox' / f'{identity}.{kind}.json'
        signature = self.state_dir / 'inbox' / f'{identity}.{kind}.sig'
        if self.enforce_root:
            protected(payload, regular=True)
            protected(signature, regular=True)
        try:
            body = payload.read_bytes()
            sig = signature.read_bytes()
        except OSError as error:
            raise Blocked('Signed operator document missing') from error
        if len(body) > 16384 or len(sig) != 64:
            raise Blocked('Signed document size differs')
        with tempfile.TemporaryDirectory(prefix='b30-stage-verify-', dir=self.state_dir) as folder:
            message = Path(folder) / 'message'
            sign = Path(folder) / 'signature'
            message.write_bytes(body)
            sign.write_bytes(sig)
            self.call(['/usr/bin/openssl', 'pkeyutl', '-verify', '-pubin', '-inkey',
                       str(self.bundle / 'public.pem'), '-rawin', '-in', str(message),
                       '-sigfile', str(sign)], timeout=10)
        value = json.loads(body)
        if (value.get('id') != identity or value.get('environment') != PROJECT or
                value.get('kind') != kind):
            raise Blocked('Signed document scope differs')
        try:
            start = datetime.fromisoformat(value['notBefore'].replace('Z', '+00:00'))
            end = datetime.fromisoformat(value['expiresAt'].replace('Z', '+00:00'))
        except (KeyError, ValueError, TypeError) as error:
            raise Blocked('Signed document validity window invalid') from error
        now = datetime.now(timezone.utc)
        maximum = timedelta(days=30) if kind == 'release' else timedelta(minutes=30)
        if not (start <= now < end <= start + maximum):
            raise Blocked('Signed document expired or not yet valid')
        return value, sha(body)

    def release(self, identity):
        value, digest = self.signed('release', identity)
        if (set(value) != {'schemaVersion', 'kind', 'id', 'environment', 'notBefore',
                           'expiresAt', 'commit', 'api', 'web', 'sqlCount',
                           'sqlListSha256', 'policySha256'} or
                value['schemaVersion'] != 1 or value['commit'] != COMMIT or
                value['api'] != self.policy['registryDigests']['api'] or
                value['web'] != self.policy['registryDigests']['web'] or
                value['sqlCount'] != 30 or value['sqlListSha256'] != B30 or
                value['policySha256'] != sha(self.policy_bytes)):
            raise Blocked('B30 release differs from signed staging policy')
        return value, digest

    def restore_proof(self, identity, backup_sha):
        value, digest = self.signed('restore', identity)
        if (set(value) != {'schemaVersion', 'kind', 'id', 'environment', 'notBefore',
                           'expiresAt', 'backupSha256', 'sqlCount', 'sqlListSha256',
                           'result', 'evidenceSha256', 'policySha256'} or
                value['schemaVersion'] != 1 or value['backupSha256'] != backup_sha or
                value['sqlCount'] != 23 or value['sqlListSha256'] != B23 or
                value['result'] != 'PASS' or
                not SHA.fullmatch(value['evidenceSha256']) or
                value['policySha256'] != sha(self.policy_bytes)):
            raise Blocked('B23 restore proof differs from approved backup')
        return digest

    def recovery_proof(self, identity, journal, ledger, gate):
        if (not re.fullmatch(r'[a-f0-9-]{36}', gate.get('nonce', '')) or
                gate['nonce'] != journal.get('gateNonce')):
            raise Blocked('Supervised recovery gate nonce differs')
        value, _ = self.signed('recovery', identity)
        if (set(value) != {'schemaVersion', 'kind', 'id', 'environment', 'notBefore',
                           'expiresAt', 'result', 'policySha256', 'approvalId',
                           'gateEpoch', 'gateNonce', 'ledgerCount', 'ledgerSha256',
                           'auditRequestId'} or
                value['schemaVersion'] != 1 or value['result'] != 'PASS' or
                value['policySha256'] != sha(self.policy_bytes) or
                value['approvalId'] != journal['approvalId'] or
                value['gateEpoch'] != gate['epoch'] or
                value['gateNonce'] != gate['nonce'] or
                value['ledgerCount'] != ledger['count'] or
                value['ledgerSha256'] != ledger['sha256'] or
                not IDENT.fullmatch(value['auditRequestId'])):
            raise Blocked('Signed supervised recovery attestation differs')
        audit_id = value['auditRequestId']
        observed = self.docker('exec', SERVICES['db'], 'psql', '-X', '-v',
                               'ON_ERROR_STOP=1', '-U', 'geops_stage', '-d', 'geops_dev',
                               '-Atq', '-c',
                               "SELECT count(*) FROM audit_event WHERE correlation_id='" +
                               audit_id + "' AND action='maintenance.recovery.validated' " +
                               "AND outcome='success' AND metadata_redacted->>'schema'='" +
                               str(ledger['count']) + "'", timeout=15)
        if observed != '1':
            raise Blocked('Supervised recovery audit event missing')
        marker = self.docker('exec', SERVICES['db'], 'psql', '-X', '-v',
                             'ON_ERROR_STOP=1', '-U', 'geops_stage', '-d', 'geops_dev',
                             '-Atq', '-c',
                             "SELECT epoch::text||'|'||nonce::text||'|'||"
                             "(database_oid=(SELECT oid FROM pg_database WHERE datname=current_database()))::text "
                             "FROM geops_maintenance_marker WHERE singleton=true", timeout=15)
        if marker != gate['epoch'] + '|' + gate['nonce'] + '|true':
            raise Blocked('Supervised recovery database marker differs')

    def approval(self, identity, release_sha, source_sha, backup_sha, restore_sha, epoch):
        value, _ = self.signed('approval', identity)
        if (set(value) != {'schemaVersion', 'kind', 'id', 'environment', 'notBefore',
                           'expiresAt', 'action', 'releaseSha256', 'sourceStateSha256',
                           'backupSha256', 'restoreProofSha256', 'gateEpoch', 'policySha256'} or
                value['schemaVersion'] != 1 or value['action'] != 'promote-b23-b30' or
                value['releaseSha256'] != release_sha or
                value['sourceStateSha256'] != source_sha or
                value['backupSha256'] != backup_sha or
                value['restoreProofSha256'] != restore_sha or
                value['gateEpoch'] != epoch or
                value['policySha256'] != sha(self.policy_bytes) or
                (self.used / identity).exists()):
            raise Blocked('Approval does not bind the exact B23→B30 transition')

    def source(self):
        for path in (self.v2_wrapper, self.v2 / 'policy.json', self.v2_rule, self.v2_state):
            if self.enforce_root:
                protected(path, regular=True)
        if (sha(self.v2_wrapper.read_bytes()) != self.policy['sourceB23']['wrapperSha256'] or
                sha((self.v2 / 'policy.json').read_bytes()) !=
                self.policy['sourceB23']['policySha256'] or
                self.v2_rule.read_bytes() != V2_RULE):
            raise Blocked('Installed B23 controller identity changed')
        old_policy = json.loads((self.v2 / 'policy.json').read_bytes())
        if old_policy.get('schemaVersion') != 2:
            raise Blocked('B23 v2 policy required')
        for name in FILES:
            file = self.v2 / 'bundle' / name
            if self.enforce_root:
                protected(file, regular=True)
            if sha(file.read_bytes()) != old_policy.get('files', {}).get(name):
                raise Blocked('Installed staging Compose or entrypoint differs from B23 policy')
            packaged = self.bundle / name
            if packaged.exists() and sha(file.read_bytes()) != sha(packaged.read_bytes()):
                raise Blocked('Packaged staging Compose differs from installed B23')
        state_body = self.v2_state.read_bytes()
        state = json.loads(state_body)
        if (state.get('schemaVersion') != 2 or state.get('phase') != 'steady' or
                state.get('pending') is not None or
                state.get('active', {}).get('profile') not in ('B23-safe', 'B23-mdm')):
            raise Blocked('Steady B23 source required')
        return state, sha(state_body)

    def context(self):
        endpoint = self.docker('context', 'inspect', '--format',
                               '{{.Endpoints.docker.Host}}', timeout=10)
        if endpoint not in ('unix:///var/run/docker.sock', 'unix:///run/docker.sock'):
            raise Blocked('Only local Docker Unix socket is allowed')

    def container(self, name):
        info = json.loads(self.docker('inspect', '--format', '{{json .}}', SERVICES[name]))
        labels = info.get('Config', {}).get('Labels') or {}
        if (labels.get('com.docker.compose.project') != PROJECT or
                labels.get('com.docker.compose.service') != f'geops-{name}'):
            raise Blocked('Docker service is outside staging project')
        return {'id': info['Id'], 'image': info['Image'],
                'status': info['State']['Status'],
                'health': (info['State'].get('Health') or {}).get('Status')}

    def ledger(self):
        lines = self.docker('exec', SERVICES['db'], 'psql', '-X', '-v',
                            'ON_ERROR_STOP=1', '-U', 'geops_stage', '-d', 'geops_dev',
                            '-Atq', '-c',
                            'SELECT version,checksum FROM geops_schema_migrations ORDER BY version',
                            timeout=15).splitlines()
        if not all(SQL.fullmatch(line) for line in lines):
            raise Blocked('Invalid PostgreSQL migration ledger')
        manifest_path = self.bundle / 'specs/spec-03-clients-geofences-routes/b30-staging-candidate.json'
        manifest_body = manifest_path.read_bytes()
        if sha(manifest_body) != self.policy['candidateManifestSha256']:
            raise Blocked('Signed B30 migration manifest differs')
        manifest = json.loads(manifest_body)
        expected = [item['version'] + '|' + item['sha256']
                    for item in manifest['database']['migrations']]
        if (len(expected) != 30 or not 23 <= len(lines) <= 30 or
                lines != expected[:len(lines)]):
            raise Blocked('Unapproved PostgreSQL migration prefix')
        result = {'count': len(lines), 'sha256': sha('\n'.join(lines).encode())}
        if ((len(lines) == 23 and result['sha256'] != B23) or
                (len(lines) == 30 and result['sha256'] != B30)):
            raise Blocked('Unapproved B23/B30 migration checksums')
        return result

    def gate(self):
        if self.enforce_root:
            protected(self.gate_file.parent.parent)
            info = os.lstat(self.gate_file.parent)
            if (info.st_uid != 1000 or info.st_gid != 1000 or
                    stat.S_IMODE(info.st_mode) != 0o755):
                raise Blocked('Staging gate volume ownership changed')
            gate_info = os.lstat(self.gate_file)
            if (not stat.S_ISREG(gate_info.st_mode) or gate_info.st_uid != 1000 or
                    gate_info.st_gid != 1000 or stat.S_IMODE(gate_info.st_mode) != 0o600):
                raise Blocked('Staging gate file permissions changed')
        gate = json.loads(self.gate_file.read_bytes())
        expected_keys = ({'phase', 'epoch', 'version', 'nonce'} if 'nonce' in gate
                         else {'phase', 'epoch', 'version'})
        if (set(gate) != expected_keys or gate.get('version') != 1 or
                gate.get('phase') not in ('open', 'maintenance') or
                not re.fullmatch(r'[a-f0-9-]{36}', gate.get('epoch', '')) or
                (gate['phase'] == 'maintenance' and
                 not re.fullmatch(r'[a-f0-9-]{36}', gate.get('nonce', '')))):
            raise Blocked('Invalid staging gate')
        epoch = self.docker('exec', SERVICES['db'], 'psql', '-X', '-v',
                            'ON_ERROR_STOP=1', '-U', 'geops_stage', '-d', 'geops_dev',
                            '-Atq', '-c',
                            'SELECT epoch FROM security_epoch WHERE singleton=true',
                            timeout=15)
        if epoch != gate['epoch']:
            raise Blocked('Staging gate epoch differs from database')
        return gate

    def backup(self):
        if self.enforce_root:
            protected(self.backups)
        candidates = sorted(self.backups.glob('geops-stage-*.dump'),
                            key=lambda path: path.stat().st_mtime)
        if not candidates:
            raise Blocked('Verified B23 backup required')
        latest = candidates[-1]
        checksum = Path(str(latest) + '.sha256')
        if self.enforce_root:
            protected(latest, regular=True)
            protected(checksum, regular=True)
        expected = checksum.read_text().split()[0]
        if (time.time() - latest.stat().st_mtime > self.old_policy['backupMaxAgeSeconds'] or
                latest.stat().st_size == 0 or not SHA.fullmatch(expected)):
            raise Blocked('Staging backup is stale or invalid')
        digest = hashlib.sha256()
        with latest.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        if digest.hexdigest() != expected:
            raise Blocked('Staging backup checksum differs')
        return expected

    def compose(self, api, web, *, migration=False, command=None, extra_env=None, mdm=True):
        files = [FILES[0]]
        if mdm:
            files.append(FILES[2])
        files.append(FILES[1])
        if migration:
            files.append(FILES[3])
        args = ['/usr/bin/docker', 'compose', '--profile', 'maintenance']
        for name in files:
            args += ['-f', str(self.v2 / 'bundle' / name)]
        env = {'GEOPS_STAGE_SECRET_GID': '24001',
               'GEOPS_STAGE_IMAGE_TAG': self.old_policy['imageTag'],
               'GEOPS_STAGE_ORIGIN': 'https://geops-staging.duckdns.org',
               'GEOPS_STAGE_API_IMAGE_REF': api,
               'GEOPS_STAGE_WEB_IMAGE_REF': web,
               'GEOPS_MDM_REGION': self.policy['mdmRegion']}
        if extra_env:
            env.update(extra_env)
        return self.call(args + (command or ['config', '--format', 'json']), env=env,
                         timeout=300 if migration else 120)

    def verify_compose(self, api, web):
        config = json.loads(self.compose(api, web))
        services = config.get('services', {})
        if (config.get('name') != PROJECT or
                services.get('geops-db', {}).get('image') != 'postgis/postgis:18-3.6' or
                services.get('geops-api', {}).get('image') != api or
                services.get('geops-web', {}).get('image') != web or
                services.get('geops-migrate', {}).get('image') != api or
                services['geops-api'].get('environment', {}).get('MDM_ENABLED') != 'true' or
                services['geops-api'].get('environment', {}).get('GEOPS_MDM_REGION') !=
                self.policy['mdmRegion'] or
                services['geops-web'].get('build', {}).get('args', {}).get('MDM_ENABLED') !=
                'true' or
                'stage_egress' not in services['geops-api'].get('networks', {})):
            raise Blocked('Staging Compose B30 environment differs')
        for name in ('geops-api', 'geops-migrate'):
            secrets = {entry.get('source') if isinstance(entry, dict) else entry
                       for entry in services[name].get('secrets', [])}
            if secrets != set(SECRETS):
                raise Blocked('Staging secret inventory differs')
        return config

    def image(self, ref, service):
        info = json.loads(self.docker('image', 'inspect', ref, '--format', '{{json .}}'))
        labels = info.get('Config', {}).get('Labels') or {}
        if (ref not in info.get('RepoDigests', []) or
                not re.fullmatch(r'sha256:[a-f0-9]{64}', info.get('Id', '')) or
                labels.get('org.opencontainers.image.revision') != COMMIT or
                labels.get('org.geops.' + service + '.variant') != 'B30-integrated' or
                (service == 'api' and
                 labels.get('org.geops.maintenance.recovery.max_schema') != '30') or
                (service == 'web' and labels.get('org.geops.web.mdm_enabled') != 'true')):
            raise Blocked('B30 image digest, provenance or variant differs')
        return info['Id']

    def target(self, release):
        api, web = release['api'], release['web']
        api_id, web_id = self.image(api, 'api'), self.image(web, 'web')
        script = ('const fs=require("fs"),c=require("crypto"),p="/work/apps/api/dist/db/migrations";'
                  'const n=fs.readdirSync(p).filter(x=>/^[0-9]{4}_[a-z0-9_]+\\.sql$/.test(x)).sort();'
                  'const s=n.map(x=>x+"|"+c.createHash("sha256").update(fs.readFileSync(p+"/"+x)).digest("hex")).join("\\n");'
                  'const r=fs.readFileSync("/work/apps/api/dist/db/maintenance-recovery.js","utf8");'
                  'console.log(JSON.stringify({count:n.length,sha256:c.createHash("sha256").update(s).digest("hex"),'
                  'recovery30:r.includes("RECOVERY_TARGET_SCHEMA = 30")}))')
        sql = json.loads(self.docker('run', '--rm', '--network', 'none', '--read-only',
                                     '--pull', 'never', '--entrypoint', 'node', api,
                                     '-e', script))
        if sql != {'count': 30, 'sha256': B30, 'recovery30': True}:
            raise Blocked('B30 image migration or supervised recovery inventory differs')
        self.verify_compose(api, web)
        return {'apiRef': api, 'webRef': web, 'apiId': api_id,
                'webId': web_id, 'commit': COMMIT}

    def journal_data(self):
        if not self.journal.exists():
            return None
        if self.enforce_root:
            protected(self.journal, regular=True)
        value = json.loads(self.journal.read_bytes())
        if (value.get('schemaVersion') != 1 or
                value.get('phase') not in ('draining', 'maintenance', 'migrating',
                                           'awaiting-recovery', 'resuming', 'complete', 'aborted') or
                value.get('sourceLedger') != B23 or value.get('targetLedger') != B30 or
                not SHA.fullmatch(value.get('policySha256', '')) or
                not SHA.fullmatch(value.get('backupSha256', '')) or
                not SHA.fullmatch(value.get('sourceStateSha256', '')) or
                not SHA.fullmatch(value.get('releaseSha256', '')) or
                not IDENT.fullmatch(value.get('approvalId', '')) or
                not re.fullmatch(r'[a-f0-9-]{36}', value.get('gateEpoch', '')) or
                (value['phase'] in ('maintenance', 'migrating', 'awaiting-recovery',
                                     'resuming', 'complete') and
                 not re.fullmatch(r'[a-f0-9-]{36}', value.get('gateNonce', ''))) or
                not isinstance(value.get('target'), dict) or
                set(value['target']) != {'apiRef', 'webRef', 'apiId', 'webId', 'commit'}):
            raise Blocked('Invalid B30 staging promotion journal')
        return value

    def save(self, value):
        atomic(self.journal, (json.dumps(value, sort_keys=True) + '\n').encode())

    def disable_v2(self):
        body = self.v2_rule.read_bytes()
        if body == V2_DISABLED:
            return
        if body != V2_RULE:
            raise Blocked('Unexpected B23 sudoers rule')
        atomic(self.v2_rule, V2_DISABLED, 0o440)

    def stop(self, journal):
        self.disable_v2()
        source = journal['source']
        mdm = source['profile'] == 'B23-mdm'
        for service in ('geops-web', 'geops-api'):
            self.compose(source['apiRef'], source['webRef'], command=['stop', service], mdm=mdm)
        if any(self.container(name)['status'] != 'exited' for name in ('api', 'web')):
            raise Blocked('Applications did not stop')

    def start(self, journal, target):
        mdm = target.get('profile') != 'B23-safe'
        for service, short, key in (('geops-api', 'api', 'apiId'),
                                    ('geops-web', 'web', 'webId')):
            self.compose(target['apiRef'], target['webRef'],
                         command=['up', '-d', '--no-deps', '--no-build', '--pull',
                                  'never', '--force-recreate', service], mdm=mdm)
            deadline = time.monotonic() + 120
            while True:
                observed = self.container(short)
                if observed['image'] != target[key] or observed['status'] != 'running':
                    raise Blocked('Staging application image or state differs')
                if observed['health'] == 'healthy':
                    break
                if observed['health'] == 'unhealthy' or time.monotonic() >= deadline:
                    raise Blocked('Staging application did not become healthy')
                time.sleep(2)
        self.docker('exec', SERVICES['api'], 'node', '-e',
                    "Promise.all(['/health/live','/health/ready'].map(p=>fetch('http://127.0.0.1:3500'+p).then(r=>{if(!r.ok)throw Error(p)}))).catch(()=>process.exit(1))")
        self.docker('exec', SERVICES['web'], 'wget', '-q', '-O', '/dev/null',
                    'http://127.0.0.1:8080/health')
        self.verify_secrets()

    def verify_secrets(self):
        for name in SECRETS:
            master = self.v2 / 'secrets' / name
            runtime = self.v2 / 'runtime-secrets' / name
            if self.enforce_root:
                protected(master, regular=True)
                protected(runtime, regular=True)
                a, b = os.stat(master), os.stat(runtime)
                if (stat.S_IMODE(a.st_mode) != 0o600 or
                        stat.S_IMODE(b.st_mode) != 0o640 or
                        b.st_gid != int(self.old_policy['secretGid'])):
                    raise Blocked('Staging secret permissions changed')
            expected = sha(master.read_bytes())
            if sha(runtime.read_bytes()) != expected:
                raise Blocked('Staging runtime secret changed')
            mounted = self.docker('exec', SERVICES['api'], 'node', '-e',
                                  "const c=require('crypto'),f=require('fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))",
                                  '/run/secrets/' + name)
            if mounted != expected:
                raise Blocked('Mounted B30 secret differs')

    def execute(self, command, release_id=None, approval_id=None, restore_id=None):
        self.load_policy()
        self.context()
        journal = self.journal_data()
        if command == 'status':
            return {'result': 'B30_STAGING_STATUS', 'journal': journal,
                    'ledger': self.ledger(), 'gate': self.gate()['phase']}
        if command == 'prepare':
            if journal is not None:
                raise Blocked('Promotion already journaled')
            source, source_sha = self.source()
            self.call([str(self.v2_wrapper), 'verify'], timeout=120)
            release, digest = self.release(release_id)
            target = self.target(release)
            if self.ledger() != {'count': 23, 'sha256': B23} or self.gate()['phase'] != 'open':
                raise Blocked('Healthy B23 ledger and gate required')
            if any(self.container(name)['health'] != 'healthy' for name in ('api', 'web', 'db')):
                raise Blocked('B23 services unhealthy')
            return {'result': 'B30_STAGING_PREPARED', 'releaseSha256': digest,
                    'sourceStateSha256': source_sha, 'target': target,
                    'sourceProfile': source['active']['profile']}
        if command == 'begin':
            ready = self.execute('prepare', release_id)
            backup_sha = self.backup()
            epoch = self.gate()['epoch']
            restore_sha = self.restore_proof(restore_id, backup_sha)
            self.approval(approval_id, ready['releaseSha256'],
                          ready['sourceStateSha256'], backup_sha, restore_sha, epoch)
            source, _ = self.source()
            target = ready['target']
            journal = {'schemaVersion': 1, 'phase': 'draining',
                       'source': source['active'], 'sourceStateSha256': ready['sourceStateSha256'],
                       'target': target, 'sourceLedger': B23, 'targetLedger': B30,
                       'policySha256': sha(self.policy_bytes), 'backupSha256': backup_sha,
                       'restoreProofSha256': restore_sha,
                       'gateEpoch': epoch, 'releaseSha256': ready['releaseSha256'],
                       'approvalId': approval_id}
            self.save(journal)
            self.used.mkdir(mode=0o700, exist_ok=True)
            atomic(self.used / approval_id, b'consumed\n')
            self.stop(journal)
            if self.gate()['phase'] != 'open':
                raise Blocked('Gate changed before maintenance start')
            self.compose(target['apiRef'], target['webRef'],
                         command=['run', '--rm', '--no-deps',
                                  '-e', 'GEOPS_CONFIRM_MAINTENANCE_TARGET=geops_dev',
                                  '-e', 'GEOPS_CONFIRM_MAINTENANCE_EPOCH=' + epoch,
                                  'geops-gate-init', 'gate', 'maintenance-start'],
                         mdm=source['active']['profile'] == 'B23-mdm')
            maintenance = self.gate()
            if maintenance['phase'] != 'maintenance':
                raise Blocked('Maintenance gate failed to close')
            journal['gateNonce'] = maintenance['nonce']
            journal['phase'] = 'maintenance'
            self.save(journal)
            return {'result': 'B30_STAGING_MAINTENANCE_READY', 'gateEpoch': epoch}
        if journal is None:
            raise Blocked('No supervised B30 promotion')
        if journal['policySha256'] != sha(self.policy_bytes):
            raise Blocked('Policy changed during promotion')
        self.disable_v2()
        if command == 'migrate':
            if journal['phase'] not in ('maintenance', 'migrating'):
                raise Blocked('Migration phase differs')
            before = self.ledger()
            if (not 23 <= before['count'] <= 30 or
                    self.gate()['phase'] != 'maintenance' or
                    any(self.container(name)['status'] != 'exited'
                        for name in ('api', 'web'))):
                raise Blocked('B30 migration resume preconditions differ')
            journal['phase'] = 'migrating'
            self.save(journal)
            if before['count'] < 30:
                target = journal['target']
                self.compose(target['apiRef'], target['webRef'], migration=True,
                             command=['run', '--rm', '--no-deps',
                                      '-e', 'GEOPS_CONFIRM_MAINTENANCE_EPOCH=' + journal['gateEpoch'],
                                      'geops-migrate'])
            if self.ledger() != {'count': 30, 'sha256': B30}:
                raise Blocked('B30 migration ledger not exact')
            journal['phase'] = 'awaiting-recovery'
            self.save(journal)
            return {'result': 'B30_AWAITING_SUPERVISED_GATE_RECOVERY'}
        if command == 'recover':
            if journal['phase'] in ('complete', 'aborted'):
                wanted = 30 if journal['phase'] == 'complete' else 23
                if (self.ledger()['count'] != wanted or self.gate()['phase'] != 'open'):
                    raise Blocked('Completed recovery state differs')
                return {'result': 'ALREADY_' + journal['phase'].upper()}
            ledger = self.ledger()
            gate = self.gate()
            if gate['epoch'] != journal['gateEpoch']:
                raise Blocked('Security epoch changed during promotion')
            if 'gateNonce' not in journal and gate.get('nonce'):
                journal['gateNonce'] = gate['nonce']
                self.save(journal)
            if (journal['phase'] == 'draining' and 'gateNonce' not in journal and
                    gate['phase'] == 'open' and ledger == {'count': 23, 'sha256': B23}):
                self.start(journal, journal['source'])
                atomic(self.v2_rule, V2_RULE, 0o440)
                journal['phase'] = 'aborted'
                self.save(journal)
                return {'result': 'B23_STAGING_RESTORED_BEFORE_MAINTENANCE'}
            if gate['phase'] != 'open':
                return {'result': 'AWAITING_SUPERVISED_GATE_RECOVERY',
                        'ledger': ledger, 'gate': gate['phase']}
            self.recovery_proof(release_id, journal, ledger, gate)
            if ledger == {'count': 30, 'sha256': B30}:
                target = journal['target']
                journal['phase'] = 'resuming'
                self.save(journal)
                self.start(journal, target)
                journal['phase'] = 'complete'
                self.save(journal)
                return {'result': 'B30_STAGING_PROMOTED'}
            if ledger == {'count': 23, 'sha256': B23}:
                source = journal['source']
                self.start(journal, source)
                atomic(self.v2_rule, V2_RULE, 0o440)
                journal['phase'] = 'aborted'
                self.save(journal)
                return {'result': 'B23_STAGING_RESTORED'}
            raise Blocked('Unknown recovery ledger')
        if command == 'verify':
            if journal['phase'] != 'complete' or self.ledger() != {'count': 30, 'sha256': B30}:
                raise Blocked('B30 promotion incomplete')
            if self.gate()['phase'] != 'open':
                raise Blocked('Staging gate remains closed')
            target = journal['target']
            if (self.container('api')['image'] != target['apiId'] or
                    self.container('web')['image'] != target['webId'] or
                    any(self.container(name)['health'] != 'healthy'
                        for name in ('api', 'web', 'db'))):
                raise Blocked('B30 services differ from approved images')
            self.verify_secrets()
            return {'result': 'B30_STAGING_VERIFIED'}
        raise Blocked('Unknown B30 staging operation')


def main(argv):
    arguments = {'status': 0, 'prepare': 1, 'begin': 3,
                 'migrate': 0, 'recover': 1, 'verify': 0}
    if (os.geteuid() != 0 or not argv or argv[0] not in arguments or
            len(argv) - 1 != arguments[argv[0]] or
            any(not IDENT.fullmatch(value) for value in argv[1:])):
        raise Blocked('Root and fixed B30 command syntax required')
    controller = Controller()
    protected(controller.state_dir)
    lock = os.open(controller.state_dir / 'controller.lock', os.O_WRONLY | os.O_CREAT |
                   getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(controller.execute(argv[0], *argv[1:]), sort_keys=True))
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as error:
        print('GEOPS B30 staging controller BLOCKED: ' + str(error), file=sys.stderr)
        sys.exit(1)
