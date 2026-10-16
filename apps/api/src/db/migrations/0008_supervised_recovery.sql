CREATE TABLE recovery_custodian (
  id uuid PRIMARY KEY,
  email_normalized text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('ACTIVE','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE TABLE recovery_request (
  id uuid PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES admin_user(id),
  status text NOT NULL CHECK (status IN ('PENDING','AUTHORIZED','CONSUMED','CANCELLED')),
  code_hash bytea UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  audit_ref uuid NOT NULL
);
CREATE TABLE recovery_approval (
  request_id uuid NOT NULL REFERENCES recovery_request(id),
  custodian_id uuid NOT NULL REFERENCES recovery_custodian(id),
  approved_at timestamptz NOT NULL,
  revoked_at timestamptz,
  PRIMARY KEY(request_id,custodian_id)
);
CREATE INDEX recovery_request_admin ON recovery_request(admin_id,status);
