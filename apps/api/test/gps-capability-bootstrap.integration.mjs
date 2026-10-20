// Run only against a migrated disposable geops_verify_* database with synthetic data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { AdminAuthService } from '../src/admin-auth/service.ts';
import { SupervisedRecoveryService } from '../src/admin-auth/supervised-recovery.ts';
import {
  GpsCapabilityBootstrapService,
  INITIAL_GPS_CAPABILITIES,
} from '../src/admin-auth/gps-capability-bootstrap.ts';
import { GpsPolicyService } from '../src/gps-policy-service.ts';
import { GpsAdministrationService } from '../src/gps-administration.ts';

const url = process.env.DATABASE_URL;
if (
  !url ||
  !/^geops_verify_[0-9]+(?:_restore)?$/.test(new URL(url).pathname.slice(1)) ||
  process.env.GEOPS_DATA_MODE !== 'synthetic'
)
  throw new Error('Disposable synthetic database required');
const pool = new pg.Pool({ connectionString: url, max: 8 });
let checks = 0;
const check = (condition, label) => {
  assert.ok(condition, label);
  checks++;
};
const rejected = async (promise, label) => {
  await assert.rejects(
    promise,
    (error) => error?.statusCode === 403 || error?.status === 403,
    label,
  );
  checks++;
};
const password = 'synthetic-password-12345678';
const first = 'first-custodian@example.invalid';
const second = 'second-custodian@example.invalid';
const adminEmail = 'first-admin@example.invalid';
const args = (requestId = randomUUID()) => ({
  requestId,
  adminEmail,
  adminPassword: password,
  custodians: [
    { email: first, password },
    { email: second, password },
  ],
  reason: 'Approved synthetic bootstrap ceremony',
});

try {
  await pool
    .query('SELECT current_database() AS name')
    .then((r) =>
      check(/^geops_verify_[0-9]+(?:_restore)?$/.test(r.rows[0].name), 'disposable database'),
    );
  await pool.query('TRUNCATE admin_user, recovery_custodian, audit_event CASCADE');
  const auth = new AdminAuthService(pool, {
    sessionKey: Buffer.alloc(32, 51),
    csrfKey: Buffer.alloc(32, 52),
    allowedOrigins: ['https://geops.example.invalid'],
  });
  const adminId = await auth.bootstrap(adminEmail, password);
  const recovery = new SupervisedRecoveryService(pool, Buffer.alloc(32, 53));
  await recovery.registerSyntheticCustodian(first, password);
  await recovery.registerSyntheticCustodian(second, password);
  let open = true;
  const ceremony = new GpsCapabilityBootstrapService(pool, async () => open);
  const operations = new GpsAdministrationService(pool, new GpsPolicyService(pool));
  check(
    (await operations.capabilities(adminId, randomUUID())).capabilities.length === 0,
    'default denial before ceremony',
  );
  const failedRequestId = randomUUID();
  await rejected(
    ceremony.grantInitial({ ...args(failedRequestId), adminPassword: 'wrong-password' }),
    'wrong administrator password',
  );
  await rejected(
    ceremony.grantInitial(args(failedRequestId)),
    'failed request ID cannot be replayed',
  );
  await rejected(
    ceremony.grantInitial({
      ...args(),
      custodians: [
        { email: first, password },
        { email: first, password },
      ],
    }),
    'same custodian twice',
  );
  await rejected(
    ceremony.grantInitial({
      ...args(),
      custodians: [
        { email: first, password },
        { email: second, password: 'wrong-password' },
      ],
    }),
    'wrong custodian password',
  );
  open = false;
  await rejected(ceremony.grantInitial(args()), 'closed gate');
  open = true;
  const id = randomUUID();
  const outcomes = await Promise.allSettled([
    ceremony.grantInitial(args(id)),
    ceremony.grantInitial(args(randomUUID())),
  ]);
  check(
    outcomes.filter((item) => item.status === 'fulfilled').length === 1,
    'concurrent bootstrap has one winner',
  );
  const active = (await operations.capabilities(adminId, randomUUID())).capabilities;
  check(
    JSON.stringify(active) === JSON.stringify([...INITIAL_GPS_CAPABILITIES]),
    'all explicit GPS capabilities visible through service',
  );
  await new GpsPolicyService(pool).requireCapability(adminId, 'gps.policy.read', randomUUID());
  checks++;
  await rejected(ceremony.grantInitial(args(id)), 'replay rejected');
  await rejected(ceremony.grantInitial(args()), 'second bootstrap rejected');
  const successful = await pool.query(
    "SELECT metadata_redacted FROM audit_event WHERE action='gps.capabilities.bootstrap.grant' AND outcome='success'",
  );
  check(
    successful.rowCount === 1 && successful.rows[0].metadata_redacted.custodian_ids.length === 2,
    'grant and both custodians audited',
  );
  await rejected(
    ceremony.revoke({
      ...args(),
      custodians: [
        { email: first, password },
        { email: second, password: 'wrong-password' },
      ],
    }),
    'unauthorized revocation',
  );
  const revokeId = randomUUID();
  await ceremony.revoke({ ...args(revokeId), adminPassword: undefined });
  check(
    (await operations.capabilities(adminId, randomUUID())).capabilities.length === 0,
    'revocation immediately removes all capabilities',
  );
  await rejected(
    new GpsPolicyService(pool).requireCapability(adminId, 'gps.policy.read', randomUUID()),
    'policy access rejected after revocation',
  );
  await rejected(
    ceremony.revoke({ ...args(revokeId), adminPassword: undefined }),
    'revocation replay rejected',
  );
  await rejected(ceremony.grantInitial(args()), 'revoked bootstrap cannot be repeated');
  check(
    (
      await pool.query(
        "SELECT 1 FROM audit_event WHERE id=$1 AND action='gps.capabilities.bootstrap.revoke'",
        [revokeId],
      )
    ).rowCount === 1,
    'revocation audited',
  );
  console.log(`GPS capability bootstrap integration: ${checks} checks PASS`);
} finally {
  await pool.end();
}
