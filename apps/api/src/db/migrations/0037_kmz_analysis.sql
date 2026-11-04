-- SPEC-03 W3: versioned analysis of staged KMZ rows. No operational row is changed.
CREATE TABLE kmz_analysis_run (
  id uuid PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES kmz_import_session(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  matcher_version text NOT NULL CHECK (length(matcher_version) BETWEEN 8 AND 100),
  catalog_revision bigint NOT NULL CHECK (catalog_revision >= 0),
  state text NOT NULL CHECK (state IN ('PROCESSING','READY','FAILED')),
  config jsonb NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  created_by uuid NOT NULL REFERENCES admin_user(id),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (import_id,version)
);
CREATE INDEX kmz_analysis_run_latest ON kmz_analysis_run(import_id,version DESC);

CREATE TABLE kmz_analysis_result (
  run_id uuid NOT NULL REFERENCES kmz_analysis_run(id) ON DELETE CASCADE,
  record_id uuid NOT NULL REFERENCES kmz_import_record(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  record_type text NOT NULL CHECK (record_type IN
    ('CLIENT_CANDIDATE','REFERENCE_POINT','WEEKLY_STOP','GEOGRAPHIC_GROUP','POLYGON','LINE','INVALID_OR_OTHER')),
  review_state text NOT NULL CHECK (review_state IN
    ('NEW','EXISTING_MATCH','POSSIBLE_DUPLICATE','CONFLICT','INVALID')),
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id,record_id),
  UNIQUE (run_id,ordinal)
);
CREATE INDEX kmz_analysis_result_filter ON kmz_analysis_result(run_id,review_state,record_type,ordinal);

CREATE TABLE kmz_analysis_candidate (
  run_id uuid NOT NULL,
  record_id uuid NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('CUSTOMER','ESTABLISHMENT','PIN','STAGING_RECORD')),
  target_id uuid NOT NULL,
  target_version bigint,
  distance_m double precision CHECK (distance_m IS NULL OR distance_m >= 0),
  proximity_band text CHECK (proximity_band IS NULL OR proximity_band IN ('HIGH','EXTENDED')),
  confidence text NOT NULL CHECK (confidence IN ('IDENTIFIER','CORROBORATED','POSSIBLE','WEAK')),
  signals jsonb NOT NULL,
  PRIMARY KEY (run_id,record_id,target_type,target_id),
  FOREIGN KEY (run_id,record_id) REFERENCES kmz_analysis_result(run_id,record_id) ON DELETE CASCADE
);
CREATE INDEX kmz_analysis_candidate_target ON kmz_analysis_candidate(target_type,target_id);

-- KMZ codes remain non-authoritative; bound exact comparison against active sites.
CREATE INDEX kmz_client_site_code_match
  ON client_site(code,id) WHERE state='ACTIVE';
