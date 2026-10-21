import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ApiError } from '../errors.js';
import { appendAudit } from '../audit/index.js';
import {
  rotationAttestationChallenge,
  rotationBytes,
  sha256,
  validateP256Spki,
  verifyP256,
} from './crypto.js';
import { type AttestationVerifier, RejectingAttestationVerifier } from './enrollment.js';
import { type DeviceRepository, transaction, type DeviceRecord } from './repository.js';
import type { DevicePrincipal } from './session.js';

export class DeviceLifecycleService {
  private readonly now: () => Date;

  constructor(
    private readonly pool: Pool,
    private readonly repository: DeviceRepository,
    private readonly verifier: AttestationVerifier = new RejectingAttestationVerifier(),
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  async rotationChallenge(
    principal: DevicePrincipal,
  ): Promise<{ challenge_id: string; challenge: string; expires_at: string }> {
    const value = randomBytes(32);
    const id = randomUUID();
    const expires = new Date(this.now().getTime() + 2 * 60_000);
    await this.pool.query(
      "INSERT INTO device_challenge(id,geops_device_id,key_id,purpose,challenge_hash,challenge_value,expires_at) VALUES($1,$2,$3,'ROTATE',$4,$5,$6)",
      [id, principal.deviceId, principal.keyId, sha256(value), value, expires],
    );
    await appendAudit(this.pool, {
      actorType: 'DEVICE',
      deviceId: principal.deviceId,
      action: 'device.rotation.challenge',
      outcome: 'success',
      correlationId: randomUUID(),
    });
    return {
      challenge_id: id,
      challenge: value.toString('base64url'),
      expires_at: expires.toISOString(),
    };
  }

  async recordSyntheticRotationException(
    challengeId: string,
    adminId: string,
    reason: string,
  ): Promise<void> {
    if (reason.trim().length < 10)
      throw new ApiError(400, 'reason_required', 'Invalid request', true);
    await this.pool.query(
      "INSERT INTO synthetic_rotation_exception(challenge_id,operator_id,reason) SELECT id,$2,$3 FROM device_challenge WHERE id=$1 AND purpose='ROTATE' AND expires_at>now() AND consumed_at IS NULL",
      [challengeId, adminId, reason.trim()],
    );
  }

  async rotate(
    principal: DevicePrincipal,
    input: {
      challenge_id: string;
      new_public_key_spki: string;
      old_signature: string;
      new_signature: string;
      attestation_chain?: string[];
    },
    correlationId: string = randomUUID(),
  ): Promise<{ new_key_id: string; status: 'ACTIVE' }> {
    const newSpki = validateP256Spki(input.new_public_key_spki);
    const now = this.now();
    return transaction(this.pool, async (db) => {
      const device = await this.repository.getDeviceForUpdate(db, principal.deviceId);
      if (device.status !== 'ACTIVE') throw new ApiError(403, 'device_inactive', 'Forbidden', true);
      const oldResult = await db.query<{ public_key_spki_der: Buffer }>(
        "SELECT public_key_spki_der FROM device_key WHERE id=$1 AND geops_device_id=$2 AND status='ACTIVE' FOR UPDATE",
        [principal.keyId, principal.deviceId],
      );
      const oldKey = oldResult.rows[0];
      if (!oldKey) throw new ApiError(403, 'key_inactive', 'Forbidden', true);
      const session = await db.query(
        'SELECT id FROM device_session WHERE id=$1 AND key_id=$2 AND revoked_at IS NULL AND expires_at>$3 FOR UPDATE',
        [principal.sessionId, principal.keyId, now],
      );
      if (!session.rowCount) throw new ApiError(401, 'invalid_session', 'Unauthorized', true);
      const challengeResult = await db.query<{
        challenge_value: Buffer;
        expires_at: Date;
        consumed_at: Date | null;
      }>(
        "SELECT challenge_value,expires_at,consumed_at FROM device_challenge WHERE id=$1 AND geops_device_id=$2 AND key_id=$3 AND purpose='ROTATE' FOR UPDATE",
        [input.challenge_id, principal.deviceId, principal.keyId],
      );
      const challenge = challengeResult.rows[0];
      if (!challenge || challenge.consumed_at)
        throw new ApiError(409, 'challenge_consumed', 'Conflict', true);
      if (challenge.expires_at.getTime() <= now.getTime())
        throw new ApiError(410, 'challenge_expired', 'Gone', true);
      const encoded = challenge.challenge_value.toString('base64url');
      const bytes = rotationBytes(
        input.challenge_id,
        encoded,
        principal.deviceId,
        principal.keyId,
        newSpki,
      );
      if (
        !verifyP256(oldKey.public_key_spki_der, bytes, input.old_signature) ||
        !verifyP256(newSpki, bytes, input.new_signature)
      ) {
        throw new ApiError(401, 'invalid_signature', 'Unauthorized', true);
      }
      if (input.attestation_chain?.length) {
        const valid = await this.verifier.verify(
          input.attestation_chain,
          rotationAttestationChallenge(input.challenge_id, encoded),
          newSpki,
        );
        if (!valid) throw new ApiError(401, 'invalid_attestation', 'Unauthorized', true);
      } else {
        const exception = await db.query(
          'SELECT challenge_id FROM synthetic_rotation_exception WHERE challenge_id=$1',
          [input.challenge_id],
        );
        if (!exception.rowCount)
          throw new ApiError(403, 'attestation_exception_required', 'Forbidden', true);
      }
      await db.query(
        "UPDATE device_key SET status='REVOKED',revoked_at=$2,version=version+1 WHERE id=$1",
        [principal.keyId, now],
      );
      await db.query(
        'UPDATE device_session SET revoked_at=$2 WHERE geops_device_id=$1 AND revoked_at IS NULL',
        [principal.deviceId, now],
      );
      const newKeyId = randomUUID();
      await db.query(
        "INSERT INTO device_key(id,geops_device_id,public_key_spki_der,public_key_fingerprint,status) VALUES($1,$2,$3,$4,'ACTIVE')",
        [newKeyId, principal.deviceId, newSpki, sha256(newSpki)],
      );
      await db.query('UPDATE device_challenge SET consumed_at=$2 WHERE id=$1', [
        input.challenge_id,
        now,
      ]);
      await appendAudit(db, {
        actorType: 'DEVICE',
        deviceId: principal.deviceId,
        action: 'device.key.rotate',
        outcome: 'success',
        correlationId,
        previousState: principal.keyId,
        nextState: newKeyId,
      });
      return { new_key_id: newKeyId, status: 'ACTIVE' };
    });
  }

  revoke(
    deviceId: string,
    adminId?: string,
    correlationId: string = randomUUID(),
    reason?: string,
  ): Promise<void> {
    return this.repository.revoke(deviceId, adminId, correlationId, reason);
  }

  suspend(deviceId: string, adminId: string, correlationId: string, reason: string): Promise<void> {
    return this.repository.suspend(deviceId, adminId, correlationId, reason);
  }

  reactivate(
    deviceId: string,
    adminId: string,
    correlationId: string,
    reason: string,
  ): Promise<void> {
    return this.repository.reactivate(deviceId, adminId, correlationId, reason);
  }

  retire(deviceId: string, adminId: string, correlationId: string, reason: string): Promise<void> {
    return this.repository.retire(deviceId, adminId, correlationId, reason);
  }

  async replace(oldDeviceId: string, newLabel: string): Promise<DeviceRecord> {
    if (!newLabel.trim() || newLabel.length > 120)
      throw new ApiError(400, 'invalid_label', 'Invalid request', true);
    return transaction(this.pool, async (db) => {
      const old = await this.repository.getDeviceForUpdate(db, oldDeviceId);
      if (old.status !== 'REVOKED') {
        await db.query(
          "UPDATE geops_device SET status='REVOKED',version=version+1,updated_at=now() WHERE id=$1",
          [oldDeviceId],
        );
        await db.query(
          "UPDATE mdm_binding SET state='REVOKED',version=version+1 WHERE geops_device_id=$1",
          [oldDeviceId],
        );
        await db.query(
          "UPDATE device_invitation SET status='CANCELLED',version=version+1 WHERE geops_device_id=$1 AND status IN ('ISSUED','CLAIMED')",
          [oldDeviceId],
        );
        await db.query(
          "UPDATE enrollment_claim SET status='CANCELLED',version=version+1 WHERE geops_device_id=$1 AND status IN ('CLAIMED','PENDING_CONFIRMATION')",
          [oldDeviceId],
        );
        await db.query(
          "UPDATE device_key SET status='REVOKED',revoked_at=now(),version=version+1 WHERE geops_device_id=$1 AND status<>'REVOKED'",
          [oldDeviceId],
        );
        await db.query(
          'UPDATE device_session SET revoked_at=now() WHERE geops_device_id=$1 AND revoked_at IS NULL',
          [oldDeviceId],
        );
      }
      const id = randomUUID();
      const bindingId = randomUUID();
      await db.query(
        "INSERT INTO geops_device(id,status,display_label,replacement_of) VALUES($1,'DRAFT',$2,$3)",
        [id, newLabel.trim(), oldDeviceId],
      );
      await db.query(
        "INSERT INTO mdm_binding(id,geops_device_id,provider,customer_id,mdm_device_id,state) VALUES($1,$2,'fake','synthetic',$3,'PENDING')",
        [bindingId, id, `fake-${id}`],
      );
      await appendAudit(db, {
        actorType: 'SYSTEM',
        deviceId: oldDeviceId,
        action: 'device.replace.synthetic',
        outcome: 'success',
        correlationId: randomUUID(),
        previousState: old.status,
        nextState: 'REVOKED',
      });
      return { id, display_label: newLabel.trim(), status: 'DRAFT', mdm_binding_id: bindingId };
    });
  }
}
