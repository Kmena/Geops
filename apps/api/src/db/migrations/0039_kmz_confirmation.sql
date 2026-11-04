-- SPEC-03 W5: immutable result and per-record ledger, independent from staging retention.
CREATE TABLE kmz_import_commit (
  id uuid PRIMARY KEY,
  import_id uuid NOT NULL UNIQUE,
  analysis_id uuid NOT NULL,
  review_revision bigint NOT NULL CHECK (review_revision >= 0),
  catalog_revision bigint NOT NULL CHECK (catalog_revision >= 0),
  plan_digest char(64) NOT NULL CHECK (plan_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('VALIDATED','CONFIRMED','APPLIED')),
  counts jsonb NOT NULL,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  blocking_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  plan jsonb NOT NULL,
  validated_by uuid NOT NULL REFERENCES admin_user(id),
  validated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  confirmation_key text CHECK (confirmation_key IS NULL OR length(confirmation_key) BETWEEN 16 AND 120),
  confirmation_hash char(64),
  confirmed_by uuid REFERENCES admin_user(id),
  applied_at timestamptz,
  result jsonb,
  CHECK ((state='APPLIED') = (result IS NOT NULL AND applied_at IS NOT NULL)),
  CHECK ((state='APPLIED') = (confirmation_key IS NOT NULL AND confirmation_hash IS NOT NULL AND confirmed_by IS NOT NULL))
);
CREATE UNIQUE INDEX kmz_import_commit_confirmation_key
  ON kmz_import_commit(confirmed_by,confirmation_key) WHERE confirmation_key IS NOT NULL;

CREATE TABLE kmz_import_operation (
  id uuid PRIMARY KEY,
  commit_id uuid NOT NULL REFERENCES kmz_import_commit(id),
  record_id uuid NOT NULL,
  source_path text NOT NULL,
  source_code text,
  action text NOT NULL CHECK (action IN ('CREATE','LINK','UPDATE','EXCLUDE')),
  target_customer_id uuid,
  target_establishment_id uuid,
  before_value jsonb NOT NULL,
  after_value jsonb NOT NULL,
  actor_id uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(commit_id,record_id)
);
