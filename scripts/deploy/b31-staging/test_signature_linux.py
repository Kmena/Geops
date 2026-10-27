"""Verify B31 operational bundle signature and tamper rejection on Linux."""
import importlib.util
import json
import sys
from pathlib import Path

archive, signature, public = map(Path, sys.argv[1:])
source = Path('/src/scripts/deploy/b31-staging/install.py')
spec = importlib.util.spec_from_file_location('b31_install', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
data = archive.read_bytes()
sig = signature.read_bytes()
digest = module.sha(data)
module.verify_signature(data, sig, public, digest)
files, policy = module.archive_items(data)
assert policy['kind'] == 'B31_STAGING_READY'
bad = bytearray(sig)
bad[0] ^= 1
try:
    module.verify_signature(data, bytes(bad), public, digest)
except module.Blocked:
    pass
else:
    raise AssertionError('Modified signature accepted')
print(json.dumps({'result': 'B31_SIGNATURE_LINUX_PASS', 'packageSha256': digest,
                  'members': len(files), 'tamperRejected': True}))