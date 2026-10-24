import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  INVENTORY_SCOPE,
  buildAuthorizationUrl,
  exchangeCode,
  locationMatches,
  revokeRefresh,
} from '../../mdm-oauth-core.mjs';
import { requireInstallationAccess } from '../device-identity/admin-scope.js';
import { appendAudit } from '../audit/index.js';
import { ApiError } from '../errors.js';
import type { RealMdmGrantStore } from './real-grants.js';
import { ManageEngineReadOnly } from './provider.js';

const hash = (value: string): Buffer => createHash('sha256').update(value).digest();
const random = (length: number): string => randomBytes(length).toString('base64url');
const FIVE_MINUTES = 5 * 60 * 1000;

interface Pending {
  admin_id: string;
  session_id: string;
  verifier_ciphertext: Buffer;
  verifier_iv: Buffer;
  verifier_tag: Buffer;
}

export interface WebOAuthConfig {
  region: string;
  customerId: string;
  clientId: string;
  clientSecret: string;
  webOrigin: string;
  grantKey: Buffer;
  mountedGrantPresent?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Persists one-use state and PKCE without depending on the Strict admin cookie at callback. */
export class MdmWebOAuth {
  readonly callbackPath = '/v1/admin/mdm/oauth/callback';
  readonly cookieName = 'geops_mdm_oauth';
  get secureCookie(): boolean {
    return this.config.webOrigin.startsWith('https://');
  }
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly pool: Pool,
    private readonly grants: RealMdmGrantStore,
    private readonly config: WebOAuthConfig,
  ) {
    if (config.grantKey.length !== 32 || !/^https?:\/\/[^/]+$/.test(config.webOrigin))
      throw new Error('Invalid MDM Web OAuth configuration');
    this.now = config.now ?? Date.now;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  private oauthConfig() {
    return {
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      authOrigin: `https://accounts.zoho.${this.config.region}`,
      redirectUri: `${this.config.webOrigin}${this.callbackPath}`,
    };
  }

  private encryptVerifier(stateDigest: Buffer, verifier: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.config.grantKey, iv);
    cipher.setAAD(stateDigest);
    return {
      ciphertext: Buffer.concat([cipher.update(verifier, 'utf8'), cipher.final()]),
      iv,
      tag: cipher.getAuthTag(),
    };
  }

  private decryptVerifier(stateDigest: Buffer, pending: Pending): string {
    const decipher = createDecipheriv('aes-256-gcm', this.config.grantKey, pending.verifier_iv);
    decipher.setAAD(stateDigest);
    decipher.setAuthTag(pending.verifier_tag);
    return Buffer.concat([decipher.update(pending.verifier_ciphertext), decipher.final()]).toString(
      'utf8',
    );
  }

  private async authorize(db: Pool | PoolClient, adminId: string, sessionId: string) {
    const session = await db.query(
      `SELECT 1 FROM admin_session s JOIN admin_user u ON u.id=s.admin_id
       WHERE s.id=$1 AND s.admin_id=$2 AND s.revoked_at IS NULL
       AND s.idle_expires_at>now() AND s.absolute_expires_at>now() AND u.state='ACTIVE'`,
      [sessionId, adminId],
    );
    if (!session.rowCount) throw new ApiError(403, 'mdm_oauth_session_expired', 'Forbidden');
    await requireInstallationAccess(db, adminId, 'synthetic');
    const permission = await db.query(
      `SELECT 1 FROM admin_permission WHERE admin_id=$1 AND permission='gps.tenant.grant'
       AND revoked_at IS NULL`,
      [adminId],
    );
    if (!permission.rowCount) throw new ApiError(403, 'mdm_oauth_forbidden', 'Forbidden');
  }

  async start(
    adminId: string,
    sessionId: string,
    correlationId: string = randomUUID(),
  ): Promise<{ url: string; nonce: string }> {
    await this.authorize(this.pool, adminId, sessionId);
    const state = random(32);
    const nonce = random(32);
    const verifier = random(64);
    const stateDigest = hash(state);
    const encrypted = this.encryptVerifier(stateDigest, verifier);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(350019)');
      const control = await db.query<{ state: string; remote_revoked: boolean }>(
        `SELECT state,remote_revoked FROM mdm_connection_control
         WHERE provider='manageengine' AND region=$1 AND customer_id=$2`,
        [this.config.region, this.config.customerId],
      );
      const row = control.rows[0];
      if (!row && this.config.mountedGrantPresent)
        throw new ApiError(409, 'mdm_already_connected', 'Conflict');
      if (!row && (await this.grants.load()))
        throw new ApiError(409, 'mdm_already_connected', 'Conflict');
      if (row && (row.state !== 'DISCONNECTED' || !row.remote_revoked))
        throw new ApiError(409, 'mdm_already_connected', 'Conflict');
      await db.query(`DELETE FROM mdm_oauth_pending WHERE region=$1 AND customer_id=$2`, [
        this.config.region,
        this.config.customerId,
      ]);
      await db.query(
        `INSERT INTO mdm_oauth_pending
         (state_digest,nonce_digest,admin_id,session_id,region,customer_id,
          verifier_ciphertext,verifier_iv,verifier_tag,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          stateDigest,
          hash(nonce),
          adminId,
          sessionId,
          this.config.region,
          this.config.customerId,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          new Date(this.now() + FIVE_MINUTES),
        ],
      );
      await appendAudit(db, {
        actorType: 'ADMIN',
        actorId: adminId,
        action: 'mdm.oauth.start',
        outcome: 'success',
        correlationId,
        metadata: { provider: 'manageengine', region: this.config.region },
      });
      await db.query('COMMIT');
      return {
        url: buildAuthorizationUrl(this.oauthConfig(), { state, verifier, scope: INVENTORY_SCOPE }),
        nonce,
      };
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  async complete(input: {
    state: string | undefined;
    nonce: string | undefined;
    code: string | undefined;
    location: string | null;
    error: string | undefined;
    correlationId: string;
  }): Promise<void> {
    if (
      !input.state ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.state) ||
      !input.nonce ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.nonce) ||
      (input.code && input.code.length > 2048)
    )
      throw new ApiError(400, 'mdm_oauth_state_invalid', 'Invalid authorization');
    const stateDigest = hash(input.state);
    const claimed = await this.pool.query<Pending>(
      `UPDATE mdm_oauth_pending SET consumed_at=now()
       WHERE state_digest=$1 AND nonce_digest=$2 AND consumed_at IS NULL
       AND expires_at>now() AND region=$3 AND customer_id=$4
       RETURNING admin_id,session_id,verifier_ciphertext,verifier_iv,verifier_tag`,
      [stateDigest, hash(input.nonce), this.config.region, this.config.customerId],
    );
    const pending = claimed.rows[0];
    if (!pending) throw new ApiError(400, 'mdm_oauth_state_invalid', 'Invalid authorization');
    if (input.error || !input.code)
      throw new ApiError(400, 'mdm_oauth_denied', 'Authorization denied');
    if (!locationMatches(this.config.region, input.location))
      throw new ApiError(400, 'mdm_oauth_region_mismatch', 'Invalid authorization');
    await this.authorize(this.pool, pending.admin_id, pending.session_id);
    let issuedRefresh: string | null = null;
    try {
      const exchanged = await exchangeCode(
        this.oauthConfig(),
        input.code,
        this.decryptVerifier(stateDigest, pending),
        this.fetchImpl,
      );
      issuedRefresh = exchanged.refreshToken;
      if (
        !exchanged.refreshToken ||
        (exchanged.grantedScope &&
          !exchanged.grantedScope.split(/[,\s]+/).includes(INVENTORY_SCOPE))
      )
        throw new ApiError(403, 'mdm_oauth_scope_insufficient', 'Authorization rejected');
      const token = exchanged.refreshToken;
      const mdmOrigin = `https://mdm.manageengine.${this.config.region}`;
      const provider = new ManageEngineReadOnly({
        enabled: true,
        origin: `${mdmOrigin}/`,
        expectedOrigin: mdmOrigin,
        region: this.config.region,
        token: async () => exchanged.accessToken,
        fetchImpl: this.fetchImpl,
      });
      await provider.listDevices(this.config.customerId, undefined, 1);
      const db = await this.pool.connect();
      try {
        await db.query('BEGIN');
        await db.query('SELECT pg_advisory_xact_lock(350019)');
        await this.authorize(db, pending.admin_id, pending.session_id);
        await this.grants.activate(db, token, pending.admin_id, input.correlationId);
        await db.query('COMMIT');
        issuedRefresh = null;
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      } finally {
        db.release();
      }
    } catch (error) {
      if (issuedRefresh) {
        await revokeRefresh(this.oauthConfig(), issuedRefresh, this.fetchImpl).catch(() => false);
      }
      // Never return token exchange details, codes, or grants to a browser or log.
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'mdm_oauth_exchange_failed', 'Authorization failed');
    }
  }
}
