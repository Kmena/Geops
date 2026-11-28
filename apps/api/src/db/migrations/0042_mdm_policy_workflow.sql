-- SPEC-05 Wave 3: additive administrative MDM workflow. No vendor write is enabled.
ALTER TABLE admin_permission DROP CONSTRAINT admin_permission_permission_check;
ALTER TABLE admin_permission ADD CONSTRAINT admin_permission_permission_check CHECK (permission IN (
  'gps.policy.read','gps.policy.write','gps.policy.assign','gps.policy.activate',
  'gps.session.read','gps.location.read','gps.audit.read',
  'gps.installation.manage','gps.tenant.grant','gps.user.manage','mdm.oauth.configure',
  'visit.catalog.read','visit.catalog.write','visit.schedule.read','visit.schedule.write',
  'visit.result.read','visit.evidence.read','visit.evaluation.recompute',
  'visit.device.read','visit.device.write',
  'catalog.import.read','catalog.import.write','catalog.import.confirm',
  'mdm.diagnostics.view','mdm.diagnostics.export',
  'mdm.policies.view','mdm.permissions.remediate','mdm.configuration.update','mdm.audit.view'
));

CREATE TABLE mdm_remediation_request (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 120),
  device_id uuid NOT NULL REFERENCES geops_device(id),
  mdm_device_id text NOT NULL CHECK (mdm_device_id ~ '^[0-9]{1,30}$'),
  action text NOT NULL CHECK (action IN ('ASSOCIATE_PROFILE')),
  profile_id text NOT NULL CHECK (profile_id ~ '^[0-9]{1,30}$'),
  state text NOT NULL CHECK (state IN (
    'REQUESTED','VALIDATED','AWAITING_APPROVAL','SUBMITTED','PENDING_APPLICATION',
    'APPLIED','EFFECTIVE_VERIFIED','PARTIALLY_APPLIED','FAILED','TIMED_OUT',
    'CANCELLED','SUPERSEDED')),
  preview_digest text NOT NULL CHECK (preview_digest ~ '^[0-9a-f]{64}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_-]{16,80}$'),
  impact_device_count integer CHECK (impact_device_count BETWEEN 0 AND 5000),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 8 AND 240),
  requested_by uuid NOT NULL REFERENCES admin_user(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  error_code text,
  UNIQUE (requested_by,idempotency_key)
);
CREATE INDEX mdm_remediation_device_history
  ON mdm_remediation_request(tenant_id,device_id,requested_at DESC,id DESC);
CREATE INDEX mdm_remediation_pending
  ON mdm_remediation_request(state,expires_at)
  WHERE state IN ('AWAITING_APPROVAL','SUBMITTED','PENDING_APPLICATION');

CREATE TABLE mdm_remediation_event (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES mdm_remediation_request(id),
  state text NOT NULL,
  actor_id uuid REFERENCES admin_user(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  code text
);
CREATE INDEX mdm_remediation_event_request ON mdm_remediation_event(request_id,occurred_at,id);
CREATE TRIGGER mdm_remediation_event_no_change BEFORE UPDATE OR DELETE ON mdm_remediation_event
  FOR EACH ROW EXECUTE FUNCTION device_diagnostic_immutable();
