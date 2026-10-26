#!/usr/bin/env python3
"""Build a deterministic, offline B30 laboratory controller package."""

import gzip
import hashlib
import io
import json
import subprocess
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
APP_COMMIT = '15f77a0d1904b77833972d8e2fd628a6cb97678f'
CANDIDATE_SHA = '02c83a5293db7a5e6452342c5b1649bcd85d3b9ac334647b5489564257200a5f'
B23 = '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d'
B30 = '64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6'
MANIFEST = 'specs/spec-03-clients-geofences-routes/release-candidate-manifest.json'
EVIDENCE = 'specs/spec-03-clients-geofences-routes/b30-lab-manifest-evidence.json'
FILES = (
    'scripts/deploy/b30-lab/controller.mjs',
    'scripts/deploy/b30-lab/seed-b23.mjs',
    'scripts/deploy/spec03-upgrade-supervisor.mjs',
    'infrastructure/compose/compose.b30-deployment-lab.yaml',
    MANIFEST,
    'scripts/deploy/b30-packaging/privileged.py',
    'scripts/deploy/b30-packaging/install.py',
    'scripts/deploy/b30-packaging/package.py',
    'scripts/deploy/b30-packaging/sign.mjs',
    'scripts/deploy/b30-packaging/verify-publication.mjs',
    'scripts/deploy/b30-packaging/verify-image-archive.py',
    'scripts/deploy/b30-packaging/sudoers',
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f'Regular, non-symlink source required: {path}')
    return path.read_bytes()


def package_names():
    seen = set()

    def visit(name):
        if name in seen:
            return
        if '/' in name or name.startswith('.'):
            raise ValueError(f'Unexpected Node package: {name}')
        seen.add(name)
        metadata = json.loads(regular(ROOT / 'node_modules' / name / 'package.json'))
        for dependency in sorted(set(metadata.get('dependencies', {})) |
                                 set(metadata.get('optionalDependencies', {}))):
            visit(dependency)

    visit('pg')
    return sorted(seen)


def source_inventory():
    result = {name: regular(ROOT / name) for name in FILES}
    for package in package_names():
        base = ROOT / 'node_modules' / package
        for path in sorted(base.rglob('*')):
            if path.is_symlink():
                raise ValueError(f'Symlink in Node runtime: {path}')
            if path.is_file():
                result[path.relative_to(ROOT).as_posix()] = regular(path)
    return result


def check_source():
    subprocess.run(['git', 'merge-base', '--is-ancestor', APP_COMMIT, 'HEAD'],
                   cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    changed = subprocess.check_output(
        ['git', 'diff', '--name-only', APP_COMMIT, 'HEAD', '--',
         'apps/api', 'apps/web', 'packages/api-contracts', 'infrastructure/docker'],
        cwd=ROOT, text=True).strip()
    dirty = subprocess.check_output(
        ['git', 'status', '--porcelain=v1', '--', 'apps/api', 'apps/web',
         'packages/api-contracts', 'infrastructure/docker'],
        cwd=ROOT, text=True).strip()
    if changed or dirty:
        raise ValueError('Application sources changed since reviewed B30 commit')
    candidate = regular(ROOT / MANIFEST)
    if sha(candidate) != CANDIDATE_SHA:
        raise ValueError('B30 candidate manifest differs')
    database = json.loads(candidate)['database']
    if (database['minimumSourceSchema'] != 23 or database['targetSchema'] != 30 or
            database['b23PrefixSha256'] != B23 or database['targetListSha256'] != B30 or
            len(database['migrations']) != 30):
        raise ValueError('B30 migration inventory differs')
    evidence = json.loads(regular(ROOT / EVIDENCE))
    if evidence['manifest']['sourceCommit'] != APP_COMMIT or \
            evidence['manifest']['candidateSha256'] != CANDIDATE_SHA:
        raise ValueError('Local image provenance differs')
    return evidence['manifest']['imageIds']


def build(output):
    images = check_source()
    files = source_inventory()
    policy = {
        'schemaVersion': 3,
        'kind': 'B30_PRIVILEGED_LAB_ONLY',
        'environment': 'synthetic-b30-local',
        'applicationCommit': APP_COMMIT,
        'candidateManifestSha256': CANDIDATE_SHA,
        'migrations': {'sourceCount': 23, 'sourceListSha256': B23,
                       'targetCount': 30, 'targetListSha256': B30},
        'localImageIds': images,
        'registryDigests': {'api': None, 'web': None},
        'publicationReady': False,
        'files': {name: sha(body) for name, body in sorted(files.items())},
    }
    files['policy.json'] = (json.dumps(policy, sort_keys=True, indent=2) + '\n').encode()
    if output.exists():
        raise FileExistsError(output)
    with output.open('xb') as raw:
        with gzip.GzipFile(fileobj=raw, filename='', mode='wb', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w') as archive:
                for name, body in sorted(files.items()):
                    item = tarfile.TarInfo(name)
                    item.uid = item.gid = item.mtime = 0
                    item.mode = 0o444
                    item.size = len(body)
                    archive.addfile(item, io.BytesIO(body))
    return {'result': 'B30_LAB_PACKAGE_DRAFT', 'packageSha256': sha(output.read_bytes()),
            'members': len(files), 'bytes': output.stat().st_size,
            'publicationReady': False}


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: package.py OUTPUT.tar.gz')
    print(json.dumps(build(Path(sys.argv[1]).resolve()), sort_keys=True))
