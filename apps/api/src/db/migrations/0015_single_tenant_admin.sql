-- Single-company administration. No automatic grants or user creation.
ALTER TABLE admin_permission DROP CONSTRAINT admin_permission_permission_check;
ALTER TABLE admin_permission ADD CONSTRAINT admin_permission_permission_check CHECK (permission IN (
  'gps.policy.read','gps.policy.write','gps.policy.assign','gps.policy.activate',
  'gps.session.read','gps.location.read','gps.audit.read',
  'gps.installation.manage','gps.tenant.grant','gps.user.manage'
));

CREATE TABLE geops_operating_tenant (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  tenant_id text NOT NULL UNIQUE CHECK (tenant_id = 'synthetic'),
  established_by uuid NOT NULL REFERENCES admin_user(id),
  established_at timestamptz NOT NULL DEFAULT now(),
  audit_ref uuid NOT NULL UNIQUE
);

CREATE TABLE admin_user_invitation (
  id uuid PRIMARY KEY,
  admin_id uuid NOT NULL REFERENCES admin_user(id),
  token_hash bytea NOT NULL UNIQUE,
  issued_by uuid NOT NULL REFERENCES admin_user(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  CHECK (expires_at > issued_at)
);
CREATE UNIQUE INDEX admin_user_invitation_one_open
  ON admin_user_invitation(admin_id) WHERE consumed_at IS NULL;
CREATE INDEX admin_user_invitation_expiry ON admin_user_invitation(expires_at);

CREATE TABLE admin_access_change (
  request_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES admin_user(id),
  target_admin_id uuid NOT NULL REFERENCES admin_user(id),
  action text NOT NULL CHECK (action IN ('CAPABILITY_GRANT','CAPABILITY_REVOKE','TENANT_GRANT','TENANT_REVOKE','USER_REVOKE')),
  payload_digest bytea NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
