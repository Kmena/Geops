#!/usr/bin/python3
"""Disposable B23→B30 staging topology exercise. Run only inside the isolated runner."""

import gzip
import hashlib
import io
import json
import os
import shutil
import subprocess
import tarfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

SOURCE = Path('/source')
ROOT = Path('/root/geops-b30-replica')
V2 = Path('/etc/geops-deploy-v2')
STAGE = SOURCE / 'scripts/deploy/b30-staging'
CLI = '/usr/local/bin/docker'
WRAPPER = '/usr/local/sbin/geops-b30-staging'
PROJECT = 'geops-spec02-staging'
OLD_TAG = 'e' * 40
OLD_API = 'geops-spec02-api:' + OLD_TAG
OLD_WEB = 'geops-spec02-web:' + OLD_TAG
API = 'ghcr.io/kmena/geops-api@sha256:' + 'a' * 64
WEB = 'ghcr.io/kmena/geops-web@sha256:' + 'b' * 64
PASSWORD = 'SyntheticB30DatabasePassword0123456789abcdef'
ADMIN_PASSWORD = 'synthetic-b30-replica-password'
NAMES = ('db_password', 'admin_session_key', 'admin_csrf_key',
         'invitation_hmac_key', 'mdm_grant_key', 'gps_quarantine_key')
FILES = ('infrastructure/compose/compose.staging.yaml',
         'infrastructure/compose/compose.staging.digest.override.yaml',
         'infrastructure/compose/compose.staging.mdm-web-oauth.override.yaml',
         'infrastructure/compose/compose.staging.migrate.digest.override.yaml',
         'infrastructure/nginx/geops-staging-web.conf',
         'infrastructure/staging/api-entrypoint.sh',
         'infrastructure/staging/backup.sh')
BASE = V2 / 'bundle/infrastructure/compose/compose.staging.yaml'
MDM = V2 / 'bundle/infrastructure/compose/compose.staging.mdm-web-oauth.override.yaml'


def sha(body):
    return hashlib.sha256(body).hexdigest()


def run(args, *, env=None, timeout=180, allow_fail=False, bytes_output=False):
    done = subprocess.run(args, env=env, capture_output=True, timeout=timeout,
                          text=not bytes_output, check=False)
    if done.returncode and not allow_fail:
        error = done.stderr if not bytes_output else done.stderr.decode(errors='replace')
        raise RuntimeError(f'Command failed ({done.returncode}): {args[:4]}: {error[-700:]}')
    return done if allow_fail else done.stdout


def docker(*args, **kwargs):
    return run([CLI, *args], **kwargs)


def compose(*args, mdm=True, timeout=180):
    command = [CLI, 'compose', '--profile', 'maintenance', '-f', str(BASE)]
    if mdm:
        command += ['-f', str(MDM)]
    env = os.environ.copy()
    env.update({'GEOPS_STAGE_SECRET_GID': '24001', 'GEOPS_STAGE_IMAGE_TAG': OLD_TAG,
                'GEOPS_STAGE_ORIGIN': 'https://geops-staging.duckdns.org',
                'GEOPS_MDM_REGION': 'com'})
    return run(command + list(args), env=env, timeout=timeout)


def db(sql):
    return docker('exec', PROJECT + '-geops-db-1', 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
                  '-U', 'geops_stage', '-d', 'geops_dev', '-Atq', '-c', sql, timeout=30).strip()


def wait_health(name, seconds=150):
    deadline = time.monotonic() + seconds
    container = PROJECT + '-geops-' + name + '-1'
    while time.monotonic() < deadline:
        result = run([CLI, 'inspect', container, '--format', '{{.State.Health.Status}}'],
                     allow_fail=True, timeout=10)
        if result.returncode == 0 and result.stdout.strip() == 'healthy':
            return
        time.sleep(2)
    raise RuntimeError(f'{name} health timeout')


def setup_files():
    ROOT.mkdir(mode=0o700, exist_ok=True)
    for name in FILES:
        target = V2 / 'bundle' / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SOURCE / name, target)
        target.chmod(0o444)
    for folder in ('secrets', 'runtime-secrets', 'docker'):
        (V2 / folder).mkdir(mode=0o700, exist_ok=True)
    for name in NAMES:
        value = PASSWORD if name == 'db_password' else ('A' * 43)
        for folder, mode, gid in (('secrets', 0o600, 0),
                                  ('runtime-secrets', 0o640, 24001)):
            path = V2 / folder / name
            path.write_text(value)
            os.chown(path, 0, gid)
            path.chmod(mode)
    link = V2 / 'bundle/infrastructure/compose/.local/staging/secrets'
    link.parent.mkdir(parents=True, exist_ok=True)
    if link.is_symlink():
        if link.resolve() != V2 / 'runtime-secrets':
            raise RuntimeError('B23 synthetic secret link changed')
    else:
        link.symlink_to(V2 / 'runtime-secrets')
    wrapper = Path('/usr/local/sbin/geops-deploy-v2')
    wrapper.write_text('#!/bin/sh\nset -eu\n[ "${1:-}" = verify ]\n'
                       '/usr/bin/docker exec geops-spec02-staging-geops-db-1 '
                       'psql -X -U geops_stage -d geops_dev -Atq -c '
                       "'SELECT count(*) FROM geops_schema_migrations' | grep -qx 23\n"
                       '/usr/bin/docker inspect geops-spec02-staging-geops-api-1 '
                       '--format "{{.State.Health.Status}}" | grep -qx healthy\n'
                       '/usr/bin/docker inspect geops-spec02-staging-geops-web-1 '
                       '--format "{{.State.Health.Status}}" | grep -qx healthy\n')
    wrapper.chmod(0o500)
    sudoers = Path('/etc/sudoers.d/geops-deploy')
    sudoers.write_bytes((SOURCE / 'scripts/deploy/remote/geops-deploy-v2.sudoers').read_bytes()
                        .replace(b'\r\n', b'\n'))
    sudoers.chmod(0o440)
    policy = {'schemaVersion': 2, 'environment': PROJECT,
              'origin': 'https://geops-staging.duckdns.org',
              'secretGid': '24001', 'imageTag': OLD_TAG,
              'backupMaxAgeSeconds': 86400,
              'profiles': {'B23-mdm': {'sqlCount': 23}},
              'mdm': {'region': 'com'},
              'files': {name: sha((V2 / 'bundle' / name).read_bytes()) for name in FILES}}
    (V2 / 'policy.json').write_text(json.dumps(policy, sort_keys=True) + '\n')
    (V2 / 'policy.json').chmod(0o600)
    return sha(wrapper.read_bytes()), sha((V2 / 'policy.json').read_bytes())


def baseline():
    docker('tag', 'geops-b30-lab-api:b23', OLD_API)
    docker('tag', 'geops-b30-lab-web:b23', OLD_WEB)
    docker('network', 'create', 'geops_spec02_stage_edge')
    docker('volume', 'create', 'geops_spec02_stage_security')
    docker('volume', 'create', 'geops_spec02_stage_backups')
    compose('up', '-d', '--no-build', '--pull', 'never', 'geops-db')
    wait_health('db')
    security = Path('/var/lib/docker/volumes/geops_spec02_stage_security/_data')
    security.mkdir(parents=True, exist_ok=True)
    os.chown(security, 1000, 1000)
    security.chmod(0o755)
    compose('run', '--rm', '--no-deps', 'geops-migrate', timeout=300)
    compose('run', '--rm', '--no-deps', 'geops-gate-init', 'gate', 'init', timeout=120)
    gate = security / 'security-gate.json'
    if json.loads(gate.read_text())['phase'] != 'open':
        raise RuntimeError('Fresh B23 gate not open')
    seed()
    compose('up', '-d', '--no-build', '--pull', 'never', 'geops-api', 'geops-web', timeout=240)
    wait_health('api')
    wait_health('web')
    if db('SELECT count(*) FROM geops_schema_migrations') != '23':
        raise RuntimeError('B23 baseline ledger differs')
    return gate


def node_in_api(code, *, image='geops-b30-staging-api:2f89b87', gate=False, timeout=120):
    args = ['run', '--rm', '--network', 'geops_spec02_stage_db',
            '-e', 'DATABASE_URL=postgresql://geops_stage:' + PASSWORD + '@geops-db:5432/geops_dev']
    if gate:
        args += ['-v', 'geops_spec02_stage_security:/geops-security']
    args += ['--entrypoint', 'node', image, '--input-type=module', '-e', code]
    return docker(*args, timeout=timeout)


def seed():
    code = """import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {AdminAuthService} from './apps/api/dist/admin-auth/service.js';
import {SupervisedRecoveryService} from './apps/api/dist/admin-auth/supervised-recovery.js';
const p=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
try {
  const a=new AdminAuthService(p,{sessionKey:Buffer.alloc(32,81),csrfKey:Buffer.alloc(32,82),allowedOrigins:['https://example.invalid']});
  await a.bootstrap('replica-admin@example.invalid','synthetic-b30-replica-password');
  const c=new SupervisedRecoveryService(p,Buffer.alloc(32,97));
  for(const email of ['custodian-one@example.invalid','custodian-two@example.invalid']) await c.registerSyntheticCustodian(email,'synthetic-b30-replica-password');
  const admin=(await p.query("SELECT id FROM admin_user WHERE email_normalized='replica-admin@example.invalid'")).rows[0].id;
  const device=randomUUID(),binding=randomUUID(),install=randomUUID();
  await p.query("INSERT INTO geops_operating_tenant(tenant_id,established_by,audit_ref) VALUES('synthetic',$1,$2)",[admin,randomUUID()]);
  await p.query("INSERT INTO mdm_integration(id,provider,region,customer_id,status) VALUES($1,'manageengine','com','12345','DISCONNECTED')",[randomUUID()]);
  await p.query("INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','Replica synthetic device')",[device]);
  await p.query("INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake','synthetic',$3,'ACTIVE')",[binding,device,'fake-'+device]);
  await p.query("INSERT INTO gps_device_installation(installation_id,device_id,activated_at,activation_binding_id,activation_tenant_id) VALUES($1,$2,$3,$4,'synthetic')",[install,device,'2026-10-20T12:00:00Z',binding]);
  console.log('B23_SEED_OK');
} finally {await p.end()}
"""
    if 'B23_SEED_OK' not in node_in_api(code):
        raise RuntimeError('Synthetic B23 seed failed')


def state_and_backup(gate):
    api_id = docker('image', 'inspect', OLD_API, '--format', '{{.Id}}').strip()
    web_id = docker('image', 'inspect', OLD_WEB, '--format', '{{.Id}}').strip()
    active = {'profile': 'B23-mdm', 'commit': OLD_TAG, 'apiRef': OLD_API,
              'webRef': OLD_WEB, 'apiId': api_id, 'webId': web_id,
              'releaseSha256': None}
    state = {'schemaVersion': 2, 'active': active, 'previous': None,
             'phase': 'steady', 'pending': None}
    directory = Path('/var/lib/geops-deploy')
    directory.mkdir(mode=0o700, exist_ok=True)
    (directory / 'state.json').write_text(json.dumps(state, sort_keys=True) + '\n')
    (directory / 'state.json').chmod(0o600)
    dump = docker('exec', PROJECT + '-geops-db-1', 'pg_dump', '-U', 'geops_stage',
                  '-d', 'geops_dev', '-Fc', bytes_output=True, timeout=120)
    backup_dir = Path('/var/lib/docker/volumes/geops_spec02_stage_backups/_data')
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup = backup_dir / 'geops-stage-replica.dump'
    backup.write_bytes(dump)
    (backup_dir / (backup.name + '.sha256')).write_text(sha(dump) + '\n')
    if not gate.is_file() or not dump:
        raise RuntimeError('B23 gate or backup missing')
    return active, sha((directory / 'state.json').read_bytes()), sha(dump)


def signed(key, kind, value):
    inbox = Path('/var/lib/geops-b30-staging/inbox')
    inbox.mkdir(parents=True, exist_ok=True, mode=0o700)
    body = (json.dumps(value, sort_keys=True) + '\n').encode()
    path = inbox / (value['id'] + '.' + kind + '.json')
    path.write_bytes(body)
    path.chmod(0o600)
    sig = inbox / (value['id'] + '.' + kind + '.sig')
    run(['openssl', 'pkeyutl', '-sign', '-inkey', str(key), '-rawin',
         '-in', str(path), '-out', str(sig)])
    sig.chmod(0o600)
    return sha(body)


def ready_package(wrapper_sha, policy_sha):
    key = ROOT / 'LAB_ONLY_private.pem'
    pub = ROOT / 'LAB_ONLY_public.pem'
    run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', str(key)])
    run(['openssl', 'pkey', '-in', str(key), '-pubout', '-out', str(pub)])
    key.chmod(0o600)
    prepared = Path('/imports/controller-b30-staging-controller-prepared.tar.gz')
    with tarfile.open(prepared, 'r:gz') as tar:
        items = {m.name: tar.extractfile(m).read() for m in tar.getmembers()}
    policy = json.loads(items['policy.json'])
    policy.pop('trustKey')
    policy.pop('bundleSignature')
    policy.update({'kind': 'B30_STAGING_READY', 'activation': 'READY',
                   'publicationReady': True, 'trustKeySha256': sha(pub.read_bytes()),
                   'registryDigests': {'api': API, 'web': WEB},
                   'sourceB23': {'wrapperSha256': wrapper_sha,
                                 'policySha256': policy_sha},
                   'mdmRegion': 'com'})
    items['public.pem'] = pub.read_bytes()
    policy['files']['public.pem'] = sha(items['public.pem'])
    items['policy.json'] = (json.dumps(policy, sort_keys=True, indent=2) + '\n').encode()
    package = ROOT / 'LAB_ONLY_ready.tar.gz'
    with package.open('xb') as raw:
        with gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w') as tar:
                for name, body in sorted(items.items()):
                    member = tarfile.TarInfo(name)
                    member.uid = member.gid = member.mtime = 0
                    member.mode = 0o444
                    member.size = len(body)
                    tar.addfile(member, io.BytesIO(body))
    digest = sha(package.read_bytes())
    message = ROOT / 'message'
    message.write_text('GEOPS-B30-STAGING-PACKAGE-SHA256\n' + digest + '\n')
    signature = ROOT / 'package.sig'
    run(['openssl', 'pkeyutl', '-sign', '-inkey', str(key), '-rawin',
         '-in', str(message), '-out', str(signature)])
    for path in (package, pub, signature):
        path.chmod(0o600)
    installer = ROOT / 'install.py'
    shutil.copyfile(STAGE / 'install.py', installer)
    installer.chmod(0o500)
    return key, pub, package, signature, digest


def install(wrapper_sha, policy_sha, pub, package, signature, digest):
    run(['useradd', '-m', 'abi'])
    result = run(['python3', '-I', str(ROOT / 'install.py'), 'from-b23',
                  str(package), str(signature), str(pub), digest, sha(pub.read_bytes()),
                  wrapper_sha, policy_sha])
    if json.loads(result)['activation'] != 'READY':
        raise RuntimeError('READY package not installed')
    run(['/usr/sbin/visudo', '-c'])
    if json.loads(run(['sudo', '-u', 'abi', 'sudo', '-n', WRAPPER, 'doctor']))['activation'] != 'READY':
        raise RuntimeError('Privileged doctor failed')


def privileged(*args, allow_fail=False):
    return run(['sudo', '-u', 'abi', 'sudo', '-n', WRAPPER, *args],
               allow_fail=allow_fail, timeout=360)


def docs(key, policy_sha, state_sha, backup_sha, gate, suffix):
    now = datetime.now(timezone.utc)
    window = {'notBefore': (now - timedelta(minutes=1)).isoformat().replace('+00:00','Z'),
              'expiresAt': (now + timedelta(minutes=25)).isoformat().replace('+00:00','Z')}
    release_id = 'replica-release-' + suffix + '-20261027'
    release = {'schemaVersion': 1, 'kind': 'release', 'id': release_id,
               'environment': PROJECT, **window,
               'commit': '2f89b87f1f636feb7e21d7e09af03959ee95f68d',
               'api': API, 'web': WEB, 'sqlCount': 30,
               'sqlListSha256': '64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6',
               'policySha256': policy_sha}
    release_sha = signed(key, 'release', release)
    restore_id = 'replica-restore-' + suffix + '-20261027'
    restore = {'schemaVersion': 1, 'kind': 'restore', 'id': restore_id,
               'environment': PROJECT, **window, 'backupSha256': backup_sha,
               'sqlCount': 23,
               'sqlListSha256': '90ae7681e90c6f9110071c140a73f028dd5d73344dcc9043cf9d50974ac9022d',
               'result': 'PASS', 'evidenceSha256': 'f' * 64,
               'policySha256': policy_sha}
    restore_sha = signed(key, 'restore', restore)
    approval_id = 'replica-approve-' + suffix + '-20261027'
    approval = {'schemaVersion': 1, 'kind': 'approval', 'id': approval_id,
                'environment': PROJECT, **window, 'action': 'promote-b23-b30',
                'releaseSha256': release_sha, 'sourceStateSha256': state_sha,
                'backupSha256': backup_sha, 'restoreProofSha256': restore_sha,
                'gateEpoch': gate['epoch'], 'policySha256': policy_sha}
    signed(key, 'approval', approval)
    return release_id, approval_id, restore_id


def recover_api(image, gate_path):
    request = str(uuid4())
    code = """import pg from 'pg';
import {recoverMaintenance} from './apps/api/dist/db/maintenance-recovery.js';
const p=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
const fs=await import('node:fs');
const gate=JSON.parse(fs.readFileSync('/geops-security/security-gate.json','utf8'));
try {const n=await recoverMaintenance(p,'/geops-security/security-gate.json',{
  target:'geops_dev',epoch:gate.epoch,requestId:process.env.REPLICA_REQUEST_ID,
  reason:'Synthetic supervised B30 staging replica recovery',
  adminEmail:'replica-admin@example.invalid',adminPassword:'synthetic-b30-replica-password',
  custodians:[{email:'custodian-one@example.invalid',password:'synthetic-b30-replica-password'},
  {email:'custodian-two@example.invalid',password:'synthetic-b30-replica-password'}],
  compatibleReleaseConfirmed:true});console.log('RECOVERED_SCHEMA='+n)}finally{await p.end()}
"""
    args = ['run', '--rm', '--network', 'geops_spec02_stage_db',
            '-e', 'DATABASE_URL=postgresql://geops_stage:' + PASSWORD + '@geops-db:5432/geops_dev',
            '-e', 'REPLICA_REQUEST_ID=' + request,
            '-v', 'geops_spec02_stage_security:/geops-security',
            '--entrypoint', 'node', image, '--input-type=module', '-e', code]
    result = docker(*args, timeout=300)
    expected = '23' if image == 'geops-b30-lab-api:b23' else '30'
    if 'RECOVERED_SCHEMA=' + expected not in result:
        raise RuntimeError('Supervised recovery result differs')
    if json.loads(gate_path.read_text())['phase'] != 'open':
        raise RuntimeError('Supervised recovery did not open gate')
    return request


def recovery_doc(key, policy_sha, approval_id, gate, count, request, suffix):
    now = datetime.now(timezone.utc)
    ledger = db('SELECT version||\'|\'||checksum FROM geops_schema_migrations ORDER BY version')
    digest = sha(ledger.encode())
    identity = 'replica-recovery-' + suffix + '-20261027'
    value = {'schemaVersion': 1, 'kind': 'recovery', 'id': identity,
             'environment': PROJECT,
             'notBefore': (now - timedelta(minutes=1)).isoformat().replace('+00:00','Z'),
             'expiresAt': (now + timedelta(minutes=20)).isoformat().replace('+00:00','Z'),
             'result': 'PASS', 'policySha256': policy_sha,
             'approvalId': approval_id, 'gateEpoch': gate['epoch'],
             'gateNonce': gate['nonce'], 'ledgerCount': count,
             'ledgerSha256': digest, 'auditRequestId': request}
    signed(key, 'recovery', value)
    return identity


def main():
    if os.geteuid() != 0 or not Path('/imports/replica-images-20261027.tar').exists():
        raise RuntimeError('Dedicated root replica runner required')
    checks = []
    if os.environ.get('REPLICA_RESUME_INSTALLED') == '1':
        gate_path = Path('/var/lib/docker/volumes/geops_spec02_stage_security/_data/security-gate.json')
        active = json.loads(Path('/var/lib/geops-deploy/state.json').read_text())['active']
        state_sha = sha(Path('/var/lib/geops-deploy/state.json').read_bytes())
        backup_sha = sha(Path('/var/lib/docker/volumes/geops_spec02_stage_backups/_data/geops-stage-replica.dump').read_bytes())
        key = ROOT / 'LAB_ONLY_private.pem'
        digest = sha((ROOT / 'LAB_ONLY_ready.tar.gz').read_bytes())
        wait_health('api')
        wait_health('web')
        if json.loads(privileged('doctor'))['activation'] != 'READY':
            raise RuntimeError('Installed privileged doctor failed')
        checks.extend(['real-compose-b23-services-healthy',
                       'synthetic-mdm-gps-b23-data',
                       'signed-ready-installer-real-sudo'])
    else:
        if os.environ.get('REPLICA_RESUME_BASELINE') == '1':
            wrapper_sha, policy_sha = setup_files()
            gate_path = Path('/var/lib/docker/volumes/geops_spec02_stage_security/_data/security-gate.json')
            wait_health('api')
            wait_health('web')
        else:
            wrapper_sha, policy_sha = setup_files()
            gate_path = baseline()
        checks.append('real-compose-b23-services-healthy')
        checks.append('synthetic-mdm-gps-b23-data')
        active, state_sha, backup_sha = state_and_backup(gate_path)
        key, pub, package, signature, digest = ready_package(wrapper_sha, policy_sha)
        install(wrapper_sha, policy_sha, pub, package, signature, digest)
        checks.append('signed-ready-installer-real-sudo')
    policy_hash = sha(Path('/opt/geops-b30-staging/policy.json').read_bytes())
    gate = json.loads(gate_path.read_text())
    release, approval, restore = docs(key, policy_hash, state_sha, backup_sha, gate, 'premig')
    if json.loads(privileged('prepare', release))['result'] != 'B30_STAGING_PREPARED':
        raise RuntimeError('Controller prepare failed')
    if json.loads(privileged('begin', release, approval, restore))['result'] != 'B30_STAGING_MAINTENANCE_READY':
        raise RuntimeError('Controller begin failed')
    checks.append('real-controller-b23-drained-gate-closed')
    (ROOT / 'fault-command').write_text('before-migrate')
    if privileged('migrate', allow_fail=True).returncode == 0 or \
       db('SELECT count(*) FROM geops_schema_migrations') != '23':
        raise RuntimeError('Pre-migration fault did not preserve B23')
    checks.append('injected-pre-migration-command-failure')
    if json.loads(privileged('recover', 'replica-recovery-premig-20261027'))['result'] != 'AWAITING_SUPERVISED_GATE_RECOVERY':
        raise RuntimeError('Premigration gate bypassed')
    request = recover_api('geops-b30-lab-api:b23', gate_path)
    gate = json.loads(gate_path.read_text())
    proof = recovery_doc(key, policy_hash, approval, gate, 23, request, 'premig')
    if json.loads(privileged('recover', proof))['result'] != 'B23_STAGING_RESTORED':
        raise RuntimeError('B23 recovery failed')
    wait_health('api')
    wait_health('web')
    checks.append('premigration-failure-supervised-b23-recovery')
    Path('/var/lib/geops-b30-staging/promotion.json').unlink()
    release, approval, restore = docs(key, policy_hash, state_sha, backup_sha, gate, 'postmig')
    privileged('prepare', release)
    privileged('begin', release, approval, restore)
    if json.loads(privileged('migrate'))['result'] != 'B30_AWAITING_SUPERVISED_GATE_RECOVERY':
        raise RuntimeError('Controller B30 migration failed')
    if db('SELECT count(*) FROM geops_schema_migrations') != '30':
        raise RuntimeError('B30 ledger count differs')
    checks.append('real-controller-b23-to-b30-thirty-migrations')
    if json.loads(privileged('recover', 'replica-recovery-postmig-20261027'))['result'] != 'AWAITING_SUPERVISED_GATE_RECOVERY':
        raise RuntimeError('Postmigration gate bypassed')
    if run(['sudo', '-u', 'abi', 'sudo', '-n', '/usr/local/sbin/geops-deploy-v2', 'verify'],
           allow_fail=True).returncode == 0:
        raise RuntimeError('Legacy B23 sudo still active after B30 migration')
    checks.append('b23-controller-blocked-at-schema30')
    request = recover_api('geops-b30-staging-api:2f89b87', gate_path)
    gate = json.loads(gate_path.read_text())
    proof = recovery_doc(key, policy_hash, approval, gate, 30, request, 'postmig')
    (ROOT / 'fault-command').write_text('after-migrate')
    if privileged('recover', proof, allow_fail=True).returncode == 0 or \
       db('SELECT count(*) FROM geops_schema_migrations') != '30':
        raise RuntimeError('Post-migration fault not isolated')
    checks.append('injected-post-migration-start-failure')
    if json.loads(privileged('recover', proof))['result'] != 'B30_STAGING_PROMOTED':
        raise RuntimeError('B30 forward recovery failed')
    if json.loads(privileged('verify'))['result'] != 'B30_STAGING_VERIFIED':
        raise RuntimeError('B30 verification failed')
    if json.loads(privileged('recover', proof))['result'] != 'ALREADY_COMPLETE':
        raise RuntimeError('B30 recovery not idempotent')
    checks.append('postmigration-failure-supervised-b30-recovery-idempotent')
    if db("SELECT count(*) FROM mdm_binding") != '1' or \
       db("SELECT count(*) FROM gps_device_installation") != '1' or \
       db("SELECT count(*) FROM position_event") != '0':
        raise RuntimeError('Synthetic MDM/GPS state changed')
    docker('exec', PROJECT + '-geops-api-1', 'node', '-e',
           "Promise.all(['/health/live','/health/ready'].map(p=>fetch('http://127.0.0.1:3500'+p).then(r=>{if(!r.ok)throw Error(p)}))).catch(()=>process.exit(1))")
    docker('exec', PROJECT + '-geops-web-1', 'wget', '-q', '-O', '/dev/null',
           'http://127.0.0.1:8080/health')
    checks.append('api-web-mdm-gps-smoke-after-upgrade')
    old_readiness = "import pg from 'pg';import {checkReadiness} from './apps/api/dist/db/migration-manager.js';const p=new pg.Pool({connectionString:process.env.DATABASE_URL});try{console.log('OLD_READY='+await checkReadiness(p))}finally{await p.end()}"
    if 'OLD_READY=false' not in node_in_api(old_readiness, image='geops-b30-lab-api:b23'):
        raise RuntimeError('B23 API unexpectedly accepts schema30')
    checks.append('b23-api-readiness-rejects-schema30')
    journal = json.loads(Path('/var/lib/geops-b30-staging/promotion.json').read_text())
    if journal['phase'] != 'complete' or journal['targetLedger'] != \
       '64e38eec0df1c0e32890cbed3dcee055482575730ada9d4e5899baf792dfa7f6':
        raise RuntimeError('Final journal differs')
    checks.append('journal-ledger-gate-complete')
    key.unlink()
    return {'result': 'B30_STAGING_REPLICA_REAL_DOCKER_PASS', 'checks': checks,
            'count': len(checks), 'packageSha256': digest,
            'gate': gate['phase'], 'schema': 30, 'journalPhase': journal['phase'],
            'syntheticDigestAdapter': True}


if __name__ == '__main__':
    print(json.dumps(main(), sort_keys=True))
