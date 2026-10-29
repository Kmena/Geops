"""Isolated B31→B32 controller state machine checks on Linux."""
import importlib.util
import json
import tempfile
from pathlib import Path

source = Path(__file__).resolve().parent / 'controller.py'
spec = importlib.util.spec_from_file_location('b32_control_test', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

api = 'ghcr.io/kmena/geops-api@sha256:' + 'a' * 64
web = 'ghcr.io/kmena/geops-web@sha256:' + 'b' * 64
recovery = 'ghcr.io/kmena/geops-api@sha256:' + 'c' * 64
source_target = {'apiRef': module.B31_API, 'webRef': module.B31_WEB,
                 'apiId': 'sha256:' + '1' * 64, 'webId': 'sha256:' + '2' * 64,
                 'commit': module.B31_COMMIT}
target = {'apiRef': api, 'webRef': web, 'recoveryRef': recovery,
          'apiId': 'sha256:' + '3' * 64, 'webId': 'sha256:' + '4' * 64,
          'recoveryId': 'sha256:' + '5' * 64, 'commit': module.APP_COMMIT}


class Fake(module.Controller):
    def __init__(self, root):
        super().__init__(root, enforce_root=False)
        self.state_dir.mkdir(parents=True)
        self.policy = {'registryDigests': {'api': api, 'web': web, 'recovery': recovery}}
        self.policy_bytes = b'synthetic-policy'
        self.phase = 'open'
        self.nonce = '66666666-7777-8888-9999-000000000000'
        self.fail_gate_start = False
        self.schema = 31
        self.statuses = {'api': 'running', 'web': 'running', 'db': 'running'}
        self.approved = False
        self.recovery_approved = False
        self.starts = []
        self.b31_journal.parent.mkdir(parents=True)
        self.b31_journal.write_text(json.dumps({
            'phase': 'complete', 'gateEpoch': '11111111-2222-3333-4444-555555555555',
            'gateNonce': self.nonce}, sort_keys=True))
        self.b31_rule.parent.mkdir(parents=True)
        self.b31_rule.write_bytes(module.B31_RULE)

    def load_policy(self):
        return self.policy

    def context(self):
        return None

    def source(self):
        return source_target.copy(), module.sha(self.b31_journal.read_bytes())

    def release(self, identity):
        if identity != 'releaseB3200000001':
            raise module.Blocked('Release missing')
        return {'api': api, 'web': web, 'recovery': recovery}, 'b' * 64

    def target(self, release):
        return target.copy()

    def ledger(self):
        hashes = {31: module.B31,
                  32: '15b89174e04195825ff4ff61f4844c2a5c8fd6535dab4e0d09760187632c62aa',
                  33: module.B32}
        return {'count': self.schema, 'sha256': hashes[self.schema]}

    def gate(self):
        return {'phase': self.phase, 'epoch': '11111111-2222-3333-4444-555555555555',
                'nonce': self.nonce}

    def container(self, name):
        return {'status': self.statuses[name],
                'health': 'healthy' if self.statuses[name] == 'running' else None,
                'image': target['apiId' if name == 'api' else 'webId']}

    def backup(self):
        return 'c' * 64

    def restore_proof(self, identity, backup_sha):
        return 'd' * 64

    def approval(self, *args):
        if not self.approved:
            raise module.Blocked('Operator approval missing')

    def compose(self, api_ref, web_ref, *, command=None, **kwargs):
        if command and 'maintenance-start' in command:
            if self.fail_gate_start:
                raise module.Blocked('Synthetic gate command failed')
            self.phase = 'maintenance'
            self.nonce = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        elif command and 'geops-migrate' in command:
            self.schema = 33
        elif command and command[0] == 'stop':
            self.statuses[command[1].removeprefix('geops-')] = 'exited'
        return ''

    def recovery_proof(self, *args):
        if not self.recovery_approved:
            raise module.Blocked('Supervised recovery evidence missing')

    def start(self, journal, selected):
        self.starts.append(selected['commit'])
        self.statuses['api'] = self.statuses['web'] = 'running'

    def verify_secrets(self):
        return None


def blocked(action):
    try:
        action()
    except module.Blocked:
        return
    raise AssertionError('Unsafe controller action was accepted')


def run():
    with tempfile.TemporaryDirectory(prefix='b32-control-', dir='/opt') as directory:
        control = Fake(Path(directory))
        assert control.execute('status')['ledger']['count'] == 31
        assert control.execute('prepare', 'releaseB3200000001')['result'] == 'B32_STAGING_PREPARED'
        blocked(lambda: control.execute('begin', 'releaseB3200000001',
                                        'approvalB320000001', 'restoreB3200000001'))
        assert control.journal_data() is None and control.statuses['api'] == 'running'
        control.approved = True
        assert control.execute('begin', 'releaseB3200000001', 'approvalB320000001',
                               'restoreB3200000001')['result'] == 'B32_STAGING_MAINTENANCE_READY'
        assert control.b31_rule.read_bytes() == module.B31_DISABLED
        assert control.statuses['api'] == control.statuses['web'] == 'exited'
        control.schema = 32
        assert control.execute('migrate')['result'] == 'B32_AWAITING_SUPERVISED_GATE_RECOVERY'
        assert control.schema == 33 and not control.starts
        assert control.execute('recover', 'recoveryB320000001')['result'] == 'AWAITING_SUPERVISED_GATE_RECOVERY'
        control.phase = 'open'
        blocked(lambda: control.execute('recover', 'recoveryB320000001'))
        assert not control.starts
        control.recovery_approved = True
        assert control.execute('recover', 'recoveryB320000001')['result'] == 'B32_STAGING_PROMOTED'
        assert control.execute('verify')['result'] == 'B32_STAGING_VERIFIED'
        assert control.execute('recover', 'recoveryB320000001')['result'] == 'ALREADY_COMPLETE'
        assert control.starts == [module.APP_COMMIT]
    with tempfile.TemporaryDirectory(prefix='b32-draining-', dir='/opt') as directory:
        control = Fake(Path(directory))
        control.approved = True
        control.fail_gate_start = True
        blocked(lambda: control.execute('begin', 'releaseB3200000001',
                                        'approvalB320000001', 'restoreB3200000001'))
        assert control.journal_data()['phase'] == 'draining'
        assert control.b31_rule.read_bytes() == module.B31_DISABLED
        control.nonce = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
        blocked(lambda: control.execute('recover', 'recoveryB320000001'))
        assert control.statuses['api'] == 'exited'
        control.nonce = '66666666-7777-8888-9999-000000000000'
        assert control.execute('recover', 'recoveryB320000001')['result'] == \
            'B31_STAGING_RESTORED_BEFORE_MAINTENANCE'
        assert control.b31_rule.read_bytes() == module.B31_RULE
        assert control.execute('recover', 'recoveryB320000001')['result'] == 'ALREADY_ABORTED'
    return {'result': 'B32_CONTROLLER_STATE_MACHINE_PASS', 'checks': 25}


if __name__ == '__main__':
    print(json.dumps(run(), sort_keys=True))
