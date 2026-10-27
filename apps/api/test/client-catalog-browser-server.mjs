// Synthetic browser verification only. Never bind to a non-loopback address.
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../src/app.ts';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { ClientCatalogService } from '../src/client-catalog.ts';
import { RouteCatalogService } from '../src/route-catalog.ts';
import { VisitScheduleService } from '../src/visit-schedule.ts';
import { VisitEvaluationService } from '../src/visit-evaluation.ts';
import { ComplianceDashboardService } from '../src/compliance-dashboard.ts';
import { AgentDeviceLinkService } from '../src/agent-device-links.ts';
import { GeocodingSearchService } from '../src/geocoding-search.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic DB required');
const pool = new pg.Pool({ connectionString: url, max: 5 });
const owner = (
  await pool.query("SELECT id FROM admin_user WHERE email_normalized='owner@example.invalid'")
).rows[0].id;
const browserDevice = randomUUID();
await pool.query(
  "INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','Dispositivo Chrome E2E')",
  [browserDevice],
);
await pool.query(
  "INSERT INTO geops_device_tenant(device_id,tenant_id,established_by,source) VALUES($1,'synthetic',$2,'GEOPS_ENROLLMENT')",
  [browserDevice, owner],
);
await pool.query(
  "INSERT INTO device_key(id,geops_device_id,public_key_spki_der,public_key_fingerprint,status) VALUES($1,$2,$3,$4,'ACTIVE')",
  [randomUUID(), browserDevice, randomBytes(64), randomBytes(32)],
);
await pool.query(
  "INSERT INTO gps_device_installation(installation_id,device_id,activated_at,activation_tenant_id) VALUES($1,$2,now(),'synthetic')",
  [randomUUID(), browserDevice],
);
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
  complianceDashboard: new ComplianceDashboardService(pool),
  agentDeviceLinks: new AgentDeviceLinkService(pool),
  geocoding: new GeocodingSearchService(
    pool,
    async () =>
      new Response(
        JSON.stringify([
          {
            osm_type: 'node',
            osm_id: 318,
            display_name: 'Lugar sintético, Guatemala',
            lat: '14.635',
            lon: '-90.515',
          },
          {
            osm_type: 'way',
            osm_id: 319,
            display_name: 'Lugar sintético alternativo, Guatemala',
            lat: '14.636',
            lon: '-90.516',
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  ),
  secureCookie: false,
});
app.addHook('onClose', async () => pool.end());
await app.listen({ host: '127.0.0.1', port: 3500 });
process.once('SIGINT', () => void app.close());
