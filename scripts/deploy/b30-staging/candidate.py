#!/usr/bin/env python3
"""Reproducible, application-scoped B30 staging candidate inventory."""

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
APP_COMMIT = '2f89b87f1f636feb7e21d7e09af03959ee95f68d'
B23 = '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d'
B30 = '64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6'
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
        raise ValueError('Application source changed since reviewed commit')
    names = subprocess.check_output(
        ['git', 'ls-tree', '-r', '--name-only', APP_COMMIT, '--', *PATHS],
        cwd=ROOT, text=True).splitlines()
    files = []
    for name in names:
        committed = subprocess.check_output(['git', 'show', APP_COMMIT + ':' + name],
                                            cwd=ROOT)
        files.append({'path': name, 'sha256': sha(committed)})
    return files


def manifest():
    files = committed_inventory()
    migrations = [entry for entry in files if re.fullmatch(
        r'apps/api/src/db/migrations/\d{4}_[a-z0-9_]+\.sql', entry['path'])]
    if len(migrations) != 30:
        raise ValueError('Exactly 30 migrations required')
    entries = [(Path(item['path']).name, item['sha256']) for item in migrations]
    if [int(name[:4]) for name, _ in entries] != list(range(1, 31)):
        raise ValueError('Migration sequence differs')
    list_hash = lambda rows: sha('\n'.join(name + '|' + digest for name, digest in rows).encode())
    if list_hash(entries[:23]) != B23 or list_hash(entries) != B30:
        raise ValueError('Reviewed B23/B30 migration checksums differ')
    return {
        'schemaVersion': 1,
        'kind': 'SPEC03_B30_STAGING_CANDIDATE_DRAFT',
        'applicationCommit': APP_COMMIT,
        'sourceSha256': sha('\n'.join(item['path'] + '|' + item['sha256']
                                     for item in files).encode()),
        'files': files,
        'database': {'sourceSchema': 23, 'targetSchema': 30,
                     'sourceListSha256': B23, 'targetListSha256': B30,
                     'migrations': [{'version': name, 'sha256': digest}
                                    for name, digest in entries]},
        'compatibility': {
            'legacyControllerMaxSchema': 23,
            'supervisedRecoveryMaxSchema': 30,
            'gateReopen': 'SIGNED_SUPERVISED_RECOVERY_ONLY',
            'databaseDowngrade': 'FORBIDDEN',
        },
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
        raise ValueError('Staging candidate manifest differs from reviewed application commit')
    print(json.dumps({'result': 'B30_STAGING_CANDIDATE_' + sys.argv[1].upper(),
                      'sha256': sha(body), 'files': len(manifest()['files'])}))
