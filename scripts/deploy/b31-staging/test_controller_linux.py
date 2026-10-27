"""Isolated B30→B31 controller state-machine regression on Linux."""
import importlib.util
import json
import os
import tempfile
from pathlib import Path

SOURCE = Path(__file__).resolve().parent / 'controller.py'
spec = importlib.util.spec_from_file_location('b31_control', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
H = 'a' * 64
API = 'ghcr.io/kmena/geops-api@sha256:' + H
WEB = 'ghcr.io/kmena/geops-web@sha256:' + 'b' * 64
SOURCE_TARGET = {'apiRef': module.B30_API, 'webRef': module.B30_WEB,
                 'apiId': 'sha256:' + '1' * 64, 'webId': 'sha256:' + '2' * 64,
                 'commit': module.B30_COMMIT}
TARGET = {'apiRef': API, 'webRef': WEB, 'apiId': 'sha256:' + '3' * 64,
          'webId': 'sha256:' + '4' * 64, 'commit': module.APP_COMMIT}


class Fake(module.Controller):
    def __init__(self, root):
        super().__init__(root, enforce_root=False)
        self.state_dir.mkdir(parents=True)
        self.policy = {'registryDigests': {'api': API, 'web': WEB}}
        self.policy_bytes = b'synthetic-policy'
        self.gate_phase = 'open'
        self.gate_nonce = '66666666-7777-8888-9999-000000000000'
        self.fail_gate_start = False
        self.schema = 30
        self.statuses = {'api': 'running', 'web': 'running', 'db': 'running'}
        self.approved = False
        self.recovery_approved = False
        self.starts = []
        self.b30_journal.parent.mkdir(parents=True)
        self.b30_journal.write_text(json.dumps({
            'phase': 'complete',
            'gateEpoch': '11111111-2222-3333-4444-555555555555',
            'gateNonce': self.gate_nonce,
        }, sort_keys=True))
        self.b30_rule.parent.mkdir(parents=True)
        self.b30_rule.write_bytes(module.B30_RULE)

    def load_policy(self):
        return self.policy

    def context(self):
        return None

    def source(self):
        return SOURCE_TARGET.copy(), module.sha(self.b30_journal.read_bytes())

    def release(self, identity):
        if identity != 'releaseB3100000001':
            raise module.Blocked('Release missing')
        return {'api': API, 'web': WEB}, 'b' * 64

    def target(self, release):
        return TARGET.copy()

    def ledger(self):
        return {'count': self.schema, 'sha256': module.B30 if self.schema == 30 else module.B31}

    def gate(self):
        return {'phase': self.gate_phase, 'epoch': '11111111-2222-3333-4444-555555555555',
                'nonce': self.gate_nonce}

    def container(self, name):
        return {'status': self.statuses[name],
                'health': 'healthy' if self.statuses[name] == 'running' else None,
                'image': TARGET['apiId' if name == 'api' else 'webId']}

    def backup(self):
        return 'c' * 64

    def restore_proof(self, identity, backup_sha):
        return 'd' * 64

    def approval(self, *args):
        if not self.approved:
            raise module.Blocked('Operator approval missing')

    def stop(self, journal):
        self.statuses['api'] = self.statuses['web'] = 'exited'

    def compose(self, api, web, *, command=None, **kwargs):
        if command and 'maintenance-start' in command:
            if self.fail_gate_start:
                raise module.Blocked('Synthetic gate command failed')
            self.gate_phase = 'maintenance'
            self.gate_nonce = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        elif command and 'geops-migrate' in command:
            self.schema = 31
        return ''

    def recovery_proof(self, *args):
        if not self.recovery_approved:
            raise module.Blocked('Supervised recovery evidence missing')

    def start(self, journal, target):
        self.starts.append(target['commit'])
        self.statuses['api'] = self.statuses['web'] = 'running'

    def verify_secrets(self):
        return None


def run():
    if os.geteuid() != 0:
        raise RuntimeError('Linux root required')
    with tempfile.TemporaryDirectory(prefix='b31-control-', dir='/opt') as folder:
        control = Fake(Path(folder))
        assert control.execute('status')['ledger']['count'] == 30
        assert control.execute('prepare', 'releaseB3100000001')['result'] == 'B31_STAGING_PREPARED'
        try:
            control.execute('begin', 'releaseB3100000001', 'approvalB310000001', 'restoreB3100000001')
        except module.Blocked:
            pass
        else:
            raise AssertionError('Unsigned approval accepted')
        assert control.journal_data() is None and control.statuses['api'] == 'running'
        control.approved = True
        assert control.execute('begin', 'releaseB3100000001', 'approvalB310000001',
                               'restoreB3100000001')['result'] == 'B31_STAGING_MAINTENANCE_READY'
        assert control.statuses['api'] == control.statuses['web'] == 'exited'
        assert control.execute('migrate')['result'] == 'B31_AWAITING_SUPERVISED_GATE_RECOVERY'
        assert control.schema == 31 and not control.starts
        assert control.execute('recover', 'recoveryB310000001')['result'] == 'AWAITING_SUPERVISED_GATE_RECOVERY'
        control.gate_phase = 'open'
        try:
            control.execute('recover', 'recoveryB310000001')
        except module.Blocked:
            pass
        else:
            raise AssertionError('Unsigned recovery accepted')
        assert not control.starts
        control.recovery_approved = True
        assert control.execute('recover', 'recoveryB310000001')['result'] == 'B31_STAGING_PROMOTED'
        assert control.execute('verify')['result'] == 'B31_STAGING_VERIFIED'
        assert control.execute('recover', 'recoveryB310000001')['result'] == 'ALREADY_COMPLETE'
        assert control.starts == [module.APP_COMMIT]
    for stale_nonce in (False, True):
        with tempfile.TemporaryDirectory(prefix='b31-draining-', dir='/opt') as folder:
            control = Fake(Path(folder))
            control.approved = True
            control.fail_gate_start = True
            try:
                control.execute('begin', 'releaseB3100000001', 'approvalB310000001',
                                'restoreB3100000001')
            except module.Blocked:
                pass
            else:
                raise AssertionError('Synthetic gate failure was ignored')
            assert control.journal_data()['phase'] == 'draining'
            assert control.statuses['api'] == control.statuses['web'] == 'exited'
            if stale_nonce:
                journal = control.journal_data()
                journal['gateNonce'] = control.gate_nonce
                control.save(journal)
            control.gate_nonce = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
            try:
                control.execute('recover', 'recoveryB310000001')
            except module.Blocked:
                pass
            else:
                raise AssertionError('Mismatched B30 gate nonce was accepted')
            assert not control.starts and control.statuses['api'] == 'exited'
            control.gate_nonce = '66666666-7777-8888-9999-000000000000'
            assert control.execute('recover', 'recoveryB310000001')['result'] == (
                'B30_STAGING_RESTORED_BEFORE_MAINTENANCE')
            assert control.statuses['api'] == control.statuses['web'] == 'running'
            assert control.journal_data()['phase'] == 'aborted'
            assert control.b30_rule.read_bytes() == module.B30_RULE
            assert control.execute('recover', 'recoveryB310000001')['result'] == 'ALREADY_ABORTED'
    return {'result': 'B31_CONTROLLER_STATE_MACHINE_PASS', 'checks': 23}


if __name__ == '__main__':
    print(json.dumps(run(), sort_keys=True))
