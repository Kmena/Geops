import { randomUUID } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { AdminAuthService } from './service.js';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';

async function readHidden(label: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode) {
    throw new Error('Interactive local console required');
  }
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
  const email = process.argv[2];
  if (!email) throw new Error('Email argument required');
  const first = await readHidden('Initial password: ');
  const second = await readHidden('Repeat password: ');
  if (first !== second) throw new Error('Password confirmation mismatch');
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
  try {
    const service = new AdminAuthService(pool, {
      sessionKey: config.adminSessionKey,
      csrfKey: config.adminCsrfKey,
      allowedOrigins: config.allowedOrigins,
    });
    await service.bootstrap(email, first, randomUUID());
    stdout.write('Synthetic admin bootstrap complete.\n');
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write('Admin bootstrap failed; details withheld.\n');
  process.exitCode = 1;
});
