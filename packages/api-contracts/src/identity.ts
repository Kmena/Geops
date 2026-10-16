// Canonical byte layouts from SPEC-00; signing and verification belong to T10–T12.
export const identityContractVersion = 'v1' as const;

export interface EnrollmentProofFields {
  claimId: string;
  challengeId: string;
  challenge: string;
  geopsDeviceId: string;
  mdmDeviceId: string;
  publicKeySpkiSha256: string;
  clientNonce: string;
}

export interface RequestProofFields {
  method: string;
  absolutePath: string;
  bodySha256: string;
  tokenSha256: string;
  timestamp: string;
  nonce: string;
  keyId: string;
}

export function enrollmentProofBytes(fields: EnrollmentProofFields): Uint8Array {
  return new TextEncoder().encode(
    [
      'GEOPS-ENROLL-V1',
      fields.claimId,
      fields.challengeId,
      fields.challenge,
      fields.geopsDeviceId,
      fields.mdmDeviceId,
      fields.publicKeySpkiSha256,
      fields.clientNonce,
    ].join('\n'),
  );
}

export function requestProofBytes(fields: RequestProofFields): Uint8Array {
  if (fields.method !== fields.method.toUpperCase()) {
    throw new Error('method must be uppercase');
  }
  if (!fields.absolutePath.startsWith('/') || fields.absolutePath.includes('?')) {
    throw new Error('path must be absolute and query-free');
  }
  return new TextEncoder().encode(
    [
      'GEOPS-REQ-V1',
      fields.method,
      fields.absolutePath,
      fields.bodySha256,
      fields.tokenSha256,
      fields.timestamp,
      fields.nonce,
      fields.keyId,
    ].join('\n'),
  );
}

export function enrollmentAttestationMessage(
  invitationId: string,
  geopsDeviceId: string,
  clientNonce: string,
): Uint8Array {
  return new TextEncoder().encode(
    ['GEOPS-ATTEST-ENROLL-V1', invitationId, geopsDeviceId, clientNonce].join('\n'),
  );
}

export function rotationAttestationMessage(challengeId: string, challenge: string): Uint8Array {
  return new TextEncoder().encode(['GEOPS-ATTEST-ROTATE-V1', challengeId, challenge].join('\n'));
}

export function sessionProofBytes(
  challengeId: string,
  challenge: string,
  keyId: string,
  geopsDeviceId: string,
): Uint8Array {
  return new TextEncoder().encode(
    ['GEOPS-SESSION-V1', challengeId, challenge, keyId, geopsDeviceId].join('\n'),
  );
}

export function rotationProofBytes(
  challengeId: string,
  challenge: string,
  geopsDeviceId: string,
  oldKeyId: string,
  newPublicKeySpkiSha256: string,
): Uint8Array {
  return new TextEncoder().encode(
    [
      'GEOPS-ROTATE-V1',
      challengeId,
      challenge,
      geopsDeviceId,
      oldKeyId,
      newPublicKeySpkiSha256,
    ].join('\n'),
  );
}
