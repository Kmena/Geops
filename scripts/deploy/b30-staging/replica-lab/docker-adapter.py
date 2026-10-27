#!/usr/bin/python3 -I
"""LAB ONLY: map synthetic GHCR digests to local images; all other Docker calls are real."""

import json
import os
import subprocess
import sys
from pathlib import Path

REAL = '/usr/local/bin/docker'
API_REF = 'ghcr.io/kmena/geops-api@sha256:' + 'a' * 64
WEB_REF = 'ghcr.io/kmena/geops-web@sha256:' + 'b' * 64
MAP = {API_REF: 'geops-b30-staging-api:2f89b87',
       WEB_REF: 'geops-b30-staging-web:2f89b87'}


def main(args):
    fault = Path('/root/geops-b30-replica/fault-command')
    if fault.exists() and args and args[0] == 'compose':
        wanted = fault.read_text().strip()
        if ((wanted == 'before-migrate' and 'run' in args and 'geops-migrate' in args) or
                (wanted == 'after-migrate' and 'up' in args and 'geops-api' in args and
                 os.environ.get('GEOPS_STAGE_API_IMAGE_REF') == API_REF)):
            fault.unlink()
            print('LAB_ONLY_INJECTED_DOCKER_COMMAND_FAILURE', file=sys.stderr)
            return 42
    if len(args) >= 3 and args[:2] == ['image', 'inspect'] and args[2] in MAP:
        ref = args[2]
        result = subprocess.run([REAL, 'image', 'inspect', MAP[ref], '--format', '{{json .}}'],
                                capture_output=True, text=True, check=True)
        value = json.loads(result.stdout)
        value['RepoDigests'] = [ref]
        print(json.dumps(value))
        return 0
    if args and args[0] == 'run':
        args = [MAP.get(value, value) for value in args]
    env = os.environ.copy()
    if args and args[0] == 'compose' and not ('config' in args):
        for key in ('GEOPS_STAGE_API_IMAGE_REF', 'GEOPS_STAGE_WEB_IMAGE_REF'):
            if key in env:
                env[key] = MAP.get(env[key], env[key])
    return subprocess.call([REAL, *args], env=env)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
