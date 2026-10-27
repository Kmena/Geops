"""Exercise the complete signed nonce repair in a disposable Linux filesystem."""
import importlib.util
import json
import shutil
import tarfile
from pathlib import Path

source = Path('/src')
root = Path('/root/b31-repair-test')
root.mkdir(mode=0o700)
inputs = []
for name in ('controller-b31-staging-recovery-v4.tar.gz',
             'controller-b31-staging-recovery-v4.sig', 'approved-public.pem'):
    target = root / name
    shutil.copyfile(source / 'artifacts/b31-staging' / name, target)
    target.chmod(0o600)
    inputs.append(target)
repair_source = root / 'repair.py'
shutil.copyfile(source / 'scripts/deploy/b31-staging/repair.py', repair_source)
repair_source.chmod(0o600)
spec = importlib.util.spec_from_file_location('b31_repair_test', repair_source)
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)

with tarfile.open(source / 'artifacts/b31-staging/controller-b31-staging-ready-v3.tar.gz') as archive:
    old = {member.name: archive.extractfile(member).read() for member in archive}
repair.BUNDLE.mkdir(parents=True, mode=0o700)
for name, body in old.items():
    path = repair.BUNDLE / name
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_bytes(body)
    path.chmod(0o444)
(repair.BUNDLE / 'policy.sha256').write_text(repair.OLD_POLICY + '\n')
(repair.BUNDLE / 'policy.sha256').chmod(0o444)
repair.STATE.mkdir(parents=True, mode=0o700)
(repair.STATE / 'install.json').write_text(json.dumps({
    'schemaVersion': 1, 'phase': 'prepared-complete',
    'packageSha256': repair.OLD_PACKAGE, 'source': 'from-b30',
}))
(repair.STATE / 'promotion.json').write_text('{"phase":"draining"}')
gate = Path('/var/lib/docker/volumes/geops_spec02_stage_security/_data/security-gate.json')
gate.parent.mkdir(parents=True)
gate.write_text('{"phase":"open"}')
repair.preflight = lambda: None
repair.checked = lambda *args: json.dumps({
    'activation': 'READY', 'files': 16, 'publicationReady': True,
    'result': 'B31_STAGING_PACKAGE_VERIFIED',
})
repair.main([str(item) for item in inputs])
assert repair.sha((repair.BUNDLE / 'policy.json').read_bytes()) == repair.NEW_POLICY
assert json.loads((repair.STATE / 'install.json').read_text())['packageSha256'] == repair.NEW_PACKAGE
backup = repair.BUNDLE.with_name('geops-b31-staging-pre-repair-' + repair.OLD_PACKAGE[:12])
assert backup.exists()
for name, body in old.items():
    assert (backup / name).read_bytes() == body
repair.main([str(item) for item in inputs])
print(json.dumps({'result': 'B31_REPAIR_INSTALLER_LINUX_PASS',
                  'signedPackage': True, 'oldBundlePreserved': True,
                  'idempotent': True}, sort_keys=True))
