-- SPEC-03 Wave 4A. Additive, planning/evaluation only; GPS ingest and ACK are unchanged.
ALTER TABLE admin_permission DROP CONSTRAINT admin_permission_permission_check;
ALTER TABLE admin_permission ADD CONSTRAINT admin_permission_permission_check CHECK (permission IN (
  'gps.policy.read','gps.policy.write','gps.policy.assign','gps.policy.activate',
  'gps.session.read','gps.location.read','gps.audit.read',
  'gps.installation.manage','gps.tenant.grant','gps.user.manage','mdm.oauth.configure',
  'visit.catalog.read','visit.catalog.write','visit.schedule.read','visit.schedule.write',
  'visit.result.read','visit.evidence.read','visit.evaluation.recompute'
));

ALTER TABLE assignment_visit ADD CONSTRAINT assignment_visit_tenant_key
  UNIQUE (tenant_id,assignment_id,stop_id);

CREATE TABLE visit_algorithm_revision (
  algorithm_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  scope text NOT NULL CHECK (scope IN ('LAB_ONLY','APPROVED')),
  parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (algorithm_id,revision)
);
INSERT INTO visit_algorithm_revision(algorithm_id,revision,scope,parameters) VALUES
  ('dwell-pair-v1',1,'LAB_ONLY',
   '{"max_gap_s":300,"credit_cap_s":300,"uncertainty_guard_s":0,"max_accuracy_m":25,"boundary_tolerance_m":0,"max_speed_m_s":50}'::jsonb);

-- Lab-only evidence of identity. No admin/API creation and ignored outside synthetic mode.
-- No FK to mdm_binding: physical identity belongs to Wave 4B.
CREATE TABLE visit_lab_agent_device_link (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  agent_id uuid NOT NULL,
  device_id uuid NOT NULL REFERENCES geops_device(id),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL,
  source text NOT NULL DEFAULT 'SYNTHETIC_TEST' CHECK (source='SYNTHETIC_TEST'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,agent_id) REFERENCES agent(tenant_id,id),
  CHECK (valid_to > valid_from)
);
ALTER TABLE visit_lab_agent_device_link ADD CONSTRAINT visit_lab_device_no_overlap
  EXCLUDE USING gist (tenant_id WITH =,device_id WITH =,tstzrange(valid_from,valid_to,'[)') WITH &&);
ALTER TABLE visit_lab_agent_device_link ADD CONSTRAINT visit_lab_agent_no_overlap
  EXCLUDE USING gist (tenant_id WITH =,agent_id WITH =,tstzrange(valid_from,valid_to,'[)') WITH &&);
CREATE INDEX visit_lab_link_agent_time ON visit_lab_agent_device_link(tenant_id,agent_id,valid_from,valid_to);

CREATE TABLE visit_evaluation_job (
  tenant_id text NOT NULL,
  assignment_id uuid NOT NULL,
  algorithm_id text NOT NULL,
  algorithm_revision integer NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','RUNNING','DONE','FAILED')),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 8 AND 240),
  requested_by uuid NOT NULL REFERENCES admin_user(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  position_count bigint NOT NULL DEFAULT 0 CHECK (position_count >= 0),
  last_error_code text,
  PRIMARY KEY (tenant_id,assignment_id),
  FOREIGN KEY (tenant_id,assignment_id) REFERENCES route_assignment(tenant_id,id),
  FOREIGN KEY (algorithm_id,algorithm_revision) REFERENCES visit_algorithm_revision(algorithm_id,revision)
);
CREATE INDEX visit_evaluation_job_queue ON visit_evaluation_job(state,requested_at,assignment_id);

CREATE TABLE visit_evaluation (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  assignment_id uuid NOT NULL,
  stop_id uuid NOT NULL,
  evaluation_no integer NOT NULL CHECK (evaluation_no > 0),
  source_digest text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  algorithm_id text NOT NULL,
  algorithm_revision integer NOT NULL,
  parameters jsonb NOT NULL CHECK (jsonb_typeof(parameters)='object'),
  status text NOT NULL CHECK (status IN (
    'PENDING','IN_PROGRESS','COMPLETED','INCOMPLETE','NOT_VISITED','INSUFFICIENT_EVIDENCE','UNATTRIBUTABLE')),
  required_s integer NOT NULL CHECK (required_s > 0),
  credited_s integer NOT NULL CHECK (credited_s >= 0),
  percent numeric(5,2) NOT NULL CHECK (percent BETWEEN 0 AND 100),
  first_qualified_at timestamptz,
  last_qualified_at timestamptz,
  completed_at timestamptz,
  sample_count integer NOT NULL CHECK (sample_count >= 0),
  uncertain_count integer NOT NULL CHECK (uncertain_count >= 0),
  gap_count integer NOT NULL CHECK (gap_count >= 0),
  source_watermark timestamptz,
  supersedes_id uuid REFERENCES visit_evaluation(id),
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,assignment_id,stop_id,evaluation_no),
  UNIQUE (tenant_id,assignment_id,stop_id,id),
  FOREIGN KEY (tenant_id,assignment_id,stop_id)
    REFERENCES assignment_visit(tenant_id,assignment_id,stop_id),
  FOREIGN KEY (algorithm_id,algorithm_revision)
    REFERENCES visit_algorithm_revision(algorithm_id,revision)
);
CREATE INDEX visit_evaluation_history ON visit_evaluation(tenant_id,assignment_id,stop_id,evaluation_no DESC);

CREATE TABLE visit_evaluation_current (
  tenant_id text NOT NULL,
  assignment_id uuid NOT NULL,
  stop_id uuid NOT NULL,
  evaluation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,assignment_id,stop_id),
  FOREIGN KEY (tenant_id,assignment_id,stop_id,evaluation_id)
    REFERENCES visit_evaluation(tenant_id,assignment_id,stop_id,id)
);

-- Event identifiers are intentionally not FKs: GPS retention may purge source rows.
-- No coordinates are copied into evidence or history.
CREATE TABLE visit_evaluation_interval (
  evaluation_id uuid NOT NULL REFERENCES visit_evaluation(id),
  interval_no integer NOT NULL CHECK (interval_no > 0),
  device_id uuid NOT NULL,
  session_id uuid NOT NULL,
  link_id uuid NOT NULL REFERENCES visit_lab_agent_device_link(id),
  event_id_a uuid NOT NULL,
  event_id_b uuid NOT NULL,
  from_at timestamptz NOT NULL,
  to_at timestamptz NOT NULL,
  observed_s integer NOT NULL CHECK (observed_s > 0),
  credited_s integer NOT NULL CHECK (credited_s > 0),
  PRIMARY KEY (evaluation_id,interval_no),
  CHECK (to_at > from_at),
  CHECK (credited_s <= observed_s)
);
CREATE INDEX visit_evaluation_interval_time ON visit_evaluation_interval(evaluation_id,from_at,to_at);

CREATE FUNCTION visit_evaluation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'visit evaluation history is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER visit_evaluation_no_change BEFORE UPDATE OR DELETE ON visit_evaluation
  FOR EACH ROW EXECUTE FUNCTION visit_evaluation_immutable();
CREATE TRIGGER visit_evaluation_interval_no_change BEFORE UPDATE OR DELETE ON visit_evaluation_interval
  FOR EACH ROW EXECUTE FUNCTION visit_evaluation_immutable();
CREATE TRIGGER visit_algorithm_revision_no_change BEFORE UPDATE OR DELETE ON visit_algorithm_revision
  FOR EACH ROW EXECUTE FUNCTION visit_evaluation_immutable();
CREATE TRIGGER visit_lab_agent_device_link_no_change BEFORE UPDATE OR DELETE ON visit_lab_agent_device_link
  FOR EACH ROW EXECUTE FUNCTION visit_evaluation_immutable();
