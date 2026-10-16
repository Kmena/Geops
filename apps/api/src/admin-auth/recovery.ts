import { stdin, stdout } from 'node:process';
import { SupervisedRecoveryService } from './supervised-recovery.js';
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
  if (
    ![
      'provision',
      'request',
      'approve',
      'revoke-approval',
      'issue',
      'consume',
      'revoke-custodian',
    ].includes(mode ?? '')
  )
    throw new Error('Supervised recovery mode required');
  const config = loadConfig(process.env);
  const pool = createPool(config.databaseUrl);
  const recovery = new SupervisedRecoveryService(pool, config.adminSessionKey);
  const custodianId = async (email: string) => {
    const row = await pool.query<{ id: string }>(
      'SELECT id FROM recovery_custodian WHERE email_normalized=$1',
      [email.trim().toLowerCase()],
    );
    if (!row.rows[0]) throw new Error('Custodian unavailable');
    return row.rows[0].id;
  };
  try {
    if (mode === 'provision') {
      if (process.env.GEOPS_ALLOW_SYNTHETIC_CUSTODIAN_SETUP !== 'YES')
        throw new Error('Synthetic custodian setup not authorized');
      const email = process.argv[3];
      if (!email) throw new Error('Custodian email required');
      const password = await hidden('Custodian password: ');
      const repeated = await hidden('Repeat password: ');
      if (password !== repeated) throw new Error('Password confirmation mismatch');
      await recovery.registerSyntheticCustodian(email, password);
      stdout.write('Synthetic custodian provisioned.\n');
    } else if (mode === 'request') {
      const email = process.argv[3];
      if (!email) throw new Error('Admin email required');
      const user = await pool.query<{ id: string }>(
        'SELECT id FROM admin_user WHERE email_normalized=$1',
        [email.trim().toLowerCase()],
      );
      if (!user.rows[0]) throw new Error('Account unavailable');
      stdout.write(`Recovery request ID: ${await recovery.request(user.rows[0].id)}\n`);
    } else if (mode === 'approve' || mode === 'revoke-approval') {
      const [requestId, email] = process.argv.slice(3);
      if (!requestId || !email) throw new Error('Request and custodian required');
      const password = await hidden('Custodian password: ');
      const id = await custodianId(email);
      if (mode === 'approve') await recovery.approve(requestId, id, password);
      else await recovery.revokeApproval(requestId, id, password);
      stdout.write('Custodian decision recorded.\n');
    } else if (mode === 'issue') {
      const requestId = process.argv[3];
      if (!requestId) throw new Error('Request required');
      const code = await recovery.issueCode(requestId);
      stdout.write(`One-time recovery code for supervised operator: ${code}\n`);
    } else if (mode === 'consume') {
      const code = await hidden('Recovery code: ');
      const password = await hidden('New password: ');
      const repeated = await hidden('Repeat new password: ');
      if (password !== repeated) throw new Error('Password confirmation mismatch');
      await recovery.consume(code, password);
      stdout.write('Recovery complete; old sessions revoked.\n');
    } else {
      if (process.env.GEOPS_ALLOW_SYNTHETIC_CUSTODIAN_SETUP !== 'YES')
        throw new Error('Synthetic custodian setup not authorized');
      const email = process.argv[3];
      if (!email) throw new Error('Custodian email required');
      await recovery.revokeCustodian(await custodianId(email));
      stdout.write('Synthetic custodian revoked.\n');
    }
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  process.stderr.write('Admin recovery failed; details withheld.\n');
  process.exitCode = 1;
});
