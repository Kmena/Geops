import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import { appendAudit } from '../audit/index.js';
import { decodeBase64url, popBytes, sessionBytes, sha256, verifyP256 } from './crypto.js';
import { transaction } from './repository.js';

const CHALLENGE_MS = 2 * 60_000;
const SESSION_MS = 15 * 60_000;
const SKEW_SECONDS = 5 * 60;

export interface DevicePrincipal {
  deviceId: string;
  keyId: string;
  sessionId: string;
}

export class DeviceSessionService {
  private readonly now: () => Date;

  constructor(
    private readonly pool: Pool,
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  async challenge(
    deviceId: string,
    keyId: string,
  ): Promise<{
    challenge_id: string;
    challenge: string;
    server_time: string;
    expires_at: string;
  }> {
    const now = this.now();
    const result = await this.pool.query(
      "SELECT k.id FROM device_key k JOIN geops_device d ON d.id=k.geops_device_id WHERE k.id=$1 AND k.geops_device_id=$2 AND k.status='ACTIVE' AND d.status='ACTIVE'",
      [keyId, deviceId],
    );
    if (!result.rowCount) throw new ApiError(403, 'device_inactive', 'Forbidden', true);
    const value = randomBytes(32);
    const id = randomUUID();
    const expires = new Date(now.getTime() + CHALLENGE_MS);
    await this.pool.query(
      "INSERT INTO device_challenge(id,geops_device_id,key_id,purpose,challenge_hash,challenge_value,expires_at) VALUES($1,$2,$3,'SESSION',$4,$5,$6)",
      [id, deviceId, keyId, sha256(value), value, expires],
    );
    await appendAudit(this.pool, {
      actorType: 'DEVICE',
      deviceId,
      action: 'device.session.challenge',
      outcome: 'success',
      correlationId: randomUUID(),
    });
    return {
      challenge_id: id,
      challenge: value.toString('base64url'),
      server_time: now.toISOString(),
      expires_at: expires.toISOString(),
    };
  }

  async create(
    deviceId: string,
    keyId: string,
    challengeId: string,
    signature: string,
  ): Promise<{
    access_token: string;
    expires_at: string;
    key_id: string;
  }> {
    const now = this.now();
    return transaction(this.pool, async (db) => {
      const result = await db.query<{
        challenge_value: Buffer;
        expires_at: Date;
        consumed_at: Date | null;
      }>(
        "SELECT challenge_value,expires_at,consumed_at FROM device_challenge WHERE id=$1 AND geops_device_id=$2 AND key_id=$3 AND purpose='SESSION' FOR UPDATE",
        [challengeId, deviceId, keyId],
      );
      const challenge = result.rows[0];
      if (!challenge || challenge.consumed_at)
        throw new ApiError(409, 'challenge_consumed', 'Conflict', true);
      if (challenge.expires_at.getTime() <= now.getTime())
        throw new ApiError(410, 'challenge_expired', 'Gone', true);
      const device = await db.query<{ status: string }>(
        'SELECT status FROM geops_device WHERE id=$1 FOR UPDATE',
        [deviceId],
      );
      if (device.rows[0]?.status !== 'ACTIVE')
        throw new ApiError(403, 'device_inactive', 'Forbidden', true);
      const key = await db.query<{ public_key_spki_der: Buffer }>(
        "SELECT public_key_spki_der FROM device_key WHERE id=$1 AND geops_device_id=$2 AND status='ACTIVE' FOR UPDATE",
        [keyId, deviceId],
      );
      if (!key.rows[0]) throw new ApiError(403, 'device_inactive', 'Forbidden', true);
      const valid = verifyP256(
        key.rows[0].public_key_spki_der,
        sessionBytes(challengeId, challenge.challenge_value.toString('base64url'), keyId, deviceId),
        signature,
      );
      await db.query('UPDATE device_challenge SET consumed_at=$2 WHERE id=$1', [challengeId, now]);
      if (!valid) return { invalid: true as const };
      const token = randomBytes(32).toString('base64url');
      const expires = new Date(now.getTime() + SESSION_MS);
      await db.query(
        'INSERT INTO device_session(id,geops_device_id,key_id,token_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [randomUUID(), deviceId, keyId, sha256(token), now, expires],
      );
      await appendAudit(db, {
        actorType: 'DEVICE',
        deviceId,
        action: 'device.session.create',
        outcome: 'success',
        correlationId: randomUUID(),
      });
      return { invalid: false as const, token, expires };
    }).then((result) => {
      if (result.invalid) throw new ApiError(401, 'invalid_signature', 'Unauthorized', true);
      return {
        access_token: result.token,
        expires_at: result.expires.toISOString(),
        key_id: keyId,
      };
    });
  }

  async verifyRequest(request: FastifyRequest, rawBody: Buffer): Promise<DevicePrincipal> {
    if (request.url.includes('?'))
      throw new ApiError(400, 'query_rejected', 'Invalid request', true);
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer '))
      throw new ApiError(401, 'invalid_session', 'Unauthorized', true);
    const token = authorization.slice(7);
    try {
      decodeBase64url(token, 32);
    } catch {
      throw new ApiError(401, 'invalid_session', 'Unauthorized', true);
    }
    const keyId = request.headers['x-geops-key-id'];
    const timestamp = request.headers['x-geops-timestamp'];
    const nonce = request.headers['x-geops-nonce'];
    const signature = request.headers['x-geops-signature'];
    if (
      typeof keyId !== 'string' ||
      typeof timestamp !== 'string' ||
      typeof nonce !== 'string' ||
      typeof signature !== 'string' ||
      !/^[0-9]{10,11}$/.test(timestamp)
    ) {
      throw new ApiError(401, 'invalid_proof', 'Unauthorized', true);
    }
    const nonceBytes = decodeBase64url(nonce, 16);
    const now = this.now();
    if (Math.abs(Number(timestamp) - Math.floor(now.getTime() / 1000)) > SKEW_SECONDS) {
      throw new ApiError(401, 'invalid_timestamp', 'Unauthorized', true);
    }
    const result = await this.pool.query<{
      session_id: string;
      device_id: string;
      key_id: string;
      spki: Buffer;
      device_status: string;
      key_status: string;
    }>(
      'SELECT s.id AS session_id,s.geops_device_id AS device_id,s.key_id,k.public_key_spki_der AS spki,d.status AS device_status,k.status AS key_status FROM device_session s JOIN device_key k ON k.id=s.key_id JOIN geops_device d ON d.id=s.geops_device_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2',
      [sha256(token), now],
    );
    const row = result.rows[0];
    if (!row || row.key_id !== keyId)
      throw new ApiError(401, 'invalid_session', 'Unauthorized', true);
    if (row.device_status !== 'ACTIVE' || row.key_status !== 'ACTIVE') {
      throw new ApiError(403, 'device_inactive', 'Forbidden', true);
    }
    const path = request.url;
    const valid = verifyP256(
      row.spki,
      popBytes({
        method: request.method.toUpperCase(),
        absolutePath: path,
        bodySha256: sha256(rawBody).toString('base64url'),
        tokenSha256: sha256(token).toString('base64url'),
        timestamp,
        nonce,
        keyId,
      }),
      signature,
    );
    if (!valid) throw new ApiError(401, 'invalid_proof', 'Unauthorized', true);
    const inserted = await this.pool.query(
      'INSERT INTO device_request_nonce(key_id,nonce_hash,observed_at,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT (key_id,nonce_hash) DO UPDATE SET observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at WHERE device_request_nonce.expires_at<=EXCLUDED.observed_at',
      [keyId, sha256(nonceBytes), now, new Date(now.getTime() + 10 * 60_000)],
    );
    if (inserted.rowCount !== 1) throw new ApiError(409, 'nonce_replay', 'Conflict', true);
    await appendAudit(this.pool, {
      actorType: 'DEVICE',
      deviceId: row.device_id,
      action: 'device.pop.accept',
      outcome: 'success',
      correlationId: request.id,
    });
    return { deviceId: row.device_id, keyId, sessionId: row.session_id };
  }
}
