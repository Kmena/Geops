-- Real MDM credentials remain in private secret files; only their digest and connection state live here.
CREATE TABLE mdm_connection_control (
  provider text NOT NULL CHECK (provider = 'manageengine'),
  region text NOT NULL,
  customer_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('CONNECTED', 'DISCONNECTING', 'DISCONNECTED')),
  credential_digest bytea NOT NULL CHECK (octet_length(credential_digest) = 32),
  remote_revoked boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, region, customer_id),
  CHECK (state <> 'CONNECTED' OR remote_revoked = false)
);

CREATE TABLE admin_login_limit (
  key_digest bytea PRIMARY KEY CHECK (octet_length(key_digest) = 32),
  attempts integer NOT NULL CHECK (attempts >= 0),
  blocked_until timestamptz,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_login_limit_expiry ON admin_login_limit(expires_at);

ALTER TABLE mdm_sync_run DROP CONSTRAINT mdm_sync_run_outcome_check;
ALTER TABLE mdm_sync_run ADD CONSTRAINT mdm_sync_run_outcome_check
  CHECK (outcome IN ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED'));
