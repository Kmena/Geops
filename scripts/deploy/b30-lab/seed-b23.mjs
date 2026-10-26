import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import argon2 from 'argon2';

export async function seedB23(pool) {
  const admin = randomUUID();
  const device = randomUUID();
  const binding = randomUUID();
  const installation = randomUUID();
  const mdm = randomUUID();
  const passwordHash = await argon2.hash('synthetic-b30-laboratory-password', {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  await pool.query(
    "INSERT INTO admin_user(id,email_normalized,password_hash,state) VALUES($1,'b30-lab@example.invalid',$2,'ACTIVE')",
    [admin, passwordHash],
  );
  await pool.query(
    "INSERT INTO geops_operating_tenant(tenant_id,established_by,audit_ref) VALUES('synthetic',$1,$2)",
    [admin, randomUUID()],
  );
  await pool.query(
    "INSERT INTO mdm_integration(id,provider,region,customer_id,status) VALUES($1,'manageengine','com','12345','DISCONNECTED')",
    [mdm],
  );
  await pool.query(
    "INSERT INTO geops_device(id,status,display_label) VALUES($1,'ACTIVE','Synthetic B23 preserved device')",
    [device],
  );
  await pool.query(
    "INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake','synthetic',$3,'ACTIVE')",
    [binding, device, `fake-${device}`],
  );
  await pool.query(
    "INSERT INTO gps_device_installation(installation_id,device_id,activated_at,activation_binding_id,activation_tenant_id) VALUES($1,$2,$3,$4,'synthetic')",
    [installation, device, '2026-10-20T12:00:00Z', binding],
  );
  const ids = { admin, device, binding, installation, mdm };
  await assertSeed(pool, ids);
  return ids;
}

export async function assertSeed(pool, ids) {
  const result = await pool.query(
    `SELECT
      (SELECT count(*)::int FROM admin_user WHERE id=$1) AS admin,
      (SELECT count(*)::int FROM geops_device WHERE id=$2 AND status='ACTIVE') AS device,
      (SELECT count(*)::int FROM mdm_binding WHERE id=$3 AND state='ACTIVE') AS binding,
      (SELECT count(*)::int FROM gps_device_installation WHERE installation_id=$4 AND activation_binding_id=$3) AS installation,
      (SELECT count(*)::int FROM mdm_integration WHERE id=$5 AND status='DISCONNECTED') AS mdm`,
    [ids.admin, ids.device, ids.binding, ids.installation, ids.mdm],
  );
  assert.deepEqual(result.rows[0], {
    admin: 1,
    device: 1,
    binding: 1,
    installation: 1,
    mdm: 1,
  });
}
