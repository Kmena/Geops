import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  CUSTOMER_SCOPE,
  INVENTORY_SCOPE,
  buildAuthorizationUrl,
  exchangeCode,
  locationMatches,
  refreshAccess,
  revokeRefresh,
} from '../../mdm-oauth-core.mjs';
import { requireInstallationAccess } from '../device-identity/admin-scope.js';
import { appendAudit } from '../audit/index.js';
import { ApiError } from '../errors.js';
import { RealMdmGrantStore } from './real-grants.js';
import { ManageEngineReadOnly, boundedJson } from './provider.js';
import type { MdmOAuthClientStore } from './oauth-client-store.js';

const hash = (value: string): Buffer => createHash('sha256').update(value).digest();
const random = (length: number): string => randomBytes(length).toString('base64url');
const FIVE_MINUTES = 5 * 60 * 1000;
const DISCOVERY = '';
const SCOPES = `${CUSTOMER_SCOPE},${INVENTORY_SCOPE}`;

interface Pending {
  admin_id: string;
  session_id: string;
  verifier_ciphertext: Buffer;
  verifier_iv: Buffer;
  verifier_tag: Buffer;
}
export interface MdmCustomer {
  customer_id: string;
  customer_name: string;
}
interface Escrow {
  refreshToken: string;
  customers: MdmCustomer[];
}
export interface WebOAuthConfig {
  region: string;
  clientId: string;
  clientSecret: string;
  webOrigin: string;
  grantKey: Buffer;
  mountedGrantPresent?: boolean;
  clientGeneration?: string;
  clientStore?: MdmOAuthClientStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function exactCustomerId(value: unknown): string {
  if (typeof value === 'string' && /^[0-9]{1,30}$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  throw new ApiError(503, 'mdm_customers_invalid', 'MDM unavailable');
}

function parseCustomers(value: unknown): MdmCustomer[] {
  if (
    !value ||
    typeof value !== 'object' ||
    !Array.isArray((value as { customers?: unknown }).customers)
  )
    throw new ApiError(503, 'mdm_customers_invalid', 'MDM unavailable');
  const rows = (value as { customers: unknown[] }).customers;
  if (rows.length > 100) throw new ApiError(503, 'mdm_customers_invalid', 'MDM unavailable');
  const customers = rows.map((row) => {
    if (!row || typeof row !== 'object')
      throw new ApiError(503, 'mdm_customers_invalid', 'MDM unavailable');
    const item = row as Record<string, unknown>;
    const customer_id = exactCustomerId(item.customer_id);
    const customer_name = item.customer_name;
    if (typeof customer_name !== 'string' || !customer_name.trim() || customer_name.length > 160)
      throw new ApiError(503, 'mdm_customers_invalid', 'MDM unavailable');
    return { customer_id, customer_name: customer_name.trim() };
  });
  if (new Set(customers.map((item) => item.customer_id)).size !== customers.length)
    throw new ApiError(503, 'mdm_customers_invalid', 'MDM unavailable');
  return customers;
}

export async function discoverCustomers(
  region: string,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<MdmCustomer[]> {
  if (!['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'cn', 'sa', 'uk'].includes(region))
    throw new ApiError(400, 'mdm_region_invalid', 'Invalid request');
  const url = new URL('/customers', `https://mdm.manageengine.${region}`);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError(503, 'mdm_customers_unavailable', 'MDM unavailable');
  }
  if (response.status === 401 || response.status === 403)
    throw new ApiError(403, 'mdm_customer_scope_insufficient', 'Authorization rejected');
  if (!response.ok) throw new ApiError(503, 'mdm_customers_unavailable', 'MDM unavailable');
  return parseCustomers(await boundedJson(response));
}

/** One-use browser OAuth, followed by an equally short-lived encrypted customer selection. */
export class MdmWebOAuth {
  readonly callbackPath = '/v1/admin/mdm/oauth/callback';
  readonly cookieName = 'geops_mdm_oauth';
  readonly selectionCookieName = 'geops_mdm_selection';
  readonly selectionPath = '/v1/admin/mdm/oauth/customers';
  get secureCookie(): boolean {
    return this.config.webOrigin.startsWith('https://');
  }
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly pool: Pool,
    private readonly config: WebOAuthConfig,
  ) {
    if (
      config.grantKey.length !== 32 ||
      !/^https?:\/\/[^/]+$/.test(config.webOrigin) ||
      !['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'cn', 'sa', 'uk'].includes(config.region)
    )
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

  private async assertClientGeneration(db: Pool | PoolClient): Promise<void> {
    await this.config.clientStore?.assertGeneration(db, this.config.clientGeneration ?? 'legacy');
  }

  private encrypt(stateDigest: Buffer, plaintext: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.config.grantKey, iv);
    cipher.setAAD(stateDigest);
    return {
      ciphertext: Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]),
      iv,
      tag: cipher.getAuthTag(),
    };
  }

  private decrypt(stateDigest: Buffer, pending: Pending): string {
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
    // The client identity is installed by the protected operator workflow.
    // Connecting it requires the active GEOPS session, installation access,
    // and gps.tenant.grant above; client configuration permission is separate.
    if (this.config.clientStore && !(await this.config.clientStore.status()).configured)
      throw new ApiError(503, 'mdm_oauth_unconfigured', 'MDM unavailable');
  }

  private async assertDisconnected(db: Pool | PoolClient) {
    const active = await db.query(
      `SELECT 1 FROM mdm_integration WHERE provider='manageengine'
       AND status='REAL_CONNECTED' LIMIT 1`,
    );
    const blocked = await db.query(
      `SELECT 1 FROM mdm_connection_control WHERE provider='manageengine'
       AND (state<>'DISCONNECTED' OR remote_revoked=false) LIMIT 1`,
    );
    if (active.rowCount || blocked.rowCount || this.config.mountedGrantPresent)
      throw new ApiError(409, 'mdm_already_connected', 'Conflict');
  }

  async start(adminId: string, sessionId: string, correlationId: string = randomUUID()) {
    await this.authorize(this.pool, adminId, sessionId);
    const state = random(32),
      nonce = random(32),
      verifier = random(64);
    const stateDigest = hash(state),
      encrypted = this.encrypt(stateDigest, verifier);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(350019)');
      await this.assertClientGeneration(db);
      await this.assertDisconnected(db);
      const expired = await db.query<Pending & { state_digest: Buffer }>(
        `SELECT state_digest,verifier_ciphertext,verifier_iv,verifier_tag
         FROM mdm_oauth_pending WHERE region=$1 AND customer_id=$2
         AND consumed_at IS NULL AND expires_at<=now() FOR UPDATE`,
        [this.config.region, DISCOVERY],
      );
      for (const row of expired.rows) {
        let escrow: Partial<Escrow> | null = null;
        try {
          escrow = JSON.parse(this.decrypt(row.state_digest, row));
        } catch {
          /* An expired PKCE verifier is not a grant. */
        }
        if (
          typeof escrow?.refreshToken === 'string' &&
          escrow.refreshToken &&
          !(await revokeRefresh(this.oauthConfig(), escrow.refreshToken, this.fetchImpl).catch(
            () => false,
          ))
        )
          throw new ApiError(503, 'mdm_expired_grant_revocation_pending', 'MDM unavailable');
      }
      const outstanding = await db.query(
        `SELECT 1 FROM mdm_oauth_pending WHERE region=$1 AND customer_id=$2
         AND consumed_at IS NULL AND expires_at>now() LIMIT 1`,
        [this.config.region, DISCOVERY],
      );
      if (outstanding.rowCount)
        throw new ApiError(409, 'mdm_oauth_pending', 'Authorization in progress');
      await db.query(`DELETE FROM mdm_oauth_pending WHERE region=$1 AND customer_id=$2`, [
        this.config.region,
        DISCOVERY,
      ]);
      await db.query(
        `INSERT INTO mdm_oauth_pending
         (state_digest,nonce_digest,admin_id,session_id,region,customer_id,
          verifier_ciphertext,verifier_iv,verifier_tag,expires_at,client_generation)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          stateDigest,
          hash(nonce),
          adminId,
          sessionId,
          this.config.region,
          DISCOVERY,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          new Date(this.now() + FIVE_MINUTES),
          this.config.clientGeneration ?? 'legacy',
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
        url: buildAuthorizationUrl(this.oauthConfig(), { state, verifier, scope: SCOPES }),
        nonce,
      };
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  private async discover(accessToken: string): Promise<MdmCustomer[]> {
    return discoverCustomers(this.config.region, accessToken, this.fetchImpl);
  }

  private async activate(
    customerId: string,
    refreshToken: string,
    accessToken: string,
    adminId: string,
    sessionId: string,
    correlationId: string,
  ) {
    const mdmOrigin = `https://mdm.manageengine.${this.config.region}`;
    const provider = new ManageEngineReadOnly({
      enabled: true,
      origin: `${mdmOrigin}/`,
      expectedOrigin: mdmOrigin,
      region: this.config.region,
      token: async () => accessToken,
      fetchImpl: this.fetchImpl,
    });
    await provider.listDevices(customerId, undefined, 1);
    const grants = new RealMdmGrantStore(
      this.pool,
      this.config.grantKey,
      this.config.region,
      customerId,
    );
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(350019)');
      await this.assertClientGeneration(db);
      await this.authorize(db, adminId, sessionId);
      await this.assertDisconnected(db);
      await grants.activate(db, refreshToken, adminId, correlationId, [
        CUSTOMER_SCOPE,
        INVENTORY_SCOPE,
      ]);
      await db.query('COMMIT');
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
  }): Promise<{ kind: 'connected' } | { kind: 'selection'; selectionToken: string }> {
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
       AND expires_at>now() AND region=$3 AND customer_id=$4 AND client_generation=$5
       RETURNING admin_id,session_id,verifier_ciphertext,verifier_iv,verifier_tag`,
      [
        stateDigest,
        hash(input.nonce),
        this.config.region,
        DISCOVERY,
        this.config.clientGeneration ?? 'legacy',
      ],
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
        this.decrypt(stateDigest, pending),
        this.fetchImpl,
      );
      issuedRefresh = exchanged.refreshToken;
      const scopes = new Set(exchanged.grantedScope?.split(/[,\s]+/) ?? []);
      if (
        !issuedRefresh ||
        (exchanged.grantedScope && (!scopes.has(INVENTORY_SCOPE) || !scopes.has(CUSTOMER_SCOPE)))
      )
        throw new ApiError(403, 'mdm_oauth_scope_insufficient', 'Authorization rejected');
      const customers = await this.discover(exchanged.accessToken);
      if (customers.length === 0)
        throw new ApiError(403, 'mdm_no_authorized_customer', 'Authorization rejected');
      const onlyCustomer = customers[0];
      if (customers.length === 1 && onlyCustomer) {
        await this.activate(
          onlyCustomer.customer_id,
          issuedRefresh,
          exchanged.accessToken,
          pending.admin_id,
          pending.session_id,
          input.correlationId,
        );
        issuedRefresh = null;
        return { kind: 'connected' };
      }
      const selectionToken = random(32),
        selectionDigest = hash(selectionToken);
      const encrypted = this.encrypt(
        selectionDigest,
        JSON.stringify({ refreshToken: issuedRefresh, customers } satisfies Escrow),
      );
      await this.pool.query(
        `INSERT INTO mdm_oauth_pending
         (state_digest,nonce_digest,admin_id,session_id,region,customer_id,
          verifier_ciphertext,verifier_iv,verifier_tag,expires_at,client_generation)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          selectionDigest,
          hash(selectionToken),
          pending.admin_id,
          pending.session_id,
          this.config.region,
          DISCOVERY,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.tag,
          new Date(this.now() + FIVE_MINUTES),
          this.config.clientGeneration ?? 'legacy',
        ],
      );
      issuedRefresh = null; // Stored encrypted for the short selection window.
      return { kind: 'selection', selectionToken };
    } catch (error) {
      if (issuedRefresh)
        await revokeRefresh(this.oauthConfig(), issuedRefresh, this.fetchImpl).catch(() => false);
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'mdm_oauth_exchange_failed', 'Authorization failed');
    }
  }

  private async selection(token: string, adminId: string, sessionId: string, consume: boolean) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new ApiError(400, 'mdm_selection_expired', 'Invalid authorization');
    await this.authorize(this.pool, adminId, sessionId);
    const digest = hash(token);
    const sql = consume
      ? `UPDATE mdm_oauth_pending SET consumed_at=now() WHERE state_digest=$1
         AND nonce_digest=$2 AND admin_id=$3 AND session_id=$4 AND region=$5
         AND customer_id=$6 AND client_generation=$7 AND consumed_at IS NULL AND expires_at>now()
         RETURNING verifier_ciphertext,verifier_iv,verifier_tag`
      : `SELECT verifier_ciphertext,verifier_iv,verifier_tag FROM mdm_oauth_pending
         WHERE state_digest=$1 AND nonce_digest=$2 AND admin_id=$3 AND session_id=$4
         AND region=$5 AND customer_id=$6 AND client_generation=$7
         AND consumed_at IS NULL AND expires_at>now()`;
    const result = await this.pool.query<Pending>(sql, [
      digest,
      digest,
      adminId,
      sessionId,
      this.config.region,
      DISCOVERY,
      this.config.clientGeneration ?? 'legacy',
    ]);
    if (!result.rows[0]) throw new ApiError(400, 'mdm_selection_expired', 'Invalid authorization');
    let escrow: Escrow;
    try {
      escrow = JSON.parse(this.decrypt(digest, result.rows[0]));
    } catch {
      throw new ApiError(503, 'mdm_selection_invalid', 'MDM unavailable');
    }
    if (
      typeof escrow.refreshToken !== 'string' ||
      !escrow.refreshToken ||
      !Array.isArray(escrow.customers)
    )
      throw new ApiError(503, 'mdm_selection_invalid', 'MDM unavailable');
    return escrow;
  }

  async customers(token: string, adminId: string, sessionId: string): Promise<MdmCustomer[]> {
    return (await this.selection(token, adminId, sessionId, false)).customers;
  }

  async choose(
    token: string,
    customerId: string,
    adminId: string,
    sessionId: string,
    correlationId: string,
  ): Promise<void> {
    const escrow = await this.selection(token, adminId, sessionId, true);
    let refreshToken = escrow.refreshToken;
    try {
      if (!escrow.customers.some((customer) => customer.customer_id === customerId))
        throw new ApiError(403, 'mdm_customer_forbidden', 'Forbidden');
      const exchanged = await refreshAccess(this.oauthConfig(), refreshToken, this.fetchImpl);
      if (
        exchanged.grantedScope &&
        !exchanged.grantedScope.split(/[,\s]+/).includes(INVENTORY_SCOPE)
      )
        throw new ApiError(403, 'mdm_oauth_scope_insufficient', 'Authorization rejected');
      refreshToken = exchanged.refreshToken ?? refreshToken;
      await this.activate(
        customerId,
        refreshToken,
        exchanged.accessToken,
        adminId,
        sessionId,
        correlationId,
      );
      refreshToken = '';
    } catch (error) {
      if (refreshToken)
        await revokeRefresh(this.oauthConfig(), refreshToken, this.fetchImpl).catch(() => false);
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'mdm_oauth_exchange_failed', 'Authorization failed');
    }
  }
}
