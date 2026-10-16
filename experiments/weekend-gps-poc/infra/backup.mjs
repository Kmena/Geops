import { createCipheriv, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const backupDir = resolve(process.env.POC_BACKUP_DIR ?? '');
const keyFile = resolve(process.env.POC_BACKUP_KEY_FILE ?? '');
const composeFile = resolve(root, process.env.POC_COMPOSE_FILE ?? 'infra/compose.dev.yaml');
const envFile = resolve(root, process.env.POC_ENV_FILE ?? 'infra/.env.local');
const within = (path) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
if (
  !process.env.POC_BACKUP_DIR ||
  !process.env.POC_BACKUP_KEY_FILE ||
  within(backupDir) ||
  within(keyFile) ||
  !existsSync(keyFile) ||
  !existsSync(composeFile) ||
  !existsSync(envFile)
)
  throw new Error('Backup configuration invalid');
const key = readFileSync(keyFile);
if (key.length !== 32) throw new Error('Backup key must be exactly 32 bytes');
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const dump = spawnSync(
  'docker',
  [
    'compose',
    '--env-file',
    envFile,
    '-f',
    composeFile,
    'exec',
    '-T',
    'poc-db',
    'pg_dump',
    '-U',
    'poc_user',
    '-d',
    'geops_poc',
    '-Fc',
  ],
  { cwd: root, maxBuffer: 50 * 1024 * 1024, windowsHide: true },
);
if (dump.status !== 0 || !dump.stdout?.length) throw new Error('POC pg_dump failed');
const iv = randomBytes(12);
const cipher = createCipheriv('aes-256-gcm', key, iv);
const encrypted = Buffer.concat([cipher.update(dump.stdout), cipher.final()]);
const name = new Date().toISOString().replace(/[:.]/g, '-') + '.pocbak';
writeFileSync(
  join(backupDir, name),
  Buffer.concat([Buffer.from('GEOPSPOC1'), iv, cipher.getAuthTag(), encrypted]),
  { flag: 'wx', mode: 0o600 },
);
process.stdout.write('Encrypted PoC backup created: ' + name + '\n');
