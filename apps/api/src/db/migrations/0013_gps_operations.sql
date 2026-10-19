-- W1-E1/C3 synthetic operations. No automatic administrator or tenant grants.
ALTER TABLE admin_permission DROP CONSTRAINT admin_permission_permission_check;
ALTER TABLE admin_permission ADD CONSTRAINT admin_permission_permission_check CHECK (permission IN (
  'gps.policy.read','gps.policy.write','gps.policy.assign','gps.policy.activate',
  'gps.session.read','gps.location.read','gps.audit.read',
  'gps.installation.manage','gps.tenant.grant'
));

CREATE TABLE gps_tenant_grant_request (
  id uuid PRIMARY KEY,
  proposed_by uuid NOT NULL REFERENCES admin_user(id),
  target_admin_id uuid NOT NULL REFERENCES admin_user(id),
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 256),
  action text NOT NULL CHECK (action IN ('GRANT','REVOKE')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 240),
  payload_digest bytea NOT NULL,
  proposed_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES admin_user(id),
  approved_at timestamptz,
  CHECK ((approved_by IS NULL AND approved_at IS NULL) OR
         (approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_by<>proposed_by))
);
CREATE INDEX gps_tenant_grant_request_target ON gps_tenant_grant_request(target_admin_id,tenant_id,proposed_at DESC);

CREATE TABLE gps_scheduler_run (
  id uuid PRIMARY KEY,
  ran_at timestamptz NOT NULL,
  versions_advanced integer NOT NULL,
  windows_created integer NOT NULL,
  windows_missed integer NOT NULL,
  sessions_unknown_end integer NOT NULL,
  positions_purged integer NOT NULL,
  health_purged integer NOT NULL,
  CHECK (versions_advanced>=0 AND windows_created>=0 AND windows_missed>=0 AND
         sessions_unknown_end>=0 AND positions_purged>=0 AND health_purged>=0)
);
CREATE INDEX gps_scheduler_run_time ON gps_scheduler_run(ran_at DESC);
