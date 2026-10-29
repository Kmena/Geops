-- Additive B32 coverage accounting. Functional decisions DEC-VISIT-001/002 are
-- approved; numeric operating thresholds are not field-calibrated or activated.
ALTER TABLE visit_algorithm_revision
  ADD COLUMN decision_refs text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN default_required_s integer CHECK (default_required_s > 0),
  ADD COLUMN accumulation_mode text CHECK (accumulation_mode IN ('ACCUMULATED')),
  ADD COLUMN unknown_policy text CHECK (unknown_policy IN ('POTENTIAL_INSIDE')),
  ADD COLUMN calibration_evidence_ref text,
  ADD COLUMN activated_at timestamptz;

INSERT INTO visit_algorithm_revision
  (algorithm_id,revision,scope,parameters,decision_refs,default_required_s,
   accumulation_mode,unknown_policy,calibration_evidence_ref,activated_at)
SELECT algorithm_id,3,'TECHNICAL_ONLY',
  parameters || '{"coverage_min_fraction":null,"non_compliance_enabled":false}'::jsonb,
  ARRAY['DEC-VISIT-001','DEC-VISIT-002'],600,'ACCUMULATED','POTENTIAL_INSIDE',NULL,NULL
FROM visit_algorithm_revision
WHERE algorithm_id='dwell-pair-v1' AND revision=2;

ALTER TABLE visit_evaluation
  ADD COLUMN outside_credited_s integer CHECK (outside_credited_s >= 0),
  ADD COLUMN unknown_s integer CHECK (unknown_s >= 0),
  ADD COLUMN coverage_percent numeric(5,2) CHECK (coverage_percent BETWEEN 0 AND 100),
  ADD COLUMN potential_inside_upper_s integer CHECK (potential_inside_upper_s >= 0);

CREATE TABLE visit_evaluation_outside_interval (
  evaluation_id uuid NOT NULL REFERENCES visit_evaluation(id),
  interval_no integer NOT NULL CHECK (interval_no > 0),
  event_id_a uuid NOT NULL,
  event_id_b uuid NOT NULL,
  from_at timestamptz NOT NULL,
  to_at timestamptz NOT NULL,
  seconds integer NOT NULL CHECK (seconds > 0),
  PRIMARY KEY (evaluation_id,interval_no),
  CHECK (to_at > from_at),
  CHECK (seconds <= floor(extract(epoch FROM to_at-from_at)))
);
CREATE TRIGGER visit_evaluation_outside_interval_no_change
  BEFORE UPDATE OR DELETE ON visit_evaluation_outside_interval
  FOR EACH ROW EXECUTE FUNCTION visit_evaluation_immutable();
