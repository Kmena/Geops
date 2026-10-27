#!/usr/bin/python3 -I
"""Read-only B30 staging package guard. No upgrade or service commands."""

import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path

ROOT = Path('/opt/geops-b30-staging')
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
            policy.get('kind') != 'B30_STAGING_PREPARED' or
            policy.get('environment') != 'geops-spec02-staging' or
            policy.get('activation') != 'DISABLED' or
            policy.get('publicationReady') is not False or
            policy.get('trustKey') != 'PENDING_OPERATOR_VERIFICATION' or
            not isinstance(policy.get('files'), dict)):
        raise RuntimeError('Staging policy is not a prepared-only policy')
    for name, digest in policy['files'].items():
        member = Path(name)
        if member.is_absolute() or '..' in member.parts or not SHA.fullmatch(digest):
            raise RuntimeError('Invalid staging package inventory')
        path = root / member
        protected(path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError('Staging package checksum differs')
    return {'result': 'B30_STAGING_PACKAGE_VERIFIED', 'activation': 'DISABLED',
            'publicationReady': False, 'files': len(policy['files'])}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2 or sys.argv[1] != 'doctor':
            raise RuntimeError('Only doctor is available before operator activation')
        print(json.dumps(doctor(), sort_keys=True))
    except Exception as error:
        print('GEOPS B30 staging guard BLOCKED: ' + str(error), file=sys.stderr)
        sys.exit(1)
