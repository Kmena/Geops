CREATE TABLE geops_device (
  id uuid PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('DRAFT','INVITED','PENDING_CONFIRMATION','ACTIVE','SUSPENDED','REVOKED','RETIRED')),
  display_label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);
CREATE TABLE mdm_binding (
  id uuid PRIMARY KEY,
  geops_device_id uuid NOT NULL REFERENCES geops_device(id),
  provider text NOT NULL,
  customer_id text NOT NULL,
  mdm_device_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','ACTIVE','REVOKED')),
  verified_at timestamptz,
  verification_method text,
  evidence_ref uuid,
  version bigint NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX mdm_binding_one_active_device ON mdm_binding(geops_device_id) WHERE state='ACTIVE';
CREATE UNIQUE INDEX mdm_binding_one_active_mdm ON mdm_binding(provider,customer_id,mdm_device_id) WHERE state='ACTIVE';
CREATE TABLE device_invitation (
  id uuid PRIMARY KEY,
  geops_device_id uuid NOT NULL REFERENCES geops_device(id),
  mdm_binding_id uuid NOT NULL REFERENCES mdm_binding(id),
  secret_hmac bytea NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('ISSUED','CLAIMED','CONSUMED','CANCELLED','EXPIRED')),
  delivery_mode text NOT NULL CHECK (delivery_mode IN ('supervised_qr','managed_configuration')),
  issued_by uuid NOT NULL REFERENCES admin_user(id),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  CHECK (expires_at <= issued_at + interval '10 minutes')
);
CREATE UNIQUE INDEX device_invitation_one_open ON device_invitation(geops_device_id) WHERE status IN ('ISSUED','CLAIMED');
CREATE INDEX device_invitation_expiry ON device_invitation(expires_at);
CREATE TABLE device_challenge (
  id uuid PRIMARY KEY,
  geops_device_id uuid NOT NULL REFERENCES geops_device(id),
  key_id uuid,
  purpose text NOT NULL CHECK (purpose IN ('ENROLL','SESSION','ROTATE')),
  challenge_hash bytea NOT NULL,
  challenge_value bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX device_challenge_expiry ON device_challenge(expires_at);
CREATE TABLE enrollment_claim (
  id uuid PRIMARY KEY,
  invitation_id uuid NOT NULL REFERENCES device_invitation(id),
  geops_device_id uuid NOT NULL REFERENCES geops_device(id),
  mdm_device_id text NOT NULL,
  public_key_spki_der bytea NOT NULL,
  client_nonce_hash bytea NOT NULL,
  client_nonce_value bytea NOT NULL,
  expected_attestation_challenge bytea NOT NULL,
  challenge_id uuid NOT NULL REFERENCES device_challenge(id),
  status text NOT NULL CHECK (status IN ('CLAIMED','PENDING_CONFIRMATION','CANCELLED','ACTIVE')),
  pairing_code_hash bytea,
  expires_at timestamptz NOT NULL,
  version bigint NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX enrollment_claim_one_open ON enrollment_claim(invitation_id) WHERE status IN ('CLAIMED','PENDING_CONFIRMATION');
CREATE TABLE device_key (
  id uuid PRIMARY KEY,
  geops_device_id uuid NOT NULL REFERENCES geops_device(id),
  public_key_spki_der bytea NOT NULL,
  public_key_fingerprint bytea NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','ACTIVE','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  version bigint NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX device_key_one_active ON device_key(geops_device_id) WHERE status='ACTIVE';
CREATE TABLE device_session (
  id uuid PRIMARY KEY,
  geops_device_id uuid NOT NULL REFERENCES geops_device(id),
  key_id uuid NOT NULL REFERENCES device_key(id),
  token_hash bytea NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX device_session_expiry ON device_session(expires_at);
CREATE TABLE device_request_nonce (
  key_id uuid NOT NULL REFERENCES device_key(id),
  nonce_hash bytea NOT NULL,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (key_id, nonce_hash)
);
CREATE INDEX device_request_nonce_expiry ON device_request_nonce(expires_at);
CREATE TABLE synthetic_mdm_evidence (
  id uuid PRIMARY KEY,
  claim_id uuid NOT NULL REFERENCES enrollment_claim(id),
  mdm_binding_id uuid NOT NULL REFERENCES mdm_binding(id),
  tenant text NOT NULL,
  mdm_device_id text NOT NULL,
  operator_id uuid NOT NULL REFERENCES admin_user(id),
  physical_confirmed boolean NOT NULL,
  method text NOT NULL CHECK (method IN ('api_read','manual_two_traits')),
  created_at timestamptz NOT NULL DEFAULT now()
);