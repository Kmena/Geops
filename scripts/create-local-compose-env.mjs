import { randomBytes } from 'node:crypto';
import { chmod, open, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../infrastructure/compose/.env.local', import.meta.url));
const names = [
  'GEOPS_DEV_DB_PASSWORD',
  'GEOPS_ADMIN_SESSION_KEY',
  'GEOPS_ADMIN_CSRF_KEY',
  'GEOPS_INVITATION_HMAC_KEY',
  'GEOPS_MDM_GRANT_KEY',
  'GEOPS_GPS_QUARANTINE_KEY',
];
let existing = '';
try {
  existing = await readFile(path, 'utf8');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const present = new Set(existing.split(/\r?\n/).map((line) => line.split('=')[0]));
const missing = names.filter((name) => !present.has(name));
if (missing.length > 0) {
  const file = await open(path, existing ? 'a' : 'wx', 0o600);
  try {
    if (existing && !existing.endsWith('\n')) await file.writeFile('\n');
    for (const name of missing) {
      await file.writeFile(`${name}=${randomBytes(32).toString('base64url')}\n`);
    }
  } finally {
    await file.close();
  }
}
await chmod(path, 0o600).catch(() => {});
process.stdout.write('Local synthetic Compose configuration ready; values withheld.\n');
