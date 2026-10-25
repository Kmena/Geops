#!/usr/bin/python3 -I
"""Locally prepared, fixed-scope v2 controller. Never installed by this source file."""

import hashlib
import importlib.util
import json
import os
import re
import stat
import sys
import tempfile
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path


def load_v1_base():
    # Isolated Python does not search the script directory. An eventual
    # installation must provide this reviewed, root-owned snapshot of v1.
    installed = Path('/usr/local/sbin/geops-deploy-v2')
    if os.name == 'posix' and Path(__file__).absolute() == installed:
        source = Path('/etc/geops-deploy-v2/lib/geops_deploy.py')
        for part in (source, *source.parents):
            info = os.lstat(part)
            if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise RuntimeError('V2 base module is not root-protected')
        spec = importlib.util.spec_from_file_location('geops_v1_base', source)
        if spec is None or spec.loader is None:
            raise RuntimeError('V2 base module unavailable')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    import geops_deploy
    return geops_deploy


v1 = load_v1_base()

try:
    import fcntl
except ImportError:  # local Windows tests never enter the privileged CLI
    fcntl = None


A21_HASH = 'cd308f751512b86926116856185b7aa870f849235161e5e23c904c4d28813d8e'
B22_HASH = 'aca17d3d9155351596a98ca412fe02b37dca575f2b8b6e8441d7466ed81abaf2'
PROFILES = {
    'A21': {'sqlCount': 21, 'sqlListSha256': A21_HASH,
            'variant': 'gps-base', 'mdmEnabled': False},
    'B22-safe': {'sqlCount': 22, 'sqlListSha256': B22_HASH,
                 'variant': 'gps-base', 'mdmEnabled': False},
    'B22-mdm': {'sqlCount': 22, 'sqlListSha256': B22_HASH,
                'variant': 'mdm-qa', 'mdmEnabled': True},
}
MDM_OVERLAY = 'infrastructure/compose/compose.staging.mdm-web-oauth.override.yaml'
MIGRATE_OVERLAY = 'infrastructure/compose/compose.staging.migrate.digest.override.yaml'
BUNDLE_FILES = v1.BUNDLE_FILES + (MDM_OVERLAY, MIGRATE_OVERLAY)
V2_ROOT = Path('/etc/geops-deploy-v2')
STATE_KEYS = ('schemaVersion', 'active', 'previous', 'phase', 'pending')
SWITCH_OPERATIONS = ('webStop', 'apiStart', 'webStart', 'commit')
SQL_SCRIPT = (
    'const fs=require("node:fs"),c=require("node:crypto"),p="/work/apps/api/dist/db/migrations";'
    'const n=fs.readdirSync(p).filter(x=>/^[0-9]{4}_[a-z0-9_]+\\.sql$/.test(x)).sort();'
    'const b=n.map(x=>x+"|"+c.createHash("sha256").update(fs.readFileSync(p+"/"+x))'
    '.digest("hex")).join("\\n");'
    'console.log(JSON.stringify({count:n.length,sha256:c.createHash("sha256")'
    '.update(b).digest("hex")}));'
)


def profile_of(version):
    profile = version.get('profile')
    if profile not in PROFILES:
        raise v1.Blocked('Unknown release profile')
    return profile


class ControllerV2(v1.Controller):
    def __init__(self, root=V2_ROOT, state_dir=v1.STATE_DIR, log=v1.LOG,
                 docker=v1.DOCKER, openssl=v1.OPENSSL, enforce_root=True, runner=None):
        super().__init__(root, state_dir, log, docker, openssl, enforce_root, runner)

    def load_policy(self):
        if self.enforce_root:
            for path in (self.root, self.state_dir, self.log.parent,
                         self.root / 'public.pem', self.root / 'policy.json',
                         self.state_dir / 'state.json', self.state_dir / 'used',
                         self.state_dir / 'tmp', self.bundle, Path(self.docker),
                         Path(self.openssl), v1.COMPOSE_PLUGIN, Path(__file__),
                         Path(v1.__file__)):
                v1.secure_tree(path)
        self.policy_bytes = v1.regular_bytes(self.root / 'policy.json',
                                             trusted=self.enforce_root)
        policy = json.loads(self.policy_bytes)
        v1.exact_keys(policy, ('schemaVersion', 'environment', 'origin', 'secretGid',
                               'imageTag', 'backupMaxAgeSeconds', 'profiles', 'mdm',
                               'files', 'controllers'))
        if (policy['schemaVersion'] != 2 or policy['environment'] != v1.ENVIRONMENT or
                policy['origin'] != 'https://geops-staging.duckdns.org' or
                policy['secretGid'] != '24001' or
                not isinstance(policy['imageTag'], str) or
                not v1.SHA.fullmatch(policy['imageTag']) or
                type(policy['backupMaxAgeSeconds']) is not int or
                not 0 < policy['backupMaxAgeSeconds'] <= 86400 or
                policy['profiles'] != PROFILES):
            raise v1.Blocked('Invalid v2 policy or SQL profiles')
        mdm = policy['mdm']
        if not isinstance(mdm, dict):
            raise v1.Blocked('Invalid isolated MDM tenant configuration')
        v1.exact_keys(mdm, ('region',))
        if mdm['region'] not in ('com', 'eu', 'in', 'com.au', 'jp', 'ca', 'cn', 'sa', 'uk'):
            raise v1.Blocked('Invalid isolated MDM tenant configuration')
        if not isinstance(policy['files'], dict) or set(policy['files']) != set(BUNDLE_FILES):
            raise v1.Blocked('V2 bundle inventory changed')
        controller_files = {'geops_deploy.py': Path(v1.__file__),
                            'geops_deploy_v2.py': Path(__file__)}
        if (not isinstance(policy['controllers'], dict) or
                set(policy['controllers']) != set(controller_files)):
            raise v1.Blocked('V2 controller inventory changed')
        for name, path in controller_files.items():
            expected = policy['controllers'][name]
            if (not isinstance(expected, str) or not v1.HEX64.fullmatch(expected) or
                    v1.digest(v1.regular_bytes(path, 1_000_000, self.enforce_root)) != expected):
                raise v1.Blocked('Controller checksum mismatch: ' + name)
        for name in BUNDLE_FILES:
            target = self.bundle / name
            if self.enforce_root:
                v1.secure_tree(target)
            expected = policy['files'][name]
            if not isinstance(expected, str) or not v1.HEX64.fullmatch(expected):
                raise v1.Blocked('Invalid bundle digest')
            if v1.digest(v1.regular_bytes(target, 1_000_000, self.enforce_root)) != expected:
                raise v1.Blocked('Approved bundle checksum mismatch: ' + name)
        if self.enforce_root:
            secret_dir = self.bundle / 'infrastructure/compose/.local/staging/secrets'
            link = os.lstat(secret_dir)
            if (not stat.S_ISLNK(link.st_mode) or
                    os.readlink(secret_dir) != str(self.root / 'runtime-secrets')):
                raise v1.Blocked('Secret directory link changed')
        self.policy = policy
        return policy

    def state(self):
        value = json.loads(v1.regular_bytes(self.state_dir / 'state.json',
                                            trusted=self.enforce_root))
        if value.get('schemaVersion') == 1:
            v1.exact_keys(value, ('schemaVersion', 'active', 'previous'))
            if value['previous'] is not None:
                raise v1.Blocked('A21 baseline has unexpected rollback target')
            v1.Controller.check_version(value['active'])
            active = value['active'] | {'profile': 'A21'}
            return {'schemaVersion': 2, 'active': active, 'previous': None,
                    'phase': 'steady', 'pending': None}
        v1.exact_keys(value, STATE_KEYS)
        if value['schemaVersion'] != 2 or value['phase'] not in (
                'steady', 'stopping', 'stopped', 'switching', 'recovering'):
            raise v1.Blocked('Invalid v2 state')
        for item in (value['active'], value['previous']):
            if item is not None:
                v1.Controller.check_version({key: item[key] for key in
                                             ('commit', 'apiRef', 'webRef', 'apiId', 'webId',
                                              'releaseSha256')})
                profile_of(item)
        if value['active'] is None:
            raise v1.Blocked('Missing active release')
        if value['phase'] == 'steady':
            if value['pending'] is not None:
                raise v1.Blocked('Unexpected promotion journal')
            if value['active']['profile'] == 'A21' and value['previous'] is not None:
                raise v1.Blocked('A21 rollback target forbidden')
            if value['previous'] is not None and (
                    value['active']['profile'] != 'B22-mdm' or
                    value['previous']['profile'] != 'B22-safe'):
                raise v1.Blocked('Unsafe previous release')
        elif value['phase'] in ('stopping', 'stopped'):
            if value['active']['profile'] != 'A21' or value['previous'] is not None:
                raise v1.Blocked('Invalid promotion source')
            pending = value['pending']
            v1.exact_keys(pending, ('target', 'backupSha256', 'restoreSha256', 'epoch'))
            v1.Controller.check_version({key: pending['target'][key] for key in
                                         ('commit', 'apiRef', 'webRef', 'apiId', 'webId',
                                          'releaseSha256')})
            if profile_of(pending['target']) != 'B22-safe':
                raise v1.Blocked('Promotion target must be B22-safe')
            if (not v1.HEX64.fullmatch(pending['backupSha256']) or
                    not v1.HEX64.fullmatch(pending['restoreSha256']) or
                    not re.fullmatch(r'[a-f0-9-]{36}', pending['epoch'])):
                raise v1.Blocked('Invalid promotion journal')
        else:
            pending = value['pending']
            v1.exact_keys(pending, ('action', 'source', 'target', 'ledger',
                                    'policySha256', 'gateEpoch', 'dbId',
                                    'approvalId', 'operations'))
            if pending['source'] != value['active'] or pending['action'] not in ('deploy', 'rollback'):
                raise v1.Blocked('Invalid transition source')
            target = pending['target']
            v1.Controller.check_version({key: target[key] for key in
                                         ('commit', 'apiRef', 'webRef', 'apiId', 'webId',
                                          'releaseSha256')})
            pair = (value['active']['profile'], profile_of(target))
            if pair not in (('B22-safe', 'B22-mdm'), ('B22-mdm', 'B22-safe')) or (
                    pending['action'] == 'deploy') != (pair[0] == 'B22-safe'):
                raise v1.Blocked('Invalid transition profiles')
            if pending['action'] == 'rollback' and value['previous'] != target:
                raise v1.Blocked('Rollback target differs from accredited safe release')
            if (pending['ledger'] != {'profile': 'B22', 'sqlCount': 22,
                                     'sqlListSha256': B22_HASH} or
                    not isinstance(pending['policySha256'], str) or
                    not v1.HEX64.fullmatch(pending['policySha256']) or
                    not re.fullmatch(r'[a-f0-9-]{36}', pending['gateEpoch']) or
                    not isinstance(pending['dbId'], str) or
                    not re.fullmatch(r'[a-f0-9]{64}', pending['dbId']) or
                    not v1.IDENT.fullmatch(pending['approvalId']) or
                    set(pending['operations']) != set(SWITCH_OPERATIONS) or
                    any(pending['operations'][key] not in ('pending', 'started', 'verified')
                        for key in SWITCH_OPERATIONS)):
                raise v1.Blocked('Invalid transition journal')
        return value

    def save_state(self, value):
        v1.exact_keys(value, STATE_KEYS)
        super().save_state(value)
        if os.name == 'posix':
            directory = os.open(self.state_dir, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)

    def local_endpoint(self):
        endpoint = self.call([self.docker, 'context', 'inspect', '--format',
                              '{{.Endpoints.docker.Host}}'], timeout=10)
        if endpoint not in ('unix:///var/run/docker.sock', 'unix:///run/docker.sock'):
            raise v1.Blocked('Only the local Docker daemon is allowed')

    def ledger(self):
        lines = self.call([self.docker, 'exec', v1.SERVICES['db'], 'psql', '-X', '-v',
                           'ON_ERROR_STOP=1', '-U', 'geops_stage', '-d', 'geops_dev',
                           '-Atq', '-c',
                           'SELECT version,checksum FROM geops_schema_migrations ORDER BY version'],
                          timeout=15).splitlines()
        if not all(v1.SQL_LINE.fullmatch(line) for line in lines):
            raise v1.Blocked('Invalid migration ledger')
        observed = {'sqlCount': len(lines),
                    'sqlListSha256': v1.digest('\n'.join(lines).encode())}
        if observed == {key: PROFILES['A21'][key] for key in observed}:
            return 'A21', observed
        if observed == {key: PROFILES['B22-safe'][key] for key in observed}:
            return 'B22', observed
        raise v1.Blocked('Migration ledger differs from approved profiles')

    def gate(self, expected_phase=None):
        gate = json.loads(v1.gate_bytes(v1.GATE, self.enforce_root))
        if (gate.get('phase') not in ('open', 'maintenance') or
                not re.fullmatch(r'[a-f0-9-]{36}', gate.get('epoch', '')) or
                (expected_phase is not None and gate['phase'] != expected_phase)):
            raise v1.Blocked('External gate phase or epoch mismatch')
        epoch = self.call([self.docker, 'exec', v1.SERVICES['db'], 'psql', '-X', '-v',
                           'ON_ERROR_STOP=1', '-U', 'geops_stage', '-d', 'geops_dev',
                           '-Atq', '-c', 'SELECT epoch FROM security_epoch WHERE singleton=true'],
                          timeout=15)
        if epoch != gate['epoch']:
            raise v1.Blocked('External gate and database epochs differ')
        return gate

    def backup(self):
        if self.enforce_root:
            v1.secure_tree(v1.BACKUPS)
        backups = sorted(v1.BACKUPS.glob('geops-stage-*.dump'),
                         key=lambda path: path.stat().st_mtime)
        if not backups:
            raise v1.Blocked('No Staging backup')
        latest = backups[-1]
        if self.enforce_root:
            v1.secure_tree(latest)
            v1.secure_tree(Path(str(latest) + '.sha256'))
        info = os.lstat(latest)
        if (not stat.S_ISREG(info.st_mode) or info.st_size == 0 or
                time.time() - info.st_mtime > self.policy['backupMaxAgeSeconds']):
            raise v1.Blocked('Invalid or stale backup')
        expected = v1.regular_bytes(Path(str(latest) + '.sha256'), 256).decode().split()[0]
        if not v1.HEX64.fullmatch(expected):
            raise v1.Blocked('Invalid backup checksum file')
        sha = hashlib.sha256()
        with latest.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                sha.update(block)
        if sha.hexdigest() != expected:
            raise v1.Blocked('Backup checksum mismatch')
        return {'sha256': expected, 'bytes': info.st_size}

    def profile_env(self, profile, api, web, maintenance_epoch=None):
        env = self.env | {
            'GEOPS_STAGE_SECRET_GID': self.policy['secretGid'],
            'GEOPS_STAGE_IMAGE_TAG': self.policy['imageTag'],
            'GEOPS_STAGE_ORIGIN': self.policy['origin'],
            'GEOPS_STAGE_API_IMAGE_REF': api,
            'GEOPS_STAGE_WEB_IMAGE_REF': web,
        }
        if profile == 'B22-mdm':
            mdm = self.policy['mdm']
            env['GEOPS_MDM_REGION'] = mdm['region']
        if maintenance_epoch is not None:
            env['GEOPS_MAINTENANCE_EPOCH'] = maintenance_epoch
        return env

    def compose_args(self, profile, migration=False):
        files = [v1.BUNDLE_FILES[0]]
        if profile == 'B22-mdm':
            files.append(MDM_OVERLAY)
        files.append(v1.BUNDLE_FILES[1])
        if migration:
            files.append(MIGRATE_OVERLAY)
        args = [self.docker, 'compose']
        for name in files:
            args.extend(('-f', str(self.bundle / name)))
        return args

    def check_compose(self, profile, api, web):
        config = json.loads(self.call([*self.compose_args(profile), 'config', '--format', 'json'],
                                      env=self.profile_env(profile, api, web)))
        services = config.get('services', {})
        if (config.get('name') != v1.ENVIRONMENT or
                services.get('geops-api', {}).get('image') != api or
                services.get('geops-web', {}).get('image') != web or
                services.get('geops-db', {}).get('image') != 'postgis/postgis:18-3.6'):
            raise v1.Blocked('Compose service identity changed')
        enabled = str(PROFILES[profile]['mdmEnabled']).lower()
        api_service, web_service = services['geops-api'], services['geops-web']
        if (api_service.get('environment', {}).get('MDM_ENABLED') != enabled or
                web_service.get('build', {}).get('args', {}).get('MDM_ENABLED') != enabled):
            raise v1.Blocked('Compose MDM profile changed')
        api_secrets = {item.get('source') if isinstance(item, dict) else item
                       for item in api_service.get('secrets', [])}
        required = set(v1.SECRET_NAMES)
        if profile == 'B22-mdm':
            mdm = api_service.get('environment', {})
            if (mdm.get('GEOPS_MDM_TEST_TENANT') != '1' or
                    mdm.get('GEOPS_MDM_REGION') != self.policy['mdm']['region'] or
                    'GEOPS_MDM_EDITION' in mdm or 'GEOPS_MDM_CUSTOMER_ID' in mdm or
                    'stage_egress' not in api_service.get('networks', {})):
                raise v1.Blocked('MDM tenant or egress configuration changed')
        elif any(name in api_service.get('environment', {}) for name in
                 ('GEOPS_MDM_CLIENT_ID', 'GEOPS_MDM_CLIENT_SECRET', 'GEOPS_MDM_REFRESH_TOKEN')):
            raise v1.Blocked('MDM credentials configured in disabled profile')
        if api_secrets != required:
            raise v1.Blocked('API secret inventory changed')
        return {'api': api, 'web': web, 'mdmEnabled': enabled,
                'webVariant': PROFILES[profile]['variant']}

    def image_info(self, ref, commit, profile, service, expected_id=None):
        value = self.docker_json(['image', 'inspect', ref, '--format', '{{json .}}'])
        image_id = value.get('Id')
        if not isinstance(image_id, str) or not v1.IMAGE_ID.fullmatch(image_id):
            raise v1.Blocked('Invalid image ID')
        if expected_id and image_id != expected_id:
            raise v1.Blocked('Image ID changed')
        if profile != 'A21':
            if ref not in value.get('RepoDigests', []):
                raise v1.Blocked('Registry digest unavailable locally')
            labels = value.get('Config', {}).get('Labels') or {}
            if labels.get('org.opencontainers.image.revision') != commit:
                raise v1.Blocked('Image revision mismatch')
            if service == 'api' and labels.get('org.geops.api.variant') != profile:
                raise v1.Blocked('API profile label mismatch')
            if service == 'web' and (
                    labels.get('org.geops.web.variant') != PROFILES[profile]['variant'] or
                    labels.get('org.geops.web.mdm_enabled') !=
                    str(PROFILES[profile]['mdmEnabled']).lower()):
                raise v1.Blocked('Web variant label mismatch')
        labels = value.get('Config', {}).get('Labels') or {}
        return {'id': image_id, 'reference': ref,
                'repoDigests': value.get('RepoDigests', []),
                'revision': labels.get('org.opencontainers.image.revision'),
                'profile': profile}

    def embedded_sql(self, ref, profile):
        result = self.docker_json(['run', '--rm', '--network', 'none', '--read-only',
                                   '--pull', 'never', '--entrypoint', 'node', ref,
                                   '-e', SQL_SCRIPT])
        expected = {key: PROFILES[profile][key] for key in ('sqlCount', 'sqlListSha256')}
        if result != {'count': expected['sqlCount'], 'sha256': expected['sqlListSha256']}:
            raise v1.Blocked('API image SQL differs from approved profile')
        return result

    def verify_secrets(self, profile, mounted=False):
        names = v1.SECRET_NAMES
        for name in names:
            master = self.root / 'secrets' / name
            runtime = self.root / 'runtime-secrets' / name
            if self.enforce_root:
                v1.secure_tree(master)
                v1.secure_tree(runtime)
                a, b = os.stat(master), os.stat(runtime)
                if (a.st_uid != 0 or a.st_gid != 0 or stat.S_IMODE(a.st_mode) != 0o600 or
                        b.st_uid != 0 or b.st_gid != int(self.policy['secretGid']) or
                        stat.S_IMODE(b.st_mode) != 0o640):
                    raise v1.Blocked('MDM secret ownership changed')
            expected = v1.digest(v1.regular_bytes(master, 4096, self.enforce_root))
            if expected != v1.digest(v1.regular_bytes(runtime, 4096, self.enforce_root)):
                raise v1.Blocked('Protected secret copies differ')
            if mounted:
                observed = self.call([self.docker, 'exec', v1.SERVICES['api'], 'node', '-e',
                                      "const c=require('node:crypto'),f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))",
                                      '/run/secrets/' + name], timeout=15)
                if observed != expected:
                    raise v1.Blocked('Mounted GEOPS secret differs from protected copy')

    def release(self, identity):
        value, sha = self.signed('release', identity)
        v1.exact_keys(value, ('schemaVersion', 'id', 'environment', 'notBefore', 'expiresAt',
                              'commit', 'api', 'web', 'profile', 'sqlCount',
                              'sqlListSha256', 'policySha256'))
        profile = value['profile']
        if (value['schemaVersion'] != 2 or profile not in ('B22-safe', 'B22-mdm') or
                not isinstance(value['commit'], str) or
                not v1.SHA.fullmatch(value['commit']) or
                not v1.image_ref(value['api'], 'api') or
                not v1.image_ref(value['web'], 'web') or
                '@sha256:' not in value['api'] or '@sha256:' not in value['web'] or
                value['sqlCount'] != 22 or value['sqlListSha256'] != B22_HASH or
                value['policySha256'] != v1.digest(self.policy_bytes)):
            raise v1.Blocked('Release differs from v2 policy')
        return value, sha

    def version_from_release(self, release, sha):
        profile = release['profile']
        api = self.image_info(release['api'], release['commit'], profile, 'api')
        web = self.image_info(release['web'], release['commit'], profile, 'web')
        self.embedded_sql(release['api'], profile)
        self.check_compose(profile, release['api'], release['web'])
        return {'commit': release['commit'], 'apiRef': release['api'],
                'webRef': release['web'], 'apiId': api['id'], 'webId': web['id'],
                'releaseSha256': sha, 'profile': profile}

    def approval(self, identity, action, release_sha, source, target,
                 backup_sha=None, restore_sha=None, epoch=None):
        value, _ = self.signed('approval', identity)
        v1.exact_keys(value, ('schemaVersion', 'id', 'environment', 'notBefore', 'expiresAt',
                              'action', 'releaseSha256', 'releaseCommit', 'apiDigest',
                              'webDigest', 'policySha256', 'sourceApiId', 'sourceWebId',
                              'targetApiId', 'targetWebId', 'sourceProfile', 'targetProfile',
                              'backupSha256', 'restoreSha256', 'epoch'))
        if (value['schemaVersion'] != 2 or value['action'] != action or
                value['releaseSha256'] != release_sha or
                value['releaseCommit'] != target['commit'] or
                value['apiDigest'] != target['apiRef'] or
                value['webDigest'] != target['webRef'] or
                value['policySha256'] != v1.digest(self.policy_bytes) or
                value['sourceApiId'] != source['apiId'] or
                value['sourceWebId'] != source['webId'] or
                value['targetApiId'] != target['apiId'] or
                value['targetWebId'] != target['webId'] or
                value['sourceProfile'] != source['profile'] or
                value['targetProfile'] != target['profile'] or
                value['backupSha256'] != backup_sha or
                value['restoreSha256'] != restore_sha or value['epoch'] != epoch or
                (self.state_dir / 'used' / identity).exists()):
            raise v1.Blocked('Approval not bound to exact v2 transition')

    def restore_proof(self, identity, backup_sha):
        value, sha = self.signed('restore', identity)
        v1.exact_keys(value, ('schemaVersion', 'id', 'environment', 'notBefore', 'expiresAt',
                              'backupSha256', 'sqlCount', 'sqlListSha256',
                              'restoredAt', 'result', 'evidenceSha256', 'policySha256'))
        if (value['schemaVersion'] != 2 or value['backupSha256'] != backup_sha or
                value['sqlCount'] != 21 or value['sqlListSha256'] != A21_HASH or
                value['result'] != 'PASS' or
                not isinstance(value['evidenceSha256'], str) or
                not v1.HEX64.fullmatch(value['evidenceSha256']) or
                value['policySha256'] != v1.digest(self.policy_bytes) or
                not datetime.now(timezone.utc) - timedelta(hours=24) <=
                v1.utc(value['restoredAt']) <= datetime.now(timezone.utc)):
            raise v1.Blocked('Invalid isolated restore attestation')
        return sha

    def evidence(self):
        state = self.state()
        live = self.current(require_healthy=False)
        ledger_profile, ledger = self.ledger()
        active = state['active']
        api = self.image_info(active['apiRef'], active['commit'], active['profile'],
                              'api', active['apiId'])
        web = self.image_info(active['webRef'], active['commit'], active['profile'],
                              'web', active['webId'])
        compose = self.check_compose(active['profile'], active['apiRef'], active['webRef'])
        return {'policySchemaVersion': 2, 'policySha256': v1.digest(self.policy_bytes),
                'bundleSha256': v1.digest(json.dumps(self.policy['files'], sort_keys=True).encode()),
                'phase': state['phase'], 'activeProfile': active['profile'],
                'previousProfile': state['previous']['profile'] if state['previous'] else None,
                'imageMatch': (state['phase'] == 'steady' and
                               live['api']['image'] == active['apiId'] and
                               live['web']['image'] == active['webId']),
                'transition': ({'action': state['pending']['action'],
                                'targetProfile': state['pending']['target']['profile'],
                                'operations': state['pending']['operations']}
                               if state['phase'] in ('switching', 'recovering') else None),
                'api': api | {'health': live['api']['health'],
                              'observedId': live['api']['image']},
                'web': web | {'health': live['web']['health'],
                              'observedId': live['web']['image'],
                              'status': live['web']['status']},
                'dbHealth': live['db']['health'], 'ledgerProfile': ledger_profile,
                'ledger': ledger, 'compose': compose,
                'gatePhase': self.gate()['phase'],
                'backup': self.backup()}

    def preflight(self):
        self.load_policy()
        self.local_endpoint()
        state = self.state()
        if state['phase'] != 'steady':
            raise v1.Blocked('Transition pending; only evidence or recovery allowed')
        self.current(state['active'])
        ledger_profile, _ = self.ledger()
        if ledger_profile != ('A21' if state['active']['profile'] == 'A21' else 'B22'):
            raise v1.Blocked('Active API and database schema differ')
        self.gate('open')
        self.backup()
        self.verify_secrets(state['active']['profile'], mounted=True)
        self.embedded_sql(state['active']['apiRef'], state['active']['profile'])
        return state

    def stop_web_gate(self):
        web = self.container('web')
        if web['status'] != 'exited':
            self.timed('close-web-traffic', lambda: self.call(
                [self.docker, 'stop', web['id']], timeout=120))
        if self.container('web')['status'] != 'exited':
            raise v1.Blocked('Web traffic gate did not close')

    def transition_op(self, state, operation, status):
        state['pending']['operations'][operation] = status
        self.save_state(state)

    def transition_journal(self, state, action, target, approval_id, before):
        ledger_profile, ledger = self.ledger()
        if ledger_profile != 'B22' or ledger != {
                'sqlCount': 22, 'sqlListSha256': B22_HASH}:
            raise v1.Blocked('B22 ledger required for profile transition')
        return {'action': action, 'source': state['active'], 'target': target,
                'ledger': {'profile': ledger_profile, **ledger},
                'policySha256': v1.digest(self.policy_bytes),
                'gateEpoch': self.gate('open')['epoch'],
                'dbId': before['db']['id'], 'approvalId': approval_id,
                'operations': {name: 'pending' for name in SWITCH_OPERATIONS}}

    def switch(self, target, progress=None, require_web_closed=False):
        profile = profile_of(target)
        ledger_profile, _ = self.ledger()
        if ledger_profile != ('A21' if profile == 'A21' else 'B22'):
            raise v1.Blocked('Target API migration set differs from live database')
        self.image_info(target['apiRef'], target['commit'], profile, 'api', target['apiId'])
        self.image_info(target['webRef'], target['commit'], profile, 'web', target['webId'])
        self.embedded_sql(target['apiRef'], profile)
        self.check_compose(profile, target['apiRef'], target['webRef'])
        self.verify_secrets(profile)
        self.gate('open')
        env = self.profile_env(profile, target['apiRef'], target['webRef'])
        for service, key in (('geops-api', 'apiId'), ('geops-web', 'webId')):
            if require_web_closed and service == 'geops-api' and (
                    self.container('web')['status'] != 'exited'):
                raise v1.Blocked('Web traffic gate reopened before API switch')
            operation = 'apiStart' if service == 'geops-api' else 'webStart'
            if progress:
                progress(operation, 'started')
            current_ledger, _ = self.ledger()
            if current_ledger != ('A21' if profile == 'A21' else 'B22'):
                raise v1.Blocked('Database schema changed before service start')
            self.timed('activate-' + service, lambda service=service: self.call(
                [*self.compose_args(profile), 'up', '-d', '--no-deps', '--no-build',
                 '--pull', 'never', service], timeout=120, env=env))
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                status = self.container('api' if service == 'geops-api' else 'web')
                if status['image'] != target[key]:
                    raise v1.Blocked('Service started with wrong image ID')
                if status['health'] == 'healthy':
                    break
                if status['health'] == 'unhealthy' or status['status'] == 'exited':
                    raise v1.Blocked('Service readiness failed')
                time.sleep(1)
            else:
                raise v1.Blocked('Service readiness timed out')
            if progress:
                progress(operation, 'verified')
        self.verify_secrets(profile, mounted=True)
        self.smoke()

    def recover_transition(self, state):
        if state['phase'] not in ('switching', 'recovering'):
            raise v1.Blocked('No recoverable profile transition')
        pending = state['pending']
        source, target = pending['source'], pending['target']
        safe = source if pending['action'] == 'deploy' else target
        # Closing ingress is the first mutation, even if later evidence fails.
        self.stop_web_gate()
        if pending['policySha256'] != v1.digest(self.policy_bytes):
            raise v1.Blocked('Transition policy changed; traffic remains closed')
        observed_profile, observed_ledger = self.ledger()
        if ({'profile': observed_profile, **observed_ledger} != pending['ledger'] or
                self.gate('open')['epoch'] != pending['gateEpoch'] or
                self.container('db')['id'] != pending['dbId']):
            raise v1.Blocked('Transition ledger, gate or database changed; traffic remains closed')
        api, web = self.container('api'), self.container('web')
        if (api['image'] not in (source['apiId'], target['apiId']) or
                web['image'] not in (source['webId'], target['webId'])):
            raise v1.Blocked('Unknown application image; traffic remains closed')
        for version in (source, target):
            profile = version['profile']
            self.image_info(version['apiRef'], version['commit'], profile, 'api', version['apiId'])
            self.image_info(version['webRef'], version['commit'], profile, 'web', version['webId'])
        self.embedded_sql(safe['apiRef'], safe['profile'])
        self.check_compose(safe['profile'], safe['apiRef'], safe['webRef'])
        state['phase'] = 'recovering'
        state['pending']['operations'] = {name: 'pending' for name in SWITCH_OPERATIONS}
        self.save_state(state)
        self.transition_op(state, 'webStop', 'verified')
        self.switch(safe, lambda op, status: self.transition_op(state, op, status), True)
        live = self.current(safe)
        if live['db']['id'] != pending['dbId']:
            raise v1.Blocked('Database changed during recovery; traffic remains closed')
        self.transition_op(state, 'commit', 'started')
        self.save_state({'schemaVersion': 2, 'active': safe,
                         'previous': state['previous'] if pending['action'] == 'deploy'
                         else None, 'phase': 'steady', 'pending': None})
        self.audit('automatic-recovery', 'PASS')
        return {'result': 'RECOVERED_SAFE', 'profile': safe['profile']}

    def guard_startup(self):
        try:
            state = self.state()
        except Exception:
            self.stop_web_gate()
            raise
        if state['phase'] in ('switching', 'recovering', 'stopping', 'stopped'):
            self.stop_web_gate()
        elif state['phase'] == 'steady':
            api, web = self.container('api'), self.container('web')
            if (api['image'] != state['active']['apiId'] or
                    web['image'] != state['active']['webId']):
                self.stop_web_gate()
            try:
                ledger_profile, _ = self.ledger()
                expected = 'A21' if state['active']['profile'] == 'A21' else 'B22'
                if ledger_profile != expected:
                    raise v1.Blocked('Active API and database schema differ')
                self.gate('open')
            except Exception:
                self.stop_web_gate()
                raise
        return state

    def execute(self, command, release_id=None, approval_id=None, restore_id=None):
        self.load_policy()
        self.local_endpoint()
        startup = self.guard_startup()
        if command == 'inspect-evidence':
            return self.evidence()
        if command == 'status':
            state = self.state()
            live = self.current(require_healthy=False)
            return {'phase': state['phase'], 'activeProfile': state['active']['profile'],
                    'previousProfile': state['previous']['profile'] if state['previous'] else None,
                    'imageMatch': (state['phase'] == 'steady' and
                                   live['api']['image'] == state['active']['apiId'] and
                                   live['web']['image'] == state['active']['webId']),
                    'webTrafficClosed': live['web']['status'] == 'exited'}
        if command == 'recover':
            if startup['phase'] == 'steady':
                self.preflight()
                return {'result': 'ALREADY_STEADY',
                        'profile': startup['active']['profile']}
            return self.recover_transition(startup)
        if command == 'verify':
            state = self.preflight()
            self.smoke()
            return {'result': 'VERIFIED', 'profile': state['active']['profile']}
        if command == 'prepare':
            state = self.preflight()
            release, sha = self.release(release_id)
            if (state['active']['profile'] == 'A21' and release['profile'] != 'B22-safe'):
                raise v1.Blocked('Only B22-safe may be prepared from A21')
            for ref in (release['api'], release['web']):
                self.timed('pull-image', lambda ref=ref: self.call(
                    [self.docker, 'pull', ref], timeout=180))
            target = self.version_from_release(release, sha)
            return {'result': 'PREPARED', 'profile': target['profile'],
                    'apiId': target['apiId'], 'webId': target['webId']}
        if command == 'promote22-begin':
            state = self.state()
            if state['phase'] != 'steady' or state['active']['profile'] != 'A21':
                raise v1.Blocked('A21 steady source required')
            self.current(state['active'])
            if self.ledger()[0] != 'A21':
                raise v1.Blocked('A21 ledger required')
            gate = self.gate('open')
            backup = self.backup()
            release, sha = self.release(release_id)
            if release['profile'] != 'B22-safe':
                raise v1.Blocked('B22-safe promotion target required')
            target = self.version_from_release(release, sha)
            restore_sha = self.restore_proof(restore_id, backup['sha256'])
            self.approval(approval_id, 'promote22-begin', sha, state['active'], target,
                          backup['sha256'], restore_sha, gate['epoch'])
            self.consume(approval_id)
            pending = {'target': target, 'backupSha256': backup['sha256'],
                       'restoreSha256': restore_sha, 'epoch': gate['epoch']}
            state |= {'phase': 'stopping', 'pending': pending}
            self.save_state(state)
            return self.stop_for_promotion(state)
        if command == 'promote22-resume':
            state = self.state()
            if state['phase'] not in ('stopping', 'stopped'):
                raise v1.Blocked('No pending promotion')
            self.approval(approval_id, 'promote22-resume',
                          state['pending']['target']['releaseSha256'], state['active'],
                          state['pending']['target'], state['pending']['backupSha256'],
                          state['pending']['restoreSha256'], state['pending']['epoch'])
            self.consume(approval_id)
            if state['phase'] == 'stopping':
                return self.stop_for_promotion(state)
            if any(self.container(service)['status'] != 'exited'
                   for service in ('api', 'web')):
                self.stop_app_services(state['active'])
            return {'result': 'AWAITING_SUPERVISED_RECOVERY',
                    'ledgerProfile': self.ledger()[0], 'gatePhase': self.gate()['phase']}
        if command in ('promote22-complete', 'promote22-abort21'):
            state = self.state()
            if state['phase'] != 'stopped':
                raise v1.Blocked('Services have not been stopped for promotion')
            pending, source = state['pending'], state['active']
            target = pending['target'] if command == 'promote22-complete' else source
            wanted = 'B22' if command == 'promote22-complete' else 'A21'
            if self.ledger()[0] != wanted or self.gate('open')['epoch'] != pending['epoch']:
                raise v1.Blocked('Gate or ledger unsuitable for requested recovery')
            if any(self.container(service)['status'] != 'exited' for service in ('api', 'web')):
                raise v1.Blocked('Old application services must remain stopped')
            action = 'promote22-complete' if wanted == 'B22' else 'promote22-abort21'
            self.approval(approval_id, action, target['releaseSha256'], source, target,
                          pending['backupSha256'], pending['restoreSha256'], pending['epoch'])
            self.consume(approval_id)
            try:
                self.switch(target)
            except Exception:
                label = 'B22-safe' if wanted == 'B22' else 'A21'
                try:
                    self.stop_app_services(source)
                except Exception:
                    raise v1.Blocked(label + ' activation failed; operator must stop services')
                raise v1.Blocked(label + ' activation failed; stopped for supervised retry')
            state = {'schemaVersion': 2, 'active': target, 'previous': None,
                     'phase': 'steady', 'pending': None}
            self.save_state(state)
            return {'result': 'PROMOTED' if wanted == 'B22' else 'ABORTED_TO_A21',
                    'profile': target['profile']}
        if command in ('deploy', 'rollback'):
            state = self.preflight()
            source = state['active']
            if command == 'deploy':
                if source['profile'] != 'B22-safe':
                    raise v1.Blocked('Only B22-safe can deploy B22-mdm')
                release, sha = self.release(release_id)
                if release['profile'] != 'B22-mdm':
                    raise v1.Blocked('B22-mdm release required')
                target = self.version_from_release(release, sha)
                action = 'deploy'
            else:
                if source['profile'] != 'B22-mdm' or state['previous'] is None:
                    raise v1.Blocked('Only B22-mdm can return to B22-safe')
                target = state['previous']
                sha = target['releaseSha256']
                action = 'rollback'
            self.approval(approval_id, action, sha, source, target)
            before = self.current(source)
            pending = self.transition_journal(state, action, target, approval_id, before)
            self.consume(approval_id)
            state['phase'], state['pending'] = 'switching', pending
            self.save_state(state)
            try:
                self.transition_op(state, 'webStop', 'started')
                self.stop_web_gate()
                self.transition_op(state, 'webStop', 'verified')
                self.switch(target,
                            lambda op, status: self.transition_op(state, op, status), True)
                if self.current(target)['db']['id'] != before['db']['id']:
                    raise v1.Blocked('Database container changed')
                self.transition_op(state, 'commit', 'started')
                self.save_state({'schemaVersion': 2, 'active': target,
                                 'previous': source if action == 'deploy' else None,
                                 'phase': 'steady', 'pending': None})
            except Exception:
                try:
                    self.recover_transition(state)
                except Exception:
                    self.audit('automatic-recovery', 'FAIL')
                    raise v1.Blocked('Switch and safe recovery failed; Web traffic closed; operator required')
                label = ('source application' if action == 'deploy' else
                         'accredited safe application')
                raise v1.Blocked('Switch failed; ' + label + ' recovered')
            return {'result': 'DEPLOYED' if action == 'deploy' else 'ROLLED_BACK',
                    'profile': target['profile']}
        raise v1.Blocked('Unknown v2 operation')

    def stop_for_promotion(self, state):
        pending = state['pending']
        observed = self.ledger()[0]
        if self.gate()['epoch'] != pending['epoch']:
            raise v1.Blocked('Promotion epoch changed')
        if observed == 'B22':
            if any(self.container(service)['status'] != 'exited' for service in ('api', 'web')):
                self.stop_app_services(state['active'])
            state['phase'] = 'stopped'
            self.save_state(state)
            return {'result': 'AWAITING_SUPERVISED_RECOVERY', 'ledgerProfile': 'B22'}
        if observed != 'A21':
            raise v1.Blocked('A21 ledger required to stop services')
        self.stop_app_services(state['active'])
        state['phase'] = 'stopped'
        self.save_state(state)
        return {'result': 'AWAITING_SUPERVISED_RECOVERY', 'ledgerProfile': 'A21'}

    def stop_app_services(self, source):
        env = self.profile_env('A21', source['apiRef'], source['webRef'])
        self.check_compose('A21', source['apiRef'], source['webRef'])
        for service in ('geops-web', 'geops-api'):
            self.timed('stop-' + service, lambda service=service: self.call(
                [*self.compose_args('A21'), 'stop', service], timeout=120, env=env))
        if any(self.container(service)['status'] != 'exited' for service in ('api', 'web')):
            raise v1.Blocked('Application services did not stop')


def main(argv):
    if os.geteuid() != 0 or fcntl is None:
        raise v1.Blocked('Root on Linux required')
    expected = {'status': 0, 'inspect-evidence': 0, 'verify': 0, 'recover': 0,
                'prepare': 1, 'deploy': 2, 'rollback': 1,
                'promote22-begin': 3, 'promote22-resume': 1,
                'promote22-complete': 1, 'promote22-abort21': 1}
    if (not argv or argv[0] not in expected or len(argv) - 1 != expected[argv[0]] or
            not all(v1.IDENT.fullmatch(item) for item in argv[1:])):
        raise v1.Blocked('Invalid v2 operation or arguments')
    command = argv[0]
    v1.secure_tree(v1.STATE_DIR)
    control = ControllerV2()
    lock = os.open(v1.STATE_DIR / 'lock', os.O_WRONLY | os.O_CREAT |
                   getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        info = os.fstat(lock)
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise v1.Blocked('Lock is not root-protected')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        control.audit('requested-' + command, 'START')
        release_id = argv[1] if command in ('prepare', 'deploy', 'promote22-begin') else None
        approval_id = (argv[2] if command == 'deploy' else
                       argv[2] if command == 'promote22-begin' else
                       argv[1] if command in ('rollback', 'promote22-resume',
                                              'promote22-complete', 'promote22-abort21') else None)
        restore_id = argv[3] if command == 'promote22-begin' else None
        result = control.execute(command, release_id, approval_id, restore_id)
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
        print(f'GEOPS v2 operation BLOCKED: {error}', file=sys.stderr)
        sys.exit(1)
