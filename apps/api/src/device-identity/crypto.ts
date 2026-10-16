import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import {
  enrollmentAttestationMessage,
  enrollmentProofBytes,
  requestProofBytes,
  rotationAttestationMessage,
  rotationProofBytes,
  sessionProofBytes,
  type RequestProofFields,
} from '@geops/api-contracts';
import { ApiError } from '../errors.js';

export function decodeBase64url(value: string, length?: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new ApiError(400, 'invalid_encoding', 'Invalid request', true);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value || (length !== undefined && bytes.length !== length)) {
    throw new ApiError(400, 'invalid_encoding', 'Invalid request', true);
  }
  return bytes;
}

export function sha256(value: Buffer | Uint8Array | string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function sameBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function validateP256Spki(encoded: string): Buffer {
  const der = decodeBase64url(encoded);
  if (der.length > 256) throw new ApiError(400, 'invalid_key', 'Invalid request', true);
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('Wrong curve');
    }
    const canonical = key.export({ format: 'der', type: 'spki' });
    if (!sameBytes(Buffer.from(canonical), der)) throw new Error('Noncanonical key');
    return der;
  } catch {
    throw new ApiError(400, 'invalid_key', 'Invalid request', true);
  }
}

export function verifyP256(spki: Buffer, bytes: Uint8Array, signature: string): boolean {
  const der = decodeBase64url(signature);
  if (der.length > 80) return false;
  try {
    return verify('sha256', bytes, { key: spki, format: 'der', type: 'spki' }, der);
  } catch {
    return false;
  }
}

export function invitationDigest(key: Buffer, secret: Buffer): Buffer {
  return createHmac('sha256', key).update(secret).digest();
}

export function enrollmentAttestationChallenge(
  secret: Buffer,
  invitationId: string,
  deviceId: string,
  nonce: string,
): Buffer {
  return createHmac('sha256', secret)
    .update(enrollmentAttestationMessage(invitationId, deviceId, nonce))
    .digest();
}

export function rotationAttestationChallenge(challengeId: string, challenge: string): Buffer {
  return sha256(rotationAttestationMessage(challengeId, challenge));
}

export function enrollmentBytes(fields: {
  claimId: string;
  challengeId: string;
  challenge: string;
  deviceId: string;
  mdmDeviceId: string;
  spki: Buffer;
  nonce: string;
}): Uint8Array {
  return enrollmentProofBytes({
    claimId: fields.claimId,
    challengeId: fields.challengeId,
    challenge: fields.challenge,
    geopsDeviceId: fields.deviceId,
    mdmDeviceId: fields.mdmDeviceId,
    publicKeySpkiSha256: sha256(fields.spki).toString('base64url'),
    clientNonce: fields.nonce,
  });
}

export function pairingCode(challenge: Buffer, spki: Buffer): string {
  const digest = sha256(Buffer.concat([challenge, spki]));
  return String(digest.readUInt32BE(0) % 100_000_000).padStart(8, '0');
}

export function sessionBytes(
  challengeId: string,
  challenge: string,
  keyId: string,
  deviceId: string,
): Uint8Array {
  return sessionProofBytes(challengeId, challenge, keyId, deviceId);
}

export function rotationBytes(
  challengeId: string,
  challenge: string,
  deviceId: string,
  oldKeyId: string,
  spki: Buffer,
): Uint8Array {
  return rotationProofBytes(
    challengeId,
    challenge,
    deviceId,
    oldKeyId,
    sha256(spki).toString('base64url'),
  );
}

export function popBytes(fields: RequestProofFields): Uint8Array {
  return requestProofBytes(fields);
}
