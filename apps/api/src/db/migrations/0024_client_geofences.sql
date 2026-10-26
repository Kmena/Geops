-- SPEC-03 Wave 1. Additive catalog only; no automatic grants or customer data.
ALTER TABLE admin_permission DROP CONSTRAINT admin_permission_permission_check;
ALTER TABLE admin_permission ADD CONSTRAINT admin_permission_permission_check CHECK (permission IN (
  'gps.policy.read','gps.policy.write','gps.policy.assign','gps.policy.activate',
  'gps.session.read','gps.location.read','gps.audit.read',
  'gps.installation.manage','gps.tenant.grant','gps.user.manage','mdm.oauth.configure',
  'visit.catalog.read','visit.catalog.write'
));

CREATE TABLE client (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES geops_operating_tenant(tenant_id),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  address text NOT NULL CHECK (length(trim(address)) BETWEEN 1 AND 300),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','INACTIVE')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES admin_user(id),
  updated_by uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);
CREATE INDEX client_tenant_name ON client(tenant_id, lower(name), id);

CREATE TABLE client_site (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  client_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  address text NOT NULL CHECK (length(trim(address)) BETWEEN 1 AND 300),
  center geography(Point,4326) NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','INACTIVE')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES admin_user(id),
  updated_by uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client(tenant_id,id),
  UNIQUE (tenant_id, client_id, code),
  UNIQUE (tenant_id, client_id, id),
  CHECK (ST_Y(center::geometry) BETWEEN -90 AND 90 AND ST_X(center::geometry) BETWEEN -180 AND 180)
);
CREATE INDEX client_site_client ON client_site(tenant_id,client_id,id);
CREATE INDEX client_site_center ON client_site USING gist(center);

CREATE TABLE client_geofence_revision (
  tenant_id text NOT NULL,
  client_id uuid NOT NULL,
  site_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  center geography(Point,4326) NOT NULL,
  radius_m numeric(10,2) NOT NULL CHECK (radius_m > 0 AND radius_m <= 100000),
  min_dwell_s integer NOT NULL CHECK (min_dwell_s BETWEEN 1 AND 86400),
  state text NOT NULL CHECK (state IN ('ACTIVE','INACTIVE')),
  created_by uuid NOT NULL REFERENCES admin_user(id),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 8 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, revision),
  CHECK (ST_Y(center::geometry) BETWEEN -90 AND 90 AND ST_X(center::geometry) BETWEEN -180 AND 180),
  FOREIGN KEY (tenant_id, client_id, site_id) REFERENCES client_site(tenant_id,client_id,id)
);
CREATE INDEX client_geofence_current ON client_geofence_revision(tenant_id,client_id,site_id,revision DESC);
CREATE INDEX client_geofence_center ON client_geofence_revision USING gist(center);

CREATE FUNCTION client_geofence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'geofence revisions are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER client_geofence_no_update BEFORE UPDATE OR DELETE ON client_geofence_revision
  FOR EACH ROW EXECUTE FUNCTION client_geofence_immutable();

CREATE TABLE client_catalog_idempotency (
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
CREATE INDEX client_catalog_idempotency_age ON client_catalog_idempotency(created_at);
