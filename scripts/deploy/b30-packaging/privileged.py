#!/usr/bin/python3 -I
"""Fixed-scope, root-owned launcher for the disposable B30 Docker laboratory."""

import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

ROOT = Path('/opt/geops-b30-lab')
LAB = ROOT / 'artifacts/b30-lab-privileged'
COMMANDS = {'doctor', 'init', 'status', 'verify', 'upgrade', 'recover'}
SHA = re.compile(r'^[a-f0-9]{64}$')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def protected(path, *, directory=False):
    for part in (path, *path.parents):
        if not part.exists():
            raise RuntimeError('Protected path is missing')
        info = os.lstat(part)
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Protected path permissions changed')
    info = os.lstat(path)
    if directory != stat.S_ISDIR(info.st_mode):
        if directory or not stat.S_ISREG(info.st_mode):
            raise RuntimeError('Protected path type changed')


def verify_installed(root=ROOT):
    protected(root, directory=True)
    policy_file = root / 'policy.json'
    protected(policy_file)
    pinned = root / 'policy.sha256'
    protected(pinned)
    expected_policy_sha = pinned.read_text().strip()
    if not SHA.fullmatch(expected_policy_sha) or digest(policy_file.read_bytes()) != expected_policy_sha:
        raise RuntimeError('Signed B30 policy checksum changed')
    policy = json.loads(policy_file.read_bytes())
    if (policy.get('schemaVersion') != 3 or
            policy.get('kind') != 'B30_PRIVILEGED_LAB_ONLY' or
            policy.get('environment') != 'synthetic-b30-local' or
            policy.get('applicationCommit') !=
            '15f77a0d1904b77833972d8e2fd628a6cb97678f' or
            policy.get('candidateManifestSha256') !=
            '02c83a5293db7a5e6452342c5b1649bcd85d3b9ac334647b5489564257200a5f' or
            policy.get('publicationReady') is not False or
            policy.get('registryDigests') != {'api': None, 'web': None} or
            policy.get('migrations') != {
                'sourceCount': 23,
                'sourceListSha256': '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d',
                'targetCount': 30,
                'targetListSha256': '64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6',
            } or not isinstance(policy.get('files'), dict)):
        raise RuntimeError('Unrecognized B30 lab policy')
    for name, expected in policy['files'].items():
        path = Path(name)
        if (path.is_absolute() or '..' in path.parts or not SHA.fullmatch(expected) or
                not (name.startswith('node_modules/') or
                     name.startswith('scripts/deploy/') or
                     name.startswith('infrastructure/compose/') or
                     name.startswith('specs/spec-03-clients-geofences-routes/'))):
            raise RuntimeError('Invalid protected bundle inventory')
        target = root / path
        protected(target)
        if digest(target.read_bytes()) != expected:
            raise RuntimeError('Protected controller bundle checksum changed')
    return policy


def verify_runtime(lab=LAB):
    protected(lab, directory=True)
    for path in lab.rglob('*'):
        protected(path, directory=path.is_dir())


def execute(command, root=ROOT, lab=LAB):
    if os.geteuid() != 0 or command not in COMMANDS:
        raise RuntimeError('Root and one fixed B30 lab command required')
    policy = verify_installed(root)
    if command == 'doctor':
        return {'result': 'B30_PRIVILEGED_PACKAGE_VERIFIED',
                'applicationCommit': policy['applicationCommit'],
                'publicationReady': False}
    if command != 'init':
        verify_runtime(lab)
    elif os.environ.get('SUDO_USER'):
        raise RuntimeError('Only the root operator may initialize disposable data')
    node = shutil.which('node')
    docker = shutil.which('docker')
    if not node or not docker:
        raise RuntimeError('Node and local Docker CLI required')
    protected(Path(node))
    protected(Path(docker))
    env = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
           'HOME': '/root', 'LANG': 'C', 'NODE_ENV': 'production'}
    result = subprocess.run(
        [node, str(root / 'scripts/deploy/b30-lab/controller.mjs'), command, str(lab)],
        cwd=root, env=env, stdin=subprocess.DEVNULL, capture_output=True,
        text=True, timeout=600, check=False)
    if result.returncode:
        raise RuntimeError('B30 lab controller blocked: ' + result.stderr[-2048:])
    return json.loads(result.stdout.strip())


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise RuntimeError('One fixed command required')
        print(json.dumps(execute(sys.argv[1]), sort_keys=True))
    except Exception as error:
        print('GEOPS B30 privileged lab BLOCKED: ' + str(error), file=sys.stderr)
        sys.exit(1)
