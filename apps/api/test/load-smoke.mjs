import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AdminAuthService } from '../dist/admin-auth/service.js';
import { createApp } from '../dist/app.js';
import { loadConfig } from '../dist/config.js';
import { applyMigrations, checkReadiness } from '../dist/db/migration-manager.js';
import { createPool } from '../dist/db/pool.js';
import { DeviceRepository } from '../dist/device-identity/repository.js';
import { FakeMdmProvider } from '../dist/mdm/provider.js';

let step = 'setup';
const p95 = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
};

async function main() {
  const name = process.env.GEOPS_TEST_DB;
  if (!/^geops_verify_[0-9]+$/.test(name ?? '')) throw new Error('Invalid synthetic DB');
  const config = loadConfig(process.env);
  const url = new URL(config.databaseUrl);
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  const auth = new AdminAuthService(pool, {
    sessionKey: config.adminSessionKey,
    csrfKey: config.adminCsrfKey,
    allowedOrigins: config.allowedOrigins,
  });
  const devices = new DeviceRepository(pool);
  const records = Array.from({ length: 25 }, (_, index) => ({
    mdm_device_id: String(index + 1),
    status: 'synthetic',
    display_name: `Simulated ${index + 1}`,
  }));
  const app = createApp({
    readinessProbe: () => checkReadiness(pool),
    logLevel: 'silent',
    adminAuth: auth,
    devices,
    mdm: new FakeMdmProvider(records),
    secureCookie: false,
  });
  try {
    step = 'migrations';
    await applyMigrations(pool);
    const password = randomBytes(24).toString('base64url');
    await auth.bootstrap('load@example.test', password);
    for (let index = 0; index < 25; index++) {
      await devices.createDraft(`Synthetic device ${index + 1}`);
    }
    step = 'login-latency';
    const loginMs = [];
    let cookie;
    for (let index = 0; index < 25; index++) {
      const begin = performance.now();
      const response = await app.inject({
        method: 'POST',
        url: '/v1/admin/auth/sessions',
        headers: { origin: 'http://localhost:3501', 'content-type': 'application/json' },
        payload: JSON.stringify({ email: 'load@example.test', password }),
      });
      loginMs.push(performance.now() - begin);
      assert.equal(response.statusCode, 200);
      cookie = response.headers['set-cookie'].split(';')[0];
    }
    step = 'inventory-latency';
    const geopsMs = [];
    const fakeMs = [];
    for (let index = 0; index < 25; index++) {
      let begin = performance.now();
      const geops = await app.inject({
        method: 'GET',
        url: '/v1/admin/devices?limit=25',
        headers: { cookie },
      });
      geopsMs.push(performance.now() - begin);
      assert.equal(geops.statusCode, 200);
      assert.equal(geops.json().items.length, 25);
      begin = performance.now();
      const fake = await app.inject({
        method: 'GET',
        url: '/v1/admin/mdm/devices?limit=25',
        headers: { cookie },
      });
      fakeMs.push(performance.now() - begin);
      assert.equal(fake.statusCode, 200);
      assert.equal(fake.json().items.length, 25);
      assert.equal(fake.json().source, 'fake');
    }
    const results = { login: p95(loginMs), geops: p95(geopsMs), fake: p95(fakeMs) };
    assert.ok(results.login < 1000);
    assert.ok(results.geops < 500);
    assert.ok(results.fake < 500);
    console.log(
      `GEOPS synthetic load: PASS 25 devices; p95 login=${results.login.toFixed(1)}ms, GEOPS inventory=${results.geops.toFixed(1)}ms, fake inventory=${results.fake.toFixed(1)}ms (container app.inject, no network)`,
    );
  } finally {
    await app.close();
  }
}

main().catch(() => {
  console.error(`GEOPS synthetic load failed at step=${step}; details withheld`);
  process.exitCode = 1;
});
