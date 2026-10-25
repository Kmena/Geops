"""No Docker, network, PostgreSQL or temporary directory is used in these tests."""

import copy
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
import unittest
from unittest.mock import patch

import geops_deploy as v1
import geops_deploy_v2 as v2


COMMIT = 'a' * 40
A_COMMIT = '0' * 40
A_API = 'geops-spec02-api:' + A_COMMIT
A_WEB = 'geops-spec02-web:' + A_COMMIT
SAFE_API = 'ghcr.io/kmena/geops-api@sha256:' + '1' * 64
SAFE_WEB = 'ghcr.io/kmena/geops-web@sha256:' + '2' * 64
MDM_API = 'ghcr.io/kmena/geops-api@sha256:' + '3' * 64
MDM_WEB = 'ghcr.io/kmena/geops-web@sha256:' + '4' * 64
BACKUP = '5' * 64
RESTORE = '6' * 64
EPOCH = '00000000-0000-0000-0000-000000000001'


def version(profile):
    api, web = {'A21': (A_API, A_WEB), 'B22-safe': (SAFE_API, SAFE_WEB),
                'B22-mdm': (MDM_API, MDM_WEB)}[profile]
    return {'commit': A_COMMIT if profile == 'A21' else COMMIT,
            'apiRef': api, 'webRef': web,
            'apiId': api.split('@')[-1] if '@' in api else 'sha256:' + '7' * 64,
            'webId': web.split('@')[-1] if '@' in web else 'sha256:' + '8' * 64,
            'releaseSha256': None if profile == 'A21' else '9' * 64,
            'profile': profile}


class FakeController(v2.ControllerV2):
    def __init__(self, active='B22-safe'):
        self.root = Path('synthetic-root')
        self.state_dir = Path('synthetic-state')
        self.policy_bytes = b'synthetic-policy'
        self.policy = {'secretGid': '24001', 'imageTag': A_COMMIT,
                       'origin': 'https://geops-staging.duckdns.org',
                       'mdm': {'region': 'com'}}
        self.env = {}
        self.docker = 'docker'
        self.saved = {'schemaVersion': 2, 'active': version(active),
                      'previous': None, 'phase': 'steady', 'pending': None}
        self.ledger_profile = 'A21' if active == 'A21' else 'B22'
        self.gate_phase = 'open'
        self.images = {'api': self.saved['active']['apiId'],
                       'web': self.saved['active']['webId'], 'db': 'sha256:' + 'd' * 64}
        self.statuses = {'api': 'running', 'web': 'running', 'db': 'running'}
        self.health = {'api': 'healthy', 'web': 'healthy', 'db': 'healthy'}
        self.commands = []
        self.approvals = []
        self.consumed = []
        self.fail_stop_once = False
        self.fail_mdm_web = False
        self.fail_safe_web_once = False

    def load_policy(self):
        return self.policy

    def local_endpoint(self):
        return None

    def state(self):
        return copy.deepcopy(self.saved)

    def save_state(self, value):
        self.saved = copy.deepcopy(value)

    def container(self, service):
        return {'id': service + '-container', 'image': self.images[service],
                'status': self.statuses[service], 'health': self.health[service]}

    def ledger(self):
        key = 'A21' if self.ledger_profile == 'A21' else 'B22-safe'
        return self.ledger_profile, {'sqlCount': v2.PROFILES[key]['sqlCount'],
                                     'sqlListSha256': v2.PROFILES[key]['sqlListSha256']}

    def gate(self, expected_phase=None):
        if expected_phase and self.gate_phase != expected_phase:
            raise v1.Blocked('Gate phase mismatch')
        return {'phase': self.gate_phase, 'epoch': EPOCH}

    def backup(self):
        return {'sha256': BACKUP, 'bytes': 100}

    def verify_secrets(self, profile, mounted=False):
        return None

    def check_compose(self, profile, api, web):
        return {'api': api, 'web': web, 'mdmEnabled': str(v2.PROFILES[profile]['mdmEnabled']).lower(),
                'webVariant': v2.PROFILES[profile]['variant']}

    def image_info(self, ref, commit, profile, service, expected_id=None):
        image_id = ref.split('@')[-1] if '@' in ref else version('A21')[service + 'Id']
        if expected_id and image_id != expected_id:
            raise v1.Blocked('Image ID mismatch')
        return {'id': image_id, 'reference': ref, 'repoDigests': [ref],
                'revision': commit, 'profile': profile}

    def embedded_sql(self, ref, profile):
        return {'count': v2.PROFILES[profile]['sqlCount'],
                'sha256': v2.PROFILES[profile]['sqlListSha256']}

    def compose_args(self, profile, migration=False):
        return ['docker', 'compose']

    def call(self, args, timeout=30, env=None):
        self.commands.append(args)
        if 'stop' in args:
            service = ('web' if args[-1] in ('geops-web', 'web-container')
                       else 'api')
            if service == 'api' and self.fail_stop_once:
                self.fail_stop_once = False
                raise v1.Blocked('Synthetic interruption')
            self.statuses[service], self.health[service] = 'exited', None
        elif 'up' in args:
            service = 'api' if args[-1] == 'geops-api' else 'web'
            ref = env['GEOPS_STAGE_API_IMAGE_REF' if service == 'api' else
                      'GEOPS_STAGE_WEB_IMAGE_REF']
            self.images[service] = ref.split('@')[-1] if '@' in ref else version('A21')[service + 'Id']
            self.statuses[service] = 'running'
            fail_safe = service == 'web' and ref == SAFE_WEB and self.fail_safe_web_once
            if fail_safe:
                self.fail_safe_web_once = False
            self.health[service] = ('unhealthy' if fail_safe or
                                    (service == 'web' and self.fail_mdm_web and ref == MDM_WEB)
                                    else 'healthy')
        return ''

    def release(self, identity):
        profile = 'B22-safe' if identity == 'safe_release_0001' else 'B22-mdm'
        target = version(profile)
        return {'profile': profile, 'commit': target['commit'],
                'api': target['apiRef'], 'web': target['webRef']}, target['releaseSha256']

    def version_from_release(self, release, sha):
        target = version(release['profile'])
        self.check_compose(target['profile'], target['apiRef'], target['webRef'])
        return target

    def restore_proof(self, identity, backup_sha):
        if identity != 'restore_pass_0001' or backup_sha != BACKUP:
            raise v1.Blocked('Restore proof mismatch')
        return RESTORE

    def approval(self, identity, action, release_sha, source, target,
                 backup_sha=None, restore_sha=None, epoch=None):
        self.approvals.append((identity, action, source['profile'], target['profile']))
        if identity in self.consumed:
            raise v1.Blocked('Approval replay')

    def consume(self, identity):
        self.consumed.append(identity)

    def audit(self, *args):
        return None

    def smoke(self):
        return None


class V2TransitionTests(unittest.TestCase):
    def test_sql_guard_blocks_a21_before_any_compose_up(self):
        controller = FakeController('A21')
        controller.ledger_profile = 'B22'
        with self.assertRaisesRegex(v1.Blocked, 'differs from live database'):
            controller.switch(version('A21'))
        self.assertFalse(controller.commands)

    def test_sql_guard_rechecks_before_each_service_start(self):
        controller = FakeController()
        original = controller.ledger
        calls = 0

        def changing_ledger():
            nonlocal calls
            calls += 1
            if calls == 3:
                controller.ledger_profile = 'A21'
            return original()

        controller.ledger = changing_ledger
        with self.assertRaisesRegex(v1.Blocked, 'Database schema changed'):
            controller.switch(version('B22-mdm'))
        self.assertEqual(sum('up' in item for item in controller.commands), 1)

    def test_mdm_mounts_must_match_protected_secret_copies(self):
        controller = FakeController()
        controller.enforce_root = False
        expected = v1.digest(b'synthetic-secret')
        with patch.object(v1, 'regular_bytes', return_value=b'synthetic-secret'):
            with self.assertRaisesRegex(v1.Blocked, 'Mounted GEOPS secret'):
                v2.ControllerV2.verify_secrets(controller, 'B22-mdm', mounted=True)
            calls = []

            def mounted_hash(args, timeout=30, env=None):
                calls.append(args)
                return expected

            controller.call = mounted_hash
            v2.ControllerV2.verify_secrets(controller, 'B22-mdm', mounted=True)
        self.assertEqual(len(calls), len(v1.SECRET_NAMES))
        self.assertTrue(all(item[2] == v1.SERVICES['api'] for item in calls))

    def test_safe_to_mdm_and_return_to_safe(self):
        controller = FakeController()
        result = controller.execute('deploy', 'mdm_release_0001', 'deploy_approval_001')
        self.assertEqual(result['profile'], 'B22-mdm')
        self.assertEqual(controller.saved['previous']['profile'], 'B22-safe')
        result = controller.execute('rollback', approval_id='return_approval_01')
        self.assertEqual(result['profile'], 'B22-safe')
        self.assertIsNone(controller.saved['previous'])
        self.assertEqual(controller.ledger_profile, 'B22')

    def test_failed_mdm_switch_recovers_only_to_safe(self):
        controller = FakeController()
        controller.fail_mdm_web = True
        with self.assertRaisesRegex(v1.Blocked, 'source application recovered'):
            controller.execute('deploy', 'mdm_release_0001', 'deploy_approval_001')
        self.assertEqual(controller.images['api'], version('B22-safe')['apiId'])
        self.assertEqual(controller.saved['active']['profile'], 'B22-safe')
        self.assertFalse(any(item['profile'] == 'A21' for item in
                             (controller.saved['active'],)))

    def test_abrupt_api_interruption_journals_and_recovers_idempotently(self):
        controller = FakeController()
        original = controller.transition_op

        def interrupt(state, operation, status):
            original(state, operation, status)
            if operation == 'apiStart' and status == 'verified':
                raise KeyboardInterrupt('synthetic process loss')

        controller.transition_op = interrupt
        with self.assertRaises(KeyboardInterrupt):
            controller.execute('deploy', 'mdm_release_0001', 'deploy_approval_001')
        self.assertEqual(controller.saved['phase'], 'switching')
        self.assertEqual(controller.saved['pending']['operations']['webStop'], 'verified')
        self.assertEqual(controller.statuses['web'], 'exited')
        self.assertEqual(controller.images['api'], version('B22-mdm')['apiId'])
        controller.transition_op = original
        self.assertEqual(controller.execute('recover')['result'], 'RECOVERED_SAFE')
        self.assertEqual(controller.execute('recover')['result'], 'ALREADY_STEADY')
        self.assertEqual(controller.images['api'], version('B22-safe')['apiId'])
        self.assertEqual(controller.images['web'], version('B22-safe')['webId'])

    def test_restart_closes_web_even_when_target_images_both_started(self):
        controller = FakeController()
        original = controller.transition_op

        def interrupt(state, operation, status):
            original(state, operation, status)
            if operation == 'webStart' and status == 'verified':
                raise KeyboardInterrupt('synthetic process loss')

        controller.transition_op = interrupt
        with self.assertRaises(KeyboardInterrupt):
            controller.execute('deploy', 'mdm_release_0001', 'deploy_approval_001')
        self.assertEqual(controller.statuses['web'], 'running')
        controller.transition_op = original
        result = controller.execute('status')
        self.assertFalse(result['imageMatch'])
        self.assertTrue(result['webTrafficClosed'])
        self.assertEqual(controller.execute('recover')['result'], 'RECOVERED_SAFE')

    def test_interrupted_rollback_recovers_accredited_b22_safe(self):
        controller = FakeController()
        controller.execute('deploy', 'mdm_release_0001', 'deploy_approval_001')
        original = controller.transition_op

        def interrupt(state, operation, status):
            original(state, operation, status)
            if operation == 'apiStart' and status == 'verified':
                raise KeyboardInterrupt('synthetic rollback loss')

        controller.transition_op = interrupt
        with self.assertRaises(KeyboardInterrupt):
            controller.execute('rollback', approval_id='return_approval_01')
        self.assertEqual(controller.saved['phase'], 'switching')
        self.assertEqual(controller.saved['pending']['action'], 'rollback')
        self.assertEqual(controller.statuses['web'], 'exited')
        controller.transition_op = original
        self.assertEqual(controller.execute('recover')['result'], 'RECOVERED_SAFE')
        self.assertEqual(controller.saved['active']['profile'], 'B22-safe')
        self.assertIsNone(controller.saved['previous'])

    def test_policy_change_blocks_recovery_with_web_closed(self):
        controller = FakeController()
        original = controller.transition_op

        def interrupt(state, operation, status):
            original(state, operation, status)
            if operation == 'apiStart' and status == 'verified':
                raise KeyboardInterrupt('synthetic process loss')

        controller.transition_op = interrupt
        with self.assertRaises(KeyboardInterrupt):
            controller.execute('deploy', 'mdm_release_0001', 'deploy_approval_001')
        controller.policy_bytes = b'changed-policy'
        controller.transition_op = original
        with self.assertRaisesRegex(v1.Blocked, 'policy changed'):
            controller.execute('recover')
        self.assertEqual(controller.statuses['web'], 'exited')
        self.assertEqual(controller.saved['phase'], 'switching')

    def test_unknown_image_blocks_recovery_and_keeps_web_closed(self):
        controller = FakeController()
        original = controller.transition_op

        def interrupt(state, operation, status):
            original(state, operation, status)
            if operation == 'apiStart' and status == 'verified':
                raise KeyboardInterrupt('synthetic process loss')

        controller.transition_op = interrupt
        with self.assertRaises(KeyboardInterrupt):
            controller.execute('deploy', 'mdm_release_0001', 'deploy_approval_001')
        controller.transition_op = original
        controller.images['api'] = 'sha256:' + 'e' * 64
        with self.assertRaisesRegex(v1.Blocked, 'Unknown application image'):
            controller.execute('recover')
        self.assertEqual(controller.statuses['web'], 'exited')
        self.assertEqual(controller.saved['phase'], 'switching')

    def test_pending_evidence_shows_observed_image_and_closed_gate(self):
        controller = FakeController()
        controller.policy['files'] = {name: 'f' * 64 for name in v2.BUNDLE_FILES}
        original = controller.transition_op

        def interrupt(state, operation, status):
            original(state, operation, status)
            if operation == 'apiStart' and status == 'verified':
                raise KeyboardInterrupt('synthetic process loss')

        controller.transition_op = interrupt
        with self.assertRaises(KeyboardInterrupt):
            controller.execute('deploy', 'mdm_release_0001', 'deploy_approval_001')
        controller.transition_op = original
        report = controller.execute('inspect-evidence')
        self.assertEqual(report['phase'], 'switching')
        self.assertFalse(report['imageMatch'])
        self.assertEqual(report['api']['observedId'], version('B22-mdm')['apiId'])
        self.assertEqual(report['web']['status'], 'exited')
        self.assertEqual(report['transition']['targetProfile'], 'B22-mdm')

    def test_promotion_requires_supervised_recovery_then_safe(self):
        controller = FakeController('A21')
        result = controller.execute('promote22-begin', 'safe_release_0001',
                                    'begin_approval_0001', 'restore_pass_0001')
        self.assertEqual(result['result'], 'AWAITING_SUPERVISED_RECOVERY')
        self.assertEqual(controller.saved['phase'], 'stopped')
        self.assertEqual(controller.ledger_profile, 'A21')
        with self.assertRaisesRegex(v1.Blocked, 'unsuitable'):
            controller.execute('promote22-complete', approval_id='complete_approval_01')
        controller.gate_phase = 'maintenance'
        controller.ledger_profile = 'B22'
        with self.assertRaisesRegex(v1.Blocked, 'Gate phase mismatch'):
            controller.execute('promote22-complete', approval_id='complete_approval_01')
        controller.gate_phase = 'open'
        result = controller.execute('promote22-complete', approval_id='complete_approval_01')
        self.assertEqual(result['profile'], 'B22-safe')
        self.assertIsNone(controller.saved['previous'])

    def test_failed_safe_activation_stops_partials_and_retries_at_22(self):
        controller = FakeController('A21')
        controller.execute('promote22-begin', 'safe_release_0001',
                           'begin_approval_0001', 'restore_pass_0001')
        controller.ledger_profile = 'B22'
        controller.fail_safe_web_once = True
        with self.assertRaisesRegex(v1.Blocked, 'stopped for supervised retry'):
            controller.execute('promote22-complete', approval_id='complete_approval_01')
        self.assertEqual(controller.saved['phase'], 'stopped')
        self.assertEqual(controller.statuses['api'], 'exited')
        self.assertEqual(controller.statuses['web'], 'exited')
        self.assertEqual(controller.ledger_profile, 'B22')
        result = controller.execute('promote22-complete', approval_id='complete_approval_02')
        self.assertEqual(result['profile'], 'B22-safe')
        self.assertEqual(controller.saved['phase'], 'steady')

    def test_resume_stops_partial_b22_after_interrupted_start(self):
        controller = FakeController('A21')
        controller.execute('promote22-begin', 'safe_release_0001',
                           'begin_approval_0001', 'restore_pass_0001')
        controller.ledger_profile = 'B22'
        controller.statuses['api'] = 'running'
        controller.health['api'] = 'healthy'
        controller.images['api'] = version('B22-safe')['apiId']
        result = controller.execute('promote22-resume', approval_id='resume_approval_001')
        self.assertEqual(result['ledgerProfile'], 'B22')
        self.assertEqual(controller.statuses['api'], 'exited')
        self.assertEqual(controller.statuses['web'], 'exited')
        self.assertFalse(any('up' in command for command in controller.commands))

    def test_promotion_pending_restart_closes_web_before_reporting(self):
        controller = FakeController('A21')
        controller.execute('promote22-begin', 'safe_release_0001',
                           'begin_approval_0001', 'restore_pass_0001')
        controller.ledger_profile = 'B22'
        controller.images['api'] = version('B22-safe')['apiId']
        controller.images['web'] = version('B22-safe')['webId']
        controller.statuses['api'] = controller.statuses['web'] = 'running'
        controller.health['api'] = controller.health['web'] = 'healthy'
        result = controller.execute('status')
        self.assertEqual(result['phase'], 'stopped')
        self.assertTrue(result['webTrafficClosed'])

    def test_interrupted_stop_is_resumable_and_never_starts_a21_at_22(self):
        controller = FakeController('A21')
        controller.fail_stop_once = True
        with self.assertRaisesRegex(v1.Blocked, 'Synthetic interruption'):
            controller.execute('promote22-begin', 'safe_release_0001',
                               'begin_approval_0001', 'restore_pass_0001')
        self.assertEqual(controller.saved['phase'], 'stopping')
        controller.execute('promote22-resume', approval_id='resume_approval_001')
        self.assertEqual(controller.saved['phase'], 'stopped')
        controller.ledger_profile = 'B22'
        with self.assertRaisesRegex(v1.Blocked, 'unsuitable'):
            controller.execute('promote22-abort21', approval_id='abort_approval_001')
        self.assertFalse(any('up' in command for command in controller.commands))

    def test_abort_before_migration_returns_a21(self):
        controller = FakeController('A21')
        controller.execute('promote22-begin', 'safe_release_0001',
                           'begin_approval_0001', 'restore_pass_0001')
        result = controller.execute('promote22-abort21', approval_id='abort_approval_001')
        self.assertEqual(result['profile'], 'A21')
        self.assertEqual(controller.saved['phase'], 'steady')

    def test_evidence_excludes_credentials(self):
        controller = FakeController()
        controller.policy_bytes = b'synthetic-private-policy'
        controller.policy['files'] = {name: 'f' * 64 for name in v2.BUNDLE_FILES}
        report = controller.execute('inspect-evidence')
        body = json.dumps(report)
        self.assertEqual(report['ledgerProfile'], 'B22')
        self.assertNotIn('customerId', body)
        self.assertNotIn('mdm_client_secret', body)
        self.assertNotIn('synthetic-private-policy', body)

    def test_policy_rejects_changed_sql_profile_and_bundle(self):
        policy = {'schemaVersion': 2, 'environment': v1.ENVIRONMENT,
                  'origin': 'https://geops-staging.duckdns.org', 'secretGid': '24001',
                  'imageTag': A_COMMIT, 'backupMaxAgeSeconds': 86400,
                  'profiles': copy.deepcopy(v2.PROFILES),
                  'mdm': {'region': 'com'},
                  'files': {name: v1.digest(b'bundle') for name in v2.BUNDLE_FILES},
                  'controllers': {name: v1.digest(b'bundle') for name in
                                  ('geops_deploy.py', 'geops_deploy_v2.py')}}
        controller = v2.ControllerV2(root=Path('synthetic-root'),
                                     state_dir=Path('synthetic-state'),
                                     enforce_root=False)
        def contents(path, *args, **kwargs):
            return json.dumps(policy).encode() if path == controller.root / 'policy.json' else b'bundle'
        with patch.object(v1, 'regular_bytes', side_effect=contents):
            self.assertEqual(controller.load_policy()['schemaVersion'], 2)
            policy['profiles']['B22-safe']['sqlCount'] = 21
            with self.assertRaisesRegex(v1.Blocked, 'Invalid v2 policy'):
                controller.load_policy()
            policy['profiles'] = copy.deepcopy(v2.PROFILES)
            policy['files'][v2.MDM_OVERLAY] = '0' * 64
            with self.assertRaisesRegex(v1.Blocked, 'bundle checksum'):
                controller.load_policy()

    def test_mdm_tenant_identity_is_discovered_by_oauth_not_policy(self):
        controller = FakeController('A21')
        controller.policy['mdm'] = {'region': 'com'}
        for profile in ('A21', 'B22-safe'):
            env = controller.profile_env(profile, 'api', 'web')
            self.assertNotIn('GEOPS_MDM_EDITION', env)
            self.assertNotIn('GEOPS_MDM_CUSTOMER_ID', env)
        mdm_env = controller.profile_env('B22-mdm', MDM_API, MDM_WEB)
        self.assertEqual(mdm_env['GEOPS_MDM_REGION'], 'com')
        self.assertNotIn('GEOPS_MDM_EDITION', mdm_env)
        self.assertNotIn('GEOPS_MDM_CUSTOMER_ID', mdm_env)

        policy = {'schemaVersion': 2, 'environment': v1.ENVIRONMENT,
                  'origin': 'https://geops-staging.duckdns.org', 'secretGid': '24001',
                  'imageTag': A_COMMIT, 'backupMaxAgeSeconds': 86400,
                  'profiles': copy.deepcopy(v2.PROFILES), 'mdm': controller.policy['mdm'],
                  'files': {name: v1.digest(b'bundle') for name in v2.BUNDLE_FILES},
                  'controllers': {name: v1.digest(b'bundle') for name in
                                  ('geops_deploy.py', 'geops_deploy_v2.py')}}
        checked = v2.ControllerV2(root=Path('synthetic-root'),
                                  state_dir=Path('synthetic-state'), enforce_root=False)
        def contents(path, *args, **kwargs):
            return json.dumps(policy).encode() if path == checked.root / 'policy.json' else b'bundle'
        with patch.object(v1, 'regular_bytes', side_effect=contents):
            self.assertEqual(checked.load_policy()['mdm'], controller.policy['mdm'])
            policy['mdm']['customerId'] = '12345'
            with self.assertRaisesRegex(v1.Blocked, 'Unexpected document fields'):
                checked.load_policy()

    def test_approval_binds_profiles_digests_and_backup_proof(self):
        controller = FakeController('A21')
        source, target = version('A21'), version('B22-safe')
        document = {
            'schemaVersion': 2, 'id': 'approval_promote22_0001',
            'environment': v1.ENVIRONMENT, 'notBefore': '2026-10-23T00:00:00Z',
            'expiresAt': '2026-10-23T00:20:00Z', 'action': 'promote22-begin',
            'releaseSha256': target['releaseSha256'], 'releaseCommit': target['commit'],
            'apiDigest': target['apiRef'], 'webDigest': target['webRef'],
            'policySha256': v1.digest(controller.policy_bytes),
            'sourceApiId': source['apiId'], 'sourceWebId': source['webId'],
            'targetApiId': target['apiId'], 'targetWebId': target['webId'],
            'sourceProfile': 'A21', 'targetProfile': 'B22-safe',
            'backupSha256': BACKUP, 'restoreSha256': RESTORE, 'epoch': EPOCH,
        }
        controller.signed = lambda _kind, _id: (document, 'e' * 64)
        v2.ControllerV2.approval(controller, document['id'], 'promote22-begin',
                                 target['releaseSha256'], source, target,
                                 BACKUP, RESTORE, EPOCH)
        document['targetProfile'] = 'A21'
        with self.assertRaisesRegex(v1.Blocked, 'exact v2 transition'):
            v2.ControllerV2.approval(controller, document['id'], 'promote22-begin',
                                     target['releaseSha256'], source, target,
                                     BACKUP, RESTORE, EPOCH)

    def test_restore_attestation_requires_recent_signed_evidence(self):
        controller = FakeController('A21')
        now = datetime.now(timezone.utc)
        document = {
            'schemaVersion': 2, 'id': 'restore_proof_0001',
            'environment': v1.ENVIRONMENT,
            'notBefore': (now - timedelta(minutes=1)).isoformat().replace('+00:00', 'Z'),
            'expiresAt': (now + timedelta(minutes=19)).isoformat().replace('+00:00', 'Z'),
            'backupSha256': BACKUP, 'sqlCount': 21, 'sqlListSha256': v2.A21_HASH,
            'restoredAt': now.isoformat().replace('+00:00', 'Z'),
            'result': 'PASS', 'evidenceSha256': 'f' * 64,
            'policySha256': v1.digest(controller.policy_bytes),
        }
        controller.signed = lambda _kind, _id: (document, RESTORE)
        self.assertEqual(v2.ControllerV2.restore_proof(controller, document['id'], BACKUP), RESTORE)
        document['backupSha256'] = '0' * 64
        with self.assertRaisesRegex(v1.Blocked, 'restore attestation'):
            v2.ControllerV2.restore_proof(controller, document['id'], BACKUP)

    def test_api_and_web_labels_are_checked(self):
        controller = FakeController()
        image = {'Id': version('B22-mdm')['apiId'], 'RepoDigests': [MDM_API],
                 'Config': {'Labels': {'org.opencontainers.image.revision': COMMIT,
                                       'org.geops.api.variant': 'B22-safe'}}}
        controller.docker_json = lambda *args, **kwargs: image
        with self.assertRaisesRegex(v1.Blocked, 'API profile label mismatch'):
            v2.ControllerV2.image_info(controller, MDM_API, COMMIT, 'B22-mdm', 'api')
        image['Config']['Labels']['org.geops.api.variant'] = 'B22-mdm'
        self.assertEqual(v2.ControllerV2.image_info(controller, MDM_API, COMMIT,
                                                     'B22-mdm', 'api')['id'],
                         version('B22-mdm')['apiId'])
        image['Id'] = version('B22-mdm')['webId']
        image['RepoDigests'] = [MDM_WEB]
        image['Config']['Labels']['org.geops.web.variant'] = 'gps-base'
        image['Config']['Labels']['org.geops.web.mdm_enabled'] = 'false'
        with self.assertRaisesRegex(v1.Blocked, 'Web variant label mismatch'):
            v2.ControllerV2.image_info(controller, MDM_WEB, COMMIT, 'B22-mdm', 'web')


if __name__ == '__main__':
    unittest.main()
