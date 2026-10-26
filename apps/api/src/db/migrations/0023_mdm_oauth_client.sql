-- Administrative OAuth client configuration is encrypted by the API with a key
-- derived from the existing MDM grant key. No client value is stored in cleartext.
ALTER TABLE admin_permission DROP CONSTRAINT admin_permission_permission_check;
ALTER TABLE admin_permission ADD CONSTRAINT admin_permission_permission_check CHECK (permission IN (
  'gps.policy.read','gps.policy.write','gps.policy.assign','gps.policy.activate',
  'gps.session.read','gps.location.read','gps.audit.read',
  'gps.installation.manage','gps.tenant.grant','gps.user.manage',
  'mdm.oauth.configure'
));

CREATE TABLE mdm_oauth_client_config (
  tenant_id text NOT NULL REFERENCES geops_operating_tenant(tenant_id),
  region text NOT NULL,
  generation uuid NOT NULL,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL CHECK (octet_length(iv)=12),
  tag bytea NOT NULL CHECK (octet_length(tag)=16),
  key_version integer NOT NULL DEFAULT 1 CHECK (key_version=1),
  updated_by uuid NOT NULL REFERENCES admin_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,region)
);

ALTER TABLE mdm_oauth_pending ADD COLUMN client_generation text NOT NULL DEFAULT 'legacy';
CREATE TABLE mdm_oauth_config_rate (
  tenant_id text NOT NULL REFERENCES geops_operating_tenant(tenant_id),
  admin_id uuid NOT NULL REFERENCES admin_user(id),
  next_allowed_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,admin_id)
);
