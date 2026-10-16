import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../infrastructure/compose/.env.local', import.meta.url));
let file;
try {
  file = await open(path, 'wx', 0o600);
  await file.writeFile(`GEOPS_DEV_DB_PASSWORD=${randomBytes(32).toString('hex')}\n`);
  process.stdout.write('Local synthetic Compose secret created.\n');
} catch (error) {
  if (error?.code === 'EEXIST') {
    process.stdout.write('Local synthetic Compose secret already exists.\n');
  } else {
    throw error;
  }
} finally {
  await file?.close();
}
