#!/usr/bin/env python3
"""Deterministic signed-ready B31 staging controller package."""
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
spec = importlib.util.spec_from_file_location('b31_candidate', HERE / 'candidate.py')
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)
MANIFEST = 'specs/spec-03-clients-geofences-routes/b31-staging-candidate.json'
CANDIDATE_SHA = '2cebd7f253f87efbc936d1ae08b429de0b5ddbd3a6d44d243d3520a99aae7061'
FILES = (
    'scripts/deploy/b31-staging/controller.py',
    'scripts/deploy/b31-staging/guard.py',
    'scripts/deploy/b31-staging/install.py',
    'scripts/deploy/b31-staging/package.py',
    'scripts/deploy/b31-staging/candidate.py',
    'scripts/deploy/b31-staging/sudoers-ready',
    'scripts/deploy/b30-staging/controller.py',
    'infrastructure/compose/compose.staging.yaml',
    'infrastructure/compose/compose.staging.digest.override.yaml',
    'infrastructure/compose/compose.staging.mdm-web-oauth.override.yaml',
    'infrastructure/compose/compose.staging.migrate.digest.override.yaml',
    'infrastructure/nginx/geops-staging-web.conf',
    'infrastructure/staging/api-entrypoint.sh',
    'infrastructure/staging/backup.sh',
    MANIFEST,
)
SOURCE_B30 = {
    'wrapperSha256': 'acc2d33361a27ba30f2639e0cb9c21f0b65bd0601d0cbef22300e439a21c9136',
    'policySha256': '9fa338195b9a121df31421771f706fbc4d779b2b197b64650d77ae87f81c9752',
    'packageSha256': 'e3cb0e42d3ab5018f9df2fe83a6decfdb5b771bb26f11936707fc2d3bedccea0',
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
        raise ValueError('Reviewed B31 candidate inventory differs')
    if 'RECOVERY_TARGET_SCHEMA = 31' not in (ROOT / 'apps/api/src/db/maintenance-recovery.ts').read_text():
        raise ValueError('B31 recovery source differs')


def build(output, public_path, api, web):
    check_source()
    refs = {'api': api, 'web': web}
    for kind, ref in refs.items():
        if not re.fullmatch(rf'ghcr\.io/kmena/geops-{kind}@sha256:[a-f0-9]{{64}}', ref):
            raise ValueError('Immutable B31 registry digest required')
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
            raise ValueError('Packaged staging configuration differs byte-for-byte from B30')
    if b'\r\n' in files['infrastructure/nginx/geops-staging-web.conf']:
        raise ValueError('Nginx CRLF is forbidden')
    if sha(files['infrastructure/nginx/geops-staging-web.conf']) != \
            '1915dcbdcb77673d7caa61fdaec5ffceb675135499c712afca71fe6c49e0a734':
        raise ValueError('Nginx differs from installed B30 LF source')
    files['public.pem'] = public
    policy = {
        'schemaVersion': 1,
        'kind': 'B31_STAGING_READY',
        'environment': 'geops-spec02-staging',
        'activation': 'READY',
        'publicationReady': True,
        'applicationCommit': candidate.APP_COMMIT,
        'candidateManifestSha256': CANDIDATE_SHA,
        'trustKeySha256': TRUST_SHA,
        'mdmRegion': 'com',
        'registryDigests': refs,
        'sourceB30': SOURCE_B30,
        'migrations': {'sourceCount': 30, 'sourceListSha256': candidate.B30,
                       'targetCount': 31, 'targetListSha256': candidate.B31},
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
    return {'result': 'B31_STAGING_BUNDLE_BUILT', 'packageSha256': sha(output.read_bytes()),
            'members': len(files), 'bytes': output.stat().st_size}


if __name__ == '__main__':
    if len(sys.argv) != 5:
        raise SystemExit('Usage: package.py OUTPUT.tar.gz APPROVED_PUBLIC.pem API_DIGEST WEB_DIGEST')
    print(json.dumps(build(Path(sys.argv[1]).resolve(), *sys.argv[2:]), sort_keys=True))