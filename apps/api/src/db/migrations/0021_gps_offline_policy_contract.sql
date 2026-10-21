-- ADR-020: preserve v1 delivery semantics while recording the bounded v2
-- recurrent authorization used for offline journeys and historical ingest.
ALTER TABLE gps_policy_delivery
  ADD COLUMN contract_version smallint NOT NULL DEFAULT 1 CHECK (contract_version IN (1,2)),
  ADD COLUMN policy_id uuid,
  ADD COLUMN policy_revision integer,
  ADD COLUMN assignment_start timestamptz,
  ADD COLUMN authorized_until timestamptz,
  ADD CONSTRAINT gps_delivery_offline_contract CHECK (
    (contract_version=1 AND policy_id IS NULL AND policy_revision IS NULL AND
      assignment_start IS NULL AND authorized_until IS NULL) OR
    (contract_version=2 AND (
      (policy_id IS NULL AND policy_revision IS NULL AND assignment_start IS NULL AND authorized_until IS NULL) OR
      (policy_id IS NOT NULL AND policy_revision IS NOT NULL AND assignment_start IS NOT NULL AND
       authorized_until IS NOT NULL AND assignment_start<=server_time AND
       server_time<authorized_until)
    ))
  ),
  ADD CONSTRAINT gps_delivery_policy_revision_fk
    FOREIGN KEY (policy_id,policy_revision) REFERENCES gps_policy_revision(policy_id,revision);

CREATE INDEX gps_delivery_offline_lookup
  ON gps_policy_delivery(device_id,installation_id,assignment_version,policy_id,policy_revision)
  WHERE contract_version=2;

-- This checks relative elapsed-time consistency per boot. It does not claim
-- cryptographic proof of civil time across an offline device reboot.
CREATE TABLE gps_offline_boot_clock (
  capture_anchor_id uuid NOT NULL REFERENCES gps_policy_delivery(capture_anchor_id),
  boot_id uuid NOT NULL,
  first_reported_at timestamptz NOT NULL,
  first_elapsed_ms bigint NOT NULL CHECK (first_elapsed_ms >= 0),
  PRIMARY KEY (capture_anchor_id,boot_id)
);

ALTER TABLE gps_session_event
  ADD COLUMN time_evidence text NOT NULL DEFAULT 'SERVER_ANCHORED_V1'
  CHECK (time_evidence IN ('SERVER_ANCHORED_V1','DEVICE_CLOCK_OFFLINE_V2'));

ALTER TABLE position_event
  ADD COLUMN time_evidence text NOT NULL DEFAULT 'SERVER_ANCHORED_V1'
  CHECK (time_evidence IN ('SERVER_ANCHORED_V1','DEVICE_CLOCK_OFFLINE_V2'));
