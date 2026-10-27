"""Validate the signed v3-to-v4 controller-only repair in an isolated Linux root."""
import importlib.util
import json
import tarfile
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
spec = importlib.util.spec_from_file_location('b31_repair', HERE / 'repair-v5.py')
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)


def contents(name):
    with tarfile.open(ROOT / 'artifacts/b31-staging' / name, 'r:gz') as archive:
        return {member.name: archive.extractfile(member).read() for member in archive}


def run():
    old = contents('controller-b31-staging-recovery-v4.tar.gz')
    new = contents('controller-b31-staging-recovery-v5.tar.gz')
    old_policy = json.loads(old['policy.json'])
    new_policy = json.loads(new['policy.json'])
    before = {name: body for name, body in old.items() if name != 'policy.json'}
    repair.validate_delta(old_policy, new_policy, before, new)
    assert [name for name in old if old[name] != new[name]] == [
        'policy.json', repair.CONTROLLER]
    with tempfile.TemporaryDirectory(prefix='b31-repair-', dir='/opt') as folder:
        target = Path(folder) / 'bundle'
        repair.create_bundle(new, target)
        for name, body in new.items():
            assert (target / name).read_bytes() == body
        assert (target / 'policy.sha256').read_text().strip() == repair.NEW_POLICY
    altered = dict(new)
    altered['infrastructure/staging/backup.sh'] += b'\n'
    try:
        repair.validate_delta(old_policy, new_policy, before, altered)
    except RuntimeError:
        pass
    else:
        raise AssertionError('Non-controller change accepted')
    altered_policy = dict(new_policy, registryDigests={'api': 'changed'})
    try:
        repair.validate_delta(old_policy, altered_policy, before, new)
    except RuntimeError:
        pass
    else:
        raise AssertionError('Compatibility policy change accepted')
    print(json.dumps({'result': 'B31_NONCE_REPAIR_ISOLATED_PASS',
                      'controllerOnly': True, 'bundleMembers': len(new),
                      'tamperRejected': True}, sort_keys=True))


if __name__ == '__main__':
    run()
