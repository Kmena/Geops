-- SPEC-05 Wave 2. Additive; GPS v2 events and MDM policies are untouched.
ALTER TABLE admin_permission DROP CONSTRAINT admin_permission_permission_check;
ALTER TABLE admin_permission ADD CONSTRAINT admin_permission_permission_check CHECK (permission IN (
  'gps.policy.read','gps.policy.write','gps.policy.assign','gps.policy.activate',
  'gps.session.read','gps.location.read','gps.audit.read',
  'gps.installation.manage','gps.tenant.grant','gps.user.manage','mdm.oauth.configure',
  'visit.catalog.read','visit.catalog.write','visit.schedule.read','visit.schedule.write',
  'visit.result.read','visit.evidence.read','visit.evaluation.recompute',
  'visit.device.read','visit.device.write',
  'catalog.import.read','catalog.import.write','catalog.import.confirm',
  'mdm.diagnostics.view','mdm.diagnostics.export'
));

CREATE TABLE device_diagnostic_snapshot (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES geops_device(id),
  installation_id uuid NOT NULL,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 120),
  boot_id text NOT NULL CHECK (length(boot_id) BETWEEN 8 AND 100),
  sequence bigint NOT NULL CHECK (sequence > 0),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  app_version text NOT NULL CHECK (length(app_version) BETWEEN 1 AND 80),
  manufacturer text NOT NULL CHECK (length(manufacturer) BETWEEN 1 AND 80),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 80),
  android_release text NOT NULL CHECK (length(android_release) BETWEEN 1 AND 40),
  android_api integer NOT NULL CHECK (android_api BETWEEN 26 AND 100),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object'),
  findings jsonb NOT NULL CHECK (jsonb_typeof(findings)='array'),
  UNIQUE (installation_id,boot_id,sequence)
);
CREATE INDEX device_diagnostic_latest ON device_diagnostic_snapshot(tenant_id,device_id,observed_at DESC,sequence DESC,received_at DESC,id DESC);
CREATE INDEX device_diagnostic_received ON device_diagnostic_snapshot(tenant_id,received_at DESC,id DESC);

CREATE FUNCTION device_diagnostic_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'diagnostic snapshot is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER device_diagnostic_no_change BEFORE UPDATE OR DELETE ON device_diagnostic_snapshot
  FOR EACH ROW EXECUTE FUNCTION device_diagnostic_immutable();
