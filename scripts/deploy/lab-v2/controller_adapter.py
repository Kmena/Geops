#!/usr/bin/env python3
"""Exercise the unchanged v2 transition methods against one fixed local lab.

This adapter replaces only Staging-bound identity, signed approvals and registry
references. It is not an installable deployment controller.
"""

import hashlib
import json
import os
import re
import shutil
import sys
from pathlib import Path

LAB = Path(os.environ.get('GEOPS_LAB_ROOT',
    r'C:\Users\kmena\.codex\visualizations\2026\10\23\01a16973-247e-72c2-826a-b3bdeb2757a8\geops-v2lab-20261023x'))
PROJECT = os.environ.get('GEOPS_LAB_PROJECT', 'geopsv2lab20261023x')
if (not LAB.name.startswith('geops-v2lab-') or
        not re.fullmatch(r'geopsv2lab[a-z0-9]+', PROJECT) or
        'visualizations' not in LAB.parts):
    raise RuntimeError('Exclusive local GEOPS laboratory identity required')
SOURCE = Path(__file__).resolve().parents[1] / 'remote'
sys.path.insert(0, str(SOURCE))
import geops_deploy as v1  # noqa: E402
import geops_deploy_v2 as v2  # noqa: E402

if not LAB.is_dir() or not (LAB / 'compose.yaml').is_file():
    raise RuntimeError('Fixed isolated laboratory unavailable')

v1.SERVICES = {name: f'{PROJECT}-geops-{name}-1' for name in ('api', 'web', 'db')}
v1.GATE = LAB / 'security' / 'security-gate.json'
v1.BACKUPS = LAB / 'backups'
v1.ENVIRONMENT = PROJECT
v1.image_ref = lambda value, service: bool(re.fullmatch(
    rf'{PROJECT}-{service}:(a21|b22-safe|b22-mdm)', value or ''))


def ref(profile, service):
    return f'{PROJECT}-{service}:{profile.lower()}'


class LabController(v2.ControllerV2):
    def __init__(self):
        docker = shutil.which('docker')
        if not docker:
            raise RuntimeError('Docker CLI unavailable')
        state_dir = LAB / 'control-state'
        state_dir.mkdir(exist_ok=True)
        (state_dir / 'used').mkdir(exist_ok=True)
        (LAB / 'audit.jsonl').touch(exist_ok=True)
        super().__init__(root=LAB, state_dir=state_dir, log=LAB / 'audit.jsonl',
                         docker=docker, enforce_root=False)
        self.bundle = LAB
        self.env = os.environ.copy()
        self.fault = self.env.get('GEOPS_LAB_FAULT', '')
        if self.fault not in ('', 'api-no-start', 'web-unhealthy',
                              'api-unhealthy', 'interrupt-after-api',
                              'before-api', 'after-api', 'before-web',
                              'after-web', 'before-commit', 'during-recovery',
                              'before-recovery-web'):
            raise RuntimeError('Unknown fixed laboratory fault')

    def transition_op(self, state, operation, status):
        super().transition_op(state, operation, status)
        faults = {'before-api': ('switching', 'apiStart', 'started'),
                  'after-api': ('switching', 'apiStart', 'verified'),
                  'before-web': ('switching', 'webStart', 'started'),
                  'after-web': ('switching', 'webStart', 'verified'),
                  'before-commit': ('switching', 'commit', 'started'),
                  'during-recovery': ('recovering', 'apiStart', 'verified'),
                  'before-recovery-web': ('recovering', 'webStart', 'started')}
        if faults.get(self.fault) == (state['phase'], operation, status):
            raise KeyboardInterrupt('Isolated lab interruption: ' + self.fault)

    def call(self, args, timeout=30, env=None):
        result = super().call(args, timeout, env)
        if (self.fault == 'interrupt-after-api' and 'up' in args and
                args[-1] == 'geops-api' and
                (env or {}).get('GEOPS_LAB_API_IMAGE') == ref('B22-mdm', 'api')):
            raise KeyboardInterrupt('Lab process interruption after API activation')
        return result

    def load_policy(self):
        # The production signed policy is verified in its own unmodified tests.
        self.policy = {'secretGid': '0', 'imageTag': '0' * 40,
                       'origin': 'http://127.0.0.1:47693' if 'recovery' in PROJECT
                                 else 'http://127.0.0.1:47683',
                       'backupMaxAgeSeconds': 86400,
                       'mdm': {'region': 'com', 'edition': 'TRIAL', 'customerId': '12345'}}
        self.policy_bytes = b'isolated-v2-lab-policy'
        return self.policy

    def local_endpoint(self):
        endpoint = self.call([self.docker, 'context', 'inspect', '--format',
                              '{{.Endpoints.docker.Host}}'], timeout=10)
        if not (endpoint.startswith('npipe:') or endpoint.startswith('unix:')):
            raise v1.Blocked('Local Docker endpoint required')

    def profile_env(self, profile, api, web, maintenance_epoch=None):
        env = self.env | {'GEOPS_LAB_API_IMAGE': api, 'GEOPS_LAB_WEB_IMAGE': web}
        if maintenance_epoch:
            env['GEOPS_MAINTENANCE_EPOCH'] = maintenance_epoch
        return env

    def compose_args(self, profile, migration=False):
        args = [self.docker, 'compose', '-p', PROJECT, '-f', str(LAB / 'compose.yaml')]
        if profile == 'B22-mdm':
            args.extend(('-f', str(LAB / 'compose.mdm.yaml')))
            fault_file = {'api-no-start': 'compose.fault-api.yaml',
                          'web-unhealthy': 'compose.fault-web.yaml',
                          'api-unhealthy': 'compose.fault-readiness.yaml'}.get(self.fault)
            if fault_file:
                args.extend(('-f', str(LAB / fault_file)))
        return args

    def check_compose(self, profile, api, web):
        config = json.loads(self.call([*self.compose_args(profile), 'config',
                                       '--format', 'json'],
                                      env=self.profile_env(profile, api, web)))
        services = config.get('services', {})
        if (config.get('name') != PROJECT or
                services.get('geops-api', {}).get('image') != api or
                services.get('geops-web', {}).get('image') != web or
                services.get('geops-db', {}).get('image') != 'postgis/postgis:18-3.6'):
            raise v1.Blocked('Lab Compose identity changed')
        enabled = str(v2.PROFILES[profile]['mdmEnabled']).lower()
        if (services['geops-api']['environment']['MDM_ENABLED'] != enabled or
                services['geops-web']['build']['args']['MDM_ENABLED'] != enabled):
            raise v1.Blocked('Lab MDM profile changed')
        if set(config.get('networks', {})) != {'lab_app', 'lab_db'} or not all(
                value.get('internal') is True for value in config['networks'].values()):
            raise v1.Blocked('Lab network isolation changed')
        return {'api': api, 'web': web, 'mdmEnabled': enabled}

    def image_info(self, image_ref, commit, profile, service, expected_id=None):
        if image_ref != ref(profile, service):
            raise v1.Blocked('Unexpected lab image reference')
        value = self.docker_json(['image', 'inspect', image_ref, '--format', '{{json .}}'])
        image_id = value['Id']
        labels = value.get('Config', {}).get('Labels') or {}
        if (not v1.IMAGE_ID.fullmatch(image_id) or
                (expected_id and image_id != expected_id) or
                labels.get('org.opencontainers.image.revision') != commit):
            raise v1.Blocked('Lab image identity changed')
        if profile != 'A21' and service == 'api' and labels.get('org.geops.api.variant') != profile:
            raise v1.Blocked('Lab API variant mismatch')
        if service == 'web' and (
                labels.get('org.geops.web.variant') != v2.PROFILES[profile]['variant'] or
                labels.get('org.geops.web.mdm_enabled') !=
                str(v2.PROFILES[profile]['mdmEnabled']).lower()):
            raise v1.Blocked('Lab Web variant mismatch')
        return {'id': image_id, 'reference': image_ref}

    def verify_secrets(self, profile, mounted=False):
        config = self.check_compose(profile, ref(profile, 'api'), ref(profile, 'web'))
        if mounted:
            for name in v1.SECRET_NAMES + (v2.MDM_SECRET_NAMES if profile == 'B22-mdm' else ()):
                self.call([self.docker, 'exec', v1.SERVICES['api'], 'test', '-s',
                           '/run/secrets/' + name], timeout=10)
        return config

    def backup(self):
        return super().backup()

    def release(self, identity):
        if not identity.startswith('lab-mdm-release-'):
            raise v1.Blocked('Lab release identity rejected')
        value = {'profile': 'B22-mdm', 'commit': COMMITS['B22-mdm'],
                 'api': ref('B22-mdm', 'api'), 'web': ref('B22-mdm', 'web')}
        return value, hashlib.sha256(identity.encode()).hexdigest()

    def approval(self, identity, action, release_sha, source, target,
                 backup_sha=None, restore_sha=None, epoch=None):
        pair = (source['profile'], target['profile'])
        if (not identity.startswith('lab-mdm-approval-') or
                (self.state_dir / 'used' / identity).exists() or
                (action, pair) not in (('deploy', ('B22-safe', 'B22-mdm')),
                                       ('rollback', ('B22-mdm', 'B22-safe'))) or
                release_sha != target['releaseSha256'] or
                any(value is not None for value in (backup_sha, restore_sha, epoch))):
            raise v1.Blocked('Lab transition approval mismatch')


COMMITS = {'A21': '03e582fba66c0d29eab885e109d3404e86b140a3',
           'B22-safe': 'ecacc2ebb0828df981d5e75a6154825f45c78afc',
           'B22-mdm': 'ecacc2ebb0828df981d5e75a6154825f45c78afc'}


def version(control, profile):
    commit = COMMITS[profile]
    api = control.image_info(ref(profile, 'api'), commit, profile, 'api')
    web = control.image_info(ref(profile, 'web'), commit, profile, 'web')
    control.embedded_sql(ref(profile, 'api'), profile)
    control.check_compose(profile, ref(profile, 'api'), ref(profile, 'web'))
    return {'commit': commit, 'apiRef': ref(profile, 'api'),
            'webRef': ref(profile, 'web'), 'apiId': api['id'], 'webId': web['id'],
            'releaseSha256': hashlib.sha256(profile.encode()).hexdigest(), 'profile': profile}


def main(action):
    control = LabController()
    control.load_policy()
    control.local_endpoint()
    if action == 'init':
        active = version(control, 'A21')
        control.current(active)
        assert control.ledger()[0] == 'A21'
        control.gate('open')
        control.backup()
        control.smoke()
        control.save_state({'schemaVersion': 2, 'active': active, 'previous': None,
                            'phase': 'steady', 'pending': None})
        return {'result': 'A21_VALIDATED'}
    state = control.state()
    if action == 'stop':
        if state['active']['profile'] != 'A21' or state['phase'] != 'steady':
            raise v1.Blocked('A21 steady source required')
        backup = control.backup()
        epoch = control.gate('open')['epoch']
        state['phase'] = 'stopping'
        state['pending'] = {'target': version(control, 'B22-safe'),
                            'backupSha256': backup['sha256'],
                            'restoreSha256': hashlib.sha256(b'lab-restore').hexdigest(),
                            'epoch': epoch}
        control.save_state(state)
        return control.stop_for_promotion(state)
    if action == 'switch-safe':
        if state['phase'] != 'stopped' or control.ledger()[0] != 'B22':
            raise v1.Blocked('Stopped A21 and B22 ledger required')
        target = state['pending']['target']
        control.switch(target)
        control.save_state({'schemaVersion': 2, 'active': target, 'previous': None,
                            'phase': 'steady', 'pending': None})
        return {'result': 'PROMOTED', 'profile': 'B22-safe'}
    if action == 'switch-mdm':
        if state['active']['profile'] != 'B22-safe':
            raise v1.Blocked('B22-safe source required')
        control.preflight()
        target = version(control, 'B22-mdm')
        control.switch(target)
        control.save_state({'schemaVersion': 2, 'active': target,
                            'previous': state['active'], 'phase': 'steady', 'pending': None})
        return {'result': 'DEPLOYED', 'profile': 'B22-mdm'}
    if action == 'rollback-safe':
        if state['active']['profile'] != 'B22-mdm':
            raise v1.Blocked('B22-mdm source required')
        control.preflight()
        target = state['previous']
        control.switch(target)
        control.save_state({'schemaVersion': 2, 'active': target, 'previous': None,
                            'phase': 'steady', 'pending': None})
        return {'result': 'ROLLED_BACK', 'profile': 'B22-safe'}
    if action == 'reject-a21':
        try:
            control.switch(version(control, 'A21'))
        except v1.Blocked as exc:
            if 'migration set differs' not in str(exc):
                raise
            return {'result': 'REJECTED_A21_WITH_22'}
        raise AssertionError('A21 unexpectedly accepted against ledger 22')
    if action == 'deploy-fault':
        if not control.fault:
            raise v1.Blocked('Explicit lab fault required')
        case_id = control.env.get('GEOPS_LAB_CASE_ID', control.fault)
        if not re.fullmatch(r'[a-z0-9-]{1,45}', case_id):
            raise v1.Blocked('Invalid fixed laboratory case identifier')
        release_id = 'lab-mdm-release-' + case_id
        approval_id = 'lab-mdm-approval-' + case_id
        try:
            control.execute('deploy', release_id, approval_id)
        except v1.Blocked as exc:
            if control.fault == 'interrupt-after-api':
                raise
            if not (control.state_dir / 'used' / approval_id).exists():
                raise AssertionError('Fault did not reach container activation') from exc
            safe = control.state()
            if (safe['active']['profile'] != 'B22-safe' or
                    control.ledger()[0] != 'B22' or
                    control.current(safe['active'])['db']['health'] != 'healthy'):
                raise AssertionError('Unsafe state after injected fault')
            return {'result': 'FAULT_RECOVERED', 'fault': control.fault,
                    'failure': str(exc)}
        raise AssertionError('Faulted deployment unexpectedly succeeded')
    if action == 'recover':
        return control.execute('recover')
    if action == 'status':
        return control.execute('status')
    if action == 'deploy-success':
        case_id = control.env.get('GEOPS_LAB_CASE_ID', 'success')
        if not re.fullmatch(r'[a-z0-9-]{1,45}', case_id):
            raise v1.Blocked('Invalid fixed laboratory case identifier')
        return control.execute('deploy', 'lab-mdm-release-' + case_id,
                               'lab-mdm-approval-' + case_id)
    if action == 'rollback-success':
        case_id = control.env.get('GEOPS_LAB_CASE_ID', 'rollback')
        if not re.fullmatch(r'[a-z0-9-]{1,45}', case_id):
            raise v1.Blocked('Invalid fixed laboratory case identifier')
        return control.execute('rollback', approval_id='lab-mdm-approval-' + case_id)
    if action == 'rollback-fault':
        if not control.fault:
            raise v1.Blocked('Explicit lab fault required')
        case_id = control.env.get('GEOPS_LAB_CASE_ID', control.fault)
        if not re.fullmatch(r'[a-z0-9-]{1,45}', case_id):
            raise v1.Blocked('Invalid fixed laboratory case identifier')
        return control.execute('rollback', approval_id='lab-mdm-approval-' + case_id)
    if action == 'recover-safe':
        if control.fault or state['active']['profile'] != 'B22-safe':
            raise v1.Blocked('B22-safe recovery required')
        control.switch(state['active'])
        control.current(state['active'])
        return {'result': 'CONTROLLER_RESTART_RECOVERED'}
    if action == 'reject-bad-image':
        try:
            control.image_info(ref('B22-mdm', 'api'), COMMITS['B22-mdm'],
                               'B22-mdm', 'api', 'sha256:' + '0' * 64)
        except v1.Blocked:
            return {'result': 'REJECTED_IMAGE_ID_MISMATCH'}
        raise AssertionError('Wrong image ID unexpectedly accepted')
    raise ValueError('Unknown lab action')


if __name__ == '__main__':
    if len(sys.argv) != 2 or sys.argv[1] not in (
            'init', 'stop', 'switch-safe', 'switch-mdm', 'rollback-safe',
            'reject-a21', 'deploy-fault', 'recover', 'status',
            'deploy-success', 'rollback-success', 'rollback-fault', 'recover-safe',
            'reject-bad-image'):
        raise SystemExit('Fixed laboratory action required')
    print(json.dumps(main(sys.argv[1]), sort_keys=True))
