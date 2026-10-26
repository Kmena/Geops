import { randomUUID } from 'node:crypto';
import { stdin, stdout, stderr } from 'node:process';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { MdmOAuthClientStore, validOAuthClientValue } from './oauth-client-store.js';

/** Installation-only command. Secrets are read from a local TTY and never put in argv or logs. */
async function readHidden(label: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode)
    throw new Error('Local interactive terminal required');
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      stdin.off('data', receive);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const receive = (data: Buffer) => {
      for (const code of data) {
        if (code === 3) return finish(new Error('Cancelled'));
        if (code === 13 || code === 10) return finish();
        if (code === 8 || code === 127) value = value.slice(0, -1);
        else if (code >= 32 && code <= 126 && value.length < 2048)
          value += String.fromCharCode(code);
      }
    };
    stdin.on('data', receive);
  });
}

async function main(): Promise<void> {
  if (process.argv.length !== 3 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.argv[2] ?? ''))
    throw new Error('Operator email required');
  const config = loadConfig(process.env);
  if (!config.mdm) throw new Error('MDM is disabled');
  const pool = createPool(config.databaseUrl);
  try {
    const operator = await pool.query<{ id: string }>(
      "SELECT id FROM admin_user WHERE email_normalized=$1 AND state='ACTIVE'",
      [process.argv[2]?.toLowerCase()],
    );
    const operatorId = operator.rows[0]?.id;
    if (!operatorId) throw new Error('Operator unavailable');
    const store = new MdmOAuthClientStore(
      pool,
      config.mdmGrantKey,
      config.mdm.region,
      config.mdm.clientId && config.mdm.clientSecret
        ? { clientId: config.mdm.clientId, clientSecret: config.mdm.clientSecret }
        : undefined,
      config.mdm.webOrigin,
    );
    await store.requireAdmin(operatorId);
    const status = await store.status();
    if (status.source === 'admin') {
      stdout.write('GEOPS OAuth application identity already provisioned.\n');
      return;
    }
    const clientId = config.mdm.clientId ?? (await readHidden('Registered Client ID: '));
    const clientSecret =
      config.mdm.clientSecret ?? (await readHidden('Registered Client Secret: '));
    if (!validOAuthClientValue(clientId) || !validOAuthClientValue(clientSecret))
      throw new Error('Invalid OAuth client');
    await store.save(operatorId, randomUUID(), clientId, clientSecret, true);
    stdout.write('GEOPS OAuth application identity encrypted and provisioned.\n');
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  stderr.write('GEOPS OAuth application provisioning failed; details withheld.\n');
  process.exitCode = 1;
});
