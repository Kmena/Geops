#!/usr/bin/env python3
"""Freeze build inputs in a fresh lab checkout without changing the worktree."""

import hashlib
import json
import shutil
import sys
from pathlib import Path


INPUTS = (
    '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.base.json',
    'apps/api/package.json', 'apps/api/tsconfig.json',
    'apps/api/tsconfig.build.json', 'apps/api/mdm-oauth-core.mjs',
    'apps/api/mdm-oauth-core.d.mts', 'apps/api/src', 'apps/api/scripts',
    'apps/web/package.json', 'apps/web/tsconfig.json',
    'apps/web/vite.config.ts', 'apps/web/index.html', 'apps/web/src',
    'packages/api-contracts/package.json', 'packages/api-contracts/src',
    'packages/api-contracts/tsconfig.json',
    'packages/api-contracts/tsconfig.build.json',
    'infrastructure/docker/api.Dockerfile',
    'infrastructure/docker/web.Dockerfile',
    'infrastructure/nginx/geops-web.conf',
    'infrastructure/staging/api-entrypoint.sh',
)


def inventory(root):
    result = {}
    for name in INPUTS:
        path = root / name
        if not path.exists() or path.is_symlink():
            raise ValueError('Missing or linked build input: ' + name)
        entries = path.rglob('*') if path.is_dir() else (path,)
        for item in entries:
            if item.is_symlink():
                raise ValueError('Linked build input: ' + str(item))
            if item.is_file():
                key = item.relative_to(root).as_posix()
                result[key] = hashlib.sha256(item.read_bytes()).hexdigest()
    return dict(sorted(result.items()))


def main(source, target, manifest):
    source, target, manifest = Path(source).resolve(), Path(target).resolve(), Path(manifest)
    if not target.is_dir() or not target.parent.name.startswith('geops-v2lab-'):
        raise ValueError('Existing exclusive lab snapshot directory required')
    before = inventory(source)
    for name in INPUTS:
        item = source / name
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if item.is_dir():
            shutil.copytree(item, destination, dirs_exist_ok=True)
        else:
            shutil.copy2(item, destination)
    if inventory(source) != before or inventory(target) != before:
        raise ValueError('Build inputs changed during snapshot')
    lines = '\n'.join(f'{name}|{digest}' for name, digest in before.items()).encode()
    identity = hashlib.sha256(lines).hexdigest()
    manifest.write_text(json.dumps({'schema': 'geops-v2lab-build-inputs-v1',
                                    'sha256': identity, 'files': before}, indent=2) + '\n')
    print(json.dumps({'sourceSha256': identity, 'fileCount': len(before)}))


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('Usage: snapshot.py WORKTREE EXTRACTED_HEAD_DIR OUTPUT_MANIFEST')
    main(*sys.argv[1:])
