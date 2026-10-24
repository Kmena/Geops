-- One outstanding browser authorization per isolated MDM tenant.
CREATE TABLE mdm_oauth_pending (
  state_digest bytea PRIMARY KEY CHECK (octet_length(state_digest)=32),
  nonce_digest bytea NOT NULL CHECK (octet_length(nonce_digest)=32),
  admin_id uuid NOT NULL REFERENCES admin_user(id),
  session_id uuid NOT NULL REFERENCES admin_session(id),
  region text NOT NULL,
  customer_id text NOT NULL,
  verifier_ciphertext bytea NOT NULL,
  verifier_iv bytea NOT NULL CHECK (octet_length(verifier_iv)=12),
  verifier_tag bytea NOT NULL CHECK (octet_length(verifier_tag)=16),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mdm_oauth_one_pending_tenant
  ON mdm_oauth_pending(region,customer_id) WHERE consumed_at IS NULL;
CREATE INDEX mdm_oauth_pending_expiry ON mdm_oauth_pending(expires_at);
