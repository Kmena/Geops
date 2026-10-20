import { randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from '../errors.js';
import type { SupervisedRecoveryService } from './supervised-recovery.js';

export const INITIAL_GPS_CAPABILITIES = [
  'gps.audit.read',
  'gps.installation.manage',
  'gps.location.read',
  'gps.policy.activate',
  'gps.policy.assign',
  'gps.policy.read',
  'gps.policy.write',
  'gps.session.read',
  'gps.tenant.grant',
  'gps.user.manage',
] as const;

const denied = () => new ApiError(403, 'gps_capability_ceremony_denied', 'Ceremony unavailable');
const email = (value: string) => value.trim().toLowerCase();
const validEmail = (value: string) =>
  value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validReason = (value: string) => value.trim().length >= 8 && value.length <= 240;
const validUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export interface CeremonyInput {
  requestId: string;
  adminEmail: string;
  adminPassword?: string;
  custodians: readonly [{ email: string; password: string }, { email: string; password: string }];
  reason: string;
  secondEmail?: string;
}

/** Local, one-time synthetic ceremony. Never register this service as an HTTP route. */
export class GpsCapabilityBootstrapService {
  constructor(
    private readonly pool: Pool,
    private readonly gateOpen: () => Promise<boolean>,
  ) {}

  private async actors(client: PoolClient, input: CeremonyInput, requireAdminPassword: boolean) {
    const target = email(input.adminEmail);
    const custody = input.custodians.map((item) => email(item.email));
    if (
      !validUuid(input.requestId) ||
      !validEmail(target) ||
      !validReason(input.reason) ||
      custody.some((item) => !validEmail(item) || item === target) ||
      custody[0] === custody[1]
    )
      throw denied();
    const admin = (
      await client.query<{ id: string; password_hash: string }>(
        "SELECT id,password_hash FROM admin_user WHERE email_normalized=$1 AND state='ACTIVE' FOR UPDATE",
        [target],
      )
    ).rows[0];
    if (
      !admin ||
      (requireAdminPassword &&
        (!input.adminPassword || !(await argon2.verify(admin.password_hash, input.adminPassword))))
    )
      throw denied();
    const custodians: string[] = [];
    for (const custodianEmail of [...custody].sort()) {
      const actor = (
        await client.query<{ id: string; password_hash: string }>(
          "SELECT id,password_hash FROM recovery_custodian WHERE email_normalized=$1 AND state='ACTIVE' FOR SHARE",
          [custodianEmail],
        )
      ).rows[0];
      const password = input.custodians.find(
        (item) => email(item.email) === custodianEmail,
      )?.password;
      if (!actor || !password || !(await argon2.verify(actor.password_hash, password)))
        throw denied();
      custodians.push(actor.id);
    }
    return { adminId: admin.id, custodianIds: custodians };
  }

  private async run(
    input: CeremonyInput,
    action:
      | 'grant'
      | 'upgrade-manager'
      | 'establish-tenant'
      | 'revoke'
      | 'add-secondary'
      | 'revoke-secondary',
  ): Promise<void> {
    if (!(await this.gateOpen())) throw denied();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(350015)');
      if (!(await this.gateOpen())) throw denied();
      const { adminId, custodianIds } = await this.actors(
        client,
        input,
        action === 'grant' ||
          action === 'upgrade-manager' ||
          action === 'establish-tenant' ||
          action === 'add-secondary',
      );
      const used = await client.query(
        "SELECT 1 FROM audit_event WHERE id=$1 OR (correlation_id=$1 AND action LIKE 'gps.capabilities.bootstrap.%') LIMIT 1",
        [input.requestId],
      );
      if (used.rowCount) throw denied();
      if (action === 'grant') {
        const initial = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM admin_user',
        );
        const bootstrapped = await client.query(
          "SELECT 1 FROM audit_event WHERE actor_id=$1 AND action='admin.bootstrap' AND outcome='success' LIMIT 1",
          [adminId],
        );
        if (initial.rows[0]?.count !== '1' || !bootstrapped.rowCount) throw denied();
        // Historical rows close bootstrap permanently, including after revocation.
        const prior = await client.query('SELECT 1 FROM admin_permission LIMIT 1');
        if (prior.rowCount) throw denied();
        for (const permission of INITIAL_GPS_CAPABILITIES) {
          await client.query(
            'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$1,$3)',
            [adminId, permission, input.reason.trim()],
          );
        }
      } else if (action === 'upgrade-manager') {
        const primary = await client.query(
          "SELECT 1 FROM audit_event WHERE actor_id=$1 AND action='admin.bootstrap' AND outcome='success' LIMIT 1",
          [adminId],
        );
        const granted = await client.query<{ permission: string }>(
          'SELECT permission FROM admin_permission WHERE admin_id=$1 AND revoked_at IS NULL',
          [adminId],
        );
        const historicalManager = await client.query(
          "SELECT 1 FROM admin_permission WHERE admin_id=$1 AND permission='gps.user.manage' LIMIT 1",
          [adminId],
        );
        const previous = INITIAL_GPS_CAPABILITIES.filter(
          (permission) => permission !== 'gps.user.manage',
        );
        if (
          !primary.rowCount ||
          historicalManager.rowCount ||
          granted.rows.length !== previous.length ||
          previous.some((permission) => !granted.rows.some((row) => row.permission === permission))
        )
          throw denied();
        await client.query(
          "INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,'gps.user.manage',$1,$2)",
          [adminId, input.reason.trim()],
        );
      } else if (action === 'establish-tenant') {
        const primary = await client.query(
          "SELECT 1 FROM audit_event WHERE actor_id=$1 AND action='admin.bootstrap' AND outcome='success' LIMIT 1",
          [adminId],
        );
        const manager = await client.query(
          "SELECT 1 FROM admin_permission WHERE admin_id=$1 AND permission='gps.user.manage' AND revoked_at IS NULL FOR SHARE",
          [adminId],
        );
        const existing = await client.query('SELECT 1 FROM geops_operating_tenant LIMIT 1');
        const grants = await client.query(
          'SELECT 1 FROM gps_data_tenant_access UNION ALL SELECT 1 FROM gps_health_tenant_access LIMIT 1',
        );
        const otherBindings = await client.query(
          "SELECT 1 FROM mdm_binding WHERE customer_id<>'synthetic' OR provider<>'fake' LIMIT 1",
        );
        if (
          !primary.rowCount ||
          !manager.rowCount ||
          existing.rowCount ||
          grants.rowCount ||
          otherBindings.rowCount
        )
          throw denied();
        await client.query(
          "INSERT INTO geops_operating_tenant(singleton,tenant_id,established_by,audit_ref) VALUES(true,'synthetic',$1,$2)",
          [adminId, input.requestId],
        );
        for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
          await client.query(
            `INSERT INTO ${table}(admin_id,tenant_id,granted_by,reason) VALUES($1,'synthetic',$1,$2)`,
            [adminId, input.reason.trim()],
          );
      } else if (action === 'add-secondary') {
        const secondaryEmail = email(input.secondEmail ?? '');
        if (!validEmail(secondaryEmail) || secondaryEmail === email(input.adminEmail))
          throw denied();
        const primary = await client.query(
          "SELECT 1 FROM audit_event WHERE actor_id=$1 AND action='admin.bootstrap' AND outcome='success' LIMIT 1",
          [adminId],
        );
        const count = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM admin_user',
        );
        const granted = await client.query<{ permission: string }>(
          'SELECT permission FROM admin_permission WHERE admin_id=$1 AND revoked_at IS NULL',
          [adminId],
        );
        if (
          !primary.rowCount ||
          count.rows[0]?.count !== '1' ||
          granted.rows.length !== INITIAL_GPS_CAPABILITIES.length ||
          INITIAL_GPS_CAPABILITIES.some(
            (permission) => !granted.rows.some((row) => row.permission === permission),
          )
        )
          throw denied();
        const secondId = randomUUID();
        // The password is never disclosed. Supervised recovery activates the locked account.
        const inaccessibleHash = await argon2.hash(randomBytes(32).toString('base64url'), {
          type: argon2.argon2id,
          memoryCost: 19456,
          timeCost: 2,
          parallelism: 1,
        });
        await client.query(
          "INSERT INTO admin_user(id,email_normalized,password_hash,state) VALUES($1,$2,$3,'LOCKED')",
          [secondId, secondaryEmail, inaccessibleHash],
        );
        for (const permission of INITIAL_GPS_CAPABILITIES) {
          await client.query(
            'INSERT INTO admin_permission(admin_id,permission,granted_by,reason) VALUES($1,$2,$3,$4)',
            [secondId, permission, adminId, input.reason.trim()],
          );
        }
        await client.query(
          "INSERT INTO audit_event(id,actor_type,actor_id,action,outcome,correlation_id,metadata_redacted) VALUES($1,'ADMIN',$2,'gps.capabilities.bootstrap.add-secondary','success',$1,$3::jsonb)",
          [
            input.requestId,
            adminId,
            JSON.stringify({
              custodian_ids: custodianIds,
              target_admin_id: secondId,
              capability_count: INITIAL_GPS_CAPABILITIES.length,
            }),
          ],
        );
      } else if (action === 'revoke-secondary') {
        const secondaryEmail = email(input.secondEmail ?? '');
        if (!validEmail(secondaryEmail) || secondaryEmail === email(input.adminEmail))
          throw denied();
        const second = await client.query<{ id: string }>(
          "SELECT id FROM admin_user WHERE email_normalized=$1 AND state IN ('ACTIVE','LOCKED') FOR UPDATE",
          [secondaryEmail],
        );
        const secondId = second.rows[0]?.id;
        if (!secondId) throw denied();
        const created = await client.query(
          "SELECT 1 FROM audit_event WHERE actor_id=$1 AND action='gps.capabilities.bootstrap.add-secondary' AND outcome='success' AND metadata_redacted->>'target_admin_id'=$2 LIMIT 1",
          [adminId, secondId],
        );
        if (!created.rowCount) throw denied();
        await client.query(
          "UPDATE admin_user SET state='REVOKED',version=version+1,updated_at=now() WHERE id=$1",
          [secondId],
        );
        await client.query(
          'UPDATE admin_session SET revoked_at=now() WHERE admin_id=$1 AND revoked_at IS NULL',
          [secondId],
        );
        await client.query(
          'UPDATE admin_permission SET revoked_at=now() WHERE admin_id=$1 AND revoked_at IS NULL',
          [secondId],
        );
        for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
          await client.query(
            `UPDATE ${table} SET revoked_at=now() WHERE admin_id=$1 AND revoked_at IS NULL`,
            [secondId],
          );
        await client.query(
          "UPDATE recovery_request SET status='CANCELLED',code_hash=NULL WHERE admin_id=$1 AND status IN ('PENDING','AUTHORIZED')",
          [secondId],
        );
        await client.query(
          "INSERT INTO audit_event(id,actor_type,actor_id,action,outcome,correlation_id,metadata_redacted) VALUES($1,'ADMIN',$2,'gps.capabilities.bootstrap.revoke-secondary','success',$1,$3::jsonb)",
          [
            input.requestId,
            adminId,
            JSON.stringify({ custodian_ids: custodianIds, target_admin_id: secondId }),
          ],
        );
      } else {
        const revoked = await client.query(
          'UPDATE admin_permission SET revoked_at=now() WHERE admin_id=$1 AND permission=ANY($2::text[]) AND revoked_at IS NULL',
          [adminId, [...INITIAL_GPS_CAPABILITIES]],
        );
        if (!revoked.rowCount) throw denied();
        for (const table of ['gps_data_tenant_access', 'gps_health_tenant_access'])
          await client.query(
            `UPDATE ${table} SET revoked_at=now() WHERE admin_id=$1 AND revoked_at IS NULL`,
            [adminId],
          );
      }
      if (
        action === 'grant' ||
        action === 'upgrade-manager' ||
        action === 'establish-tenant' ||
        action === 'revoke'
      )
        await client.query(
          "INSERT INTO audit_event(id,actor_type,actor_id,action,outcome,correlation_id,metadata_redacted) VALUES($1,'ADMIN',$2,$3,'success',$1,$4::jsonb)",
          [
            input.requestId,
            adminId,
            `gps.capabilities.bootstrap.${action}`,
            JSON.stringify({
              custodian_ids: custodianIds,
              capability_count: INITIAL_GPS_CAPABILITIES.length,
            }),
          ],
        );
      if (!(await this.gateOpen())) throw denied();
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (validUuid(input.requestId) && (await this.gateOpen().catch(() => false))) {
        await this.pool
          .query(
            "INSERT INTO audit_event(id,actor_type,action,outcome,correlation_id) VALUES($1,'SYSTEM',$2,'rejected',$3)",
            [randomUUID(), `gps.capabilities.bootstrap.${action}`, input.requestId],
          )
          .catch(() => {});
      }
      throw error instanceof ApiError ? error : denied();
    } finally {
      client.release();
    }
  }

  grantInitial(input: CeremonyInput): Promise<void> {
    return this.run(input, 'grant');
  }
  upgradeManager(input: CeremonyInput): Promise<void> {
    return this.run(input, 'upgrade-manager');
  }
  establishTenant(input: CeremonyInput): Promise<void> {
    return this.run(input, 'establish-tenant');
  }
  revoke(input: CeremonyInput): Promise<void> {
    return this.run(input, 'revoke');
  }
  addSecondary(input: CeremonyInput & { secondEmail: string }): Promise<void> {
    return this.run(input, 'add-secondary');
  }
  revokeSecondary(input: CeremonyInput & { secondEmail: string }): Promise<void> {
    return this.run(input, 'revoke-secondary');
  }

  /** Activates only a secondary account created by this ceremony; recovery code stays in memory. */
  async activateSecondary(
    input: CeremonyInput & { secondEmail: string },
    newPassword: string,
    recovery: SupervisedRecoveryService,
  ): Promise<void> {
    if (!(await this.gateOpen())) throw denied();
    const client = await this.pool.connect();
    let targetId: string;
    let custodianIds: string[];
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(350015)');
      if (!(await this.gateOpen())) throw denied();
      const actors = await this.actors(client, input, true);
      custodianIds = actors.custodianIds;
      const secondaryEmail = email(input.secondEmail);
      if (!validEmail(secondaryEmail) || secondaryEmail === email(input.adminEmail)) throw denied();
      const target = await client.query<{ id: string }>(
        "SELECT id FROM admin_user WHERE email_normalized=$1 AND state='LOCKED' FOR UPDATE",
        [secondaryEmail],
      );
      targetId = target.rows[0]?.id ?? '';
      const created = await client.query(
        "SELECT 1 FROM audit_event WHERE actor_id=$1 AND action='gps.capabilities.bootstrap.add-secondary' AND outcome='success' AND metadata_redacted->>'target_admin_id'=$2 LIMIT 1",
        [actors.adminId, targetId],
      );
      const used = await client.query(
        "SELECT 1 FROM audit_event WHERE id=$1 OR (correlation_id=$1 AND action LIKE 'gps.capabilities.bootstrap.%') LIMIT 1",
        [input.requestId],
      );
      if (!targetId || !created.rowCount || used.rowCount) throw denied();
      await client.query(
        "INSERT INTO audit_event(id,actor_type,actor_id,action,outcome,correlation_id,metadata_redacted) VALUES($1,'ADMIN',$2,'gps.capabilities.bootstrap.activate-secondary.request','success',$1,$3::jsonb)",
        [
          input.requestId,
          actors.adminId,
          JSON.stringify({ target_admin_id: targetId, custodian_ids: custodianIds }),
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (validUuid(input.requestId) && (await this.gateOpen().catch(() => false)))
        await this.pool
          .query(
            "INSERT INTO audit_event(id,actor_type,action,outcome,correlation_id) VALUES($1,'SYSTEM','gps.capabilities.bootstrap.activate-secondary','rejected',$2)",
            [randomUUID(), input.requestId],
          )
          .catch(() => {});
      throw error instanceof ApiError ? error : denied();
    } finally {
      client.release();
    }
    // Recovery enforces two distinct active custodians and sets the password itself.
    const requestId = await recovery.request(targetId, input.requestId);
    const sorted = [...input.custodians].sort((a, b) =>
      email(a.email).localeCompare(email(b.email)),
    );
    for (let index = 0; index < 2; index++) {
      const custodian = sorted[index];
      const id = custodianIds[index];
      if (!custodian || !id) throw denied();
      await recovery.approve(requestId, id, custodian.password);
    }
    const code = await recovery.issueCode(requestId);
    if (!(await this.gateOpen())) throw denied();
    await recovery.consume(code, newPassword);
  }
}
