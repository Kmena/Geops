#!/usr/bin/python3
"""One-time root installation from an out-of-band reviewed archive digest."""

try:
    import grp
except ImportError:  # unit tests on Windows
    grp = None
import hashlib
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path('/etc/geops-deploy')
STATE = Path('/var/lib/geops-deploy')
LOG = Path('/var/log/geops-deploy')
WRAPPER = Path('/usr/local/sbin/geops-deploy')
SUDOERS = Path('/etc/sudoers.d/geops-deploy')
SECRETS = ROOT / 'secrets'
COMPOSE_PLUGIN = Path('/usr/libexec/docker/cli-plugins/docker-compose')
FILES = {
    'geops_deploy.py', 'policy.json', 'state.json', 'geops-deploy.sudoers',
    'bundle/infrastructure/compose/compose.staging.yaml',
    'bundle/infrastructure/compose/compose.staging.digest.override.yaml',
    'bundle/infrastructure/nginx/geops-staging-web.conf',
    'bundle/infrastructure/staging/api-entrypoint.sh',
    'bundle/infrastructure/staging/backup.sh',
}
SECRET_NAMES = ('db_password', 'admin_session_key', 'admin_csrf_key',
                'invitation_hmac_key', 'mdm_grant_key', 'gps_quarantine_key')


def command(args, *, limit=30):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True,
                            text=True, timeout=limit, check=False,
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LANG': 'C'})
    if result.returncode:
        raise ValueError('Preinstallation check failed: ' + args[0])
    return result.stdout.strip()


def root_protected(path):
    for part in (path, *path.parents):
        info = os.lstat(part)
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('Administrative path is not root-protected')


def verify_secrets():
    root_protected(SECRETS)
    if not stat.S_ISDIR(os.stat(SECRETS).st_mode):
        raise ValueError('Root-owned secret directory required')
    if (stat.S_IMODE(os.stat(ROOT).st_mode) != 0o700 or
            stat.S_IMODE(os.stat(SECRETS).st_mode) != 0o700):
        raise ValueError('Administrative and secret directories must be root-only')
    for name in SECRET_NAMES:
        path = SECRETS / name
        root_protected(path)
        info = os.stat(path)
        if (not stat.S_ISREG(info.st_mode) or info.st_size == 0 or info.st_size > 4096 or
                info.st_gid != 24001 or stat.S_IMODE(info.st_mode) != 0o640):
            raise ValueError('Invalid provisioned secret file')


def verify_host_tool(path):
    root_protected(path.parent)
    source = os.lstat(path)
    if source.st_uid != 0:
        raise ValueError('Host tool is not root-owned')
    resolved = path.resolve(strict=True)
    root_protected(resolved)
    if not stat.S_ISREG(os.stat(resolved).st_mode):
        raise ValueError('Host tool is not a regular file')


def archive_files(archive, expected):
    if len(expected) != 64 or any(x not in '0123456789abcdef' for x in expected):
        raise ValueError('Full SHA-256 archive digest required')
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)
    fd = os.open(archive, flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 15_000_000:
            raise ValueError('Invalid installation archive')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(15_000_001)
        if len(data) > 15_000_000:
            raise ValueError('Installation archive too large')
    finally:
        os.close(fd)
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError('Archive digest differs from operator-reviewed value')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as package:
        members = package.getmembers()
        if {m.name for m in members} != FILES or len(members) != len(FILES):
            raise ValueError('Archive inventory changed')
        if any(not m.isfile() or m.size > 1_000_000 for m in members):
            raise ValueError('Archive contains a link, special file or oversized file')
        return {m.name: package.extractfile(m).read() for m in members}


def write_owned(path, data, mode):
    ensure_directory(path.parent)
    if os.path.lexists(path):
        root_protected(path)
        info = os.lstat(path)
        if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != mode or
                path.read_bytes() != data):
            raise ValueError('Existing installation file differs from reviewed archive')
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                 getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0), mode)
    try:
        offset = 0
        while offset < len(data):
            written = os.write(fd, data[offset:])
            if not written:
                raise OSError('Incomplete installation write')
            offset += written
        os.fchmod(fd, mode)
        os.fchown(fd, 0, 0)
        os.fsync(fd)
    except Exception:
        os.close(fd)
        path.unlink()
        raise
    else:
        os.close(fd)


def ensure_directory(path):
    missing = []
    cursor = path
    while not cursor.exists():
        missing.append(cursor)
        cursor = cursor.parent
    root_protected(cursor)
    for item in reversed(missing):
        item.mkdir(mode=0o755)
        os.chown(item, 0, 0)
        os.chmod(item, 0o755)


def inspect_baseline(state):
    endpoint = command(['/usr/bin/docker', 'context', 'inspect', '--format',
                        '{{.Endpoints.docker.Host}}'])
    if endpoint not in ('unix:///var/run/docker.sock', 'unix:///run/docker.sock'):
        raise ValueError('Only the local Docker daemon is allowed')
    expected = state['active']
    for kind, service in (('api', 'geops-api'), ('web', 'geops-web')):
        name = f'geops-spec02-staging-{service}-1'
        result = json.loads(command(['/usr/bin/docker', 'inspect', '--format', '{{json .}}', name]))
        labels = result['Config'].get('Labels') or {}
        if (labels.get('com.docker.compose.project') != 'geops-spec02-staging' or
                labels.get('com.docker.compose.service') != service or
                result['Image'] != expected[kind + 'Id'] or
                result['State']['Health']['Status'] != 'healthy'):
            raise ValueError('Active A container differs from reviewed baseline')
        image = json.loads(command(['/usr/bin/docker', 'image', 'inspect',
                                    expected[kind + 'Ref'], '--format', '{{json .}}']))
        if image['Id'] != expected[kind + 'Id']:
            raise ValueError('A local tag no longer identifies the active image')
    db = json.loads(command(['/usr/bin/docker', 'inspect', '--format', '{{json .}}',
                             'geops-spec02-staging-geops-db-1']))
    if db['State']['Health']['Status'] != 'healthy':
        raise ValueError('Staging database is not healthy')
    # The protected copies must match the secrets mounted in the active API.
    # Only digests are compared; values are never logged or printed.
    for name in SECRET_NAMES:
        observed = command(['/usr/bin/docker', 'exec', 'geops-spec02-staging-geops-api-1',
                            'node', '-e',
                            "const c=require('node:crypto'),f=require('node:fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))",
                            '/run/secrets/' + name])
        expected = hashlib.sha256((SECRETS / name).read_bytes()).hexdigest()
        if observed != expected:
            raise ValueError('Protected secret copy differs from active container')


def install(archive, expected, public_key):
    if grp is None or os.geteuid() != 0:
        raise ValueError('Operator root access required')
    if os.path.lexists(SUDOERS):
        raise ValueError('Sudoers already installed; refusing to overwrite')
    root_protected(public_key)
    for tool in ('/usr/bin/python3', '/usr/bin/docker', '/usr/bin/openssl',
                 '/usr/sbin/visudo', COMPOSE_PLUGIN):
        verify_host_tool(Path(tool))
    command(['/usr/bin/openssl', 'pkey', '-pubin', '-in', str(public_key), '-noout'])
    verify_secrets()
    items = archive_files(archive, expected)
    policy = json.loads(items['policy.json'])
    state = json.loads(items['state.json'])
    if policy.get('environment') != 'geops-spec02-staging' or state.get('schemaVersion') != 1:
        raise ValueError('Wrong installation target')
    if set(policy['files']) != {name[7:] for name in FILES if name.startswith('bundle/')}:
        raise ValueError('Bundle inventory differs from policy')
    for name, sha in policy['files'].items():
        if hashlib.sha256(items['bundle/' + name]).hexdigest() != sha:
            raise ValueError('Bundle checksum mismatch')
    inspect_baseline(state)
    with tempfile.TemporaryDirectory(prefix='geops-install-') as temporary:
        sudoers_candidate = Path(temporary) / 'sudoers'
        sudoers_candidate.write_bytes(items['geops-deploy.sudoers'])
        command(['/usr/sbin/visudo', '-cf', str(sudoers_candidate)])
    ROOT.mkdir(mode=0o700, exist_ok=True)
    root_protected(ROOT)
    if stat.S_IMODE(os.stat(ROOT).st_mode) != 0o700:
        raise ValueError('Administrative directory is not root-only')
    for name in sorted(FILES):
        if name.startswith('bundle/'):
            write_owned(ROOT / name, items[name], 0o444)
    link = ROOT / 'bundle/infrastructure/compose/.local/staging/secrets'
    ensure_directory(link.parent)
    if os.path.lexists(link):
        if not link.is_symlink() or os.readlink(link) != str(SECRETS):
            raise ValueError('Existing secret link differs from reviewed target')
    else:
        os.symlink(SECRETS, link)
    write_owned(ROOT / 'policy.json', items['policy.json'], 0o444)
    write_owned(ROOT / 'public.pem', public_key.read_bytes(), 0o444)
    (ROOT / 'docker').mkdir(mode=0o700, exist_ok=True)
    root_protected(ROOT / 'docker')
    if stat.S_IMODE(os.stat(ROOT / 'docker').st_mode) != 0o700:
        raise ValueError('Docker credential directory is not root-only')
    STATE.mkdir(mode=0o700, exist_ok=True)
    root_protected(STATE)
    if stat.S_IMODE(os.stat(STATE).st_mode) != 0o700:
        raise ValueError('State directory is not root-only')
    write_owned(STATE / 'state.json', items['state.json'], 0o600)
    for name in ('used', 'tmp'):
        (STATE / name).mkdir(mode=0o700, exist_ok=True)
        root_protected(STATE / name)
        if stat.S_IMODE(os.stat(STATE / name).st_mode) != 0o700:
            raise ValueError('Private state directory is not root-only')
    inbox = STATE / 'inbox'
    if inbox.is_symlink():
        raise ValueError('Approval inbox must not be a symlink')
    if not inbox.exists():
        inbox.mkdir(mode=0o770)
        os.chown(inbox, 0, grp.getgrnam('abi').gr_gid)
        os.chmod(inbox, 0o770)
    inbox_info = os.stat(inbox)
    if (inbox_info.st_uid != 0 or inbox_info.st_gid != grp.getgrnam('abi').gr_gid or
            stat.S_IMODE(inbox_info.st_mode) != 0o770):
        raise ValueError('Approval inbox permissions changed')
    LOG.mkdir(mode=0o700, exist_ok=True)
    root_protected(LOG)
    if stat.S_IMODE(os.stat(LOG).st_mode) != 0o700:
        raise ValueError('Audit directory is not root-only')
    audit = LOG / 'audit.jsonl'
    if os.path.lexists(audit):
        root_protected(audit)
        if (not stat.S_ISREG(os.stat(audit).st_mode) or
                stat.S_IMODE(os.stat(audit).st_mode) != 0o600):
            raise ValueError('Existing audit log is not protected')
    else:
        write_owned(audit, b'', 0o600)
    write_owned(WRAPPER, items['geops_deploy.py'], 0o755)
    command([str(WRAPPER), 'status'])
    command([str(WRAPPER), 'verify'])
    write_owned(SUDOERS, items['geops-deploy.sudoers'], 0o440)
    try:
        command(['/usr/sbin/visudo', '-c'])
    except Exception:
        SUDOERS.unlink(missing_ok=True)
        raise
    print('GEOPS wrapper installed; status and verify passed; sudoers validated')


if __name__ == '__main__':
    try:
        root_protected(Path(__file__).absolute())
        if len(sys.argv) != 4:
            raise ValueError('Usage: install.py PACKAGE.tar.gz REVIEWED_SHA256 ROOT_OWNED_ED25519_PUBLIC_KEY')
        install(Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3]))
    except Exception as error:
        print('GEOPS installation BLOCKED: ' + str(error), file=sys.stderr)
        sys.exit(1)
