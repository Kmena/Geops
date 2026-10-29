#!/usr/bin/env python3
"""Deterministic signed-ready B32 staging controller package."""
import gzip
import hashlib
import importlib.util
import io
import json
import re
import subprocess
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
spec = importlib.util.spec_from_file_location('b32_candidate', HERE / 'candidate.py')
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)
MANIFEST = 'specs/spec-03-clients-geofences-routes/b32-staging-candidate.json'
CANDIDATE_SHA = 'c1011f3235d9efd25fdee1336f3a882babd0cbb640d05e3494b27ccc3b176e3f'
FILES = (
    'scripts/deploy/b32-staging/controller.py',
    'scripts/deploy/b32-staging/guard.py',
    'scripts/deploy/b32-staging/install.py',
    'scripts/deploy/b32-staging/package.py',
    'scripts/deploy/b32-staging/sign-package.mjs',
    'scripts/deploy/b32-staging/candidate.py',
    'scripts/deploy/b32-staging/sudoers-ready',
    'scripts/deploy/b30-staging/controller.py',
    'scripts/deploy/b32-staging/maintenance-recovery.ts',
    'scripts/deploy/b32-staging/api-b32-recovery.Dockerfile',
    'scripts/deploy/b32-staging/backup-restore-staging.sh',
    'infrastructure/compose/compose.staging.yaml',
    'infrastructure/compose/compose.staging.digest.override.yaml',
    'infrastructure/compose/compose.staging.mdm-web-oauth.override.yaml',
    'infrastructure/compose/compose.staging.migrate.digest.override.yaml',
    'infrastructure/nginx/geops-staging-web.conf',
    'infrastructure/staging/api-entrypoint.sh',
    'infrastructure/staging/backup.sh',
    MANIFEST,
)
SOURCE_B31 = {
    'wrapperSha256': '8dabed2dee1e82e994295e71952ee3f6f2cf140fd6d16e0063977153c7a4297c',
    'policySha256': '89b5de6f15cc547244982fb1af250fa6dc9fff3a12ce1b0b2298de64401dc3eb',
}
TRUST_SHA = 'd01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27'


def sha(body):
    return hashlib.sha256(body).hexdigest()


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('Regular package source required')
    return path.read_bytes()


def check_source():
    expected = (json.dumps(candidate.manifest(), sort_keys=True, indent=2) + '\n').encode()
    if regular(ROOT / MANIFEST) != expected or sha(expected) != CANDIDATE_SHA:
        raise ValueError('Reviewed B32 candidate inventory differs')
    if 'RECOVERY_TARGET_SCHEMA = 33' not in (ROOT / 'scripts/deploy/b32-staging/maintenance-recovery.ts').read_text():
        raise ValueError('B32 recovery source differs')
    if 'RECOVERY_TARGET_SCHEMA = 31' not in (ROOT / 'apps/api/src/db/maintenance-recovery.ts').read_text():
        raise ValueError('Ordinary API recovery ceiling differs')


def build(output, public_path, api, web, recovery, promotion_commit):
    check_source()
    refs = {'api': api, 'web': web, 'recovery': recovery}
    for kind, ref in refs.items():
        repository = 'web' if kind == 'web' else 'api'
        if not re.fullmatch(rf'ghcr\.io/kmena/geops-{repository}@sha256:[a-f0-9]{{64}}', ref):
            raise ValueError('Immutable B32 registry digest required')
    if not re.fullmatch(r'[a-f0-9]{40}', promotion_commit):
        raise ValueError('B32 promotion commit required')
    public = regular(Path(public_path))
    if sha(public) != TRUST_SHA or not public.startswith(b'-----BEGIN PUBLIC KEY-----'):
        raise ValueError('Approved staging Ed25519 public key differs')
    files = {name: regular(ROOT / name) for name in FILES}
    installed_source = {
        'infrastructure/compose/compose.staging.yaml': '165865879bd3037c03ca4b033f3ea1a9ad283d45ae4c43439e7163adcf6248f4',
        'infrastructure/compose/compose.staging.digest.override.yaml': 'd7dd571c46c46a8f20751611d747914bd4da1f2bf8cac34c02504fdffbd6f702',
        'infrastructure/compose/compose.staging.mdm-web-oauth.override.yaml': '72afabdd52b25675d69c46117dda6117c0a79cfafc412686249a52196d00c800',
        'infrastructure/compose/compose.staging.migrate.digest.override.yaml': '8bcf71faab918436f2bb42fce83ee1fa586ed1663c60c52a5e9c815cf7cc2c19',
        'infrastructure/nginx/geops-staging-web.conf': '1915dcbdcb77673d7caa61fdaec5ffceb675135499c712afca71fe6c49e0a734',
        'infrastructure/staging/api-entrypoint.sh': '7d6d46206cf9ee635d4da0623119c9f666bccbe5e214fed1ca617d0d7ae123a7',
        'infrastructure/staging/backup.sh': 'b6784af0ac4c6180e65b981a963b33ea79d2f4902ace966c2c23e99b02f6ef6f',
    }
    for name, digest in installed_source.items():
        if sha(files[name]) != digest:
            raise ValueError('Packaged staging configuration differs byte-for-byte from B31')
    if b'\r\n' in files['infrastructure/nginx/geops-staging-web.conf']:
        raise ValueError('Nginx CRLF is forbidden')
    if sha(files['infrastructure/nginx/geops-staging-web.conf']) != \
            '1915dcbdcb77673d7caa61fdaec5ffceb675135499c712afca71fe6c49e0a734':
        raise ValueError('Nginx differs from installed B31 LF source')
    files['public.pem'] = public
    policy = {
        'schemaVersion': 1,
        'kind': 'B32_STAGING_READY',
        'environment': 'geops-spec02-staging',
        'activation': 'READY',
        'publicationReady': True,
        'applicationCommit': candidate.APP_COMMIT,
        'promotionCommit': promotion_commit,
        'candidateManifestSha256': CANDIDATE_SHA,
        'trustKeySha256': TRUST_SHA,
        'mdmRegion': 'com',
        'registryDigests': refs,
        'sourceB31': SOURCE_B31,
        'migrations': {'sourceCount': 31, 'sourceListSha256': candidate.B31,
                       'targetCount': 33, 'targetListSha256': candidate.B32},
        'files': {name: sha(body) for name, body in sorted(files.items())},
    }
    files['policy.json'] = (json.dumps(policy, sort_keys=True, indent=2) + '\n').encode()
    with output.open('xb') as raw:
        with gzip.GzipFile(fileobj=raw, filename='', mode='wb', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w') as archive:
                for name, body in sorted(files.items()):
                    item = tarfile.TarInfo(name)
                    item.uid = item.gid = item.mtime = 0
                    item.mode = 0o444
                    item.size = len(body)
                    archive.addfile(item, io.BytesIO(body))
    return {'result': 'B32_STAGING_BUNDLE_BUILT', 'packageSha256': sha(output.read_bytes()),
            'members': len(files), 'bytes': output.stat().st_size}


if __name__ == '__main__':
    if len(sys.argv) != 7:
        raise SystemExit('Usage: package.py OUTPUT.tar.gz APPROVED_PUBLIC.pem API_DIGEST WEB_DIGEST RECOVERY_DIGEST PROMOTION_COMMIT')
    print(json.dumps(build(Path(sys.argv[1]).resolve(), *sys.argv[2:]), sort_keys=True))
