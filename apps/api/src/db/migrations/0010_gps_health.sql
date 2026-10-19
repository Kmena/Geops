-- GPS-HEALTH-001: synthetic backend extension. No grants and no PoC tables.
ALTER TABLE gps_policy_revision
  ADD COLUMN health_interval_s integer NOT NULL DEFAULT 300
    CHECK (health_interval_s BETWEEN 60 AND 3600);

-- SPEC-01 administrators are global today; health reads require an explicit tenant grant too.
CREATE TABLE gps_health_tenant_access (
  admin_id uuid NOT NULL REFERENCES admin_user(id),
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 256),
  granted_by uuid NOT NULL REFERENCES admin_user(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 240),
  PRIMARY KEY (admin_id, tenant_id, granted_at),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE UNIQUE INDEX gps_health_tenant_access_one_active
  ON gps_health_tenant_access(admin_id, tenant_id) WHERE revoked_at IS NULL;

-- Composite FK prevents an event row from naming a binding in another tenant.
ALTER TABLE mdm_binding ADD CONSTRAINT mdm_binding_health_identity_unique
  UNIQUE (id, geops_device_id, customer_id);
ALTER TABLE gps_policy_delivery
  ADD COLUMN health_boot_id uuid,
  ADD COLUMN health_mdm_binding_id uuid,
  ADD COLUMN health_tenant_id text,
  ADD CONSTRAINT gps_policy_delivery_health_tenant_pair CHECK
    ((health_mdm_binding_id IS NULL AND health_tenant_id IS NULL) OR
     (health_mdm_binding_id IS NOT NULL AND health_tenant_id IS NOT NULL)),
  ADD CONSTRAINT gps_policy_delivery_health_tenant_fk
    FOREIGN KEY (health_mdm_binding_id, device_id, health_tenant_id)
    REFERENCES mdm_binding(id, geops_device_id, customer_id);

CREATE TABLE gps_device_health_event (
  device_id uuid NOT NULL REFERENCES geops_device(id),
  event_id uuid NOT NULL,
  tenant_id text NOT NULL,
  mdm_binding_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  assignment_version bigint NOT NULL CHECK (assignment_version >= 0),
  policy_revision integer NOT NULL CHECK (policy_revision > 0),
  scheduled_session_id uuid NOT NULL,
  capture_anchor_id uuid NOT NULL REFERENCES gps_policy_delivery(capture_anchor_id),
  boot_id uuid NOT NULL,
  anchor_elapsed_realtime_ms bigint NOT NULL CHECK (anchor_elapsed_realtime_ms >= 0),
  elapsed_realtime_ms bigint NOT NULL CHECK (elapsed_realtime_ms >= anchor_elapsed_realtime_ms),
  due_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  battery_percent smallint CHECK (battery_percent BETWEEN 0 AND 100),
  charging boolean,
  plugged boolean,
  power_save boolean,
  provider_available boolean,
  network_available boolean,
  tracking_state text NOT NULL CHECK (tracking_state IN ('RUNNING','STOPPED')),
  observed_states text[] NOT NULL,
  payload_digest bytea NOT NULL,
  PRIMARY KEY (device_id, event_id),
  FOREIGN KEY (mdm_binding_id, device_id, tenant_id)
    REFERENCES mdm_binding(id, geops_device_id, customer_id),
  FOREIGN KEY (installation_id, device_id)
    REFERENCES gps_device_installation(installation_id, device_id),
  FOREIGN KEY (scheduled_session_id, device_id, assignment_version)
    REFERENCES gps_scheduled_session(id, device_id, assignment_version),
  CHECK (due_at <= observed_at),
  CHECK (cardinality(observed_states) BETWEEN 1 AND 6),
  CHECK (observed_states <@ ARRAY[
    'ONLINE','GPS_UNAVAILABLE','NETWORK_UNAVAILABLE','BATTERY_LOW',
    'BATTERY_CRITICAL','POWER_SAVE_ENABLED','UNKNOWN']::text[])
);
CREATE INDEX gps_device_health_tenant_device_time
  ON gps_device_health_event(tenant_id, device_id, observed_at DESC, event_id DESC);
CREATE INDEX gps_device_health_retention
  ON gps_device_health_event(observed_at);
CREATE INDEX gps_device_health_received
  ON gps_device_health_event(device_id, received_at DESC);

CREATE TABLE gps_health_batch_receipt (
  device_id uuid NOT NULL REFERENCES geops_device(id),
  batch_id uuid NOT NULL,
  payload_digest bytea NOT NULL,
  accepted_event_ids uuid[] NOT NULL,
  duplicate_event_ids uuid[] NOT NULL,
  persisted_at timestamptz NOT NULL,
  PRIMARY KEY (device_id, batch_id)
);
CREATE INDEX gps_health_batch_receipt_retention ON gps_health_batch_receipt(persisted_at);

-- Distributed per-device quota; old buckets are removable independently of health retention.
CREATE TABLE gps_health_request_quota (
  device_id uuid NOT NULL REFERENCES geops_device(id),
  minute_bucket timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count BETWEEN 1 AND 6),
  PRIMARY KEY (device_id, minute_bucket)
);
CREATE INDEX gps_health_request_quota_expiry ON gps_health_request_quota(minute_bucket);
