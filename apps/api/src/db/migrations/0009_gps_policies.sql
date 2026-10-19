-- SPEC-02 W1-B. Product tables only; no PoC data or automatic permission grants.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE FUNCTION gps_valid_iso_days(days smallint[]) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT array_ndims(days) = 1 AND cardinality(days) BETWEEN 1 AND 7
    AND days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]
    AND cardinality(days) = (SELECT count(DISTINCT day) FROM unnest(days) AS day);
$$;

CREATE TABLE admin_permission (
  admin_id uuid NOT NULL REFERENCES admin_user(id),
  permission text NOT NULL CHECK (permission IN (
    'gps.policy.read','gps.policy.write','gps.policy.assign','gps.policy.activate',
    'gps.session.read','gps.location.read','gps.audit.read'
  )),
  granted_by uuid NOT NULL REFERENCES admin_user(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 240),
  PRIMARY KEY (admin_id, permission, granted_at),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE UNIQUE INDEX admin_permission_one_active ON admin_permission(admin_id, permission)
  WHERE revoked_at IS NULL;

CREATE TABLE gps_policy (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  state text NOT NULL CHECK (state IN ('DRAFT','ACTIVE','PAUSED','REVOKED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  current_revision integer NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  draft_config jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(draft_config) = 'object')
);

CREATE TABLE gps_policy_revision (
  policy_id uuid NOT NULL REFERENCES gps_policy(id),
  revision integer NOT NULL CHECK (revision > 0),
  days_iso smallint[] NOT NULL CHECK (gps_valid_iso_days(days_iso)),
  start_local time NOT NULL,
  end_local time NOT NULL,
  time_zone text NOT NULL,
  capture_interval_s integer NOT NULL CHECK (capture_interval_s BETWEEN 30 AND 300),
  sync_interval_s integer NOT NULL CHECK (sync_interval_s BETWEEN 60 AND 900),
  heartbeat_missing_after_s integer NOT NULL CHECK (heartbeat_missing_after_s BETWEEN 300 AND 7200),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES admin_user(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (policy_id, revision),
  CHECK (start_local <> end_local AND valid_from < valid_until)
);
CREATE FUNCTION gps_validate_revision_zone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.time_zone AND
    (name = 'UTC' OR name LIKE '%/%')) THEN
    RAISE EXCEPTION 'invalid IANA time zone' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gps_revision_zone BEFORE INSERT ON gps_policy_revision
  FOR EACH ROW EXECUTE FUNCTION gps_validate_revision_zone();

CREATE TABLE gps_policy_exception (
  policy_id uuid NOT NULL,
  revision integer NOT NULL,
  local_date date NOT NULL,
  mode text NOT NULL CHECK (mode IN ('OFF','REPLACE')),
  start_local time,
  end_local time,
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 240),
  PRIMARY KEY (policy_id, revision, local_date),
  FOREIGN KEY (policy_id, revision) REFERENCES gps_policy_revision(policy_id, revision),
  CHECK ((mode='OFF' AND start_local IS NULL AND end_local IS NULL) OR
         (mode='REPLACE' AND start_local IS NOT NULL AND end_local IS NOT NULL AND start_local <> end_local))
);

CREATE TABLE gps_device_group (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gps_group_member (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES gps_device_group(id),
  device_id uuid NOT NULL REFERENCES geops_device(id),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  CHECK (valid_until IS NULL OR valid_from < valid_until),
  EXCLUDE USING gist (group_id WITH =, device_id WITH =,
    tstzrange(valid_from,coalesce(valid_until,'infinity'::timestamptz),'[)') WITH &&)
);
CREATE INDEX gps_group_member_device ON gps_group_member(device_id, valid_until);

-- Nullable revision means a draft assignment. Published rows are append-only.
-- The paired nullable FK columns enforce exactly one scope target.
CREATE TABLE gps_policy_assignment (
  id uuid PRIMARY KEY,
  policy_id uuid NOT NULL REFERENCES gps_policy(id),
  revision integer,
  scope_type text NOT NULL CHECK (scope_type IN ('DEVICE','GROUP')),
  device_id uuid REFERENCES geops_device(id),
  group_id uuid REFERENCES gps_device_group(id),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  FOREIGN KEY (policy_id, revision) REFERENCES gps_policy_revision(policy_id, revision),
  UNIQUE (id, policy_id, revision),
  CHECK (valid_from < valid_until),
  CHECK ((scope_type='DEVICE' AND device_id IS NOT NULL AND group_id IS NULL) OR
         (scope_type='GROUP' AND group_id IS NOT NULL AND device_id IS NULL))
);
CREATE INDEX gps_policy_assignment_revision ON gps_policy_assignment(policy_id, revision);
CREATE INDEX gps_policy_assignment_group ON gps_policy_assignment(group_id) WHERE group_id IS NOT NULL;

CREATE TABLE gps_device_assignment_state (
  device_id uuid PRIMARY KEY REFERENCES geops_device(id),
  assignment_version bigint NOT NULL CHECK (assignment_version >= 0),
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gps_effective_assignment (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES geops_device(id),
  policy_id uuid NOT NULL,
  revision integer NOT NULL,
  source_assignment_id uuid NOT NULL,
  effective_range tstzrange NOT NULL,
  assignment_version bigint NOT NULL CHECK (assignment_version > 0),
  superseded_at timestamptz,
  FOREIGN KEY (policy_id, revision) REFERENCES gps_policy_revision(policy_id, revision),
  FOREIGN KEY (source_assignment_id, policy_id, revision)
    REFERENCES gps_policy_assignment(id, policy_id, revision),
  CHECK (NOT isempty(effective_range) AND lower_inc(effective_range) AND NOT upper_inc(effective_range)),
  EXCLUDE USING gist (device_id WITH =, effective_range WITH &&)
    WHERE (superseded_at IS NULL)
);
CREATE INDEX gps_effective_assignment_current ON gps_effective_assignment(device_id, assignment_version)
  WHERE superseded_at IS NULL;

CREATE TABLE gps_device_installation (
  installation_id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES geops_device(id),
  activated_at timestamptz NOT NULL,
  retired_at timestamptz,
  CHECK (retired_at IS NULL OR retired_at >= activated_at),
  UNIQUE (installation_id, device_id)
);
CREATE UNIQUE INDEX gps_device_installation_one_active ON gps_device_installation(device_id)
  WHERE retired_at IS NULL;

CREATE TABLE gps_policy_delivery (
  capture_anchor_id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES geops_device(id),
  installation_id uuid NOT NULL,
  assignment_version bigint NOT NULL,
  server_time timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  offline_not_after timestamptz NOT NULL,
  reported_applied_at timestamptz,
  agent_version text,
  apply_status text,
  error_code text,
  CHECK (offline_not_after <= server_time + interval '12 hours'),
  FOREIGN KEY (installation_id, device_id)
    REFERENCES gps_device_installation(installation_id, device_id)
);

CREATE TABLE gps_scheduled_session (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES geops_device(id),
  policy_id uuid NOT NULL,
  revision integer NOT NULL,
  assignment_version bigint NOT NULL,
  local_date date NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('SCHEDULED','MISSED','CANCELLED')),
  FOREIGN KEY (policy_id, revision) REFERENCES gps_policy_revision(policy_id, revision),
  UNIQUE (device_id, policy_id, revision, assignment_version, local_date, start_at, end_at),
  UNIQUE (id, device_id, assignment_version),
  CHECK (start_at < end_at)
);
CREATE INDEX gps_scheduled_session_device_time ON gps_scheduled_session(device_id,start_at);

CREATE TABLE gps_effective_session (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES geops_device(id),
  installation_id uuid NOT NULL,
  client_session_id uuid NOT NULL,
  scheduled_session_id uuid NOT NULL,
  assignment_version bigint NOT NULL,
  started_at timestamptz NOT NULL,
  stopped_at timestamptz,
  start_event_id uuid NOT NULL,
  stop_event_id uuid,
  end_reason text,
  state text NOT NULL CHECK (state IN ('OPEN','INTERRUPTED','STOPPED','UNKNOWN_END')),
  evidence_state text NOT NULL,
  UNIQUE (device_id,installation_id,client_session_id),
  UNIQUE (id,device_id),
  FOREIGN KEY (installation_id,device_id)
    REFERENCES gps_device_installation(installation_id,device_id),
  FOREIGN KEY (scheduled_session_id,device_id,assignment_version)
    REFERENCES gps_scheduled_session(id,device_id,assignment_version),
  CHECK (stopped_at IS NULL OR stopped_at >= started_at),
  CHECK (state <> 'UNKNOWN_END' OR stopped_at IS NULL)
);
CREATE UNIQUE INDEX gps_effective_session_one_open ON gps_effective_session(device_id)
  WHERE state IN ('OPEN','INTERRUPTED');

CREATE TABLE gps_session_event (
  device_id uuid NOT NULL REFERENCES geops_device(id),
  event_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  client_session_id uuid,
  session_id uuid,
  type text NOT NULL CHECK (type IN ('START_ATTEMPT','STARTED','STOP_REQUESTED','STOPPED','INTERRUPTED','RESUMED','MISSED_START')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  reason_code text,
  assignment_version bigint NOT NULL,
  capture_anchor_id uuid REFERENCES gps_policy_delivery(capture_anchor_id),
  boot_id uuid NOT NULL,
  anchor_elapsed_realtime_ms bigint,
  elapsed_realtime_ms bigint NOT NULL,
  payload_digest bytea NOT NULL,
  PRIMARY KEY (device_id,event_id),
  CHECK (reason_code IS NULL OR reason_code IN (
    'FGS_START_BLOCKED','PERMISSION_DENIED','GPS_DISABLED','CONNECTIVITY_LOST',
    'WINDOW_END','POLICY_REPLACED','POLICY_REVOKED','IDENTITY_REVOKED',
    'PROCESS_RESTART','USER_STOP','UNKNOWN')),
  FOREIGN KEY (installation_id,device_id)
    REFERENCES gps_device_installation(installation_id,device_id),
  FOREIGN KEY (session_id,device_id) REFERENCES gps_effective_session(id,device_id),
  CHECK (anchor_elapsed_realtime_ms IS NULL OR anchor_elapsed_realtime_ms <= elapsed_realtime_ms),
  CHECK (type IN ('START_ATTEMPT','MISSED_START') OR
         (client_session_id IS NOT NULL AND capture_anchor_id IS NOT NULL AND anchor_elapsed_realtime_ms IS NOT NULL))
);
CREATE INDEX gps_session_event_session_time ON gps_session_event(session_id,occurred_at);

CREATE TABLE gps_event_quarantine (
  device_id uuid NOT NULL REFERENCES geops_device(id),
  event_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('SESSION','POSITION')),
  encrypted_payload_ref text NOT NULL,
  reason_code text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (device_id,event_id,kind),
  CHECK (expires_at <= first_seen_at + interval '7 days')
);

CREATE TABLE position_event (
  device_id uuid NOT NULL REFERENCES geops_device(id),
  event_id uuid NOT NULL,
  session_id uuid NOT NULL,
  assignment_version bigint NOT NULL,
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  capture_anchor_id uuid NOT NULL REFERENCES gps_policy_delivery(capture_anchor_id),
  boot_id uuid NOT NULL,
  anchor_elapsed_realtime_ms bigint NOT NULL,
  elapsed_realtime_ms bigint NOT NULL,
  geom geography(Point,4326) NOT NULL,
  accuracy_m double precision NOT NULL CHECK (accuracy_m > 0 AND accuracy_m <= 10000),
  payload_digest bytea NOT NULL,
  quality_state text NOT NULL,
  PRIMARY KEY (device_id,event_id),
  FOREIGN KEY (session_id,device_id) REFERENCES gps_effective_session(id,device_id),
  CHECK (anchor_elapsed_realtime_ms <= elapsed_realtime_ms)
);
CREATE INDEX position_event_geom ON position_event USING gist(geom);
CREATE INDEX position_event_device_time ON position_event(device_id,captured_at);

CREATE TABLE gps_sync_status (
  device_id uuid PRIMARY KEY REFERENCES geops_device(id),
  last_ack_at timestamptz,
  last_heartbeat_at timestamptz,
  backlog_reported integer NOT NULL DEFAULT 0 CHECK (backlog_reported >= 0),
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gps_admin_idempotency (
  admin_id uuid NOT NULL REFERENCES admin_user(id),
  method text NOT NULL,
  path text NOT NULL,
  key uuid NOT NULL,
  body_precondition_digest bytea NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  response_etag text,
  additional_capabilities text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (admin_id,method,path,key),
  CHECK (expires_at <= created_at + interval '24 hours')
);
CREATE INDEX gps_admin_idempotency_expiry ON gps_admin_idempotency(expires_at);

CREATE FUNCTION gps_reject_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'published GPS history is immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER gps_revision_immutable BEFORE UPDATE OR DELETE ON gps_policy_revision
  FOR EACH ROW EXECUTE FUNCTION gps_reject_immutable_change();
CREATE TRIGGER gps_exception_immutable BEFORE UPDATE OR DELETE ON gps_policy_exception
  FOR EACH ROW EXECUTE FUNCTION gps_reject_immutable_change();
CREATE FUNCTION gps_reject_published_assignment_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revision IS NOT NULL OR (TG_OP = 'UPDATE' AND NEW.revision IS NOT NULL) THEN
    RAISE EXCEPTION 'published GPS assignment is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gps_assignment_immutable BEFORE UPDATE OR DELETE ON gps_policy_assignment
  FOR EACH ROW EXECUTE FUNCTION gps_reject_published_assignment_change();
