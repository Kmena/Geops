#!/usr/bin/python3 -I
"""Signed, supervised B30→B31 staging promotion."""
import fcntl
import hashlib
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

here = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('b30_controller_base', here.parent / 'b30-staging/controller.py')
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

B30 = base.B30
B31 = '17cf75b6e88193552efb799ab33b94d44d3a17bc19c0eb15e6c9f0a77d7e9ea0'
APP_COMMIT = 'eba9b3ba3cf1927dcbf032070322fa32dbfe4db3'
CANDIDATE_SHA = '2cebd7f253f87efbc936d1ae08b429de0b5ddbd3a6d44d243d3520a99aae7061'
B30_COMMIT = '2f89b87f1f636feb7e21d7e09af03959ee95f68d'
B30_API = 'ghcr.io/kmena/geops-api@sha256:42c1eeb392f8e8b23199a2536724910dc32721074c9c0784a3fcb9207a9ffe9d'
B30_WEB = 'ghcr.io/kmena/geops-web@sha256:2b59828bf0d50c29eaf87bb2f7fa3499e03da814d66ca56dd76971adb1a15483'
B30_RULE = (b'Defaults!/usr/local/sbin/geops-b30-staging env_reset\n'
            b'Defaults!/usr/local/sbin/geops-b30-staging secure_path="/usr/sbin:/usr/bin:/sbin:/bin"\n'
            b'abi ALL=(root) NOPASSWD: /usr/local/sbin/geops-b30-staging\n')
B30_DISABLED = b'# B30 controller suspended during supervised B31 promotion\n'
B31_V3_POLICY = '75bbaf0a2cb9a57a4aecd05ea00ae46b96430a6d2f24f39e2baae6262be931a0'
Blocked = base.Blocked
sha = base.sha
protected = base.protected
atomic = base.atomic


class Controller(base.Controller):
    def __init__(self, base_path=Path('/'), runner=None, enforce_root=True):
        super().__init__(base_path, runner, enforce_root)
        self.bundle = self.base / 'opt/geops-b31-staging'
        self.state_dir = self.base / 'var/lib/geops-b31-staging'
        self.journal = self.state_dir / 'promotion.json'
        self.used = self.state_dir / 'used'
        self.b30 = self.base / 'opt/geops-b30-staging'
        self.b30_wrapper = self.base / 'usr/local/sbin/geops-b30-staging'
        self.b30_rule = self.base / 'etc/sudoers.d/geops-b30-staging'
        self.b30_journal = self.base / 'var/lib/geops-b30-staging/promotion.json'
        self.b30_install = self.base / 'var/lib/geops-b30-staging/install.json'

    def load_policy(self):
        paths = (self.bundle, self.bundle / 'policy.json', self.bundle / 'policy.sha256',
                 self.bundle / 'public.pem', self.b30, self.b30_wrapper,
                 self.b30 / 'policy.json', self.b30_rule, self.b30_journal,
                 self.b30_install, self.v2, self.v2 / 'policy.json', self.state_dir)
        if self.enforce_root:
            for path in paths:
                protected(path)
        body = (self.bundle / 'policy.json').read_bytes()
        pin = (self.bundle / 'policy.sha256').read_text().strip()
        if not base.SHA.fullmatch(pin) or sha(body) != pin:
            raise Blocked('B31 signed policy pin differs')
        policy = json.loads(body)
        if (policy.get('schemaVersion') != 1 or policy.get('kind') != 'B31_STAGING_READY' or
                policy.get('environment') != base.PROJECT or
                policy.get('activation') != 'READY' or
                policy.get('publicationReady') is not True or
                policy.get('applicationCommit') != APP_COMMIT or
                policy.get('candidateManifestSha256') != CANDIDATE_SHA or
                policy.get('migrations') != {'sourceCount': 30, 'sourceListSha256': B30,
                                             'targetCount': 31, 'targetListSha256': B31} or
                policy.get('sourceB30') != {
                    'wrapperSha256': 'acc2d33361a27ba30f2639e0cb9c21f0b65bd0601d0cbef22300e439a21c9136',
                    'policySha256': '9fa338195b9a121df31421771f706fbc4d779b2b197b64650d77ae87f81c9752',
                    'packageSha256': 'e3cb0e42d3ab5018f9df2fe83a6decfdb5b771bb26f11936707fc2d3bedccea0'
                } or not base.SHA.fullmatch(policy.get('trustKeySha256', '')) or
                sha((self.bundle / 'public.pem').read_bytes()) != policy['trustKeySha256'] or
                policy.get('mdmRegion') != 'com'):
            raise Blocked('B31 staging policy or source compatibility differs')
        digests = policy.get('registryDigests')
        if (not isinstance(digests, dict) or set(digests) != {'api', 'web'} or
                any(not isinstance(digests[name], str) or
                    not base.IMAGE.fullmatch(digests[name]) or
                    not digests[name].startswith('ghcr.io/kmena/geops-' + name + '@')
                    for name in ('api', 'web'))):
            raise Blocked('B31 registry digests invalid')
        files = policy.get('files')
        if not isinstance(files, dict) or not files:
            raise Blocked('B31 package inventory missing')
        for name, digest in files.items():
            member = Path(name)
            if member.is_absolute() or '..' in member.parts or not base.SHA.fullmatch(digest):
                raise Blocked('B31 package member invalid')
            path = self.bundle / member
            if self.enforce_root:
                protected(path, regular=True)
            if sha(path.read_bytes()) != digest:
                raise Blocked('B31 package member changed')
        self.policy, self.policy_bytes = policy, body
        self.old_policy = json.loads((self.v2 / 'policy.json').read_bytes())
        if (self.old_policy.get('schemaVersion') != 2 or
                self.old_policy.get('environment') != base.PROJECT or
                self.old_policy.get('origin') != 'https://geops-staging.duckdns.org' or
                self.old_policy.get('secretGid') != '24001' or
                self.old_policy.get('mdm', {}).get('region') != 'com' or
                not re.fullmatch(r'[a-f0-9]{40}', self.old_policy.get('imageTag', ''))):
            raise Blocked('Staging Compose source policy differs')
        return policy

    def source(self):
        for path in (self.b30_wrapper, self.b30 / 'policy.json', self.b30_rule,
                     self.b30_journal, self.b30_install):
            if self.enforce_root:
                protected(path, regular=True)
        identity = self.policy['sourceB30']
        if (sha(self.b30_wrapper.read_bytes()) != identity['wrapperSha256'] or
                sha((self.b30 / 'policy.json').read_bytes()) != identity['policySha256'] or
                self.b30_rule.read_bytes() != B30_RULE):
            raise Blocked('Installed B30 controller identity changed')
        installation = json.loads(self.b30_install.read_bytes())
        if (installation.get('packageSha256') != identity['packageSha256'] or
                installation.get('phase') != 'prepared-complete'):
            raise Blocked('Installed B30 bundle record differs')
        observed = json.loads(self.call([str(self.b30_wrapper), 'verify']))
        if observed.get('result') != 'B30_STAGING_VERIFIED':
            raise Blocked('B30 source verification failed')
        for name in base.FILES:
            existing = self.v2 / 'bundle' / name
            packaged = self.bundle / name
            if self.enforce_root:
                protected(existing, regular=True)
                protected(packaged, regular=True)
            if sha(existing.read_bytes()) != self.old_policy.get('files', {}).get(name):
                raise Blocked('Installed Compose differs from protected source')
            if existing.read_bytes() != packaged.read_bytes():
                raise Blocked('B31 packaged Compose differs byte-for-byte')
        body = self.b30_journal.read_bytes()
        journal = json.loads(body)
        target = journal.get('target', {})
        if (journal.get('phase') != 'complete' or journal.get('targetLedger') != B30 or
                target.get('commit') != B30_COMMIT or target.get('apiRef') != B30_API or
                target.get('webRef') != B30_WEB or
                not all(re.fullmatch(r'sha256:[a-f0-9]{64}', target.get(key, '')) for key in ('apiId', 'webId'))):
            raise Blocked('Completed B30 source journal differs')
        return target, sha(body)

    def ledger(self):
        lines = self.docker('exec', base.SERVICES['db'], 'psql', '-X', '-v',
                            'ON_ERROR_STOP=1', '-U', 'geops_stage', '-d', 'geops_dev',
                            '-Atq', '-c',
                            'SELECT version,checksum FROM geops_schema_migrations ORDER BY version',
                            timeout=15).splitlines()
        manifest_path = self.bundle / 'specs/spec-03-clients-geofences-routes/b31-staging-candidate.json'
        body = manifest_path.read_bytes()
        if sha(body) != self.policy['candidateManifestSha256']:
            raise Blocked('B31 candidate manifest changed')
        expected = [item['version'] + '|' + item['sha256']
                    for item in json.loads(body)['database']['migrations']]
        if (not all(base.SQL.fullmatch(line) for line in lines) or
                len(expected) != 31 or len(lines) not in (30, 31) or
                lines != expected[:len(lines)]):
            raise Blocked('Unapproved B30/B31 migration ledger')
        result = {'count': len(lines), 'sha256': sha('\n'.join(lines).encode())}
        if result['sha256'] != (B30 if len(lines) == 30 else B31):
            raise Blocked('B30/B31 ledger hash differs')
        return result

    def release(self, identity):
        value, digest = self.signed('release', identity)
        if (set(value) != {'schemaVersion', 'kind', 'id', 'environment', 'notBefore',
                           'expiresAt', 'commit', 'api', 'web', 'sqlCount',
                           'sqlListSha256', 'policySha256'} or
                value['schemaVersion'] != 1 or value['commit'] != APP_COMMIT or
                value['api'] != self.policy['registryDigests']['api'] or
                value['web'] != self.policy['registryDigests']['web'] or
                value['sqlCount'] != 31 or value['sqlListSha256'] != B31 or
                value['policySha256'] != sha(self.policy_bytes)):
            raise Blocked('B31 release differs from signed staging policy')
        return value, digest

    def restore_proof(self, identity, backup_sha):
        value, digest = self.signed('restore', identity)
        if (set(value) != {'schemaVersion', 'kind', 'id', 'environment', 'notBefore',
                           'expiresAt', 'backupSha256', 'sqlCount', 'sqlListSha256',
                           'result', 'evidenceSha256', 'policySha256'} or
                value['schemaVersion'] != 1 or value['backupSha256'] != backup_sha or
                value['sqlCount'] != 30 or value['sqlListSha256'] != B30 or
                value['result'] != 'PASS' or
                not base.SHA.fullmatch(value['evidenceSha256']) or
                value['policySha256'] != sha(self.policy_bytes)):
            raise Blocked('B30 restore proof differs from signed backup')
        return digest

    def approval(self, identity, release_sha, source_sha, backup_sha, restore_sha, epoch):
        value, _ = self.signed('approval', identity)
        if (set(value) != {'schemaVersion', 'kind', 'id', 'environment', 'notBefore',
                           'expiresAt', 'action', 'releaseSha256', 'sourceStateSha256',
                           'backupSha256', 'restoreProofSha256', 'gateEpoch', 'policySha256'} or
                value['schemaVersion'] != 1 or value['action'] != 'promote-b30-b31' or
                value['releaseSha256'] != release_sha or
                value['sourceStateSha256'] != source_sha or
                value['backupSha256'] != backup_sha or
                value['restoreProofSha256'] != restore_sha or
                value['gateEpoch'] != epoch or
                value['policySha256'] != sha(self.policy_bytes) or
                (self.used / identity).exists()):
            raise Blocked('Approval does not bind exact B30→B31 transition')

    def image(self, ref, service):
        info = json.loads(self.docker('image', 'inspect', ref, '--format', '{{json .}}'))
        labels = info.get('Config', {}).get('Labels') or {}
        if (ref not in info.get('RepoDigests', []) or
                not re.fullmatch(r'sha256:[a-f0-9]{64}', info.get('Id', '')) or
                labels.get('org.opencontainers.image.revision') != APP_COMMIT or
                labels.get('org.geops.' + service + '.variant') != 'B31-integrated' or
                (service == 'api' and
                 labels.get('org.geops.maintenance.recovery.max_schema') != '31') or
                (service == 'web' and labels.get('org.geops.web.mdm_enabled') != 'true')):
            raise Blocked('B31 image digest, provenance or variant differs')
        return info['Id']

    def target(self, release):
        api, web = release['api'], release['web']
        api_id, web_id = self.image(api, 'api'), self.image(web, 'web')
        script = ('const fs=require("fs"),c=require("crypto"),p="/work/apps/api/dist/db/migrations";'
                  'const n=fs.readdirSync(p).filter(x=>/^[0-9]{4}_[a-z0-9_]+\\.sql$/.test(x)).sort();'
                  'const s=n.map(x=>x+"|"+c.createHash("sha256").update(fs.readFileSync(p+"/"+x)).digest("hex")).join("\\n");'
                  'const r=fs.readFileSync("/work/apps/api/dist/db/maintenance-recovery.js","utf8");'
                  'console.log(JSON.stringify({count:n.length,sha256:c.createHash("sha256").update(s).digest("hex"),'
                  'recovery31:r.includes("RECOVERY_TARGET_SCHEMA = 31")}))')
        sql = json.loads(self.docker('run', '--rm', '--network', 'none', '--read-only',
                                     '--pull', 'never', '--entrypoint', 'node', api, '-e', script))
        if sql != {'count': 31, 'sha256': B31, 'recovery31': True}:
            raise Blocked('B31 image migration or recovery inventory differs')
        self.verify_compose(api, web)
        return {'apiRef': api, 'webRef': web, 'apiId': api_id,
                'webId': web_id, 'commit': APP_COMMIT}

    def journal_data(self):
        if not self.journal.exists():
            return None
        if self.enforce_root:
            protected(self.journal, regular=True)
        value = json.loads(self.journal.read_bytes())
        if (value.get('schemaVersion') != 1 or
                value.get('phase') not in ('draining', 'maintenance', 'migrating',
                                           'awaiting-recovery', 'resuming', 'complete', 'aborted') or
                value.get('sourceLedger') != B30 or value.get('targetLedger') != B31 or
                not all(base.SHA.fullmatch(value.get(key, '')) for key in
                        ('policySha256', 'backupSha256', 'sourceStateSha256', 'releaseSha256')) or
                not base.IDENT.fullmatch(value.get('approvalId', '')) or
                not re.fullmatch(r'[a-f0-9-]{36}', value.get('gateEpoch', '')) or
                not isinstance(value.get('target'), dict) or
                set(value['target']) != {'apiRef', 'webRef', 'apiId', 'webId', 'commit'}):
            raise Blocked('Invalid B31 promotion journal')
        return value

    def disable_b30(self):
        body = self.b30_rule.read_bytes()
        if body == B30_DISABLED:
            return
        if body != B30_RULE:
            raise Blocked('Unexpected B30 sudoers rule')
        atomic(self.b30_rule, B30_DISABLED, 0o440)

    def stop(self, journal):
        self.disable_b30()
        for service in ('geops-web', 'geops-api'):
            self.compose(journal['source']['apiRef'], journal['source']['webRef'],
                         command=['stop', service])
        if any(self.container(name)['status'] != 'exited' for name in ('api', 'web')):
            raise Blocked('B30 application did not stop')

    def execute(self, command, release_id=None, approval_id=None, restore_id=None):
        self.load_policy()
        self.context()
        journal = self.journal_data()
        if command == 'status':
            return {'result': 'B31_STAGING_STATUS', 'journal': journal,
                    'ledger': self.ledger(), 'gate': self.gate()['phase']}
        if command == 'prepare':
            if journal is not None:
                raise Blocked('B31 promotion already journaled')
            source, source_sha = self.source()
            release, digest = self.release(release_id)
            target = self.target(release)
            if self.ledger() != {'count': 30, 'sha256': B30} or self.gate()['phase'] != 'open':
                raise Blocked('Healthy B30 ledger and gate required')
            if any(self.container(name)['health'] != 'healthy' for name in ('api', 'web', 'db')):
                raise Blocked('B30 services unhealthy')
            return {'result': 'B31_STAGING_PREPARED', 'releaseSha256': digest,
                    'sourceStateSha256': source_sha, 'target': target, 'source': source}
        if command == 'begin':
            ready = self.execute('prepare', release_id)
            backup_sha = self.backup()
            epoch = self.gate()['epoch']
            restore_sha = self.restore_proof(restore_id, backup_sha)
            self.approval(approval_id, ready['releaseSha256'], ready['sourceStateSha256'],
                          backup_sha, restore_sha, epoch)
            journal = {'schemaVersion': 1, 'phase': 'draining', 'source': ready['source'],
                       'sourceStateSha256': ready['sourceStateSha256'],
                       'target': ready['target'], 'sourceLedger': B30, 'targetLedger': B31,
                       'policySha256': sha(self.policy_bytes), 'backupSha256': backup_sha,
                       'restoreProofSha256': restore_sha, 'gateEpoch': epoch,
                       'releaseSha256': ready['releaseSha256'], 'approvalId': approval_id}
            self.save(journal)
            self.used.mkdir(mode=0o700, exist_ok=True)
            atomic(self.used / approval_id, b'consumed\n')
            self.stop(journal)
            if self.gate()['phase'] != 'open':
                raise Blocked('Gate changed before B31 maintenance')
            self.compose(ready['target']['apiRef'], ready['target']['webRef'],
                         command=['run', '--rm', '--no-deps',
                                  '-e', 'GEOPS_CONFIRM_MAINTENANCE_TARGET=geops_dev',
                                  '-e', 'GEOPS_CONFIRM_MAINTENANCE_EPOCH=' + epoch,
                                  'geops-gate-init', 'gate', 'maintenance-start'])
            gate = self.gate()
            if gate['phase'] != 'maintenance':
                raise Blocked('B31 gate failed to close')
            journal['gateNonce'] = gate['nonce']
            journal['phase'] = 'maintenance'
            self.save(journal)
            return {'result': 'B31_STAGING_MAINTENANCE_READY', 'gateEpoch': epoch}
        if journal is None:
            raise Blocked('No supervised B31 promotion')
        if journal['policySha256'] != sha(self.policy_bytes):
            # A signed controller-only repair changes the policy hash while
            # the failed v3 attempt remains in draining. Permit only its
            # pre-maintenance B30 recovery; all migration paths stay pinned.
            if not (command == 'recover' and journal['phase'] in ('draining', 'aborted') and
                    journal['policySha256'] == B31_V3_POLICY and
                    self.gate()['phase'] == 'open' and
                    self.ledger() == {'count': 30, 'sha256': B30}):
                raise Blocked('B31 policy changed during promotion')
        if command == 'migrate':
            if journal['phase'] not in ('maintenance', 'migrating'):
                raise Blocked('B31 migration phase differs')
            before = self.ledger()
            if (before['count'] not in (30, 31) or self.gate()['phase'] != 'maintenance' or
                    any(self.container(name)['status'] != 'exited' for name in ('api', 'web'))):
                raise Blocked('B31 migration preconditions differ')
            journal['phase'] = 'migrating'
            self.save(journal)
            if before['count'] == 30:
                self.compose(journal['target']['apiRef'], journal['target']['webRef'],
                             migration=True,
                             command=['run', '--rm', '--no-deps',
                                      '-e', 'GEOPS_CONFIRM_MAINTENANCE_EPOCH=' + journal['gateEpoch'],
                                      'geops-migrate'])
            if self.ledger() != {'count': 31, 'sha256': B31}:
                raise Blocked('B31 migration ledger not exact')
            journal['phase'] = 'awaiting-recovery'
            self.save(journal)
            return {'result': 'B31_AWAITING_SUPERVISED_GATE_RECOVERY'}
        if command == 'recover':
            if journal['phase'] in ('complete', 'aborted'):
                wanted = 31 if journal['phase'] == 'complete' else 30
                if self.ledger()['count'] != wanted or self.gate()['phase'] != 'open':
                    raise Blocked('Completed B31 recovery state differs')
                return {'result': 'ALREADY_' + journal['phase'].upper()}
            ledger, gate = self.ledger(), self.gate()
            if gate['epoch'] != journal['gateEpoch']:
                raise Blocked('Security epoch changed during B31 promotion')
            # An open B30 gate already has a nonce from the previous promotion.
            # It is not proof that this B31 attempt entered maintenance. During
            # draining, compare it with the pinned B30 source journal first.
            if (journal['phase'] == 'draining' and gate['phase'] == 'open' and
                    ledger == {'count': 30, 'sha256': B30}):
                source_body = self.b30_journal.read_bytes()
                if sha(source_body) != journal['sourceStateSha256']:
                    raise Blocked('B30 source journal changed during recovery')
                source_journal = json.loads(source_body)
                if (source_journal.get('phase') != 'complete' or
                        source_journal.get('gateNonce') != gate.get('nonce') or
                        source_journal.get('gateEpoch') != gate['epoch'] or
                        journal.get('gateNonce', gate.get('nonce')) != gate.get('nonce')):
                    raise Blocked('Open B30 gate does not match source journal')
                self.start(journal, journal['source'])
                atomic(self.b30_rule, B30_RULE, 0o440)
                journal['phase'] = 'aborted'
                self.save(journal)
                return {'result': 'B30_STAGING_RESTORED_BEFORE_MAINTENANCE'}
            if 'gateNonce' not in journal and gate.get('nonce'):
                journal['gateNonce'] = gate['nonce']
                self.save(journal)
            if gate['phase'] != 'open':
                return {'result': 'AWAITING_SUPERVISED_GATE_RECOVERY',
                        'ledger': ledger, 'gate': gate['phase']}
            self.recovery_proof(release_id, journal, ledger, gate)
            if ledger == {'count': 31, 'sha256': B31}:
                journal['phase'] = 'resuming'
                self.save(journal)
                self.start(journal, journal['target'])
                journal['phase'] = 'complete'
                self.save(journal)
                return {'result': 'B31_STAGING_PROMOTED'}
            if ledger == {'count': 30, 'sha256': B30}:
                self.start(journal, journal['source'])
                atomic(self.b30_rule, B30_RULE, 0o440)
                journal['phase'] = 'aborted'
                self.save(journal)
                return {'result': 'B30_STAGING_RESTORED'}
            raise Blocked('Unknown B31 recovery ledger; downgrade forbidden')
        if command == 'verify':
            if journal['phase'] != 'complete' or self.ledger() != {'count': 31, 'sha256': B31}:
                raise Blocked('B31 promotion incomplete')
            if self.gate()['phase'] != 'open':
                raise Blocked('Staging gate remains closed')
            target = journal['target']
            if (self.container('api')['image'] != target['apiId'] or
                    self.container('web')['image'] != target['webId'] or
                    any(self.container(name)['health'] != 'healthy' for name in ('api', 'web', 'db'))):
                raise Blocked('B31 services differ from approved images')
            self.verify_secrets()
            return {'result': 'B31_STAGING_VERIFIED'}
        raise Blocked('Unknown B31 staging operation')


def main(argv):
    arguments = {'status': 0, 'prepare': 1, 'begin': 3, 'migrate': 0, 'recover': 1, 'verify': 0}
    if (os.geteuid() != 0 or not argv or argv[0] not in arguments or
            len(argv) - 1 != arguments[argv[0]] or
            any(not base.IDENT.fullmatch(value) for value in argv[1:])):
        raise Blocked('Root and fixed B31 command syntax required')
    controller = Controller()
    protected(controller.state_dir)
    lock = os.open(controller.state_dir / 'controller.lock',
                   os.O_WRONLY | os.O_CREAT | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(controller.execute(argv[0], *argv[1:]), sort_keys=True))
    finally:
        os.close(lock)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except Exception as error:
        print('GEOPS B31 staging controller BLOCKED: ' + str(error), file=sys.stderr)
        sys.exit(1)
