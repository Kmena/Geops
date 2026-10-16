CREATE TABLE admin_user (
  id uuid PRIMARY KEY,
  email_normalized text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('ACTIVE', 'LOCKED', 'REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1
);
CREATE TABLE admin_session (
  id uuid PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES admin_user(id),
  token_hash bytea NOT NULL UNIQUE,
  csrf_hash bytea NOT NULL,
  issued_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX admin_session_admin ON admin_session(admin_id, revoked_at);
CREATE INDEX admin_session_expiry ON admin_session(absolute_expires_at);
CREATE TABLE admin_recovery (
  id uuid PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES admin_user(id),
  code_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  issued_by text NOT NULL,
  approved_by text NOT NULL,
  audit_ref uuid NOT NULL
);
CREATE UNIQUE INDEX admin_recovery_one_active ON admin_recovery(admin_id) WHERE consumed_at IS NULL;
CREATE TABLE audit_event (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL,
  actor_id uuid,
  device_id uuid,
  action text NOT NULL,
  outcome text NOT NULL,
  correlation_id uuid NOT NULL,
  previous_state text,
  next_state text,
  metadata_redacted jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX audit_event_time ON audit_event(occurred_at);
CREATE INDEX audit_event_actor ON audit_event(actor_id, occurred_at);
CREATE INDEX audit_event_device ON audit_event(device_id, occurred_at);