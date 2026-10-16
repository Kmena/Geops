ALTER TABLE enrollment_claim
  ADD COLUMN attestation_state text NOT NULL DEFAULT 'UNVERIFIED'
  CHECK (attestation_state IN ('UNVERIFIED','VERIFIED','UNSUPPORTED'));
ALTER TABLE synthetic_mdm_evidence
  ADD COLUMN attestation_exception boolean NOT NULL DEFAULT false;