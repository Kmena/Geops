-- R4-A: server-side continuity inference. No coordinates, credentials or automatic grants.
CREATE TABLE gps_continuity_threshold (
  tenant_id text PRIMARY KEY CHECK (length(tenant_id) BETWEEN 1 AND 256),
  warning_after_s integer NOT NULL DEFAULT 300 CHECK (warning_after_s BETWEEN 60 AND 86400),
  critical_after_s integer NOT NULL DEFAULT 600 CHECK (critical_after_s BETWEEN 120 AND 172800),
  start_grace_s integer NOT NULL DEFAULT 300 CHECK (start_grace_s BETWEEN 0 AND 3600),
  policy_grace_s integer NOT NULL DEFAULT 300 CHECK (policy_grace_s BETWEEN 0 AND 3600),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (warning_after_s < critical_after_s)
);

CREATE TABLE gps_continuity_alert (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 256),
  device_id uuid NOT NULL,
  mdm_binding_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  scheduled_session_id uuid NOT NULL,
  assignment_version bigint NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('CAPTURE_STALE','COMMUNICATION_MISSING')),
  severity text NOT NULL CHECK (severity IN ('WARNING','CRITICAL')),
  source text NOT NULL DEFAULT 'SERVER_INFERENCE' CHECK (source = 'SERVER_INFERENCE'),
  opened_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolution_reason text CHECK (resolution_reason IN ('EVIDENCE_RECOVERED','WINDOW_ENDED','POLICY_CHANGED','DEVICE_INACTIVE','INSTALLATION_CHANGED')),
  evidence_at timestamptz,
  age_s integer NOT NULL CHECK (age_s >= 0),
  threshold_s integer NOT NULL CHECK (threshold_s > 0),
  last_position_captured_at timestamptz,
  last_position_received_at timestamptz,
  last_health_observed_at timestamptz,
  last_health_received_at timestamptz,
  last_batch_persisted_at timestamptz,
  observed_tracking_state text CHECK (observed_tracking_state IN ('RUNNING','STOPPED')),
  FOREIGN KEY (mdm_binding_id,device_id,tenant_id)
    REFERENCES mdm_binding(id,geops_device_id,customer_id),
  FOREIGN KEY (installation_id,device_id)
    REFERENCES gps_device_installation(installation_id,device_id),
  FOREIGN KEY (scheduled_session_id,device_id,assignment_version)
    REFERENCES gps_scheduled_session(id,device_id,assignment_version),
  CHECK ((resolved_at IS NULL AND resolution_reason IS NULL) OR
         (resolved_at IS NOT NULL AND resolution_reason IS NOT NULL AND resolved_at >= opened_at)),
  CHECK (updated_at >= opened_at)
);
CREATE UNIQUE INDEX gps_continuity_alert_one_open
  ON gps_continuity_alert(tenant_id,device_id,scheduled_session_id,mdm_binding_id,installation_id)
  WHERE resolved_at IS NULL;
CREATE INDEX gps_continuity_alert_tenant_open
  ON gps_continuity_alert(tenant_id,severity,updated_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX gps_continuity_alert_device_history
  ON gps_continuity_alert(tenant_id,device_id,opened_at DESC,id DESC);
