import { createDecipheriv, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const backup = process.argv[2];
const keyFile = process.env.POC_BACKUP_KEY_FILE;
if (!backup || !keyFile) throw new Error('Backup file and key file required');
const bytes = readFileSync(resolve(backup));
const key = readFileSync(resolve(keyFile));
if (key.length !== 32 || bytes.subarray(0, 9).toString('ascii') !== 'GEOPSPOC1')
  throw new Error('Invalid PoC backup');
const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(9, 21));
decipher.setAuthTag(bytes.subarray(21, 37));
const dump = Buffer.concat([decipher.update(bytes.subarray(37)), decipher.final()]);
const root = fileURLToPath(new URL('../', import.meta.url));
const envFile = resolve(root, process.env.POC_ENV_FILE ?? 'infra/.env.local');
const composeFile = resolve(root, process.env.POC_COMPOSE_FILE ?? 'infra/compose.dev.yaml');
const compose = ['compose', '--env-file', envFile, '-f', composeFile, 'exec', '-T', 'poc-db'];
const run = (args, input) =>
  spawnSync('docker', [...compose, ...args], {
    input,
    maxBuffer: 5 * 1024 * 1024,
    windowsHide: true,
  });
const manifest = run(['pg_restore', '-l'], dump);
if (manifest.status !== 0 || !manifest.stdout?.length)
  throw new Error('Encrypted backup archive verification failed');
if (process.env.POC_RESTORE_VERIFY === 'true') {
  const target = 'geops_poc_restore_' + randomBytes(4).toString('hex');
  const created = run(['createdb', '-U', 'poc_user', target]);
  if (created.status !== 0) throw new Error('Synthetic restore target creation failed');
  let restoreError;
  let cleanupFailed = false;
  try {
    const restored = run(['pg_restore', '-U', 'poc_user', '-d', target, '--no-owner'], dump);
    if (restored.status !== 0) throw new Error('Synthetic restore failed');
    const checked = run([
      'psql',
      '-U',
      'poc_user',
      '-d',
      target,
      '-tAc',
      "SELECT PostGIS_Version() IS NOT NULL AND to_regclass('poc_location') IS NOT NULL",
    ]);
    if (checked.status !== 0 || checked.stdout.toString().trim() !== 't')
      throw new Error('Synthetic restore integrity failed');
  } catch (error) {
    restoreError = error;
  } finally {
    const removed = run(['dropdb', '-U', 'poc_user', '--if-exists', target]);
    cleanupFailed = removed.status !== 0;
  }
  if (cleanupFailed) throw new Error('Synthetic restore cleanup failed');
  if (restoreError) throw restoreError;
  process.stdout.write(
    'Encrypted PoC backup restored and checked in isolated disposable database\n',
  );
} else {
  process.stdout.write('Encrypted PoC backup authentication and pg_restore manifest verified\n');
}
