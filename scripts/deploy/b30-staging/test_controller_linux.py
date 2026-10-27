"""Isolated Linux simulation of the fixed staging Docker project and signed handoff."""

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = 'ghcr.io/kmena/geops-api@sha256:' + 'a' * 64
WEB = 'ghcr.io/kmena/geops-web@sha256:' + 'b' * 64
API_ID = 'sha256:' + '1' * 64
WEB_ID = 'sha256:' + '2' * 64
OLD_API_ID = 'sha256:' + '3' * 64
OLD_WEB_ID = 'sha256:' + '4' * 64
OLD_API = 'ghcr.io/kmena/geops-api@sha256:' + 'c' * 64
OLD_WEB = 'ghcr.io/kmena/geops-web@sha256:' + 'd' * 64


def sha(body):
    return hashlib.sha256(body).hexdigest()


def write(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(body)
    return path


def signed(folder, key, kind, value):
    body = (json.dumps(value, sort_keys=True) + '\n').encode()
    path = write(folder / f"{value['id']}.{kind}.json", body)
    subprocess.run(['openssl', 'pkeyutl', '-sign', '-inkey', str(key), '-rawin',
                    '-in', str(path), '-out', str(folder / f"{value['id']}.{kind}.sig")],
                   check=True, capture_output=True)
    return sha(body)


class FakeDocker:
    def __init__(self, control):
        self.control = control
        self.ledger = {'count': 23, 'sha256': control.B23}
        self.gate = 'open'
        self.images = {'api': OLD_API_ID, 'web': OLD_WEB_ID,
                       'db': 'sha256:' + '5' * 64}
        self.statuses = {'api': 'running', 'web': 'running', 'db': 'running'}
        self.health = {'api': 'healthy', 'web': 'healthy', 'db': 'healthy'}
        self.calls = []
        self.recovery_max_schema = '30'
        self.audit_ok = True
        self.migration_lines = []

    def result(self, value='', code=0):
        return subprocess.CompletedProcess([], code, value, '')

    def __call__(self, args, **kwargs):
        self.calls.append(args)
        if args[0] == '/usr/bin/openssl':
            return subprocess.run(args, **kwargs)
        if args[0].endswith('geops-deploy-v2'):
            return self.result('VERIFIED') if args[1:] == ['verify'] and \
                self.ledger['count'] == 23 and self.gate == 'open' else self.result(code=1)
        if args[:2] != ['/usr/bin/docker', 'compose'] and args[0] != '/usr/bin/docker':
            raise AssertionError(args)
        command = args[1:]
        if command[:2] == ['context', 'inspect']:
            return self.result('unix:///var/run/docker.sock')
        if command[:2] == ['inspect', '--format']:
            name = command[-1]
            short = next(key for key, value in self.control.SERVICES.items() if value == name)
            value = {'Id': 'c' * 64, 'Image': self.images[short],
                     'Config': {'Labels': {'com.docker.compose.project': self.control.PROJECT,
                                           'com.docker.compose.service': 'geops-' + short}},
                     'State': {'Status': self.statuses[short],
                               'Health': {'Status': self.health[short]}}}
            return self.result(json.dumps(value))
        if command[:2] == ['image', 'inspect']:
            ref = command[2]
            service = 'api' if ref == API else 'web'
            value = {'Id': API_ID if service == 'api' else WEB_ID,
                     'RepoDigests': [ref],
                     'Config': {'Labels': {
                         'org.opencontainers.image.revision': self.control.COMMIT,
                         'org.geops.' + service + '.variant': 'B30-integrated',
                         'org.geops.maintenance.recovery.max_schema': self.recovery_max_schema,
                         'org.geops.web.mdm_enabled': 'true'}}}
            return self.result(json.dumps(value))
        if command[:2] == ['run', '--rm']:
            return self.result(json.dumps({'count': 30, 'sha256': self.control.B30,
                                           'recovery30': True}))
        if command[0] == 'exec':
            if command[1] == self.control.SERVICES['db']:
                if 'SELECT epoch FROM security_epoch WHERE singleton=true' in command[-1]:
                    return self.result('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
                if 'maintenance.recovery.validated' in command[-1]:
                    return self.result('1' if self.audit_ok else '0')
                if 'FROM geops_maintenance_marker WHERE singleton=true' in command[-1]:
                    return self.result('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee|11111111-2222-3333-4444-555555555555|true')
                return self.result('\n'.join(self.migration_lines[:self.ledger['count']]))
            if command[1] == self.control.SERVICES['api'] and \
                    command[-1].startswith('/run/secrets/'):
                return self.result(sha(b'synthetic-secret'))
            return self.result()
        if 'config' in command and '--format' in command:
            env = kwargs['env']
            value = {'name': self.control.PROJECT, 'services': {
                'geops-db': {'image': 'postgis/postgis:18-3.6'},
                'geops-api': {'image': env['GEOPS_STAGE_API_IMAGE_REF'],
                              'environment': {'MDM_ENABLED': 'true',
                                              'GEOPS_MDM_REGION': env['GEOPS_MDM_REGION']},
                              'networks': {'stage_egress': {}},
                              'secrets': [{'source': name} for name in self.control.SECRETS]},
                'geops-web': {'image': env['GEOPS_STAGE_WEB_IMAGE_REF'],
                              'build': {'args': {'MDM_ENABLED': 'true'}}},
                'geops-migrate': {'image': env['GEOPS_STAGE_API_IMAGE_REF'],
                                  'secrets': [{'source': name}
                                              for name in self.control.SECRETS]},
            }}
            return self.result(json.dumps(value))
        if 'stop' in command:
            short = command[-1].removeprefix('geops-')
            self.statuses[short] = 'exited'
            self.health[short] = None
            return self.result()
        if 'run' in command and 'geops-gate-init' in command:
            self.gate = 'maintenance'
            write(self.control_path, json.dumps({'version': 1, 'phase': self.gate,
                                                 'epoch': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                                                 'nonce': '11111111-2222-3333-4444-555555555555'}).encode())
            return self.result()
        if 'run' in command and 'geops-migrate' in command:
            self.ledger = {'count': 30, 'sha256': self.control.B30}
            return self.result()
        if 'up' in command:
            short = command[-1].removeprefix('geops-')
            env = kwargs['env']
            ref = env['GEOPS_STAGE_API_IMAGE_REF' if short == 'api'
                      else 'GEOPS_STAGE_WEB_IMAGE_REF']
            self.images[short] = (API_ID if short == 'api' else WEB_ID) if ref in (API, WEB) \
                else (OLD_API_ID if short == 'api' else OLD_WEB_ID)
            self.statuses[short] = 'running'
            self.health[short] = 'healthy'
            return self.result()
        raise AssertionError(args)


def run(source, candidate):
    if os.geteuid() != 0 or sys.platform != 'linux':
        raise RuntimeError('Isolated Linux root required')
    spec = importlib.util.spec_from_file_location('b30_stage_controller', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with tempfile.TemporaryDirectory(prefix='b30-stage-controller-', dir='/opt') as folder:
        base = Path(folder)
        control = module.Controller(base, enforce_root=False)
        fake = FakeDocker(module)
        fake.control_path = control.gate_file
        control.runner = fake
        manifest_body = candidate.read_bytes()
        manifest = json.loads(manifest_body)
        fake.migration_lines = [item['version'] + '|' + item['sha256']
                                for item in manifest['database']['migrations']]
        for path in (control.bundle, control.v2 / 'bundle', control.state_dir / 'inbox',
                     control.backups, control.v2_state.parent, control.v2_wrapper.parent,
                     control.v2_rule.parent, control.gate_file.parent):
            path.mkdir(parents=True, exist_ok=True)
        key = base / 'synthetic-private.pem'
        pub = control.bundle / 'public.pem'
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(key)],
                       check=True, capture_output=True)
        subprocess.run(['openssl', 'pkey', '-in', str(key), '-pubout', '-out', str(pub)],
                       check=True, capture_output=True)
        old_wrapper = write(control.v2_wrapper, b'#!/bin/sh\nexit 0\n')
        write(control.v2_rule, module.V2_RULE)
        old_state = {'schemaVersion': 2, 'phase': 'steady', 'pending': None,
                     'active': {'profile': 'B23-mdm', 'apiRef': OLD_API,
                                'webRef': OLD_WEB, 'apiId': OLD_API_ID,
                                'webId': OLD_WEB_ID}}
        old_body = (json.dumps(old_state) + '\n').encode()
        write(control.v2_state, old_body)
        files = {}
        for name in module.FILES:
            body = (name + '\n').encode()
            files[name] = sha(body)
            write(control.v2 / 'bundle' / name, body)
            write(control.bundle / name, body)
        old_policy = {'schemaVersion': 2, 'environment': module.PROJECT,
                      'origin': 'https://geops-staging.duckdns.org',
                      'secretGid': '24001', 'imageTag': 'e' * 40,
                      'backupMaxAgeSeconds': 86400, 'mdm': {'region': 'com'},
                      'files': files}
        old_policy_body = (json.dumps(old_policy) + '\n').encode()
        write(control.v2 / 'policy.json', old_policy_body)
        for name in module.SECRETS:
            write(control.v2 / 'secrets' / name, b'synthetic-secret')
            write(control.v2 / 'runtime-secrets' / name, b'synthetic-secret')
        write(control.gate_file, json.dumps({
            'version': 1, 'phase': 'open',
            'epoch': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}).encode())
        backup = write(control.backups / 'geops-stage-synthetic.dump', b'synthetic-backup')
        write(Path(str(backup) + '.sha256'), (sha(backup.read_bytes()) + '\n').encode())
        policy = {'schemaVersion': 1, 'kind': 'B30_STAGING_READY',
                  'environment': module.PROJECT, 'activation': 'READY',
                  'publicationReady': True, 'applicationCommit': module.COMMIT,
                  'candidateManifestSha256':
                  '3685814d172901cab4435caee5cfa6cbf17259f738d6b904df6f3b143cd74c2b',
                  'migrations': {'sourceCount': 23, 'sourceListSha256': module.B23,
                                 'targetCount': 30, 'targetListSha256': module.B30},
                  'trustKeySha256': sha(pub.read_bytes()),
                  'registryDigests': {'api': API, 'web': WEB},
                  'sourceB23': {'wrapperSha256': sha(old_wrapper.read_bytes()),
                                'policySha256': sha(old_policy_body)},
                  'mdmRegion': 'com', 'files': {'public.pem': sha(pub.read_bytes())}}
        policy_body = (json.dumps(policy, sort_keys=True) + '\n').encode()
        write(control.bundle / 'policy.json', policy_body)
        write(control.bundle / 'policy.sha256', (sha(policy_body) + '\n').encode())
        write(control.bundle / 'specs/spec-03-clients-geofences-routes/b30-staging-candidate.json',
              manifest_body)
        control.policy = policy
        now = datetime.now(timezone.utc)
        window = {'notBefore': (now - timedelta(minutes=1)).isoformat().replace('+00:00', 'Z'),
                  'expiresAt': (now + timedelta(minutes=20)).isoformat().replace('+00:00', 'Z')}
        release = {'schemaVersion': 1, 'kind': 'release', 'id': 'b30release001234567',
                   'environment': module.PROJECT, **window, 'commit': module.COMMIT,
                   'api': API, 'web': WEB, 'sqlCount': 30, 'sqlListSha256': module.B30,
                   'policySha256': sha(policy_body)}
        release_sha = signed(control.state_dir / 'inbox', key, 'release', release)
        restore = {'schemaVersion': 1, 'kind': 'restore', 'id': 'b23restore001234567',
                   'environment': module.PROJECT, **window, 'backupSha256': sha(backup.read_bytes()),
                   'sqlCount': 23, 'sqlListSha256': module.B23, 'result': 'PASS',
                   'evidenceSha256': 'f' * 64, 'policySha256': sha(policy_body)}
        restore_sha = signed(control.state_dir / 'inbox', key, 'restore', restore)
        approval = {'schemaVersion': 1, 'kind': 'approval', 'id': 'b30approve001234567',
                    'environment': module.PROJECT, **window, 'action': 'promote-b23-b30',
                    'releaseSha256': release_sha, 'sourceStateSha256': sha(old_body),
                    'backupSha256': sha(backup.read_bytes()),
                    'restoreProofSha256': restore_sha,
                    'gateEpoch': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                    'policySha256': sha(policy_body)}
        signed(control.state_dir / 'inbox', key, 'approval', approval)
        checks = []
        assert control.ledger() == {'count': 23, 'sha256': module.B23}
        fake.ledger['count'] = 27
        assert control.ledger()['count'] == 27
        checks.append('partial-b30-prefix-accepted-for-resume')
        fake.migration_lines[26] = '0027_corrupt.sql|' + '0' * 64
        try:
            control.ledger()
        except module.Blocked:
            checks.append('partial-b30-prefix-tamper-rejected')
        else:
            raise AssertionError('Corrupt partial ledger accepted')
        fake.migration_lines = [item['version'] + '|' + item['sha256']
                                for item in manifest['database']['migrations']]
        fake.ledger['count'] = 23
        fake.recovery_max_schema = '23'
        try:
            control.execute('prepare', release['id'])
        except module.Blocked:
            checks.append('b30-image-with-recovery-23-rejected')
        else:
            raise AssertionError('B30 image without recovery schema 30 accepted')
        fake.recovery_max_schema = '30'
        assert control.execute('prepare', release['id'])['result'] == 'B30_STAGING_PREPARED'
        checks.append('signed-release-and-stage-compose')
        assert control.execute('begin', release['id'], approval['id'], restore['id'])['result'] == \
            'B30_STAGING_MAINTENANCE_READY'
        assert control.v2_rule.read_bytes() == module.V2_DISABLED
        checks.append('signed-approval-stops-b23-and-closes-gate')
        fake.ledger['count'] = 27
        assert control.execute('migrate')['result'] == 'B30_AWAITING_SUPERVISED_GATE_RECOVERY'
        checks.append('partial-b30-migration-resumed')
        checks.append('exact-b30-ledger-after-migrate')
        assert control.execute('recover', 'b30recovery00123456')['result'] == \
            'AWAITING_SUPERVISED_GATE_RECOVERY'
        assert fake.statuses['api'] == fake.statuses['web'] == 'exited'
        checks.append('no-start-before-supervised-gate-recovery')
        fake.gate = 'open'
        write(control.gate_file, json.dumps({
            'version': 1, 'phase': 'open',
            'epoch': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            'nonce': '11111111-2222-3333-4444-555555555555'}).encode())
        recovery = {'schemaVersion': 1, 'kind': 'recovery', 'id': 'b30recovery00123456',
                    'environment': module.PROJECT, **window, 'result': 'PASS',
                    'policySha256': sha(policy_body), 'approvalId': approval['id'],
                    'gateEpoch': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                    'gateNonce': '11111111-2222-3333-4444-555555555555',
                    'ledgerCount': 30, 'ledgerSha256': module.B30,
                    'auditRequestId': 'auditrequest001234567'}
        signed(control.state_dir / 'inbox', key, 'recovery', recovery)
        key.unlink()
        fake.audit_ok = False
        try:
            control.execute('recover', recovery['id'])
        except module.Blocked:
            checks.append('missing-recovery-audit-rejected')
        else:
            raise AssertionError('Gate reopened without audit accepted')
        fake.audit_ok = True
        assert control.execute('recover', recovery['id'])['result'] == 'B30_STAGING_PROMOTED'
        assert control.execute('verify')['result'] == 'B30_STAGING_VERIFIED'
        checks.append('forward-b30-after-gate-recovery')
        assert control.execute('recover', recovery['id'])['result'] == 'ALREADY_COMPLETE'
        checks.append('idempotent-recovery')
        assert control.v2_rule.read_bytes() == module.V2_DISABLED
        checks.append('legacy-v2-sudo-remains-disabled')
        interrupted = control.journal_data()
        interrupted['phase'] = 'draining'
        interrupted.pop('gateNonce')
        control.save(interrupted)
        fake.ledger = {'count': 23, 'sha256': module.B23}
        fake.images['api'], fake.images['web'] = OLD_API_ID, OLD_WEB_ID
        fake.statuses['api'] = fake.statuses['web'] = 'exited'
        fake.gate = 'open'
        write(control.gate_file, json.dumps({
            'version': 1, 'phase': 'open',
            'epoch': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}).encode())
        assert control.execute('recover', recovery['id'])['result'] == \
            'B23_STAGING_RESTORED_BEFORE_MAINTENANCE'
        assert control.v2_rule.read_bytes() == module.V2_RULE
        checks.append('pre-maintenance-b23-recovery')
        return {'result': 'B30_STAGING_CONTROLLER_ISOLATED_PASS',
                'checks': len(checks), 'cases': checks}


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: test_controller_linux.py CONTROLLER_SOURCE CANDIDATE')
    print(json.dumps(run(Path(sys.argv[1]), Path(sys.argv[2])), sort_keys=True))
