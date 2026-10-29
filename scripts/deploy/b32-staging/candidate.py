#!/usr/bin/env python3
"""Reproducible application inventory for B31→B32 staging."""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
APP_COMMIT = '06b6599779bbf95a45576d9bda581119ddce27de'
B31 = '17cf75b6e88193552efb799ab33b94d44d3a17bc19c0eb15e6c9f0a77d7e9ea0'
B32 = 'd4730ee35c02af8976f1b7a642c305ea0304448742f9d54a5ff829336752074a'
PATHS = ('apps/api', 'apps/web', 'packages/api-contracts', 'infrastructure/docker',
         'infrastructure/nginx/geops-web.conf', 'package.json', 'package-lock.json',
         'tsconfig.base.json', '.dockerignore')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def committed_inventory():
    dirty = subprocess.check_output(['git', 'status', '--porcelain=v1', '--', *PATHS],
                                    cwd=ROOT, text=True).strip()
    changed = subprocess.check_output(['git', 'diff', '--name-only', APP_COMMIT, 'HEAD',
                                       '--', *PATHS], cwd=ROOT, text=True).strip()
    if dirty or changed:
        raise ValueError('Application source changed since reviewed target commit')
    names = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', APP_COMMIT, '--', *PATHS],
                                    cwd=ROOT, text=True).splitlines()
    return [{'path': name,
             'sha256': sha(subprocess.check_output(['git', 'show', APP_COMMIT + ':' + name],
                                                   cwd=ROOT))} for name in names]


def manifest():
    files = committed_inventory()
    migrations = [entry for entry in files if re.fullmatch(
        r'apps/api/src/db/migrations/\d{4}_[a-z0-9_]+\.sql', entry['path'])]
    entries = [(Path(item['path']).name, item['sha256']) for item in migrations]
    if len(entries) != 33 or [int(name[:4]) for name, _ in entries] != list(range(1, 34)):
        raise ValueError('Exactly 33 sequential migrations required')
    digest = lambda rows: sha('\n'.join(name + '|' + value for name, value in rows).encode())
    if digest(entries[:31]) != B31 or digest(entries) != B32:
        raise ValueError('Reviewed B31/B32 migration checksums differ')
    return {
        'schemaVersion': 1,
        'kind': 'B32_STAGING_CANDIDATE_DRAFT',
        'applicationCommit': APP_COMMIT,
        'sourceSha256': sha('\n'.join(item['path'] + '|' + item['sha256']
                                     for item in files).encode()),
        'files': files,
        'database': {'sourceSchema': 31, 'targetSchema': 33,
                     'sourceListSha256': B31, 'targetListSha256': B32,
                     'migrations': [{'version': name, 'sha256': value}
                                    for name, value in entries]},
        'compatibility': {'sourceControllerMaxSchema': 31,
                          'supervisedRecoveryMaxSchema': 33,
                          'gateReopen': 'SIGNED_SUPERVISED_RECOVERY_ONLY',
                          'databaseDowngrade': 'FORBIDDEN'},
        'publication': {'apiDigest': None, 'webDigest': None,
                        'stagingSignature': None, 'status': 'PENDING'},
    }


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ('create', 'verify'):
        raise SystemExit('Usage: candidate.py create|verify OUTPUT.json')
    target = Path(sys.argv[2]).resolve()
    body = (json.dumps(manifest(), sort_keys=True, indent=2) + '\n').encode()
    if sys.argv[1] == 'create':
        with target.open('xb') as file:
            file.write(body)
    elif target.read_bytes() != body:
        raise ValueError('Staging candidate manifest differs from reviewed B31 commit')
    print(json.dumps({'result': 'B32_STAGING_CANDIDATE_' + sys.argv[1].upper(),
                      'sha256': sha(body), 'files': len(manifest()['files'])}))
