-- SPEC-03 W1-A: catalog foundation only. No KMZ staging or operational visits.
ALTER TABLE admin_permission DROP CONSTRAINT admin_permission_permission_check;
ALTER TABLE admin_permission ADD CONSTRAINT admin_permission_permission_check CHECK (permission IN (
  'gps.policy.read','gps.policy.write','gps.policy.assign','gps.policy.activate',
  'gps.session.read','gps.location.read','gps.audit.read',
  'gps.installation.manage','gps.tenant.grant','gps.user.manage',
  'catalog.import.read','catalog.import.write','catalog.import.confirm'
));

CREATE TABLE catalog_revision (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0)
);
INSERT INTO catalog_revision(singleton,version) VALUES(true,0);

CREATE TABLE catalog_source (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('AUTHORIZED_CSV','AUTHORIZED_XLSX','KMZ_GEO','MANUAL')),
  authority text NOT NULL DEFAULT 'PENDING' CHECK (authority IN ('PENDING','AUTHORIZED')),
  namespace text NOT NULL CHECK (length(namespace) BETWEEN 1 AND 80 AND namespace ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 160),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (id,authority),
  UNIQUE (namespace),
  CHECK (authority <> 'AUTHORIZED' OR kind IN ('AUTHORIZED_CSV','AUTHORIZED_XLSX'))
);

CREATE TABLE catalog_customer (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  identity_status text NOT NULL CHECK (identity_status IN ('CANDIDATE','VERIFIED')),
  source_id uuid,
  source_authority text,
  external_customer_id text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  FOREIGN KEY (source_id,source_authority) REFERENCES catalog_source(id,authority),
  CHECK (
    (identity_status='CANDIDATE' AND source_id IS NULL AND source_authority IS NULL AND external_customer_id IS NULL)
    OR
    (identity_status='VERIFIED' AND source_id IS NOT NULL AND source_authority='AUTHORIZED'
      AND external_customer_id IS NOT NULL AND length(external_customer_id) BETWEEN 1 AND 120)
  )
);
CREATE UNIQUE INDEX catalog_customer_external_identity
  ON catalog_customer(source_id,external_customer_id) WHERE external_customer_id IS NOT NULL;
CREATE INDEX catalog_customer_name ON catalog_customer(lower(name),id);

CREATE TABLE catalog_establishment (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  classification text NOT NULL DEFAULT 'PENDING'
    CHECK (classification IN ('PENDING','CONFIRMED','DUPLICATE','ARCHIVED')),
  geog geography(Point,4326),
  source_id uuid REFERENCES catalog_source(id),
  source_key text CHECK (source_key IS NULL OR length(source_key) BETWEEN 1 AND 240),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX catalog_establishment_geog ON catalog_establishment USING gist(geog);
CREATE INDEX catalog_establishment_name ON catalog_establishment(lower(name),id);
CREATE UNIQUE INDEX catalog_establishment_source_key
  ON catalog_establishment(source_id,source_key) WHERE source_id IS NOT NULL AND source_key IS NOT NULL;

CREATE TABLE catalog_customer_establishment (
  customer_id uuid NOT NULL REFERENCES catalog_customer(id),
  establishment_id uuid NOT NULL REFERENCES catalog_establishment(id),
  approved_by uuid NOT NULL REFERENCES admin_user(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 8 AND 240),
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id,establishment_id)
);
CREATE INDEX catalog_customer_establishment_establishment
  ON catalog_customer_establishment(establishment_id,customer_id);

CREATE TABLE catalog_pin (
  id uuid PRIMARY KEY,
  establishment_id uuid NOT NULL REFERENCES catalog_establishment(id),
  geog geography(Point,4326) NOT NULL,
  state text NOT NULL DEFAULT 'CANDIDATE' CHECK (state IN ('CANDIDATE','CONFIRMED','ARCHIVED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,establishment_id)
);
CREATE UNIQUE INDEX catalog_pin_one_current ON catalog_pin(establishment_id) WHERE state <> 'ARCHIVED';
CREATE INDEX catalog_pin_geog ON catalog_pin USING gist(geog);

CREATE TABLE catalog_territory_group (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','ARCHIVED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog_territory_member (
  group_id uuid NOT NULL REFERENCES catalog_territory_group(id),
  establishment_id uuid NOT NULL REFERENCES catalog_establishment(id),
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  added_by uuid NOT NULL REFERENCES admin_user(id),
  PRIMARY KEY (group_id,establishment_id,valid_from),
  CHECK (valid_until IS NULL OR valid_from < valid_until)
);
CREATE UNIQUE INDEX catalog_territory_member_current
  ON catalog_territory_member(group_id,establishment_id) WHERE valid_until IS NULL;

CREATE TABLE catalog_route (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','ARCHIVED')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE catalog_route_version (
  id uuid PRIMARY KEY,
  route_id uuid NOT NULL REFERENCES catalog_route(id),
  revision integer NOT NULL CHECK (revision > 0),
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state='DRAFT'),
  calendar_draft jsonb,
  recurrence_draft jsonb,
  valid_from timestamptz,
  valid_until timestamptz,
  created_by uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (route_id,revision),
  CHECK (calendar_draft IS NULL OR jsonb_typeof(calendar_draft)='object'),
  CHECK (recurrence_draft IS NULL OR jsonb_typeof(recurrence_draft)='object'),
  CHECK (valid_until IS NULL OR (valid_from IS NOT NULL AND valid_from < valid_until))
);

CREATE TABLE catalog_route_stop (
  id uuid PRIMARY KEY,
  route_version_id uuid NOT NULL REFERENCES catalog_route_version(id),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  geog geography(Point,4326),
  customer_id uuid REFERENCES catalog_customer(id),
  establishment_id uuid REFERENCES catalog_establishment(id),
  pin_id uuid,
  stop_order integer CHECK (stop_order IS NULL OR stop_order > 0),
  state text NOT NULL DEFAULT 'CANDIDATE' CHECK (state='CANDIDATE'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES admin_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (customer_id,establishment_id)
    REFERENCES catalog_customer_establishment(customer_id,establishment_id),
  FOREIGN KEY (pin_id,establishment_id)
    REFERENCES catalog_pin(id,establishment_id),
  CHECK (pin_id IS NULL OR establishment_id IS NOT NULL)
);
CREATE UNIQUE INDEX catalog_route_stop_order
  ON catalog_route_stop(route_version_id,stop_order) WHERE stop_order IS NOT NULL;
CREATE INDEX catalog_route_stop_geog ON catalog_route_stop USING gist(geog);
CREATE INDEX catalog_route_stop_version ON catalog_route_stop(route_version_id,id);

-- Every catalog writer, including future CSV ingestion, advances the same revision.
CREATE FUNCTION catalog_advance_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE catalog_revision SET version=version+1 WHERE singleton=true;
  RETURN NULL;
END;
$$;
CREATE TRIGGER catalog_source_revision AFTER INSERT OR UPDATE OR DELETE ON catalog_source
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_advance_revision();
CREATE TRIGGER catalog_customer_revision AFTER INSERT OR UPDATE OR DELETE ON catalog_customer
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_advance_revision();
CREATE TRIGGER catalog_establishment_revision AFTER INSERT OR UPDATE OR DELETE ON catalog_establishment
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_advance_revision();
CREATE TRIGGER catalog_link_revision AFTER INSERT OR UPDATE OR DELETE ON catalog_customer_establishment
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_advance_revision();
CREATE TRIGGER catalog_pin_revision AFTER INSERT OR UPDATE OR DELETE ON catalog_pin
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_advance_revision();
CREATE TRIGGER catalog_group_revision AFTER INSERT OR UPDATE OR DELETE ON catalog_territory_group
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_advance_revision();
CREATE TRIGGER catalog_member_revision AFTER INSERT OR UPDATE OR DELETE ON catalog_territory_member
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_advance_revision();
CREATE TRIGGER catalog_route_revision AFTER INSERT OR UPDATE OR DELETE ON catalog_route
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_advance_revision();
CREATE TRIGGER catalog_route_version_revision AFTER INSERT OR UPDATE OR DELETE ON catalog_route_version
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_advance_revision();
CREATE TRIGGER catalog_stop_revision AFTER INSERT OR UPDATE OR DELETE ON catalog_route_stop
  FOR EACH STATEMENT EXECUTE FUNCTION catalog_advance_revision();
