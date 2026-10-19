-- W1-E1/C2 synthetic session and position integration. No grants and no PoC tables.
CREATE TABLE gps_data_tenant_access (
  admin_id uuid NOT NULL REFERENCES admin_user(id),
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 256),
  granted_by uuid NOT NULL REFERENCES admin_user(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 240),
  PRIMARY KEY (admin_id, tenant_id, granted_at),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE UNIQUE INDEX gps_data_tenant_access_one_active
  ON gps_data_tenant_access(admin_id, tenant_id) WHERE revoked_at IS NULL;

ALTER TABLE gps_effective_session
  ADD COLUMN tenant_id text NOT NULL,
  ADD COLUMN mdm_binding_id uuid NOT NULL,
  ADD COLUMN start_boot_id uuid NOT NULL,
  ADD COLUMN start_anchor_id uuid NOT NULL REFERENCES gps_policy_delivery(capture_anchor_id),
  ADD CONSTRAINT gps_effective_session_tenant_fk
    FOREIGN KEY (mdm_binding_id, device_id, tenant_id)
    REFERENCES mdm_binding(id, geops_device_id, customer_id);
CREATE INDEX gps_effective_session_tenant_device_time
  ON gps_effective_session(tenant_id, device_id, started_at DESC, id DESC);

ALTER TABLE gps_session_event
  ADD COLUMN tenant_id text NOT NULL,
  ADD COLUMN mdm_binding_id uuid NOT NULL,
  ADD COLUMN scheduled_session_id uuid,
  ADD CONSTRAINT gps_session_event_tenant_fk
    FOREIGN KEY (mdm_binding_id, device_id, tenant_id)
    REFERENCES mdm_binding(id, geops_device_id, customer_id),
  ADD CONSTRAINT gps_session_event_scheduled_fk
    FOREIGN KEY (scheduled_session_id, device_id, assignment_version)
    REFERENCES gps_scheduled_session(id, device_id, assignment_version);
CREATE INDEX gps_session_event_tenant_device_time
  ON gps_session_event(tenant_id, device_id, occurred_at DESC, event_id DESC);

ALTER TABLE position_event
  ADD COLUMN tenant_id text NOT NULL,
  ADD COLUMN mdm_binding_id uuid NOT NULL,
  ADD COLUMN installation_id uuid NOT NULL,
  ADD CONSTRAINT position_event_tenant_fk
    FOREIGN KEY (mdm_binding_id, device_id, tenant_id)
    REFERENCES mdm_binding(id, geops_device_id, customer_id),
  ADD CONSTRAINT position_event_installation_fk
    FOREIGN KEY (installation_id, device_id)
    REFERENCES gps_device_installation(installation_id, device_id);
CREATE INDEX position_event_tenant_device_time
  ON position_event(tenant_id, device_id, captured_at DESC, event_id DESC);

ALTER TABLE gps_policy_delivery ADD COLUMN session_boot_id uuid;

CREATE TABLE gps_event_batch_receipt (
  device_id uuid NOT NULL REFERENCES geops_device(id),
  kind text NOT NULL CHECK (kind IN ('SESSION','POSITION')),
  batch_id uuid NOT NULL,
  payload_digest bytea NOT NULL,
  accepted_event_ids uuid[] NOT NULL,
  duplicate_event_ids uuid[] NOT NULL,
  session_mappings jsonb NOT NULL DEFAULT '[]'::jsonb,
  persisted_at timestamptz NOT NULL,
  PRIMARY KEY (device_id, kind, batch_id),
  CHECK (jsonb_typeof(session_mappings) = 'array')
);
CREATE INDEX gps_event_batch_receipt_retention ON gps_event_batch_receipt(persisted_at);

CREATE TABLE gps_event_request_quota (
  device_id uuid NOT NULL REFERENCES geops_device(id),
  kind text NOT NULL CHECK (kind IN ('SESSION','POSITION')),
  minute_bucket timestamptz NOT NULL,
  request_count integer NOT NULL CHECK (request_count BETWEEN 1 AND 6),
  PRIMARY KEY (device_id, kind, minute_bucket)
);
CREATE INDEX gps_event_request_quota_expiry ON gps_event_request_quota(minute_bucket);

-- The existing quarantine reference points to encrypted inline payload; no plaintext coordinates.
ALTER TABLE gps_event_quarantine
  ADD COLUMN batch_id uuid NOT NULL,
  ADD COLUMN installation_id uuid NOT NULL,
  ADD COLUMN tenant_id text NOT NULL,
  ADD COLUMN mdm_binding_id uuid NOT NULL,
  ADD COLUMN payload_digest bytea NOT NULL,
  ADD COLUMN payload_nonce bytea NOT NULL CHECK (octet_length(payload_nonce) = 12),
  ADD COLUMN payload_tag bytea NOT NULL CHECK (octet_length(payload_tag) = 16),
  ADD COLUMN payload_ciphertext bytea NOT NULL,
  ADD CONSTRAINT gps_quarantine_tenant_fk
    FOREIGN KEY (mdm_binding_id, device_id, tenant_id)
    REFERENCES mdm_binding(id, geops_device_id, customer_id),
  ADD CONSTRAINT gps_quarantine_installation_fk
    FOREIGN KEY (installation_id, device_id)
    REFERENCES gps_device_installation(installation_id, device_id);
CREATE INDEX gps_event_quarantine_expiry ON gps_event_quarantine(expires_at);
