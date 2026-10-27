#!/usr/bin/env python3
"""Deterministic B30 staging controller package; signing remains external."""

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
SOURCE = HERE / 'candidate.py'
spec = importlib.util.spec_from_file_location('b30_stage_candidate', SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

EXTRA = (
    'scripts/deploy/b30-staging/guard.py',
    'scripts/deploy/b30-staging/controller.py',
    'scripts/deploy/b30-staging/install.py',
    'scripts/deploy/b30-staging/package.py',
    'scripts/deploy/b30-staging/candidate.py',
    'scripts/deploy/b30-staging/verify-trust-key.mjs',
    'scripts/deploy/b30-staging/sudoers',
    'scripts/deploy/b30-staging/sudoers-ready',
    'scripts/deploy/remote/geops_deploy_v2.py',
    'scripts/deploy/remote/geops_deploy.py',
    'scripts/deploy/remote/install-v2.py',
    'scripts/deploy/remote/geops-deploy-v2.sudoers',
    'infrastructure/compose/compose.staging.yaml',
    'infrastructure/compose/compose.staging.digest.override.yaml',
    'infrastructure/compose/compose.staging.migrate.digest.override.yaml',
    'infrastructure/compose/compose.staging.mdm-web-oauth.override.yaml',
    'infrastructure/nginx/geops-staging-web.conf',
    'infrastructure/staging/api-entrypoint.sh',
    'infrastructure/staging/backup.sh',
    'specs/spec-03-clients-geofences-routes/b30-staging-candidate.json',
)
MANIFEST = EXTRA[-1]
APP_COMMIT = module.APP_COMMIT
CANDIDATE_SHA = '3685814d172901cab4435caee5cfa6cbf17259f738d6b904df6f3b143cd74c2b'
B23, B30 = module.B23, module.B30


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('Regular source file required')
    return path.read_bytes()


def check_source():
    expected = (json.dumps(module.manifest(), sort_keys=True, indent=2) + '\n').encode()
    if regular(ROOT / MANIFEST) != expected or sha(expected) != CANDIDATE_SHA:
        raise ValueError('Reviewed staging candidate manifest differs')
    if 'RECOVERY_TARGET_SCHEMA = 30' not in (ROOT / 'apps/api/src/db/maintenance-recovery.ts').read_text():
        raise ValueError('B30 supervised recovery source differs')
    return {'api': None, 'web': None}


def sha(body):
    return hashlib.sha256(body).hexdigest()


def ready_fields(public_key, approved_key_sha, api, web, wrapper_sha, policy_sha, region):
    check_source()
    digest = re.compile(r'^ghcr\.io/kmena/geops-(api|web)@sha256:[a-f0-9]{64}$')
    if (not digest.fullmatch(api) or not api.startswith('ghcr.io/kmena/geops-api@') or
            not digest.fullmatch(web) or not web.startswith('ghcr.io/kmena/geops-web@') or
            not all(re.fullmatch(r'[a-f0-9]{64}', value)
                    for value in (wrapper_sha, policy_sha)) or
            region not in ('com', 'eu', 'in', 'com.au', 'jp', 'ca', 'cn', 'sa', 'uk')):
        raise ValueError('Reviewed B30 registry refs, source hashes and region required')
    key = regular(Path(public_key))
    if not key.startswith(b'-----BEGIN PUBLIC KEY-----'):
        raise ValueError('Ed25519 public key required')
    subprocess.run(['node', str(HERE / 'verify-trust-key.mjs'), public_key,
                    approved_key_sha], check=True, stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL, timeout=10)
    return key, {'kind': 'B30_STAGING_READY', 'activation': 'READY',
                 'publicationReady': True, 'trustKeySha256': sha(key),
                 'registryDigests': {'api': api, 'web': web},
                 'sourceB23': {'wrapperSha256': wrapper_sha,
                               'policySha256': policy_sha},
                 'mdmRegion': region}


def build(output, ready=None):
    images = check_source()
    files = {name: regular(ROOT / name) for name in EXTRA}
    settings = None
    if ready is not None:
        key, settings = ready_fields(*ready)
        files['public.pem'] = key
    policy = {
        'schemaVersion': 1,
        'kind': 'B30_STAGING_PREPARED',
        'environment': 'geops-spec02-staging',
        'activation': 'DISABLED',
        'trustKey': 'PENDING_OPERATOR_VERIFICATION',
        'bundleSignature': 'PENDING',
        'publicationReady': False,
        'applicationCommit': APP_COMMIT,
        'candidateManifestSha256': CANDIDATE_SHA,
        'migrations': {'sourceCount': 23, 'sourceListSha256': B23,
                       'targetCount': 30, 'targetListSha256': B30},
        'localImageIds': images,
        'registryDigests': {'api': None, 'web': None},
        'files': {name: sha(body) for name, body in sorted(files.items())},
    }
    if settings:
        del policy['trustKey']
        del policy['bundleSignature']
        policy.update(settings)
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
    return {'result': 'B30_STAGING_READY_UNSIGNED' if settings else 'B30_STAGING_PREPARED_UNSIGNED',
            'packageSha256': sha(output.read_bytes()),
            'members': len(files), 'bytes': output.stat().st_size,
            'publicationReady': bool(settings)}


if __name__ == '__main__':
    if len(sys.argv) not in (2, 10) or (len(sys.argv) == 10 and sys.argv[1] != '--ready'):
        raise SystemExit('Usage: package.py OUTPUT.tar.gz | --ready OUTPUT PUBLIC APPROVED_KEY_SHA256 API WEB B23_WRAPPER_SHA B23_POLICY_SHA MDM_REGION')
    if len(sys.argv) == 2:
        result = build(Path(sys.argv[1]).resolve())
    else:
        result = build(Path(sys.argv[2]).resolve(), tuple(sys.argv[3:]))
    print(json.dumps(result, sort_keys=True))
