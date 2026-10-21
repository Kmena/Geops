-- Additive v2 receipt. Existing v1 SESSION/POSITION receipts and quotas remain intact.
CREATE TABLE gps_mixed_batch_receipt (
  device_id uuid NOT NULL REFERENCES geops_device(id),
  batch_id uuid NOT NULL,
  payload_digest bytea NOT NULL,
  accepted_event_ids uuid[] NOT NULL,
  duplicate_event_ids uuid[] NOT NULL,
  session_mappings jsonb NOT NULL DEFAULT '[]'::jsonb,
  persisted_at timestamptz NOT NULL,
  PRIMARY KEY (device_id, batch_id),
  CHECK (jsonb_typeof(session_mappings) = 'array')
);
CREATE INDEX gps_mixed_batch_receipt_retention ON gps_mixed_batch_receipt(persisted_at);
