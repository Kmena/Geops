"""Exercise the signed B31 installer in a disposable Linux root filesystem."""
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

archive, signature, public = map(Path, sys.argv[1:])
root = Path('/root/b31-input')
root.mkdir(mode=0o700)
paths = []
for source, name in ((archive, 'bundle.tar.gz'), (signature, 'bundle.sig'),
                     (public, 'public.pem'),
                     (Path('/src/scripts/deploy/b31-staging/install.py'), 'install.py')):
    target = root / name
    shutil.copyfile(source, target)
    target.chmod(0o600)
    paths.append(target)
spec = importlib.util.spec_from_file_location('b31_install', paths[3])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.preflight = lambda policy: {'sourceController': 'B30_STAGING_VERIFIED', 'sourceSchema': 30}
expected = module.sha(paths[0].read_bytes())
first = module.install(paths[0], paths[1], paths[2], expected)
second = module.install(paths[0], paths[1], paths[2], expected)
assert first == second and first['result'] == 'B31_STAGING_PACKAGE_READY'
doctor = subprocess.run(['/usr/bin/python3', '/usr/local/sbin/geops-b31-staging', 'doctor'],
                        capture_output=True, text=True, check=True)
assert json.loads(doctor.stdout)['result'] == 'B31_STAGING_PACKAGE_VERIFIED'
subprocess.run(['/usr/sbin/visudo', '-c'], capture_output=True, check=True)
assert Path('/etc/sudoers.d/geops-b31-staging').read_bytes() == module.RULE
print(json.dumps({'result': 'B31_INSTALLER_ISOLATED_PASS',
                  'packageSha256': expected, 'idempotent': True, 'sudoers': 'PASS'}))