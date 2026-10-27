#!/usr/bin/python3 -I
"""Install only the signed B31 nonce-recovery controller repair over v3."""
import fcntl
import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

OLD_PACKAGE = 'b510ecb71b6b79cbc46fb1e2f1dd5a2985cf0edc1c04899042dd754f79deba03'
NEW_PACKAGE = '6129476fc396978e1429b36011f98a964ae3702034cfd31391c1bc796b611853'
OLD_POLICY = '75bbaf0a2cb9a57a4aecd05ea00ae46b96430a6d2f24f39e2baae6262be931a0'
NEW_POLICY = '3d5aaa8fc5b3a07b2c2ad0392ee50eba83075481a89562eb457ab149b3e372b8'
PUBLIC = 'd01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27'
B30_LEDGER = '64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6'
B30_SOURCE = '297753232179b61b04b80f13ddd7e429aea782f6469949071459c57d7d7536d3'
B30_API = 'sha256:42c1eeb392f8e8b23199a2536724910dc32721074c9c0784a3fcb9207a9ffe9d'
B30_WEB = 'sha256:2b59828bf0d50c29eaf87bb2f7fa3499e03da814d66ca56dd76971adb1a15483'
BACKUP = 'f1654af7f0d42611f012bcfcf2ed6aac4b75b691bf0ae1d2e8306607fadb4705'
EVIDENCE = '45ffd1e232b8bdecc08c10698f726401f3d720fc763b1d6db516b716730f0bcc'
CONTROLLER = 'scripts/deploy/b31-staging/controller.py'
BUNDLE = Path('/opt/geops-b31-staging')
STATE = Path('/var/lib/geops-b31-staging')


def sha(body):
    return hashlib.sha256(body).hexdigest()


def checked(*args):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True,
                            text=True, timeout=120, check=False,
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root',
                                 'LANG': 'C', 'DOCKER_CONFIG': '/etc/geops-deploy-v2/docker'})
    if result.returncode:
        raise RuntimeError('Protected preflight command failed: ' + args[0])
    return result.stdout.strip()


def validate_delta(old_policy, new_policy, old_files, items):
    if (sha(items['policy.json']) != NEW_POLICY or
            set(old_policy) != set(new_policy) or
            {key: value for key, value in old_policy.items() if key != 'files'} !=
            {key: value for key, value in new_policy.items() if key != 'files'} or
            set(old_policy['files']) != set(new_policy['files']) or
            set(items) != set(old_files) | {'policy.json'}):
        raise RuntimeError('Repair changes B31 policy or inventory outside controller')
    changed = []
    for name, before in old_files.items():
        after = items[name]
        if sha(before) != old_policy['files'][name] or sha(after) != new_policy['files'][name]:
            raise RuntimeError('B31 inventory hash differs')
        if before != after:
            changed.append(name)
    if changed != [CONTROLLER] or b'Open B30 gate does not match source journal' not in items[CONTROLLER]:
        raise RuntimeError('Repair must change only the nonce-recovery controller')


def preflight():
    current = json.loads(checked('/usr/local/sbin/geops-b31-staging', 'doctor'))
    if current != {'activation': 'READY', 'files': 16, 'publicationReady': True,
                   'result': 'B31_STAGING_PACKAGE_VERIFIED'}:
        raise RuntimeError('Installed B31 package is not verified')
    status = json.loads(checked('/usr/local/sbin/geops-b31-staging', 'status'))
    journal = status.get('journal') or {}
    if (status.get('gate') != 'open' or
            status.get('ledger') != {'count': 30, 'sha256': B30_LEDGER} or
            journal.get('phase') != 'draining' or
            journal.get('sourceStateSha256') != B30_SOURCE or
            journal.get('source', {}).get('apiId') != B30_API or
            journal.get('source', {}).get('webId') != B30_WEB):
        raise RuntimeError('B30 source or B31 draining state differs')
    source = Path('/var/lib/geops-b30-staging/promotion.json').read_bytes()
    if sha(source) != B30_SOURCE:
        raise RuntimeError('B30 source journal changed')
    source_journal = json.loads(source)
    gate = json.loads(Path('/var/lib/docker/volumes/geops_spec02_stage_security/_data/security-gate.json').read_bytes())
    if (source_journal.get('gateNonce') != gate.get('nonce') or
            source_journal.get('gateEpoch') != gate.get('epoch') or
            gate.get('phase') != 'open'):
        raise RuntimeError('Open gate differs from B30 source')
    if json.loads(checked('/usr/local/sbin/geops-b30-staging', 'verify')).get('result') != 'B30_STAGING_VERIFIED':
        raise RuntimeError('B30 services are not healthy')
    running = checked('/usr/bin/docker', 'ps',
                      '--filter', 'name=geops-spec02-staging-geops-migrate',
                      '--filter', 'name=geops-spec02-staging-geops-gate-init',
                      '--format', '{{.ID}}')
    if running:
        raise RuntimeError('Maintenance or migration container active')
    backup = Path('/var/lib/docker/volumes/geops_spec02_stage_backups/_data/geops-stage-20261027T195947Z.dump')
    if sha(backup.read_bytes()) != BACKUP:
        raise RuntimeError('B30 backup hash differs')
    max_age = json.loads(Path('/etc/geops-deploy-v2/policy.json').read_bytes())['backupMaxAgeSeconds']
    if datetime.now(timezone.utc).timestamp() - backup.stat().st_mtime > max_age:
        raise RuntimeError('B30 backup expired')
    evidence = Path('/root/geops-b31-restore-evidence-H6EDph/restore-evidence.json')
    if sha(evidence.read_bytes()) != EVIDENCE:
        raise RuntimeError('B30 restore evidence differs')
    return journal


def create_bundle(items, root):
    root.mkdir(mode=0o700)
    for name, body in items.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_bytes(body)
        path.chmod(0o444)
    (root / 'policy.sha256').write_bytes((NEW_POLICY + '\n').encode())
    (root / 'policy.sha256').chmod(0o444)


def main(args):
    if os.geteuid() != 0 or len(args) != 3:
        raise RuntimeError('Usage: repair.py BUNDLE.tar.gz BUNDLE.sig APPROVED_PUBLIC.pem')
    archive_path, signature_path, public_path = map(Path, args)
    for path in (archive_path, signature_path, public_path, Path(__file__).resolve()):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('Root-owned protected regular input required')
    if sha(public_path.read_bytes()) != PUBLIC:
        raise RuntimeError('Unapproved trust key')
    installed = BUNDLE / 'scripts/deploy/b31-staging/install.py'
    spec = importlib.util.spec_from_file_location('b31_original_installer', installed)
    original = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(original)
    original.secure(installed, regular=True)
    archive = archive_path.read_bytes()
    original.verify_signature(archive, signature_path.read_bytes(), public_path, NEW_PACKAGE)
    items, new_policy = original.archive_items(archive)
    old_body = (BUNDLE / 'policy.json').read_bytes()
    record_file = STATE / 'install.json'
    record_bytes = record_file.read_bytes()
    record = json.loads(record_bytes)
    if sha(old_body) == NEW_POLICY:
        if (record != {'schemaVersion': 1, 'phase': 'prepared-complete',
                       'packageSha256': NEW_PACKAGE, 'source': 'from-b30'} or
                any((BUNDLE / name).read_bytes() != body for name, body in items.items()) or
                json.loads(checked('/usr/local/sbin/geops-b31-staging', 'doctor')).get('result') !=
                'B31_STAGING_PACKAGE_VERIFIED'):
            raise RuntimeError('Existing B31 repair differs')
        print(json.dumps({'result': 'B31_CONTROLLER_NONCE_REPAIR_ALREADY_INSTALLED',
                          'packageSha256': NEW_PACKAGE}, sort_keys=True))
        return
    if sha(old_body) != OLD_POLICY:
        raise RuntimeError('Installed B31 v3 policy differs')
    old_policy = json.loads(old_body)
    old_files = {name: (BUNDLE / name).read_bytes() for name in old_policy['files']}
    validate_delta(old_policy, new_policy, old_files, items)
    if record != {'schemaVersion': 1, 'phase': 'prepared-complete',
                  'packageSha256': OLD_PACKAGE, 'source': 'from-b30'}:
        raise RuntimeError('Installed B31 v3 record differs')
    preflight()
    journal_hash = sha((STATE / 'promotion.json').read_bytes())
    gate_file = Path('/var/lib/docker/volumes/geops_spec02_stage_security/_data/security-gate.json')
    gate_hash = sha(gate_file.read_bytes())
    fds = []
    temporary = None
    old_backup = BUNDLE.with_name('geops-b31-staging-pre-repair-' + OLD_PACKAGE[:12])
    if old_backup.exists():
        raise RuntimeError('B31 v3 backup directory already exists')
    try:
        for name in ('install.lock', 'controller.lock'):
            fd = os.open(STATE / name, os.O_WRONLY | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fds.append(fd)
        if (sha((STATE / 'promotion.json').read_bytes()) != journal_hash or
                sha(gate_file.read_bytes()) != gate_hash):
            raise RuntimeError('B31 journal or gate changed before repair')
        temporary = Path(tempfile.mkdtemp(prefix='.geops-b31-repair-', dir=BUNDLE.parent))
        temporary.rmdir()
        create_bundle(items, temporary)
        os.rename(BUNDLE, old_backup)
        try:
            os.rename(temporary, BUNDLE)
            temporary = None
            next_record = dict(record, packageSha256=NEW_PACKAGE)
            original.atomic(record_file, (json.dumps(next_record, sort_keys=True) + '\n').encode(), 0o600)
            result = json.loads(checked('/usr/local/sbin/geops-b31-staging', 'doctor'))
            if result.get('result') != 'B31_STAGING_PACKAGE_VERIFIED':
                raise RuntimeError('Repaired B31 doctor failed')
        except Exception:
            failed = BUNDLE.with_name('geops-b31-staging-failed-repair-' + NEW_PACKAGE[:12])
            if BUNDLE.exists():
                os.rename(BUNDLE, failed)
            os.rename(old_backup, BUNDLE)
            original.atomic(record_file, record_bytes, 0o600)
            raise
    finally:
        for fd in reversed(fds):
            os.close(fd)
    print(json.dumps({'result': 'B31_CONTROLLER_NONCE_REPAIR_INSTALLED',
                      'sourcePackageSha256': OLD_PACKAGE,
                      'packageSha256': NEW_PACKAGE,
                      'policySha256': NEW_POLICY,
                      'applicationChanged': False, 'databaseChanged': False}, sort_keys=True))


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as error:
        print('B31 nonce repair BLOCKED: ' + str(error), file=sys.stderr)
        sys.exit(1)
