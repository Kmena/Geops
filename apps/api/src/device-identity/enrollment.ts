import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ApiError } from '../errors.js';
import { appendAudit } from '../audit/index.js';
import {
  decodeBase64url,
  enrollmentAttestationChallenge,
  enrollmentBytes,
  invitationDigest,
  pairingCode,
  sameBytes,
  sha256,
  validateP256Spki,
  verifyP256,
} from './crypto.js';
import { type DeviceRepository, transaction } from './repository.js';
import { requireInstallationAccess } from './admin-scope.js';

const INVITATION_MS = 10 * 60_000;
const MANAGED_INVITATION_MS = 24 * 60 * 60_000;
const CHALLENGE_MS = 2 * 60_000;

export interface ClaimInput {
  invitation_id: string;
  invitation_secret: string;
  geops_device_id: string;
  mdm_device_id: string;
  public_key_spki: string;
  client_nonce: string;
}

export interface AttestationVerifier {
  verify(chain: readonly string[], expectedChallenge: Buffer, spki: Buffer): Promise<boolean>;
}

export class RejectingAttestationVerifier implements AttestationVerifier {
  async verify(): Promise<boolean> {
    return false;
  }
}

export class EnrollmentService {
  private readonly now: () => Date;

  private async rejected(
    adminId: string,
    deviceId: string,
    action: string,
    correlationId: string,
    error: unknown,
  ): Promise<void> {
    await appendAudit(this.pool, {
      actorType: 'ADMIN',
      actorId: adminId,
      deviceId,
      action,
      outcome: 'rejected',
      correlationId,
      metadata: { code: error instanceof ApiError ? error.code : 'dependency_unavailable' },
    }).catch(() => {});
  }

  constructor(
    private readonly pool: Pool,
    private readonly repository: DeviceRepository,
    private readonly invitationKey: Buffer,
    private readonly attestation: AttestationVerifier = new RejectingAttestationVerifier(),
    now?: () => Date,
  ) {
    if (invitationKey.length !== 32) throw new Error('Invitation key must be 32 bytes');
    this.now = now ?? (() => new Date());
  }

  async issueInvitation(
    deviceId: string,
    bindingId: string,
    deliveryMode: string,
    adminId: string,
    correlationId: string = randomUUID(),
  ): Promise<{
    invitation_id: string;
    geops_device_id: string;
    invitation_secret: string;
    expires_at: string;
    managed_configuration?: Record<string, string>;
  }> {
    if (deliveryMode !== 'supervised_qr' && deliveryMode !== 'managed_configuration') {
      throw new ApiError(403, 'delivery_unavailable', 'Forbidden', true);
    }
    try {
      return await transaction(this.pool, async (db) => {
        await requireInstallationAccess(db, adminId, 'synthetic');
        const device = await this.repository.getDeviceForUpdate(db, deviceId);
        if (!['DRAFT', 'INVITED', 'PENDING_CONFIRMATION'].includes(device.status)) {
          throw new ApiError(409, 'device_state', 'Conflict', true);
        }
        const binding = await this.repository.getBinding(db, bindingId, deviceId);
        if (binding.provider !== 'fake' || binding.customer_id !== 'synthetic') {
          throw new ApiError(403, 'real_binding_disabled', 'Forbidden', true);
        }
        let managedMdmId: string | null = null;
        if (deliveryMode === 'managed_configuration') {
          const managed = await db.query<{ mdm_device_id: string }>(
            `SELECT mdm_device_id FROM mdm_inventory_device WHERE geops_device_id=$1
             AND provider='manageengine' AND status='managed' AND platform='android'
             AND removed=false AND last_seen_at >= $2::timestamptz - interval '1 hour'
             FOR SHARE`,
            [deviceId, this.now()],
          );
          if (managed.rows.length !== 1 || !managed.rows[0])
            throw new ApiError(409, 'mdm_device_unavailable', 'Conflict', true);
          managedMdmId = managed.rows[0].mdm_device_id;
        }
        await requireInstallationAccess(db, adminId, binding.customer_id);
        await db.query(
          "UPDATE enrollment_claim SET status='CANCELLED',version=version+1 WHERE geops_device_id=$1 AND status IN ('CLAIMED','PENDING_CONFIRMATION')",
          [deviceId],
        );
        await db.query(
          "UPDATE device_invitation SET status='CANCELLED',version=version+1 WHERE geops_device_id=$1 AND status IN ('ISSUED','CLAIMED')",
          [deviceId],
        );
        const secret = randomBytes(32);
        const issued = this.now();
        const expires = new Date(
          issued.getTime() +
            (deliveryMode === 'managed_configuration' ? MANAGED_INVITATION_MS : INVITATION_MS),
        );
        const id = randomUUID();
        await db.query(
          "INSERT INTO device_invitation(id,geops_device_id,mdm_binding_id,secret_hmac,status,delivery_mode,issued_by,issued_at,expires_at) VALUES($1,$2,$3,$4,'ISSUED',$5,$6,$7,$8)",
          [
            id,
            deviceId,
            bindingId,
            invitationDigest(this.invitationKey, secret),
            deliveryMode,
            adminId,
            issued,
            expires,
          ],
        );
        await db.query(
          "UPDATE geops_device SET status='INVITED',version=version+1,updated_at=$2 WHERE id=$1",
          [deviceId, issued],
        );
        await appendAudit(db, {
          actorType: 'ADMIN',
          actorId: adminId,
          deviceId,
          action: 'device.invitation.issue',
          outcome: 'success',
          correlationId,
          previousState: device.status,
          nextState: 'INVITED',
        });
        return {
          invitation_id: id,
          geops_device_id: deviceId,
          invitation_secret: secret.toString('base64url'),
          expires_at: expires.toISOString(),
          ...(managedMdmId
            ? {
                managed_configuration: {
                  geops_device_id: deviceId,
                  mdm_device_id: managedMdmId,
                  invitation_id: id,
                  invitation_secret: secret.toString('base64url'),
                  expires_at: expires.toISOString(),
                },
              }
            : {}),
        };
      });
    } catch (error) {
      await this.rejected(adminId, deviceId, 'device.invitation.issue', correlationId, error);
      throw error;
    }
  }

  async cancelInvitation(
    deviceId: string,
    invitationId: string,
    adminId: string,
    correlationId: string = randomUUID(),
  ): Promise<{ status: 'CANCELLED' }> {
    try {
      return await transaction(this.pool, async (db) => {
        await requireInstallationAccess(db, adminId, 'synthetic');
        const device = await this.repository.getDeviceForUpdate(db, deviceId);
        if (device.status === 'ACTIVE' || device.status === 'REVOKED')
          throw new ApiError(409, 'device_state', 'Conflict', true);
        const result = await db.query<{ status: string; mdm_binding_id: string }>(
          'SELECT status,mdm_binding_id FROM device_invitation WHERE id=$1 AND geops_device_id=$2 FOR UPDATE',
          [invitationId, deviceId],
        );
        const invite = result.rows[0];
        if (!invite) throw new ApiError(404, 'invitation_missing', 'Not found', true);
        const binding = await this.repository.getBinding(db, invite.mdm_binding_id, deviceId);
        if (binding.provider !== 'fake' || binding.customer_id !== 'synthetic')
          throw new ApiError(403, 'real_binding_disabled', 'Forbidden', true);
        await requireInstallationAccess(db, adminId, binding.customer_id);
        if (invite.status !== 'ISSUED' && invite.status !== 'CLAIMED')
          throw new ApiError(409, 'invitation_state', 'Conflict', true);
        await db.query(
          "UPDATE device_invitation SET status='CANCELLED',version=version+1 WHERE id=$1",
          [invitationId],
        );
        await db.query(
          "UPDATE enrollment_claim SET status='CANCELLED',version=version+1 WHERE invitation_id=$1 AND status IN ('CLAIMED','PENDING_CONFIRMATION')",
          [invitationId],
        );
        await db.query(
          "UPDATE geops_device SET status='DRAFT',version=version+1,updated_at=$2 WHERE id=$1 AND status IN ('INVITED','PENDING_CONFIRMATION')",
          [deviceId, this.now()],
        );
        await appendAudit(db, {
          actorType: 'ADMIN',
          actorId: adminId,
          deviceId,
          action: 'device.invitation.cancel',
          outcome: 'success',
          correlationId,
          previousState: invite.status,
          nextState: 'CANCELLED',
        });
        return { status: 'CANCELLED' };
      });
    } catch (error) {
      await this.rejected(adminId, deviceId, 'device.invitation.cancel', correlationId, error);
      throw error;
    }
  }

  async claim(
    input: ClaimInput,
    correlationId: string = randomUUID(),
  ): Promise<{ claim_id: string; challenge_id: string; challenge: string; expires_at: string }> {
    const secret = decodeBase64url(input.invitation_secret, 32);
    const nonce = decodeBase64url(input.client_nonce, 16);
    const spki = validateP256Spki(input.public_key_spki);
    const now = this.now();
    return transaction(this.pool, async (db) => {
      const inviteResult = await db.query<{
        id: string;
        geops_device_id: string;
        mdm_binding_id: string;
        secret_hmac: Buffer;
        status: string;
        delivery_mode: string;
        expires_at: Date;
      }>(
        'SELECT id,geops_device_id,mdm_binding_id,secret_hmac,status,delivery_mode,expires_at FROM device_invitation WHERE id=$1 FOR UPDATE',
        [input.invitation_id],
      );
      const invite = inviteResult.rows[0];
      if (!invite || invite.geops_device_id !== input.geops_device_id) {
        throw new ApiError(401, 'invalid_invitation', 'Unauthorized', true);
      }
      if (invite.expires_at.getTime() <= now.getTime())
        throw new ApiError(410, 'invitation_expired', 'Gone', true);
      if (invite.status !== 'ISSUED')
        throw new ApiError(409, 'invitation_consumed', 'Conflict', true);
      if (!sameBytes(invite.secret_hmac, invitationDigest(this.invitationKey, secret))) {
        throw new ApiError(401, 'invalid_invitation', 'Unauthorized', true);
      }
      const binding = await this.repository.getBinding(
        db,
        invite.mdm_binding_id,
        input.geops_device_id,
      );
      if (binding.provider !== 'fake' || binding.customer_id !== 'synthetic') {
        throw new ApiError(403, 'binding_mismatch', 'Forbidden', true);
      }
      if (invite.delivery_mode === 'managed_configuration') {
        const managed = await db.query(
          `SELECT 1 FROM mdm_inventory_device WHERE geops_device_id=$1 AND mdm_device_id=$2
           AND provider='manageengine' AND status='managed' AND platform='android'
           AND removed=false AND last_seen_at >= $3::timestamptz - interval '1 hour'
           FOR SHARE`,
          [input.geops_device_id, input.mdm_device_id, now],
        );
        if (managed.rows.length !== 1)
          throw new ApiError(403, 'binding_mismatch', 'Forbidden', true);
      } else if (binding.mdm_device_id !== input.mdm_device_id) {
        throw new ApiError(403, 'binding_mismatch', 'Forbidden', true);
      }
      const device = await this.repository.getDeviceForUpdate(db, input.geops_device_id);
      if (device.status !== 'INVITED') throw new ApiError(409, 'device_state', 'Conflict', true);
      const changed = await db.query(
        "UPDATE device_invitation SET status='CLAIMED',version=version+1 WHERE id=$1 AND status='ISSUED'",
        [invite.id],
      );
      if (changed.rowCount !== 1) throw new ApiError(409, 'invitation_consumed', 'Conflict', true);
      const challenge = randomBytes(32);
      const challengeId = randomUUID();
      const expires = new Date(now.getTime() + CHALLENGE_MS);
      const claimId = randomUUID();
      await db.query(
        "INSERT INTO device_challenge(id,geops_device_id,purpose,challenge_hash,challenge_value,expires_at) VALUES($1,$2,'ENROLL',$3,$4,$5)",
        [challengeId, input.geops_device_id, sha256(challenge), challenge, expires],
      );
      await db.query(
        "INSERT INTO enrollment_claim(id,invitation_id,geops_device_id,mdm_device_id,public_key_spki_der,client_nonce_hash,client_nonce_value,expected_attestation_challenge,challenge_id,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'CLAIMED',$10)",
        [
          claimId,
          invite.id,
          input.geops_device_id,
          input.mdm_device_id,
          spki,
          sha256(nonce),
          nonce,
          enrollmentAttestationChallenge(
            secret,
            invite.id,
            input.geops_device_id,
            input.client_nonce,
          ),
          challengeId,
          invite.expires_at,
        ],
      );
      await appendAudit(db, {
        actorType: 'DEVICE',
        deviceId: input.geops_device_id,
        action: 'device.claim',
        outcome: 'success',
        correlationId,
        previousState: 'INVITED',
        nextState: 'CLAIMED',
      });
      return {
        claim_id: claimId,
        challenge_id: challengeId,
        challenge: challenge.toString('base64url'),
        expires_at: expires.toISOString(),
      };
    });
  }

  async prove(
    claimId: string,
    challengeId: string,
    signature: string,
    chain?: readonly string[],
    correlationId: string = randomUUID(),
  ): Promise<
    | {
        status: 'PENDING_CONFIRMATION';
        pairing_code: string;
        expires_at: string;
      }
    | { status: 'ACTIVE'; key_id: string; installation_id: string }
  > {
    if (chain && chain.length === 0)
      throw new ApiError(401, 'invalid_attestation', 'Unauthorized', true);
    const now = this.now();
    const outcome = await transaction(this.pool, async (db) => {
      const result = await db.query<{
        id: string;
        invitation_id: string;
        geops_device_id: string;
        mdm_device_id: string;
        public_key_spki_der: Buffer;
        client_nonce_value: Buffer;
        challenge_id: string;
        status: string;
        expires_at: Date;
        expected_attestation_challenge: Buffer;
      }>('SELECT * FROM enrollment_claim WHERE id=$1 FOR UPDATE', [claimId]);
      const claim = result.rows[0];
      if (!claim || claim.challenge_id !== challengeId)
        throw new ApiError(409, 'claim_unavailable', 'Conflict', true);
      if (claim.status !== 'CLAIMED') throw new ApiError(409, 'claim_consumed', 'Conflict', true);
      if (claim.expires_at.getTime() <= now.getTime())
        throw new ApiError(410, 'claim_expired', 'Gone', true);
      const challengeResult = await db.query<{
        challenge_value: Buffer;
        expires_at: Date;
        consumed_at: Date | null;
      }>(
        "SELECT challenge_value,expires_at,consumed_at FROM device_challenge WHERE id=$1 AND purpose='ENROLL' FOR UPDATE",
        [challengeId],
      );
      const challenge = challengeResult.rows[0];
      if (!challenge || challenge.consumed_at)
        throw new ApiError(409, 'challenge_consumed', 'Conflict', true);
      if (challenge.expires_at.getTime() <= now.getTime())
        throw new ApiError(410, 'challenge_expired', 'Gone', true);
      const valid = verifyP256(
        claim.public_key_spki_der,
        enrollmentBytes({
          claimId,
          challengeId,
          challenge: challenge.challenge_value.toString('base64url'),
          deviceId: claim.geops_device_id,
          mdmDeviceId: claim.mdm_device_id,
          spki: claim.public_key_spki_der,
          nonce: claim.client_nonce_value.toString('base64url'),
        }),
        signature,
      );
      const attestationResult =
        chain && chain.length > 0
          ? await this.attestation.verify(
              chain,
              claim.expected_attestation_challenge,
              claim.public_key_spki_der,
            )
          : null;
      if (!valid || attestationResult === false) {
        await db.query(
          "UPDATE enrollment_claim SET status='CANCELLED',version=version+1 WHERE id=$1",
          [claimId],
        );
        await db.query(
          "UPDATE device_invitation SET status='CANCELLED',version=version+1 WHERE id=$1",
          [claim.invitation_id],
        );
        await db.query('UPDATE device_challenge SET consumed_at=$2 WHERE id=$1', [
          challengeId,
          now,
        ]);
        await appendAudit(db, {
          actorType: 'DEVICE',
          deviceId: claim.geops_device_id,
          action: 'device.claim.proof',
          outcome: 'rejected',
          correlationId,
          previousState: 'CLAIMED',
          nextState: 'CANCELLED',
        });
        return { error: new ApiError(401, 'invalid_proof', 'Unauthorized', true) };
      }
      const invitation = await db.query<{ delivery_mode: string; issued_by: string }>(
        "SELECT delivery_mode,issued_by FROM device_invitation WHERE id=$1 AND status='CLAIMED' FOR UPDATE",
        [claim.invitation_id],
      );
      if (!invitation.rows[0]) throw new ApiError(409, 'invitation_consumed', 'Conflict', true);
      if (invitation.rows[0].delivery_mode === 'managed_configuration') {
        const managed = await db.query(
          `SELECT 1 FROM mdm_inventory_device WHERE geops_device_id=$1 AND mdm_device_id=$2
           AND provider='manageengine' AND status='managed' AND platform='android'
           AND removed=false AND last_seen_at >= $3::timestamptz - interval '1 hour'
           FOR SHARE`,
          [claim.geops_device_id, claim.mdm_device_id, now],
        );
        if (managed.rows.length !== 1)
          throw new ApiError(409, 'mdm_device_unavailable', 'Conflict', true);
        const activeKey = await db.query(
          "SELECT 1 FROM device_key WHERE geops_device_id=$1 AND status='ACTIVE' FOR SHARE",
          [claim.geops_device_id],
        );
        const activeInstallation = await db.query(
          'SELECT 1 FROM gps_device_installation WHERE device_id=$1 AND retired_at IS NULL FOR SHARE',
          [claim.geops_device_id],
        );
        if (activeKey.rowCount || activeInstallation.rowCount)
          throw new ApiError(409, 'device_state', 'Conflict', true);
        const keyId = randomUUID();
        const installationId = randomUUID();
        await db.query(
          "INSERT INTO device_key(id,geops_device_id,public_key_spki_der,public_key_fingerprint,status) VALUES($1,$2,$3,$4,'ACTIVE')",
          [
            keyId,
            claim.geops_device_id,
            claim.public_key_spki_der,
            sha256(claim.public_key_spki_der),
          ],
        );
        await db.query(
          `INSERT INTO geops_device_tenant(device_id,tenant_id,established_by,source,evidence_ref)
           VALUES($1,'synthetic',$2,'GEOPS_ENROLLMENT',$3)`,
          [claim.geops_device_id, invitation.rows[0].issued_by, claimId],
        );
        await db.query(
          `INSERT INTO gps_device_installation(installation_id,device_id,activated_at,activation_tenant_id)
           VALUES($1,$2,$3,'synthetic')`,
          [installationId, claim.geops_device_id, now],
        );
        await db.query('UPDATE device_challenge SET consumed_at=$2 WHERE id=$1', [
          challengeId,
          now,
        ]);
        await db.query(
          "UPDATE enrollment_claim SET status='ACTIVE',attestation_state=$2,version=version+1 WHERE id=$1",
          [claimId, attestationResult ? 'VERIFIED' : 'UNSUPPORTED'],
        );
        await db.query(
          "UPDATE device_invitation SET status='CONSUMED',consumed_at=$2,version=version+1 WHERE id=$1",
          [claim.invitation_id, now],
        );
        await db.query(
          "UPDATE geops_device SET status='ACTIVE',version=version+1,updated_at=$2 WHERE id=$1 AND status='INVITED'",
          [claim.geops_device_id, now],
        );
        await appendAudit(db, {
          actorType: 'DEVICE',
          deviceId: claim.geops_device_id,
          action: 'device.activate.managed',
          outcome: 'success',
          correlationId,
          previousState: 'INVITED',
          nextState: 'ACTIVE',
          metadata: { source: 'manageengine', mdm_device_id: claim.mdm_device_id },
        });
        return {
          value: { status: 'ACTIVE' as const, key_id: keyId, installation_id: installationId },
        };
      }
      const code = pairingCode(challenge.challenge_value, claim.public_key_spki_der);
      await db.query('UPDATE device_challenge SET consumed_at=$2 WHERE id=$1', [challengeId, now]);
      await db.query(
        "UPDATE enrollment_claim SET status='PENDING_CONFIRMATION',pairing_code_hash=$2,attestation_state=$3,version=version+1 WHERE id=$1",
        [
          claimId,
          invitationDigest(this.invitationKey, Buffer.from(code)),
          attestationResult ? 'VERIFIED' : 'UNSUPPORTED',
        ],
      );
      await db.query(
        "UPDATE geops_device SET status='PENDING_CONFIRMATION',version=version+1,updated_at=$2 WHERE id=$1",
        [claim.geops_device_id, now],
      );
      await appendAudit(db, {
        actorType: 'DEVICE',
        deviceId: claim.geops_device_id,
        action: 'device.claim.proof',
        outcome: 'success',
        correlationId,
        previousState: 'CLAIMED',
        nextState: 'PENDING_CONFIRMATION',
      });
      return {
        value: {
          status: 'PENDING_CONFIRMATION' as const,
          pairing_code: code,
          expires_at: claim.expires_at.toISOString(),
        },
      };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }

  async recordSyntheticEvidence(
    claimId: string,
    deviceId: string,
    adminId: string,
    physicalConfirmed: boolean,
    attestationException: boolean,
    correlationId: string = randomUUID(),
  ): Promise<string> {
    if (!physicalConfirmed)
      throw new ApiError(403, 'physical_confirmation_required', 'Forbidden', true);
    try {
      return await transaction(this.pool, async (db) => {
        await requireInstallationAccess(db, adminId, 'synthetic');
        const result = await db.query<{
          mdm_device_id: string;
          geops_device_id: string;
          invitation_id: string;
        }>(
          "SELECT mdm_device_id,geops_device_id,invitation_id FROM enrollment_claim WHERE id=$1 AND status='PENDING_CONFIRMATION' FOR UPDATE",
          [claimId],
        );
        const claim = result.rows[0];
        if (!claim || claim.geops_device_id !== deviceId)
          throw new ApiError(409, 'claim_unavailable', 'Conflict', true);
        const binding = await db.query<{ id: string; customer_id: string; provider: string }>(
          'SELECT b.id,b.customer_id,b.provider FROM mdm_binding b JOIN device_invitation i ON i.mdm_binding_id=b.id WHERE i.id=$1',
          [claim.invitation_id],
        );
        const row = binding.rows[0];
        if (row?.provider !== 'fake' || row.customer_id !== 'synthetic')
          throw new ApiError(403, 'real_binding_disabled', 'Forbidden', true);
        await requireInstallationAccess(db, adminId, row.customer_id);
        const id = randomUUID();
        await db.query(
          "INSERT INTO synthetic_mdm_evidence(id,claim_id,mdm_binding_id,tenant,mdm_device_id,operator_id,physical_confirmed,method,attestation_exception) VALUES($1,$2,$3,$4,$5,$6,true,'manual_two_traits',$7)",
          [
            id,
            claimId,
            row.id,
            row.customer_id,
            claim.mdm_device_id,
            adminId,
            attestationException,
          ],
        );
        await appendAudit(db, {
          actorType: 'ADMIN',
          actorId: adminId,
          deviceId,
          action: 'device.synthetic_evidence',
          outcome: 'success',
          correlationId,
          metadata: { source: 'fake', attestation_exception: attestationException },
        });
        return id;
      });
    } catch (error) {
      await this.rejected(adminId, deviceId, 'device.synthetic_evidence', correlationId, error);
      throw error;
    }
  }

  async activate(
    deviceId: string,
    claimId: string,
    code: string,
    method: string,
    evidenceRef: string,
    adminId: string,
    correlationId: string = randomUUID(),
  ): Promise<{
    status: 'ACTIVE';
    key_id: string;
    mdm_binding_id: string;
  }> {
    if (!/^[0-9]{8}$/.test(code) || method !== 'manual_two_traits') {
      throw new ApiError(403, 'confirmation_required', 'Forbidden', true);
    }
    try {
      return await transaction(this.pool, async (db) => {
        await requireInstallationAccess(db, adminId, 'synthetic');
        const device = await this.repository.getDeviceForUpdate(db, deviceId);
        if (device.status !== 'PENDING_CONFIRMATION')
          throw new ApiError(409, 'device_state', 'Conflict', true);
        const result = await db.query<{
          invitation_id: string;
          geops_device_id: string;
          public_key_spki_der: Buffer;
          pairing_code_hash: Buffer;
          status: string;
          expires_at: Date;
          attestation_state: string;
        }>('SELECT * FROM enrollment_claim WHERE id=$1 FOR UPDATE', [claimId]);
        const claim = result.rows[0];
        if (
          !claim ||
          claim.geops_device_id !== deviceId ||
          claim.status !== 'PENDING_CONFIRMATION'
        ) {
          throw new ApiError(409, 'claim_unavailable', 'Conflict', true);
        }
        if (claim.expires_at.getTime() <= this.now().getTime())
          throw new ApiError(410, 'claim_expired', 'Gone', true);
        if (
          !sameBytes(
            claim.pairing_code_hash,
            invitationDigest(this.invitationKey, Buffer.from(code)),
          )
        ) {
          throw new ApiError(403, 'confirmation_mismatch', 'Forbidden', true);
        }
        const invitation = await db.query<{ mdm_binding_id: string; status: string }>(
          'SELECT mdm_binding_id,status FROM device_invitation WHERE id=$1 FOR UPDATE',
          [claim.invitation_id],
        );
        if (invitation.rows[0]?.status !== 'CLAIMED')
          throw new ApiError(409, 'invitation_consumed', 'Conflict', true);
        const bindingId = invitation.rows[0].mdm_binding_id;
        const binding = await this.repository.getBinding(db, bindingId, deviceId);
        if (binding.provider !== 'fake' || binding.customer_id !== 'synthetic')
          throw new ApiError(403, 'real_binding_disabled', 'Forbidden', true);
        await requireInstallationAccess(db, adminId, binding.customer_id);
        const evidence = await db.query<{
          operator_id: string;
          physical_confirmed: boolean;
          attestation_exception: boolean;
        }>(
          "SELECT e.operator_id,e.physical_confirmed,e.attestation_exception FROM synthetic_mdm_evidence e JOIN mdm_binding b ON b.id=e.mdm_binding_id JOIN enrollment_claim c ON c.id=e.claim_id WHERE e.id=$1 AND e.claim_id=$2 AND e.mdm_binding_id=$3 AND e.operator_id=$4 AND e.method='manual_two_traits' AND e.tenant=b.customer_id AND e.mdm_device_id=c.mdm_device_id AND b.provider='fake'",
          [evidenceRef, claimId, bindingId, adminId],
        );
        const proof = evidence.rows[0];
        if (
          !proof?.physical_confirmed ||
          (claim.attestation_state !== 'VERIFIED' && !proof.attestation_exception)
        ) {
          throw new ApiError(403, 'evidence_missing', 'Forbidden', true);
        }
        const keyId = randomUUID();
        await db.query(
          "INSERT INTO device_key(id,geops_device_id,public_key_spki_der,public_key_fingerprint,status) VALUES($1,$2,$3,$4,'ACTIVE')",
          [keyId, deviceId, claim.public_key_spki_der, sha256(claim.public_key_spki_der)],
        );
        await db.query(
          "UPDATE geops_device SET status='ACTIVE',version=version+1,updated_at=now() WHERE id=$1",
          [deviceId],
        );
        await db.query(
          "UPDATE mdm_binding SET state='ACTIVE',verified_at=now(),verification_method=$2,evidence_ref=$3,version=version+1 WHERE id=$1 AND state='PENDING'",
          [bindingId, method, evidenceRef],
        );
        await db.query(
          "UPDATE enrollment_claim SET status='ACTIVE',version=version+1 WHERE id=$1",
          [claimId],
        );
        await db.query(
          "UPDATE device_invitation SET status='CONSUMED',consumed_at=now(),version=version+1 WHERE id=$1",
          [claim.invitation_id],
        );
        await appendAudit(db, {
          actorType: 'ADMIN',
          actorId: adminId,
          deviceId,
          action: 'device.activate.synthetic',
          outcome: 'success',
          correlationId,
          previousState: 'PENDING_CONFIRMATION',
          nextState: 'ACTIVE',
          metadata: { source: 'fake' },
        });
        return { status: 'ACTIVE', key_id: keyId, mdm_binding_id: bindingId };
      });
    } catch (error) {
      await this.rejected(adminId, deviceId, 'device.activate.synthetic', correlationId, error);
      throw error;
    }
  }
}
