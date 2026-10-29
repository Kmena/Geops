#!/usr/bin/python3 -I
"""Pinned B32 staging wrapper; commands require an activated signed package."""

import hashlib
import importlib.util
import json
import os
import re
import stat
import sys
from pathlib import Path

ROOT = Path('/opt/geops-b32-staging')
SHA = re.compile(r'^[a-f0-9]{64}$')


def protected(path, directory=False):
    for part in (path, *path.parents):
        item = os.lstat(part)
        if stat.S_ISLNK(item.st_mode) or item.st_uid != 0 or item.st_mode & 0o022:
            raise RuntimeError('Unprotected staging package path')
    mode = os.lstat(path).st_mode
    if not (stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode)):
        raise RuntimeError('Unexpected staging package path type')


def doctor(root=ROOT):
    if os.geteuid() != 0:
        raise RuntimeError('Root required')
    protected(root, True)
    policy_file = root / 'policy.json'
    pin = root / 'policy.sha256'
    protected(policy_file)
    protected(pin)
    body = policy_file.read_bytes()
    expected = pin.read_text().strip()
    if not SHA.fullmatch(expected) or hashlib.sha256(body).hexdigest() != expected:
        raise RuntimeError('Staging policy pin differs')
    policy = json.loads(body)
    if (policy.get('schemaVersion') != 1 or
        policy.get('kind') != 'B32_STAGING_READY' or
            policy.get('environment') != 'geops-spec02-staging' or
            not isinstance(policy.get('files'), dict)):
        raise RuntimeError('Unrecognized B32 staging policy')
    prepared = False
    if prepared:
        if (policy.get('activation') != 'DISABLED' or
                policy.get('publicationReady') is not False or
                policy.get('trustKey') != 'PENDING_OPERATOR_VERIFICATION' or
                policy.get('bundleSignature') != 'PENDING'):
            raise RuntimeError('Prepared policy restrictions changed')
    else:
        protected(root / 'public.pem')
    if not prepared and (policy.get('activation') != 'READY' or
          policy.get('publicationReady') is not True or
          not SHA.fullmatch(policy.get('trustKeySha256', '')) or
          hashlib.sha256((root / 'public.pem').read_bytes()).hexdigest() !=
          policy['trustKeySha256']):
        raise RuntimeError('Ready policy trust key differs')
    for name, digest in policy['files'].items():
        member = Path(name)
        if member.is_absolute() or '..' in member.parts or not SHA.fullmatch(digest):
            raise RuntimeError('Invalid staging package inventory')
        path = root / member
        protected(path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Staging package checksum differs')
    return {'result': 'B32_STAGING_PACKAGE_VERIFIED',
            'activation': policy['activation'],
            'publicationReady': policy['publicationReady'], 'files': len(policy['files'])}


if __name__ == '__main__':
    try:
        args = sys.argv[1:]
        counts = {'doctor': 0, 'status': 0, 'prepare': 1,
                  'begin': 3, 'migrate': 0, 'recover': 1, 'verify': 0}
        if not args or args[0] not in counts or len(args) - 1 != counts[args[0]]:
            raise RuntimeError('Unknown B32 staging command or argument count')
        verified = doctor()
        if args[0] == 'doctor':
            print(json.dumps(verified, sort_keys=True))
        else:
            if verified['activation'] != 'READY':
                raise RuntimeError('Staging activation remains disabled')
            source = ROOT / 'scripts/deploy/b32-staging/controller.py'
            protected(source)
            spec = importlib.util.spec_from_file_location('b32_stage_controller', source)
            controller = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(controller)
            controller.main(args)
    except Exception as error:
        print('GEOPS B32 staging guard BLOCKED: ' + str(error), file=sys.stderr)
        sys.exit(1)
