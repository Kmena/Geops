import { createPool } from './pool.js';
import { beginMaintenance, finishMaintenance, verifyMaintenance } from './maintenance-gate.js';
import {
  closeGate,
  epochMatches,
  gateAllowsTraffic,
  initializeFreshGate,
  openGateAfterQuarantine,
  readGate,
  recoverMissingGate,
  verifyForReopen,
} from './restore-gate.js';

async function main(): Promise<void> {
  const mode = process.argv[2];
  const gatePath = process.env.GEOPS_SECURITY_GATE_PATH;
  const databaseUrl = process.env.DATABASE_URL;
  if (
    process.env.GEOPS_DATA_MODE !== 'synthetic' ||
    !gatePath ||
    !databaseUrl ||
    ![
      'init',
      'close',
      'verify',
      'open',
      'recover-missing',
      'maintenance-start',
      'maintenance-verify',
      'maintenance-finish',
    ].includes(mode ?? '')
  )
    throw new Error('Synthetic gate configuration required');
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('PostgreSQL required');
  const testName = process.env.GEOPS_TEST_DB;
  if (testName) {
    if (!/^geops_verify_[0-9]+(_restore)?$/.test(testName))
      throw new Error('Synthetic restore database required');
    url.pathname = `/${testName}`;
  }
  const pool = createPool(url.toString());
  try {
    if (
      mode === 'maintenance-start' ||
      mode === 'maintenance-verify' ||
      mode === 'maintenance-finish'
    ) {
      const target = process.env.GEOPS_CONFIRM_MAINTENANCE_TARGET ?? '';
      const epoch = process.env.GEOPS_CONFIRM_MAINTENANCE_EPOCH ?? '';
      if (target !== decodeURIComponent(url.pathname.slice(1)) || !epoch)
        throw new Error('Explicit maintenance target and epoch required');
      if (mode === 'maintenance-start') await beginMaintenance(pool, gatePath, target, epoch);
      else if (mode === 'maintenance-finish') {
        if (target === 'geops_dev')
          throw new Error('Persistent maintenance requires supervised forward recovery');
        await finishMaintenance(pool, gatePath, target, epoch);
      } else if (!(await verifyMaintenance(pool, gatePath, target, epoch)))
        throw new Error('Maintenance verification failed');
    } else if (mode === 'init') await initializeFreshGate(pool, gatePath);
    else if (mode === 'recover-missing') {
      if (process.env.GEOPS_CONFIRM_LOST_GATE !== 'YES' || !testName)
        throw new Error('Missing gate recovery confirmation required');
      await recoverMissingGate(pool, gatePath, testName);
    } else if (mode === 'close') await closeGate(gatePath);
    else if (mode === 'verify') {
      if (!(await verifyForReopen(pool, gatePath))) throw new Error('Restore verification failed');
    } else if (mode === 'open') {
      const state = await readGate(gatePath);
      const authorization = {
        databaseName: process.env.GEOPS_CONFIRM_REOPEN_TARGET ?? '',
        epoch: process.env.GEOPS_CONFIRM_REOPEN_EPOCH ?? '',
      };
      if (authorization.databaseName !== testName || authorization.epoch !== state.epoch)
        throw new Error('Explicit restore reopen authorization required');
      if (state.phase === 'open') {
        if (!(await gateAllowsTraffic(pool, gatePath))) throw new Error('Open gate mismatch');
      } else await openGateAfterQuarantine(pool, gatePath, authorization);
    }
    const state = await readGate(gatePath);
    if (!(await epochMatches(pool, state.epoch)) && mode !== 'close' && mode !== 'recover-missing')
      throw new Error('Security epoch mismatch');
    process.stdout.write(
      `GEOPS synthetic security gate ${mode} completed; phase=${state.phase}; epoch=${state.epoch}\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write('GEOPS synthetic security gate failed; details withheld\n');
  process.exitCode = 1;
});
