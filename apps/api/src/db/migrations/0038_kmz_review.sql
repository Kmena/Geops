-- SPEC-03 W4: administrator review state only. Operational catalog remains unchanged.
CREATE TABLE kmz_review_session (
  import_id uuid PRIMARY KEY REFERENCES kmz_import_session(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE kmz_review_record (
  record_id uuid PRIMARY KEY REFERENCES kmz_import_record(id) ON DELETE CASCADE,
  import_id uuid NOT NULL REFERENCES kmz_import_session(id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL REFERENCES kmz_analysis_run(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  proposed jsonb NOT NULL DEFAULT '{}'::jsonb,
  action text NOT NULL DEFAULT 'PENDING' CHECK (action IN ('CREATE','LINK','UPDATE','EXCLUDE','PENDING')),
  target_customer_id uuid REFERENCES client(id),
  target_customer_version bigint,
  target_establishment_id uuid REFERENCES client_site(id),
  target_establishment_version bigint,
  selected_fields text[] NOT NULL DEFAULT '{}',
  reason text,
  acknowledged_conflict boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL REFERENCES admin_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (action NOT IN ('LINK','UPDATE') OR target_customer_id IS NOT NULL),
  CHECK (action <> 'UPDATE' OR (array_length(selected_fields,1) > 0 AND reason IS NOT NULL)),
  CHECK (action <> 'EXCLUDE' OR reason IS NOT NULL)
);
CREATE INDEX kmz_review_record_import_action ON kmz_review_record(import_id,action);

CREATE TABLE kmz_review_event (
  id uuid PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES kmz_import_session(id) ON DELETE CASCADE,
  record_id uuid NOT NULL REFERENCES kmz_import_record(id) ON DELETE CASCADE,
  batch_id uuid,
  before_value jsonb NOT NULL,
  after_value jsonb NOT NULL,
  actor_id uuid NOT NULL REFERENCES admin_user(id),
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kmz_review_event_record_time ON kmz_review_event(record_id,created_at DESC);
