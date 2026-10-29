#!/usr/bin/python3 -I
"""Signed, supervised B31→B32 staging promotion."""
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

B31 = '17cf75b6e88193552efb799ab33b94d44d3a17bc19c0eb15e6c9f0a77d7e9ea0'
B32 = 'd4730ee35c02af8976f1b7a642c305ea0304448742f9d54a5ff829336752074a'
APP_COMMIT = '06b6599779bbf95a45576d9bda581119ddce27de'
CANDIDATE_SHA = 'c1011f3235d9efd25fdee1336f3a882babd0cbb640d05e3494b27ccc3b176e3f'
B31_COMMIT = 'eba9b3ba3cf1927dcbf032070322fa32dbfe4db3'
B31_API = 'ghcr.io/kmena/geops-api@sha256:14e004b341ba6a4173a66ffe506fa8d2d7ca4f22dc5a033248f7af775f38c17c'
B31_WEB = 'ghcr.io/kmena/geops-web@sha256:6467721d823c142257205927d2ab6d31d916ac941c15645815db692a2f524ff8'
B31_RULE = (b'Defaults!/usr/local/sbin/geops-b31-staging env_reset\n'
            b'Defaults!/usr/local/sbin/geops-b31-staging secure_path="/usr/sbin:/usr/bin:/sbin:/bin"\n'
            b'abi ALL=(root) NOPASSWD: /usr/local/sbin/geops-b31-staging\n')
B31_DISABLED = b'# B31 controller suspended during supervised B32 promotion\n'
Blocked = base.Blocked
sha = base.sha
protected = base.protected
atomic = base.atomic


class Controller(base.Controller):
    def __init__(self, base_path=Path('/'), runner=None, enforce_root=True):
        super().__init__(base_path, runner, enforce_root)
        self.bundle = self.base / 'opt/geops-b32-staging'
        self.state_dir = self.base / 'var/lib/geops-b32-staging'
        self.journal = self.state_dir / 'promotion.json'
        self.used = self.state_dir / 'used'
        self.b31 = self.base / 'opt/geops-b31-staging'
        self.b31_wrapper = self.base / 'usr/local/sbin/geops-b31-staging'
        self.b31_rule = self.base / 'etc/sudoers.d/geops-b31-staging'
        self.b31_journal = self.base / 'var/lib/geops-b31-staging/promotion.json'
        self.b31_install = self.base / 'var/lib/geops-b31-staging/install.json'

    def load_policy(self):
        paths = (self.bundle, self.bundle / 'policy.json', self.bundle / 'policy.sha256',
                 self.bundle / 'public.pem', self.b31, self.b31_wrapper,
                 self.b31 / 'policy.json', self.b31_rule, self.b31_journal,
                 self.b31_install, self.v2, self.v2 / 'policy.json', self.state_dir)
        if self.enforce_root:
            for item in paths:
                protected(item)
        body = (self.bundle / 'policy.json').read_bytes()
        pin = (self.bundle / 'policy.sha256').read_text().strip()
        if not base.SHA.fullmatch(pin) or sha(body) != pin:
            raise Blocked('B32 signed policy pin differs')
        policy = json.loads(body)
        if (policy.get('schemaVersion') != 1 or policy.get('kind') != 'B32_STAGING_READY' or
                policy.get('environment') != base.PROJECT or
                policy.get('activation') != 'READY' or
                policy.get('publicationReady') is not True or
                policy.get('applicationCommit') != APP_COMMIT or
                not re.fullmatch(r'[a-f0-9]{40}', policy.get('promotionCommit', '')) or
                policy.get('candidateManifestSha256') != CANDIDATE_SHA or
                policy.get('migrations') != {'sourceCount': 31, 'sourceListSha256': B31,
                                             'targetCount': 33, 'targetListSha256': B32} or
                policy.get('sourceB31') != {
                    'wrapperSha256': '8dabed2dee1e82e994295e71952ee3f6f2cf140fd6d16e0063977153c7a4297c',
                    'policySha256': '89b5de6f15cc547244982fb1af250fa6dc9fff3a12ce1b0b2298de64401dc3eb'
                } or not base.SHA.fullmatch(policy.get('trustKeySha256', '')) or
                sha((self.bundle / 'public.pem').read_bytes()) != policy['trustKeySha256'] or
                policy.get('mdmRegion') != 'com'):
            raise Blocked('B32 staging policy or source compatibility differs')
        refs = policy.get('registryDigests')
        if (not isinstance(refs, dict) or set(refs) != {'api', 'web', 'recovery'} or
                any(not isinstance(refs[name], str) or
                    not base.IMAGE.fullmatch(refs[name]) or
                    not refs[name].startswith('ghcr.io/kmena/geops-' +
                                              ('web' if name == 'web' else 'api') + '@')
                    for name in refs)):
            raise Blocked('B32 registry digests invalid')
        files = policy.get('files')
        if not isinstance(files, dict) or not files:
            raise Blocked('B32 package inventory missing')
        for name, digest in files.items():
            member = Path(name)
            if member.is_absolute() or '..' in member.parts or not base.SHA.fullmatch(digest):
                raise Blocked('B32 package member invalid')
            item = self.bundle / member
            if self.enforce_root:
                protected(item, regular=True)
            if sha(item.read_bytes()) != digest:
                raise Blocked('B32 package member changed')
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
        for item in (self.b31_wrapper, self.b31 / 'policy.json', self.b31_rule,
                     self.b31_journal, self.b31_install):
            if self.enforce_root:
                protected(item, regular=True)
        identity = self.policy['sourceB31']
        if (sha(self.b31_wrapper.read_bytes()) != identity['wrapperSha256'] or
                sha((self.b31 / 'policy.json').read_bytes()) != identity['policySha256'] or
                self.b31_rule.read_bytes() != B31_RULE or
                self.b31_wrapper.read_bytes() !=
                (self.b31 / 'scripts/deploy/b31-staging/guard.py').read_bytes()):
            raise Blocked('Installed B31 controller identity changed')
        installation = json.loads(self.b31_install.read_bytes())
        if installation.get('phase') != 'prepared-complete':
            raise Blocked('Installed B31 bundle record differs')
        for command, expected in (('doctor', 'B31_STAGING_PACKAGE_VERIFIED'),
                                  ('verify', 'B31_STAGING_VERIFIED')):
            observed = json.loads(self.call([str(self.b31_wrapper), command]))
            if observed.get('result') != expected:
                raise Blocked('B31 source verification failed')
        for name in base.FILES:
            existing = self.v2 / 'bundle' / name
            packaged = self.bundle / name
            if self.enforce_root:
                protected(existing, regular=True)
                protected(packaged, regular=True)
            if (sha(existing.read_bytes()) != self.old_policy.get('files', {}).get(name) or
                    existing.read_bytes() != packaged.read_bytes()):
                raise Blocked('B32 packaged Compose differs from installed source')
        body = self.b31_journal.read_bytes()
        journal = json.loads(body)
        target = journal.get('target', {})
        if (journal.get('phase') != 'complete' or journal.get('targetLedger') != B31 or
                target.get('commit') != B31_COMMIT or target.get('apiRef') != B31_API or
                target.get('webRef') != B31_WEB or
                not all(re.fullmatch(r'sha256:[a-f0-9]{64}', target.get(key, ''))
                        for key in ('apiId', 'webId'))):
            raise Blocked('Completed B31 source journal differs')
        return target, sha(body)

    def ledger(self):
        lines = self.docker('exec', base.SERVICES['db'], 'psql', '-X', '-v',
                            'ON_ERROR_STOP=1', '-U', 'geops_stage', '-d', 'geops_dev',
                            '-Atq', '-c',
                            'SELECT version,checksum FROM geops_schema_migrations ORDER BY version',
                            timeout=15).splitlines()
        manifest_path = self.bundle / 'specs/spec-03-clients-geofences-routes/b32-staging-candidate.json'
        body = manifest_path.read_bytes()
        if sha(body) != self.policy['candidateManifestSha256']:
            raise Blocked('B32 candidate manifest changed')
        expected = [item['version'] + '|' + item['sha256']
                    for item in json.loads(body)['database']['migrations']]
        if (not all(base.SQL.fullmatch(line) for line in lines) or
                len(expected) != 33 or len(lines) not in (31, 32, 33) or
                lines != expected[:len(lines)]):
            raise Blocked('Unapproved B31/B32 migration ledger')
        result = {'count': len(lines), 'sha256': sha('\n'.join(lines).encode())}
        if result['sha256'] != (B31 if len(lines) == 31 else
                                '15b89174e04195825ff4ff61f4844c2a5c8fd6535dab4e0d09760187632c62aa'
                                if len(lines) == 32 else B32):
            raise Blocked('B31/B32 ledger hash differs')
        return result

    def release(self, identity):
        value, digest = self.signed('release', identity)
        if (set(value) != {'schemaVersion', 'kind', 'id', 'environment', 'notBefore',
                           'expiresAt', 'commit', 'api', 'web', 'recovery', 'sqlCount',
                           'sqlListSha256', 'policySha256'} or
                value['schemaVersion'] != 1 or value['commit'] != APP_COMMIT or
                value['api'] != self.policy['registryDigests']['api'] or
                value['web'] != self.policy['registryDigests']['web'] or
                value['recovery'] != self.policy['registryDigests']['recovery'] or
                value['sqlCount'] != 33 or value['sqlListSha256'] != B32 or
                value['policySha256'] != sha(self.policy_bytes)):
            raise Blocked('B32 release differs from signed staging policy')
        return value, digest

    def restore_proof(self, identity, backup_sha):
        value, digest = self.signed('restore', identity)
        if (set(value) != {'schemaVersion', 'kind', 'id', 'environment', 'notBefore',
                           'expiresAt', 'backupSha256', 'sqlCount', 'sqlListSha256',
                           'result', 'evidenceSha256', 'policySha256'} or
                value['schemaVersion'] != 1 or value['backupSha256'] != backup_sha or
                value['sqlCount'] != 31 or value['sqlListSha256'] != B31 or
                value['result'] != 'PASS' or
                not base.SHA.fullmatch(value['evidenceSha256']) or
                value['policySha256'] != sha(self.policy_bytes)):
            raise Blocked('B31 restore proof differs from signed backup')
        return digest

    def approval(self, identity, release_sha, source_sha, backup_sha, restore_sha, epoch):
        value, _ = self.signed('approval', identity)
        if (set(value) != {'schemaVersion', 'kind', 'id', 'environment', 'notBefore',
                           'expiresAt', 'action', 'releaseSha256', 'sourceStateSha256',
                           'backupSha256', 'restoreProofSha256', 'gateEpoch', 'policySha256'} or
                value['schemaVersion'] != 1 or value['action'] != 'promote-b31-b32' or
                value['releaseSha256'] != release_sha or
                value['sourceStateSha256'] != source_sha or
                value['backupSha256'] != backup_sha or
                value['restoreProofSha256'] != restore_sha or
                value['gateEpoch'] != epoch or
                value['policySha256'] != sha(self.policy_bytes) or
                (self.used / identity).exists()):
            raise Blocked('Approval does not bind exact B31→B32 transition')

    def image(self, ref, service):
        info = json.loads(self.docker('image', 'inspect', ref, '--format', '{{json .}}'))
        labels = info.get('Config', {}).get('Labels') or {}
        if (ref not in info.get('RepoDigests', []) or
                not re.fullmatch(r'sha256:[a-f0-9]{64}', info.get('Id', '')) or
                labels.get('org.opencontainers.image.revision') != APP_COMMIT or
                labels.get('org.geops.' + service + '.variant') != 'B32-integrated' or
                (service == 'api' and
                 labels.get('org.geops.maintenance.recovery.max_schema') != '31') or
                (service == 'web' and labels.get('org.geops.web.mdm_enabled') != 'true')):
            raise Blocked('B32 image digest, provenance or variant differs')
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
        if sql != {'count': 33, 'sha256': B32, 'recovery31': True}:
            raise Blocked('B32 image migration or recovery inventory differs')
        recovery = release['recovery']
        recovery_info = json.loads(self.docker('image', 'inspect', recovery, '--format', '{{json .}}'))
        recovery_labels = recovery_info.get('Config', {}).get('Labels') or {}
        if (recovery not in recovery_info.get('RepoDigests', []) or
                not re.fullmatch(r'sha256:[a-f0-9]{64}', recovery_info.get('Id', '')) or
                recovery_labels.get('org.geops.api.variant') != 'B32-recovery' or
                recovery_labels.get('org.geops.maintenance.recovery.max_schema') != '33' or
                recovery_labels.get('org.geops.application.commit') != APP_COMMIT or
                recovery_labels.get('org.opencontainers.image.revision') !=
                self.policy['promotionCommit']):
            raise Blocked('B32 recovery image provenance differs')
        recovery_sql = json.loads(self.docker('run', '--rm', '--network', 'none', '--read-only',
                                              '--pull', 'never', '--entrypoint', 'node',
                                              recovery, '-e', script.replace('recovery31', 'recovery33')
                                              .replace('RECOVERY_TARGET_SCHEMA = 31',
                                                       'RECOVERY_TARGET_SCHEMA = 33')))
        if recovery_sql != {'count': 33, 'sha256': B32, 'recovery33': True}:
            raise Blocked('B32 recovery image SQL or code differs')
        self.verify_compose(api, web)
        return {'apiRef': api, 'webRef': web, 'apiId': api_id,
                'webId': web_id, 'recoveryRef': recovery,
                'recoveryId': recovery_info['Id'], 'commit': APP_COMMIT}

    def journal_data(self):
        if not self.journal.exists():
            return None
        if self.enforce_root:
            protected(self.journal, regular=True)
        value = json.loads(self.journal.read_bytes())
        if (value.get('schemaVersion') != 1 or
                value.get('phase') not in ('draining', 'maintenance', 'migrating',
                                           'awaiting-recovery', 'resuming', 'complete', 'aborted') or
                value.get('sourceLedger') != B31 or value.get('targetLedger') != B32 or
                not all(base.SHA.fullmatch(value.get(key, '')) for key in
                        ('policySha256', 'backupSha256', 'sourceStateSha256', 'releaseSha256')) or
                not base.IDENT.fullmatch(value.get('approvalId', '')) or
                not re.fullmatch(r'[a-f0-9-]{36}', value.get('gateEpoch', '')) or
                not isinstance(value.get('target'), dict) or
                set(value['target']) != {'apiRef', 'webRef', 'apiId', 'webId',
                                         'recoveryRef', 'recoveryId', 'commit'}):
            raise Blocked('Invalid B32 promotion journal')
        return value

    def disable_b31(self):
        body = self.b31_rule.read_bytes()
        if body == B31_DISABLED:
            return
        if body != B31_RULE:
            raise Blocked('Unexpected B31 sudoers rule')
        atomic(self.b31_rule, B31_DISABLED, 0o440)

    def stop(self, journal):
        self.disable_b31()
        for service in ('geops-web', 'geops-api'):
            self.compose(journal['source']['apiRef'], journal['source']['webRef'],
                         command=['stop', service])
        if any(self.container(name)['status'] != 'exited' for name in ('api', 'web')):
            raise Blocked('B31 application did not stop')

    def execute(self, command, release_id=None, approval_id=None, restore_id=None):
        self.load_policy()
        self.context()
        journal = self.journal_data()
        if command == 'status':
            return {'result': 'B32_STAGING_STATUS', 'journal': journal,
                    'ledger': self.ledger(), 'gate': self.gate()['phase']}
        if command == 'prepare':
            if journal is not None:
                raise Blocked('B32 promotion already journaled')
            source, source_sha = self.source()
            release, digest = self.release(release_id)
            target = self.target(release)
            if self.ledger() != {'count': 31, 'sha256': B31} or self.gate()['phase'] != 'open':
                raise Blocked('Healthy B31 ledger and gate required')
            if any(self.container(name)['health'] != 'healthy' for name in ('api', 'web', 'db')):
                raise Blocked('B31 services unhealthy')
            return {'result': 'B32_STAGING_PREPARED', 'releaseSha256': digest,
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
                       'target': ready['target'], 'sourceLedger': B31, 'targetLedger': B32,
                       'policySha256': sha(self.policy_bytes), 'backupSha256': backup_sha,
                       'restoreProofSha256': restore_sha, 'gateEpoch': epoch,
                       'releaseSha256': ready['releaseSha256'], 'approvalId': approval_id}
            self.save(journal)
            self.used.mkdir(mode=0o700, exist_ok=True)
            atomic(self.used / approval_id, b'consumed\n')
            self.stop(journal)
            if self.gate()['phase'] != 'open':
                raise Blocked('Gate changed before B32 maintenance')
            self.compose(ready['target']['apiRef'], ready['target']['webRef'],
                         command=['run', '--rm', '--no-deps',
                                  '-e', 'GEOPS_CONFIRM_MAINTENANCE_TARGET=geops_dev',
                                  '-e', 'GEOPS_CONFIRM_MAINTENANCE_EPOCH=' + epoch,
                                  'geops-gate-init', 'gate', 'maintenance-start'])
            gate = self.gate()
            if gate['phase'] != 'maintenance':
                raise Blocked('B32 gate failed to close')
            journal['gateNonce'] = gate['nonce']
            journal['phase'] = 'maintenance'
            self.save(journal)
            return {'result': 'B32_STAGING_MAINTENANCE_READY', 'gateEpoch': epoch}
        if journal is None:
            raise Blocked('No supervised B32 promotion')
        if journal['policySha256'] != sha(self.policy_bytes):
            raise Blocked('B32 policy changed during promotion')
        if command == 'migrate':
            if journal['phase'] not in ('maintenance', 'migrating'):
                raise Blocked('B32 migration phase differs')
            before = self.ledger()
            if (before['count'] not in (31, 32, 33) or self.gate()['phase'] != 'maintenance' or
                    any(self.container(name)['status'] != 'exited' for name in ('api', 'web'))):
                raise Blocked('B32 migration preconditions differ')
            journal['phase'] = 'migrating'
            self.save(journal)
            if before['count'] in (31, 32):
                self.compose(journal['target']['apiRef'], journal['target']['webRef'],
                             migration=True,
                             command=['run', '--rm', '--no-deps',
                                      '-e', 'GEOPS_CONFIRM_MAINTENANCE_EPOCH=' + journal['gateEpoch'],
                                      'geops-migrate'])
            if self.ledger() != {'count': 33, 'sha256': B32}:
                raise Blocked('B32 migration ledger not exact')
            journal['phase'] = 'awaiting-recovery'
            self.save(journal)
            return {'result': 'B32_AWAITING_SUPERVISED_GATE_RECOVERY'}
        if command == 'recover':
            if journal['phase'] in ('complete', 'aborted'):
                wanted = 33 if journal['phase'] == 'complete' else 31
                if self.ledger()['count'] != wanted or self.gate()['phase'] != 'open':
                    raise Blocked('Completed B32 recovery state differs')
                return {'result': 'ALREADY_' + journal['phase'].upper()}
            ledger, gate = self.ledger(), self.gate()
            if gate['epoch'] != journal['gateEpoch']:
                raise Blocked('Security epoch changed during B32 promotion')
            # An open B31 gate already has a nonce from the previous promotion.
            # It is not proof that this B32 attempt entered maintenance. During
            # draining, compare it with the pinned B31 source journal first.
            if (journal['phase'] == 'draining' and gate['phase'] == 'open' and
                    ledger == {'count': 31, 'sha256': B31}):
                source_body = self.b31_journal.read_bytes()
                if sha(source_body) != journal['sourceStateSha256']:
                    raise Blocked('B31 source journal changed during recovery')
                source_journal = json.loads(source_body)
                if (source_journal.get('phase') != 'complete' or
                        source_journal.get('gateNonce') != gate.get('nonce') or
                        source_journal.get('gateEpoch') != gate['epoch'] or
                        journal.get('gateNonce', gate.get('nonce')) != gate.get('nonce')):
                    raise Blocked('Open B31 gate does not match source journal')
                self.start(journal, journal['source'])
                atomic(self.b31_rule, B31_RULE, 0o440)
                journal['phase'] = 'aborted'
                self.save(journal)
                return {'result': 'B31_STAGING_RESTORED_BEFORE_MAINTENANCE'}
            if 'gateNonce' not in journal and gate.get('nonce'):
                journal['gateNonce'] = gate['nonce']
                self.save(journal)
            if gate['phase'] != 'open':
                return {'result': 'AWAITING_SUPERVISED_GATE_RECOVERY',
                        'ledger': ledger, 'gate': gate['phase']}
            self.recovery_proof(release_id, journal, ledger, gate)
            if ledger == {'count': 33, 'sha256': B32}:
                journal['phase'] = 'resuming'
                self.save(journal)
                self.start(journal, journal['target'])
                journal['phase'] = 'complete'
                self.save(journal)
                return {'result': 'B32_STAGING_PROMOTED'}
            if ledger == {'count': 31, 'sha256': B31}:
                self.start(journal, journal['source'])
                atomic(self.b31_rule, B31_RULE, 0o440)
                journal['phase'] = 'aborted'
                self.save(journal)
                return {'result': 'B31_STAGING_RESTORED'}
            raise Blocked('Unknown B32 recovery ledger; downgrade forbidden')
        if command == 'verify':
            if journal['phase'] != 'complete' or self.ledger() != {'count': 33, 'sha256': B32}:
                raise Blocked('B32 promotion incomplete')
            if self.gate()['phase'] != 'open':
                raise Blocked('Staging gate remains closed')
            target = journal['target']
            if (self.container('api')['image'] != target['apiId'] or
                    self.container('web')['image'] != target['webId'] or
                    any(self.container(name)['health'] != 'healthy' for name in ('api', 'web', 'db'))):
                raise Blocked('B32 services differ from approved images')
            self.verify_secrets()
            return {'result': 'B32_STAGING_VERIFIED'}
        raise Blocked('Unknown B32 staging operation')


def main(argv):
    arguments = {'status': 0, 'prepare': 1, 'begin': 3, 'migrate': 0, 'recover': 1, 'verify': 0}
    if (os.geteuid() != 0 or not argv or argv[0] not in arguments or
            len(argv) - 1 != arguments[argv[0]] or
            any(not base.IDENT.fullmatch(value) for value in argv[1:])):
        raise Blocked('Root and fixed B32 command syntax required')
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
        print('GEOPS B32 staging controller BLOCKED: ' + str(error), file=sys.stderr)
        sys.exit(1)
