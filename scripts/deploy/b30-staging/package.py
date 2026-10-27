#!/usr/bin/env python3
"""Deterministic, prepared-only staging package; never a signed release."""

import gzip
import hashlib
import importlib.util
import io
import json
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
LAB = HERE.parent / 'b30-packaging' / 'package.py'
spec = importlib.util.spec_from_file_location('b30_lab_package', LAB)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

EXTRA = (
    'scripts/deploy/b30-staging/guard.py',
    'scripts/deploy/b30-staging/install.py',
    'scripts/deploy/b30-staging/package.py',
    'scripts/deploy/b30-staging/sudoers',
    'scripts/deploy/remote/geops_deploy_v2.py',
    'scripts/deploy/remote/install-v2.py',
    'scripts/deploy/remote/geops-deploy-v2.sudoers',
    'infrastructure/compose/compose.staging.yaml',
    'infrastructure/compose/compose.staging.digest.override.yaml',
    'infrastructure/compose/compose.staging.migrate.digest.override.yaml',
)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def build(output):
    images = module.check_source()
    files = {
        name: body for name, body in module.source_inventory().items()
        if not name.startswith('scripts/deploy/b30-packaging/') and
        name != 'infrastructure/compose/compose.b30-deployment-lab.yaml'
    }
    files.update({name: module.regular(ROOT / name) for name in EXTRA})
    policy = {
        'schemaVersion': 1,
        'kind': 'B30_STAGING_PREPARED',
        'environment': 'geops-spec02-staging',
        'activation': 'DISABLED',
        'trustKey': 'PENDING_OPERATOR_VERIFICATION',
        'bundleSignature': 'PENDING',
        'publicationReady': False,
        'applicationCommit': module.APP_COMMIT,
        'candidateManifestSha256': module.CANDIDATE_SHA,
        'migrations': {'sourceCount': 23, 'sourceListSha256': module.B23,
                       'targetCount': 30, 'targetListSha256': module.B30},
        'localImageIds': images,
        'registryDigests': {'api': None, 'web': None},
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
    return {'result': 'B30_STAGING_PREPARED_UNSIGNED', 'packageSha256': sha(output.read_bytes()),
            'members': len(files), 'bytes': output.stat().st_size,
            'publicationReady': False}


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: package.py OUTPUT.tar.gz')
    print(json.dumps(build(Path(sys.argv[1]).resolve()), sort_keys=True))
