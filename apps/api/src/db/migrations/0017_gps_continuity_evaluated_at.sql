-- Preserve the last inference timestamp independently of episode resolution.
-- Existing R4-A rows can only prove their initial evaluation time; keep the
-- timestamp nullable rather than deriving a false value from updated_at.
ALTER TABLE gps_continuity_alert ADD COLUMN evaluated_at timestamptz;
CREATE INDEX gps_continuity_alert_page
  ON gps_continuity_alert(tenant_id,opened_at DESC,id DESC);

CREATE TABLE gps_continuity_read_quota (
  admin_id uuid NOT NULL REFERENCES admin_user(id),
  minute_bucket timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count BETWEEN 1 AND 60),
  PRIMARY KEY (admin_id,minute_bucket)
);
