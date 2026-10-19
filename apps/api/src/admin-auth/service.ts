import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import type { Pool, PoolClient } from 'pg';
import { ApiError } from '../errors.js';

const ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
const HASH_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Queryable = Pick<PoolClient, 'query'>;

export interface AdminIdentity {
  id: string;
  email: string;
  csrfToken: string;
  sessionId: string;
}

export interface AdminSession extends AdminIdentity {
  token: string;
  expiresAt: string;
}

export interface AuthSettings {
  sessionKey: Buffer;
  csrfKey: Buffer;
  allowedOrigins: readonly string[];
  cookieName?: 'geops_admin' | 'geops_stage_admin';
  now?: () => Date;
}

function hmac(key: Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function equal(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !EMAIL.test(normalized)) {
    throw new ApiError(400, 'invalid_request', 'Invalid request');
  }
  return normalized;
}

async function audit(
  db: Queryable,
  event: {
    actorId?: string;
    action: string;
    outcome: string;
    correlationId: string;
    previousState?: string;
    nextState?: string;
  },
): Promise<void> {
  await db.query(
    'INSERT INTO audit_event(id,actor_type,actor_id,action,outcome,correlation_id,previous_state,next_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      randomUUID(),
      'ADMIN',
      event.actorId ?? null,
      event.action,
      event.outcome,
      event.correlationId,
      event.previousState ?? null,
      event.nextState ?? null,
    ],
  );
}

export class AdminAuthService {
  private readonly now: () => Date;
  private readonly failures = new Map<string, { count: number; blockedUntil: number }>();
  private dummyHash: string | undefined;

  get cookieName(): 'geops_admin' | 'geops_stage_admin' {
    return this.settings.cookieName ?? 'geops_admin';
  }

  constructor(
    private readonly pool: Pool,
    private readonly settings: AuthSettings,
  ) {
    if (settings.sessionKey.length < 32 || settings.csrfKey.length < 32) {
      throw new Error('Admin authentication keys must be at least 32 bytes');
    }
    this.now = settings.now ?? (() => new Date());
  }

  isAllowedOrigin(origin: string | undefined): boolean {
    return origin !== undefined && this.settings.allowedOrigins.includes(origin);
  }

  async bootstrap(email: string, password: string, correlationId = randomUUID()): Promise<string> {
    const normalized = normalizeEmail(email);
    if (password.length < 16 || password.length > 1024) {
      throw new ApiError(400, 'invalid_request', 'Invalid request');
    }
    const passwordHash = await argon2.hash(password, HASH_OPTIONS);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(350006)');
      const existing = await client.query('SELECT id FROM admin_user LIMIT 1');
      if (existing.rowCount) throw new ApiError(409, 'bootstrap_closed', 'Bootstrap unavailable');
      const id = randomUUID();
      await client.query(
        "INSERT INTO admin_user(id,email_normalized,password_hash,state) VALUES($1,$2,$3,'ACTIVE')",
        [id, normalized, passwordHash],
      );
      await audit(client, {
        actorId: id,
        action: 'admin.bootstrap',
        outcome: 'success',
        correlationId,
      });
      await client.query('COMMIT');
      return id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async dummyVerify(password: string): Promise<void> {
    this.dummyHash ??= await argon2.hash('synthetic-dummy-password-never-used', HASH_OPTIONS);
    await argon2.verify(this.dummyHash, password);
  }

  async login(
    email: string,
    password: string,
    ip: string,
    correlationId: string,
  ): Promise<AdminSession> {
    const normalized = normalizeEmail(email);
    const now = this.now();
    const accountKey = `account:${normalized}`;
    const ipKey = `ip:${ip}`;
    if (
      [accountKey, ipKey].some((key) => (this.failures.get(key)?.blockedUntil ?? 0) > now.getTime())
    ) {
      throw new ApiError(429, 'rate_limited', 'Try again later');
    }
    const result = await this.pool.query<{ id: string; password_hash: string; state: string }>(
      'SELECT id,password_hash,state FROM admin_user WHERE email_normalized=$1',
      [normalized],
    );
    const user = result.rows[0];
    let valid = false;
    if (user) valid = await argon2.verify(user.password_hash, password);
    else await this.dummyVerify(password);
    if (!valid || user?.state !== 'ACTIVE') {
      for (const key of [accountKey, ipKey]) {
        const count = (this.failures.get(key)?.count ?? 0) + 1;
        this.failures.set(key, {
          count,
          blockedUntil:
            count >= 5 ? now.getTime() + Math.min(15 * 60_000, 60_000 * 2 ** (count - 5)) : 0,
        });
      }
      throw new ApiError(401, 'invalid_credentials', 'Invalid credentials');
    }
    this.failures.delete(accountKey);
    this.failures.delete(ipKey);
    const token = randomBytes(32).toString('base64url');
    const csrfToken = hmac(this.settings.csrfKey, token).toString('base64url');
    const issued = now.toISOString();
    const absolute = new Date(now.getTime() + ABSOLUTE_MS).toISOString();
    const idle = new Date(now.getTime() + IDLE_MS).toISOString();
    const sessionId = randomUUID();
    await this.pool.query(
      'INSERT INTO admin_session(id,admin_id,token_hash,csrf_hash,issued_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES($1,$2,$3,$4,$5,$5,$6,$7)',
      [
        sessionId,
        user.id,
        hmac(this.settings.sessionKey, token),
        hmac(this.settings.csrfKey, csrfToken),
        issued,
        idle,
        absolute,
      ],
    );
    await audit(this.pool, {
      actorId: user.id,
      action: 'admin.login',
      outcome: 'success',
      correlationId,
    });
    return { id: user.id, email: normalized, csrfToken, sessionId, token, expiresAt: absolute };
  }

  async authenticate(token: string | undefined): Promise<AdminIdentity> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new ApiError(401, 'unauthorized', 'Unauthorized');
    }
    const now = this.now();
    const result = await this.pool.query<{
      id: string;
      admin_id: string;
      email_normalized: string;
      csrf_hash: Buffer;
    }>(
      "SELECT s.id,s.admin_id,u.email_normalized,s.csrf_hash FROM admin_session s JOIN admin_user u ON u.id=s.admin_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.idle_expires_at>$2 AND s.absolute_expires_at>$2 AND u.state='ACTIVE'",
      [hmac(this.settings.sessionKey, token), now],
    );
    const session = result.rows[0];
    if (!session) throw new ApiError(401, 'unauthorized', 'Unauthorized');
    const csrfToken = hmac(this.settings.csrfKey, token).toString('base64url');
    if (!equal(session.csrf_hash, hmac(this.settings.csrfKey, csrfToken))) {
      throw new ApiError(401, 'unauthorized', 'Unauthorized');
    }
    const touched = await this.pool.query(
      'UPDATE admin_session SET last_seen_at=$2,idle_expires_at=LEAST(absolute_expires_at,$3) WHERE id=$1 AND revoked_at IS NULL AND idle_expires_at>$2 AND absolute_expires_at>$2',
      [session.id, now, new Date(now.getTime() + IDLE_MS)],
    );
    if (touched.rowCount !== 1) throw new ApiError(401, 'unauthorized', 'Unauthorized');
    return {
      id: session.admin_id,
      email: session.email_normalized,
      csrfToken,
      sessionId: session.id,
    };
  }

  assertCsrf(identity: AdminIdentity, presented: string | undefined): void {
    if (!presented || !equal(Buffer.from(identity.csrfToken), Buffer.from(presented))) {
      throw new ApiError(403, 'csrf_rejected', 'Forbidden');
    }
  }

  async logout(identity: AdminIdentity, correlationId: string): Promise<void> {
    await this.pool.query(
      'UPDATE admin_session SET revoked_at=$2 WHERE id=$1 AND revoked_at IS NULL',
      [identity.sessionId, this.now()],
    );
    await audit(this.pool, {
      actorId: identity.id,
      action: 'admin.logout',
      outcome: 'success',
      correlationId,
    });
  }

  /** Legacy label-only recovery is disabled; use supervised approvals after an offline custodian ceremony. */
  async issueRecovery(
    _adminId: string,
    _issuer: string,
    _approver: string,
    _correlationId: string,
  ): Promise<string> {
    throw new ApiError(403, 'supervised_recovery_required', 'Recovery unavailable');
  }

  async consumeRecovery(
    _code: string,
    _newPassword: string,
    _correlationId: string,
  ): Promise<void> {
    throw new ApiError(403, 'supervised_recovery_required', 'Recovery unavailable');
  }
}
