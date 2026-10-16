import { randomUUID } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { AdminAuthService } from './service.js';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';

async function hidden(label: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode)
    throw new Error('Interactive local console required');
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const receive = (data: Buffer) => {
      for (const code of data) {
        if (code === 3) {
          cleanup();
          reject(new Error('Cancelled'));
          return;
        }
        if (code === 13 || code === 10) {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (code === 8 || code === 127) value = value.slice(0, -1);
        else if (code >= 32 && code <= 126 && value.length < 1024)
          value += String.fromCharCode(code);
      }
    };
    const cleanup = () => {
      stdin.off('data', receive);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', receive);
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'issue' && mode !== 'consume') throw new Error('Mode issue or consume required');
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
  try {
    const auth = new AdminAuthService(pool, {
      sessionKey: config.adminSessionKey,
      csrfKey: config.adminCsrfKey,
      allowedOrigins: config.allowedOrigins,
    });
    if (mode === 'issue') {
      const [email, issuer, approver] = process.argv.slice(3);
      if (!email || !issuer || !approver || issuer === approver)
        throw new Error('Two distinct custodians required');
      const user = await pool.query<{ id: string }>(
        'SELECT id FROM admin_user WHERE email_normalized=$1',
        [email.trim().toLowerCase()],
      );
      if (!user.rows[0]) throw new Error('Account unavailable');
      const code = await auth.issueRecovery(user.rows[0].id, issuer, approver, randomUUID());
      stdout.write(`Recovery code, show once to the supervised operator: ${code}\n`);
    } else {
      const code = await hidden('Recovery code: ');
      const password = await hidden('New password: ');
      const repeated = await hidden('Repeat new password: ');
      if (password !== repeated) throw new Error('Password confirmation mismatch');
      await auth.consumeRecovery(code, password, randomUUID());
      stdout.write('Recovery complete; old sessions revoked.\n');
    }
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write('Admin recovery failed; details withheld.\n');
  process.exitCode = 1;
});
