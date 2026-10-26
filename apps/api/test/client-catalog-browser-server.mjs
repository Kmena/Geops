// Synthetic browser verification only. Never bind to a non-loopback address.
import pg from 'pg';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { ClientCatalogService } from '../src/client-catalog.ts';
import { RouteCatalogService } from '../src/route-catalog.ts';
import { VisitScheduleService } from '../src/visit-schedule.ts';
import { VisitEvaluationService } from '../src/visit-evaluation.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic DB required');
const pool = new pg.Pool({ connectionString: url, max: 5 });
const auth = new AdminAuthService(pool, {
  sessionKey: Buffer.alloc(32, 11),
  csrfKey: Buffer.alloc(32, 12),
  allowedOrigins: ['http://127.0.0.1:3501', 'http://localhost:3501'],
});
const app = createApp({
  readinessProbe: async () => true,
  logLevel: 'silent',
  adminAuth: auth,
  clientCatalog: new ClientCatalogService(pool, { max_radius_m: 500, max_dwell_s: 3600 }),
  routeCatalog: new RouteCatalogService(pool, { max_radius_m: 500, max_dwell_s: 3600 }),
  visitSchedule: new VisitScheduleService(pool),
  visitEvaluation: new VisitEvaluationService(pool),
  secureCookie: false,
});
app.addHook('onClose', async () => pool.end());
await app.listen({ host: '127.0.0.1', port: 3500 });
process.once('SIGINT', () => void app.close());
