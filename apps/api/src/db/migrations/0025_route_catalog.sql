-- SPEC-03 Wave 2. Additive reusable routes. Published revisions are append-only.
CREATE TABLE route_template (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES geops_operating_tenant(tenant_id),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','INACTIVE')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  published_revision integer NOT NULL DEFAULT 0 CHECK (published_revision >= 0),
  has_draft boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES admin_user(id),
  updated_by uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,code),
  UNIQUE (tenant_id,id)
);
CREATE INDEX route_template_list ON route_template(tenant_id,state,code,id);
CREATE INDEX route_template_search ON route_template(tenant_id,lower(name),id);

CREATE TABLE route_draft_stop (
  tenant_id text NOT NULL,
  route_id uuid NOT NULL,
  stop_id uuid NOT NULL,
  client_id uuid NOT NULL,
  site_id uuid NOT NULL,
  geofence_revision integer NOT NULL CHECK (geofence_revision > 0),
  required boolean NOT NULL,
  suggested_order integer CHECK (suggested_order > 0),
  min_dwell_override_s integer CHECK (min_dwell_override_s BETWEEN 1 AND 86400),
  PRIMARY KEY (route_id,stop_id),
  UNIQUE (route_id,site_id),
  FOREIGN KEY (tenant_id,route_id) REFERENCES route_template(tenant_id,id),
  FOREIGN KEY (tenant_id,client_id,site_id) REFERENCES client_site(tenant_id,client_id,id),
  FOREIGN KEY (site_id,geofence_revision) REFERENCES client_geofence_revision(site_id,revision)
);
CREATE INDEX route_draft_stop_site ON route_draft_stop(tenant_id,site_id);

CREATE TABLE route_revision (
  tenant_id text NOT NULL,
  route_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  sealed boolean NOT NULL DEFAULT false,
  published_by uuid NOT NULL REFERENCES admin_user(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (route_id,revision),
  UNIQUE (tenant_id,route_id,revision),
  FOREIGN KEY (tenant_id,route_id) REFERENCES route_template(tenant_id,id)
);
CREATE INDEX route_revision_history ON route_revision(tenant_id,route_id,revision DESC);

CREATE TABLE route_stop_revision (
  tenant_id text NOT NULL,
  route_id uuid NOT NULL,
  revision integer NOT NULL,
  stop_id uuid NOT NULL,
  client_id uuid NOT NULL,
  site_id uuid NOT NULL,
  geofence_revision integer NOT NULL,
  required boolean NOT NULL,
  suggested_order integer CHECK (suggested_order > 0),
  min_dwell_override_s integer CHECK (min_dwell_override_s BETWEEN 1 AND 86400),
  min_dwell_effective_s integer NOT NULL CHECK (min_dwell_effective_s BETWEEN 1 AND 86400),
  client_code text NOT NULL,
  client_name text NOT NULL,
  site_code text NOT NULL,
  site_name text NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  radius_m numeric(10,2) NOT NULL CHECK (radius_m > 0),
  PRIMARY KEY (route_id,revision,stop_id),
  UNIQUE (route_id,revision,site_id),
  FOREIGN KEY (tenant_id,route_id,revision) REFERENCES route_revision(tenant_id,route_id,revision),
  FOREIGN KEY (tenant_id,client_id,site_id) REFERENCES client_site(tenant_id,client_id,id),
  FOREIGN KEY (site_id,geofence_revision) REFERENCES client_geofence_revision(site_id,revision)
);
CREATE INDEX route_stop_revision_site ON route_stop_revision(tenant_id,site_id);

CREATE FUNCTION route_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.sealed = false AND NEW.sealed = true
     AND (to_jsonb(OLD) - 'sealed') = (to_jsonb(NEW) - 'sealed') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'published route revisions are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER route_revision_no_update BEFORE UPDATE OR DELETE ON route_revision
  FOR EACH ROW EXECUTE FUNCTION route_revision_guard();
CREATE FUNCTION route_stop_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM route_revision WHERE route_id=NEW.route_id AND revision=NEW.revision AND sealed=false
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'published route stops are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER route_stop_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON route_stop_revision
  FOR EACH ROW EXECUTE FUNCTION route_stop_guard();

CREATE TABLE route_catalog_idempotency (
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
CREATE INDEX route_catalog_idempotency_age ON route_catalog_idempotency(created_at);
