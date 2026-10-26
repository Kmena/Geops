-- SPEC-03 Wave 4B: temporal GEOPS device ownership and agent attribution.
-- Existing GPS and MDM identities, ingest, ACK and historical migrations stay intact.
ALTER TABLE admin_permission DROP CONSTRAINT admin_permission_permission_check;
ALTER TABLE admin_permission ADD CONSTRAINT admin_permission_permission_check CHECK (permission IN (
  'gps.policy.read','gps.policy.write','gps.policy.assign','gps.policy.activate',
  'gps.session.read','gps.location.read','gps.audit.read',
  'gps.installation.manage','gps.tenant.grant','gps.user.manage','mdm.oauth.configure',
  'visit.catalog.read','visit.catalog.write','visit.schedule.read','visit.schedule.write',
  'visit.result.read','visit.evidence.read','visit.evaluation.recompute',
  'visit.device.read','visit.device.write'
));

-- This identity remains valid after an MDM binding is retired. Establishment is
-- deliberately limited to a verified existing binding by the administrative API.
CREATE TABLE geops_device_tenant (
  device_id uuid PRIMARY KEY REFERENCES geops_device(id),
  tenant_id text NOT NULL REFERENCES geops_operating_tenant(tenant_id),
  established_by uuid NOT NULL REFERENCES admin_user(id),
  established_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('VERIFIED_BINDING','GEOPS_ENROLLMENT')),
  evidence_ref uuid,
  UNIQUE (tenant_id,device_id)
);
CREATE INDEX geops_device_tenant_tenant ON geops_device_tenant(tenant_id,device_id);

CREATE TABLE agent_device_link (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  agent_id uuid NOT NULL,
  device_id uuid NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  state text NOT NULL CHECK (state IN ('ACTIVE','ENDED','REVOKED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  create_reason text NOT NULL CHECK (length(trim(create_reason)) BETWEEN 8 AND 240),
  ended_by uuid REFERENCES admin_user(id),
  ended_at timestamptz,
  end_reason text,
  FOREIGN KEY (tenant_id,agent_id) REFERENCES agent(tenant_id,id),
  FOREIGN KEY (tenant_id,device_id) REFERENCES geops_device_tenant(tenant_id,device_id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (
    (state='ACTIVE' AND valid_to IS NULL AND ended_by IS NULL AND ended_at IS NULL AND end_reason IS NULL)
    OR
    (state='ENDED' AND valid_to IS NOT NULL AND ended_by IS NOT NULL AND ended_at IS NOT NULL
      AND length(trim(end_reason)) BETWEEN 8 AND 240)
    OR
    (state='REVOKED' AND ended_by IS NOT NULL AND ended_at IS NOT NULL
      AND length(trim(end_reason)) BETWEEN 8 AND 240)
  )
);
-- One active device per agent and one active agent per device. A revoked link
-- remains in history but no longer grants attribution or blocks a correction.
ALTER TABLE agent_device_link ADD CONSTRAINT agent_device_no_device_overlap
  EXCLUDE USING gist (tenant_id WITH =,device_id WITH =,
    tstzrange(valid_from,coalesce(valid_to,'infinity'::timestamptz),'[)') WITH &&)
  WHERE (state<>'REVOKED');
ALTER TABLE agent_device_link ADD CONSTRAINT agent_device_no_agent_overlap
  EXCLUDE USING gist (tenant_id WITH =,agent_id WITH =,
    tstzrange(valid_from,coalesce(valid_to,'infinity'::timestamptz),'[)') WITH &&)
  WHERE (state<>'REVOKED');
CREATE INDEX agent_device_agent_history ON agent_device_link(tenant_id,agent_id,valid_from DESC,id);
CREATE INDEX agent_device_device_history ON agent_device_link(tenant_id,device_id,valid_from DESC,id);

CREATE FUNCTION agent_device_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'agent-device link history is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.state<>'ACTIVE' OR NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id
    OR NEW.agent_id<>OLD.agent_id OR NEW.device_id<>OLD.device_id
    OR NEW.valid_from<>OLD.valid_from OR NEW.created_by<>OLD.created_by
    OR NEW.created_at<>OLD.created_at OR NEW.create_reason<>OLD.create_reason
    OR NEW.version<>OLD.version+1 OR NEW.state NOT IN ('ENDED','REVOKED') THEN
    RAISE EXCEPTION 'agent-device link history is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_device_link_no_history_change BEFORE UPDATE OR DELETE ON agent_device_link
  FOR EACH ROW EXECUTE FUNCTION agent_device_link_guard();

-- Preserve every Wave 4A lab interval. New operational intervals refer to the
-- operational link; neither evidence type requires retaining raw GPS rows.
ALTER TABLE visit_evaluation_interval ALTER COLUMN link_id DROP NOT NULL;
ALTER TABLE visit_evaluation_interval ADD COLUMN operational_link_id uuid REFERENCES agent_device_link(id);
ALTER TABLE visit_evaluation_interval ADD CONSTRAINT visit_interval_one_link
  CHECK ((link_id IS NULL) <> (operational_link_id IS NULL));

ALTER TABLE visit_algorithm_revision DROP CONSTRAINT visit_algorithm_revision_scope_check;
ALTER TABLE visit_algorithm_revision ADD CONSTRAINT visit_algorithm_revision_scope_check
  CHECK (scope IN ('LAB_ONLY','TECHNICAL_ONLY','APPROVED'));
INSERT INTO visit_algorithm_revision(algorithm_id,revision,scope,parameters)
  SELECT algorithm_id,2,'TECHNICAL_ONLY',parameters
  FROM visit_algorithm_revision WHERE algorithm_id='dwell-pair-v1' AND revision=1;

ALTER TABLE visit_evaluation_job ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX visit_evaluation_job_retry ON visit_evaluation_job(state,next_attempt_at,requested_at,assignment_id);
