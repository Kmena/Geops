#!/usr/bin/env python3
"""Deterministic, local review archive. No installation or server access."""

import gzip
import hashlib
import io
import json
import sys
import tarfile
from pathlib import Path

from geops_deploy_v2 import BUNDLE_FILES

SOURCE = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
CONTROLLERS = {'geops_deploy.py': HERE / 'geops_deploy.py',
               'geops_deploy_v2.py': HERE / 'geops_deploy_v2.py'}


def normalized(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError('Reviewed source must be a regular file')
    return path.read_bytes().replace(b'\r\n', b'\n')


def build(output, policy_path):
    policy_bytes = normalized(policy_path)
    policy = json.loads(policy_bytes)
    if policy.get('schemaVersion') != 2 or set(policy.get('files', {})) != set(BUNDLE_FILES):
        raise ValueError('V2 policy file inventory required')
    if set(policy.get('controllers', {})) != set(CONTROLLERS):
        raise ValueError('V2 controller inventory required')
    files = {'policy.json': policy_bytes,
             'geops-deploy-v2.sudoers': normalized(HERE / 'geops-deploy-v2.sudoers')}
    for name, path in CONTROLLERS.items():
        body = normalized(path)
        if hashlib.sha256(body).hexdigest() != policy['controllers'][name]:
            raise ValueError('Controller differs from reviewed policy: ' + name)
        files['lib/' + name if name == 'geops_deploy.py' else 'controller/' + name] = body
    for name in BUNDLE_FILES:
        body = normalized(SOURCE / name)
        if hashlib.sha256(body).hexdigest() != policy['files'][name]:
            raise ValueError('Bundle differs from reviewed policy: ' + name)
        files['bundle/' + name] = body
    with output.open('xb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode='w') as archive:
                for name, body in sorted(files.items()):
                    item = tarfile.TarInfo(name)
                    item.size, item.uid, item.gid, item.mtime = len(body), 0, 0, 0
                    item.mode = 0o444
                    archive.addfile(item, io.BytesIO(body))
    print('package_sha256=' + hashlib.sha256(output.read_bytes()).hexdigest())


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: package-v2.py OUTPUT.tar.gz REVIEWED_POLICY.json')
    build(Path(sys.argv[1]), Path(sys.argv[2]))
