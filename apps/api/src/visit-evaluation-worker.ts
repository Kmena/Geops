// Separate bounded worker entry point. The admin HTTP API only queues jobs.
import { createPool } from './db/pool.js';
import { checkReadiness } from './db/migration-manager.js';
import { gateAllowsTraffic } from './db/restore-gate.js';
import { VisitEvaluationService } from './visit-evaluation.js';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const gatePath = process.env.GEOPS_SECURITY_GATE_PATH;
  if (!databaseUrl || !gatePath)
    throw new Error('Evaluation worker requires database and restore gate');
  const pool = createPool(databaseUrl);
  try {
    if (!(await gateAllowsTraffic(pool, gatePath)) || !(await checkReadiness(pool)))
      throw new Error('Evaluation worker gate closed');
    const service = new VisitEvaluationService(pool);
    if (process.env.GEOPS_DATA_MODE === 'synthetic') await service.reconcileSynthetic(100);
    await service.reconcileOperational(100);
    const result = await service.drain(100);
    process.stdout.write(`GEOPS visit evaluation jobs processed: ${result.length}\n`);
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  process.stderr.write('GEOPS visit evaluation worker failed; details withheld\n');
  process.exitCode = 1;
});
