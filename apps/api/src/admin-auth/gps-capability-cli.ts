import { stdin, stdout } from 'node:process';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { gateAllowsTraffic } from '../db/restore-gate.js';
import { GpsCapabilityBootstrapService } from './gps-capability-bootstrap.js';
import { SupervisedRecoveryService } from './supervised-recovery.js';

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
  const [mode, adminEmail, firstEmail, secondEmail, requestId, ...reasonParts] =
    process.argv.slice(2);
  const securityGatePath = process.env.GEOPS_SECURITY_GATE_PATH;
  const secondaryMode =
    mode === 'add-secondary' || mode === 'activate-secondary' || mode === 'revoke-secondary';
  const newAdminEmail = secondaryMode ? reasonParts.shift() : undefined;
  if (
    process.env.GEOPS_ALLOW_SYNTHETIC_GPS_CAPABILITY_CEREMONY !== 'YES' ||
    ![
      'grant-initial',
      'upgrade-manager',
      'establish-tenant',
      'revoke',
      'revoke-secondary',
    ].includes(mode ?? '') ||
    !adminEmail ||
    !firstEmail ||
    !secondEmail ||
    !requestId ||
    (secondaryMode && !newAdminEmail) ||
    !reasonParts.length ||
    !securityGatePath
  )
    throw new Error('Explicit synthetic ceremony configuration required');
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
  try {
    const ceremony = new GpsCapabilityBootstrapService(pool, () =>
      gateAllowsTraffic(pool, securityGatePath),
    );
    const adminPassword =
      mode === 'grant-initial' || mode === 'upgrade-manager' || mode === 'establish-tenant'
        ? await hidden('Administrator password: ')
        : undefined;
    const firstPassword = await hidden('First custodian password: ');
    const secondPassword = await hidden('Second custodian password: ');
    const newPassword =
      mode === 'activate-secondary'
        ? await hidden('New secondary administrator password: ')
        : undefined;
    if (newPassword !== undefined && newPassword !== (await hidden('Repeat new password: ')))
      throw new Error('Password confirmation mismatch');
    const input = {
      requestId,
      adminEmail,
      ...(adminPassword === undefined ? {} : { adminPassword }),
      custodians: [
        { email: firstEmail, password: firstPassword },
        { email: secondEmail, password: secondPassword },
      ] as const,
      reason: reasonParts.join(' '),
      ...(newAdminEmail === undefined ? {} : { secondEmail: newAdminEmail }),
    };
    if (mode === 'grant-initial') await ceremony.grantInitial(input);
    else if (mode === 'upgrade-manager') await ceremony.upgradeManager(input);
    else if (mode === 'establish-tenant') await ceremony.establishTenant(input);
    else if (mode === 'revoke') await ceremony.revoke(input);
    else if (mode === 'add-secondary')
      await ceremony.addSecondary({ ...input, secondEmail: newAdminEmail ?? '' });
    else if (mode === 'activate-secondary')
      await ceremony.activateSecondary(
        { ...input, secondEmail: newAdminEmail ?? '' },
        newPassword ?? '',
        new SupervisedRecoveryService(pool, config.adminSessionKey),
      );
    else await ceremony.revokeSecondary({ ...input, secondEmail: newAdminEmail ?? '' });
    stdout.write('GPS capability ceremony recorded.\n');
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write('GPS capability ceremony failed; details withheld.\n');
  process.exitCode = 1;
});
