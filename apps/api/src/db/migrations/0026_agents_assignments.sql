-- SPEC-03 Wave 3 planning only. No GPS/MDM linkage or automatic grants.
ALTER TABLE admin_permission DROP CONSTRAINT admin_permission_permission_check;
ALTER TABLE admin_permission ADD CONSTRAINT admin_permission_permission_check CHECK (permission IN (
  'gps.policy.read','gps.policy.write','gps.policy.assign','gps.policy.activate',
  'gps.session.read','gps.location.read','gps.audit.read',
  'gps.installation.manage','gps.tenant.grant','gps.user.manage','mdm.oauth.configure',
  'visit.catalog.read','visit.catalog.write','visit.schedule.read','visit.schedule.write'
));

CREATE TABLE agent (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES geops_operating_tenant(tenant_id),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','INACTIVE')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES admin_user(id),
  updated_by uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,code), UNIQUE (tenant_id,id)
);
CREATE INDEX agent_tenant_state_code ON agent(tenant_id,state,code,id);
CREATE INDEX agent_tenant_name ON agent(tenant_id,lower(name),id);

CREATE TABLE route_schedule_rule (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  agent_id uuid NOT NULL,
  route_id uuid NOT NULL,
  route_revision integer NOT NULL CHECK (route_revision > 0),
  start_date date NOT NULL,
  end_date date,
  days_iso integer[] NOT NULL CHECK (array_length(days_iso,1) BETWEEN 1 AND 7 AND days_iso <@ ARRAY[1,2,3,4,5,6,7]),
  time_zone text NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 80),
  starts_local time NOT NULL,
  ends_local time NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','INACTIVE')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES admin_user(id),
  updated_by uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,agent_id) REFERENCES agent(tenant_id,id),
  FOREIGN KEY (tenant_id,route_id,route_revision) REFERENCES route_revision(tenant_id,route_id,revision),
  UNIQUE (tenant_id,id),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (ends_local > starts_local)
);
CREATE INDEX route_schedule_rule_agent ON route_schedule_rule(tenant_id,agent_id,state,start_date,id);

CREATE TABLE route_schedule_exception (
  tenant_id text NOT NULL,
  rule_id uuid NOT NULL,
  local_date date NOT NULL,
  action text NOT NULL CHECK (action IN ('SKIP','CANCEL','REPLACE')),
  replacement_route_id uuid,
  replacement_revision integer,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 8 AND 240),
  created_by uuid NOT NULL REFERENCES admin_user(id),
  updated_by uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id,local_date),
  FOREIGN KEY (tenant_id,rule_id) REFERENCES route_schedule_rule(tenant_id,id),
  FOREIGN KEY (tenant_id,replacement_route_id,replacement_revision) REFERENCES route_revision(tenant_id,route_id,revision),
  CHECK ((action='REPLACE') = (replacement_route_id IS NOT NULL AND replacement_revision IS NOT NULL))
);

CREATE TABLE route_assignment (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  agent_id uuid NOT NULL,
  agent_code text NOT NULL,
  agent_name text NOT NULL,
  route_id uuid NOT NULL,
  route_revision integer NOT NULL CHECK (route_revision > 0),
  route_code text NOT NULL,
  route_name text NOT NULL,
  local_date date NOT NULL,
  time_zone text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  origin text NOT NULL CHECK (origin IN ('MANUAL','RECURRENCE','EXTRAORDINARY')),
  rule_id uuid,
  state text NOT NULL DEFAULT 'PLANNED' CHECK (state IN ('PLANNED','CANCELLED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 8 AND 240),
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES admin_user(id),
  cancel_reason text,
  created_by uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,agent_id) REFERENCES agent(tenant_id,id),
  FOREIGN KEY (tenant_id,route_id,route_revision) REFERENCES route_revision(tenant_id,route_id,revision),
  FOREIGN KEY (tenant_id,rule_id) REFERENCES route_schedule_rule(tenant_id,id),
  UNIQUE (tenant_id,id),
  CHECK (ends_at > starts_at),
  CHECK ((origin='RECURRENCE') = (rule_id IS NOT NULL)),
  CHECK ((state='CANCELLED') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL))
);
CREATE INDEX route_assignment_calendar ON route_assignment(tenant_id,local_date,agent_id,route_id,id);
CREATE INDEX route_assignment_rule ON route_assignment(tenant_id,rule_id,local_date,id);
CREATE UNIQUE INDEX route_assignment_no_duplicate_active ON route_assignment(tenant_id,agent_id,route_id,route_revision,local_date,starts_at,ends_at) WHERE state='PLANNED';
ALTER TABLE route_assignment ADD CONSTRAINT route_assignment_agent_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, agent_id WITH =, tstzrange(starts_at,ends_at,'[)') WITH &&)
  WHERE (state='PLANNED');

CREATE TABLE assignment_visit (
  tenant_id text NOT NULL,
  assignment_id uuid NOT NULL,
  stop_id uuid NOT NULL,
  client_id uuid NOT NULL,
  site_id uuid NOT NULL,
  geofence_revision integer NOT NULL,
  required boolean NOT NULL,
  suggested_order integer,
  min_dwell_effective_s integer NOT NULL CHECK (min_dwell_effective_s BETWEEN 1 AND 86400),
  client_code text NOT NULL,
  client_name text NOT NULL,
  site_code text NOT NULL,
  site_name text NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  radius_m numeric(10,2) NOT NULL CHECK (radius_m > 0),
  PRIMARY KEY (assignment_id,stop_id),
  FOREIGN KEY (tenant_id,assignment_id) REFERENCES route_assignment(tenant_id,id),
  FOREIGN KEY (tenant_id,client_id,site_id) REFERENCES client_site(tenant_id,client_id,id),
  FOREIGN KEY (site_id,geofence_revision) REFERENCES client_geofence_revision(site_id,revision)
);
CREATE FUNCTION assignment_visit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'assignment snapshots are immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER assignment_visit_no_change BEFORE UPDATE OR DELETE ON assignment_visit
  FOR EACH ROW EXECUTE FUNCTION assignment_visit_immutable();

CREATE TABLE route_schedule_occurrence (
  tenant_id text NOT NULL,
  rule_id uuid NOT NULL,
  local_date date NOT NULL,
  applied_version bigint NOT NULL CHECK (applied_version > 0),
  assignment_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('GENERATED','SKIPPED','CANCELLED')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id,local_date),
  FOREIGN KEY (tenant_id,rule_id) REFERENCES route_schedule_rule(tenant_id,id),
  FOREIGN KEY (tenant_id,assignment_id) REFERENCES route_assignment(tenant_id,id),
  CHECK ((outcome='GENERATED') = (assignment_id IS NOT NULL))
);

CREATE TABLE visit_schedule_idempotency (
  actor_id uuid NOT NULL REFERENCES admin_user(id),
  request_key uuid NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  payload_digest bytea NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id,request_key)
);
CREATE INDEX visit_schedule_idempotency_age ON visit_schedule_idempotency(created_at);
