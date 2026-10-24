#!/usr/bin/env python3
"""Reproduce the LF SQL bytes in the reviewed local A21 image inside a lab copy."""

import hashlib
import json
import sys
from pathlib import Path


def run(lab):
    lab = Path(lab).resolve()
    if not lab.name.startswith('geops-v2lab-'):
        raise ValueError('Exclusive lab root required')
    a21 = lab / 'a21' / 'apps/api/src/db/migrations'
    b22 = lab / 'b22' / 'apps/api/src/db/migrations'
    files = sorted(a21.glob('*.sql'))
    if len(files) != 21 or len(list(b22.glob('*.sql'))) != 22:
        raise ValueError('Expected 21 and 22 SQL catalogs')
    normalized = {}
    for file in files:
        contents = file.read_bytes().replace(b'\r\n', b'\n')
        if contents != (b22 / file.name).read_bytes():
            raise ValueError('A21 SQL differs beyond line endings: ' + file.name)
        normalized[file] = contents
    for file, contents in normalized.items():
        file.write_bytes(contents)
    lines = '\n'.join(file.name + '|' + hashlib.sha256(contents).hexdigest()
                      for file, contents in normalized.items()).encode()
    digest = hashlib.sha256(lines).hexdigest()
    if digest != 'cd308f751512b86926116856185b7aa870f849235161e5e23c904c4d28813d8e':
        raise ValueError('Normalized A21 catalog differs from reviewed policy')
    print(json.dumps({'sqlCount': 21, 'sqlListSha256': digest,
                      'transformation': 'CRLF to LF in lab copy only'}))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: normalize_a21_sql.py EXCLUSIVE_LAB_ROOT')
    run(sys.argv[1])
