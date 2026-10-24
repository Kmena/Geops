#!/usr/bin/env python3
"""Fixed, isolated Docker interruption matrix for the v2 profile journal."""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from controller_adapter import LAB, PROJECT, LabController, v1, v2, version


def run(action, fault='', case_id=''):
    env = os.environ.copy()
    env['GEOPS_LAB_FAULT'] = fault
    env['GEOPS_LAB_CASE_ID'] = case_id
    result = subprocess.run(
        [sys.executable, str(Path(__file__).with_name('controller_adapter.py')), action],
        env=env, capture_output=True, text=True, timeout=180, check=False)
    return result


def success(action, fault='', case_id=''):
    result = run(action, fault, case_id)
    if result.returncode:
        raise AssertionError(f'{action} failed with exit {result.returncode}: '
                             f'{result.stderr[-500:]}')
    return json.loads(result.stdout)


def snapshot():
    control = LabController()
    control.load_policy()
    state = control.state()
    ledger_profile, ledger = control.ledger()
    live = {name: control.container(name) for name in ('api', 'web', 'db')}
    gate = control.gate('open')
    return {'phase': state['phase'], 'active': state['active']['profile'],
            'pending': state['pending']['operations'] if state['pending'] and
                       'operations' in state['pending'] else None,
            'ledgerProfile': ledger_profile, 'ledger': ledger,
            'policySha256': v1.digest(control.policy_bytes),
            'gatePhase': gate['phase'], 'gateEpoch': gate['epoch'],
            'apiId': live['api']['image'], 'apiHealth': live['api']['health'],
            'webId': live['web']['image'], 'webHealth': live['web']['health'],
            'webStatus': live['web']['status'], 'dbId': live['db']['id'],
            'dbHealth': live['db']['health']}


def assert_safe(row):
    control = LabController()
    control.load_policy()
    safe = version(control, 'B22-safe')
    assert row['phase'] == 'steady' and row['active'] == 'B22-safe'
    assert row['ledgerProfile'] == 'B22'
    assert row['ledger'] == {'sqlCount': 22, 'sqlListSha256': v2.B22_HASH}
    assert row['gatePhase'] == 'open'
    assert row['apiId'] == safe['apiId'] and row['webId'] == safe['webId']
    assert row['apiHealth'] == row['webHealth'] == row['dbHealth'] == 'healthy'


def interrupted_deploy(fault, case_id, rows):
    result = run('deploy-fault', fault, case_id)
    if result.returncode == 0 or 'KeyboardInterrupt' not in result.stderr:
        raise AssertionError(f'{fault} did not abruptly interrupt')
    raw = snapshot()
    assert raw['phase'] == 'switching' and raw['pending'] is not None
    assert raw['ledgerProfile'] == 'B22' and raw['gatePhase'] == 'open'
    # When profiles differ, the only external Web ingress must be stopped.
    control = LabController()
    control.load_policy()
    safe = version(control, 'B22-safe')
    if raw['apiId'] != safe['apiId'] and raw['webId'] == safe['webId']:
        assert raw['webStatus'] == 'exited'
    status = success('status')
    closed = snapshot()
    assert status['phase'] == 'switching' and not status['imageMatch']
    assert closed['webStatus'] == 'exited'
    rows.append({'case': fault, 'interrupted': raw, 'afterRestart': closed,
                 'interruptExit': result.returncode})


def verified_recover(rows, case):
    answer = success('recover')
    if answer != {'result': 'RECOVERED_SAFE', 'profile': 'B22-safe'}:
        raise AssertionError('Recovery did not actually execute')
    after = snapshot()
    assert_safe(after)
    again = success('recover')
    assert again == {'result': 'ALREADY_STEADY', 'profile': 'B22-safe'}
    rows[-1]['recovered'] = after
    rows[-1]['repeat'] = again['result']


def main():
    if PROJECT != 'geopsv2labrecovery20261023' or LAB.name != 'geops-v2lab-recovery-20261023':
        raise SystemExit('Fixed recovery laboratory required')
    run_id = os.environ.get('GEOPS_LAB_RUN_ID', 'matrix3')
    if not run_id or not run_id.isalnum() or len(run_id) > 16:
        raise SystemExit('Fixed alphanumeric laboratory run ID required')
    rows = []
    assert_safe(snapshot())
    for fault in ('before-api', 'after-api', 'before-web',
                  'after-web', 'before-commit'):
        interrupted_deploy(fault, run_id + '-' + fault, rows)
        verified_recover(rows, fault)
        print(f'{fault}: recovered and verified', flush=True)
    for fault in ('during-recovery', 'before-recovery-web'):
        interrupted_deploy('after-api', run_id + '-' + fault + '-seed', rows)
        interrupted = run('recover', fault)
        if interrupted.returncode == 0 or 'KeyboardInterrupt' not in interrupted.stderr:
            raise AssertionError(f'{fault} did not interrupt recovery')
        recovering = snapshot()
        assert recovering['phase'] == 'recovering' and recovering['webStatus'] == 'exited'
        rows[-1]['case'] = fault
        rows[-1]['duringRecovery'] = recovering
        verified_recover(rows, fault)
        print(f'{fault}: recovered and verified', flush=True)
    rejected = success('reject-a21')
    assert rejected['result'] == 'REJECTED_A21_WITH_22'
    deployed = success('deploy-success', case_id=run_id + '-success')
    assert deployed == {'result': 'DEPLOYED', 'profile': 'B22-mdm'}
    mdm = snapshot()
    assert mdm['phase'] == 'steady' and mdm['active'] == 'B22-mdm'
    assert mdm['ledgerProfile'] == 'B22' and mdm['apiHealth'] == mdm['webHealth'] == 'healthy'
    rollback_fault = run('rollback-fault', 'after-api', run_id + '-rollback-fault')
    if rollback_fault.returncode == 0 or 'KeyboardInterrupt' not in rollback_fault.stderr:
        raise AssertionError('Interrupted rollback did not reach API activation')
    rollback_pending = snapshot()
    assert rollback_pending['phase'] == 'switching' and rollback_pending['active'] == 'B22-mdm'
    assert rollback_pending['webStatus'] == 'exited'
    success('status')
    rollback_recovery = success('recover')
    assert rollback_recovery == {'result': 'RECOVERED_SAFE', 'profile': 'B22-safe'}
    after_rollback_recovery = snapshot()
    assert_safe(after_rollback_recovery)
    success('deploy-success', case_id=run_id + '-success-again')
    returned = success('rollback-success', case_id=run_id + '-rollback')
    assert returned == {'result': 'ROLLED_BACK', 'profile': 'B22-safe'}
    final = snapshot()
    assert_safe(final)
    evidence = {'project': PROJECT, 'cases': rows, 'a21At22': rejected,
                'deploy': deployed, 'mdm': mdm, 'rollback': returned,
                'interruptedRollback': rollback_pending,
                'rollbackRecovery': after_rollback_recovery,
                'final': final}
    destination = LAB / f'recovery-matrix-evidence-{run_id}.json'
    if destination.exists():
        raise AssertionError('Run evidence already exists; refusing overwrite')
    destination.write_text(json.dumps(evidence, indent=2, sort_keys=True) + '\n',
                           encoding='utf-8')
    print(json.dumps({'result': 'LAB_MATRIX_PASS', 'cases': len(rows),
                      'evidenceSha256': hashlib.sha256(destination.read_bytes()).hexdigest()},
                     sort_keys=True))


if __name__ == '__main__':
    main()
