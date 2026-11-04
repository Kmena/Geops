-- SPEC-03 W6-R: recovery lease and manual, auditable staging retention.
ALTER TABLE kmz_import_session
  ADD COLUMN processing_token uuid,
  ADD COLUMN processing_started_at timestamptz,
  ADD COLUMN purged_at timestamptz;

CREATE INDEX kmz_import_session_retention
  ON kmz_import_session(created_at,id) WHERE purged_at IS NULL;

-- Approved review history is detached from temporary staging before deletion.
CREATE TABLE kmz_import_review_archive (
  id uuid PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES kmz_import_session(id),
  record_id uuid NOT NULL,
  entry_kind text NOT NULL CHECK (entry_kind IN ('DECISION','EVENT')),
  payload jsonb NOT NULL,
  actor_id uuid NOT NULL REFERENCES admin_user(id),
  occurred_at timestamptz NOT NULL
);
CREATE INDEX kmz_import_review_archive_import
  ON kmz_import_review_archive(import_id,occurred_at,id);
