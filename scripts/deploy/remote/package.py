#!/usr/bin/env python3
"""Build a deterministic, reviewable first-Staging control archive."""

import gzip
import hashlib
import io
import json
import subprocess
import sys
import tarfile
from pathlib import Path

from geops_deploy import BUNDLE_FILES

SOURCE = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
BASE_SHA = '052f4bec0633f829869699e9485a0fdc61bc1964'
FILES = {
    'geops_deploy.py': HERE / 'geops_deploy.py',
    'policy.json': HERE / 'first-staging-policy.json',
    'state.json': HERE / 'first-staging-state.json',
    'geops-deploy.sudoers': HERE / 'geops-deploy.sudoers',
    **{'bundle/' + name: SOURCE / name for name in BUNDLE_FILES},
}


def contents(name, path):
    if name.startswith('bundle/'):
        return subprocess.check_output(['git', 'show', BASE_SHA + ':' + name[7:]], cwd=SOURCE)
    return path.read_bytes().replace(b'\r\n', b'\n')


def build(output):
    policy = json.loads(FILES['policy.json'].read_text())
    for name in BUNDLE_FILES:
        if hashlib.sha256(contents('bundle/' + name, FILES['bundle/' + name])).hexdigest() != policy['files'][name]:
            raise ValueError('Bundle differs from policy: ' + name)
    with output.open('wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode='w') as archive:
                for name, path in sorted(FILES.items()):
                    data = contents(name, path)
                    item = tarfile.TarInfo(name)
                    item.size, item.uid, item.gid, item.mtime = len(data), 0, 0, 0
                    item.mode = 0o444
                    archive.addfile(item, io.BytesIO(data))
    print('package_sha256=' + hashlib.sha256(output.read_bytes()).hexdigest())


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python package.py OUTPUT.tar.gz')
    build(Path(sys.argv[1]))
