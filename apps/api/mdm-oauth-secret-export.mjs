import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Export one consented, read-only OAuth grant for a local Staging test tenant. */
export async function saveLocalMdmGrant(directory, config, refreshToken) {
  if (!refreshToken || typeof refreshToken !== 'string') throw new Error('refresh_grant_missing');
  const entries = [
    ['mdm_client_id', config.clientId],
    ['mdm_client_secret', config.clientSecret],
    ['mdm_refresh_token', refreshToken],
  ];
  if (entries.some(([, value]) => !value || typeof value !== 'string' || /[\r\n]/.test(value)))
    throw new Error('invalid_mdm_grant');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('mdm_grant_export_failed');
  const created = [];
  try {
    for (const [name, value] of entries) {
      const path = join(directory, name);
      const handle = await open(path, 'wx', 0o600);
      created.push(path);
      try {
        await handle.writeFile(value);
      } finally {
        await handle.close();
      }
    }
  } catch {
    await Promise.all(created.map((path) => rm(path, { force: true })));
    throw new Error('mdm_grant_export_failed');
  }
}
