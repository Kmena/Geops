import { stdin, stdout } from 'node:process';
import { createPool } from './pool.js';
import { recoverMaintenance } from './maintenance-recovery.js';

async function hidden(label: string): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || !stdin.setRawMode)
    throw new Error('Interactive local console required');
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.off('data', receive);
      stdin.setRawMode(false);
      stdin.pause();
    };
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
    stdin.on('data', receive);
  });
}

async function main(): Promise<void> {
  const [adminEmail, firstEmail, secondEmail, requestId, ...reason] = process.argv.slice(2);
  const path = process.env.GEOPS_SECURITY_GATE_PATH;
  const target = process.env.GEOPS_CONFIRM_MAINTENANCE_TARGET;
  const epoch = process.env.GEOPS_CONFIRM_MAINTENANCE_EPOCH;
  const url = process.env.DATABASE_URL;
  if (
    process.env.GEOPS_DATA_MODE !== 'synthetic' ||
    process.env.GEOPS_CONFIRM_FORWARD_RECOVERY !== 'YES' ||
    process.env.GEOPS_CONFIRM_COMPATIBLE_RELEASE !== 'YES' ||
    !path ||
    !url ||
    !target ||
    !epoch ||
    !adminEmail ||
    !firstEmail ||
    !secondEmail ||
    !requestId ||
    !reason.length ||
    new URL(url).pathname !== `/${target}`
  )
    throw new Error('Explicit synthetic forward recovery configuration required');
  const pool = createPool(url);
  try {
    const adminPassword = await hidden('Administrator password: ');
    const firstPassword = await hidden('First custodian password: ');
    const secondPassword = await hidden('Second custodian password: ');
    await recoverMaintenance(pool, path, {
      target,
      epoch,
      requestId,
      reason: reason.join(' '),
      adminEmail,
      adminPassword,
      custodians: [
        { email: firstEmail, password: firstPassword },
        { email: secondEmail, password: secondPassword },
      ],
      compatibleReleaseConfirmed: true,
    });
    stdout.write('GEOPS supervised maintenance recovery completed.\n');
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write('GEOPS supervised maintenance recovery failed; details withheld\n');
  process.exitCode = 1;
});
