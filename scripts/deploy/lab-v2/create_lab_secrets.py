#!/usr/bin/env python3
"""Create laboratory-only credentials in a new isolated directory."""

import base64
import os
import secrets
import sys
from pathlib import Path


def create(root):
    root = Path(root).resolve()
    if not root.parent.name.startswith('geops-v2lab-'):
        raise ValueError('Exclusive GEOPS v2 laboratory directory required')
    if root.exists():
        if not root.is_dir() or any(root.iterdir()):
            raise ValueError('Laboratory secret directory must be empty')
    else:
        root.mkdir(mode=0o700)
    key_names = ('admin_session_key', 'admin_csrf_key', 'invitation_hmac_key',
                 'mdm_grant_key', 'gps_quarantine_key')
    values = {'db_password': secrets.token_urlsafe(48),
              **{name: base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip('=')
                 for name in key_names},
              'mdm_client_id': 'synthetic-client-' + secrets.token_hex(12),
              'mdm_client_secret': 'synthetic-secret-' + secrets.token_hex(24)}
    for name, value in values.items():
        with (root / name).open('x', encoding='ascii') as stream:
            stream.write(value)
        (root / name).chmod(0o600)
    print('Created eight synthetic laboratory secrets; values withheld')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: secrets.py NEW_LAB_SECRETS_DIRECTORY')
    create(sys.argv[1])
