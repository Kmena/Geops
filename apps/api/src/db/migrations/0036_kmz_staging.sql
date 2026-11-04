-- SPEC-03 KMZ staging on the existing GEOPS client/site catalog.
-- Keep every B32 permission and add the import capabilities without auto-grants.
ALTER TABLE admin_permission DROP CONSTRAINT admin_permission_permission_check;
ALTER TABLE admin_permission ADD CONSTRAINT admin_permission_permission_check CHECK (permission IN (
  'gps.policy.read','gps.policy.write','gps.policy.assign','gps.policy.activate',
  'gps.session.read','gps.location.read','gps.audit.read',
  'gps.installation.manage','gps.tenant.grant','gps.user.manage','mdm.oauth.configure',
  'visit.catalog.read','visit.catalog.write','visit.schedule.read','visit.schedule.write',
  'visit.result.read','visit.evidence.read','visit.evaluation.recompute',
  'visit.device.read','visit.device.write',
  'catalog.import.read','catalog.import.write','catalog.import.confirm'
));

-- Version token for reviewed imports; the operating catalog remains client/client_site.
CREATE TABLE catalog_revision (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0)
);
INSERT INTO catalog_revision(singleton,version) VALUES(true,0);
CREATE FUNCTION kmz_bump_catalog_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE catalog_revision SET version=version+1 WHERE singleton=true;
  RETURN NULL;
END;
$$;
CREATE TRIGGER kmz_client_revision AFTER INSERT OR UPDATE OR DELETE ON client
  FOR EACH ROW EXECUTE FUNCTION kmz_bump_catalog_revision();
CREATE TRIGGER kmz_site_revision AFTER INSERT OR UPDATE OR DELETE ON client_site
  FOR EACH ROW EXECUTE FUNCTION kmz_bump_catalog_revision();

-- Read-only projections preserve matcher/review queries without another client master.
CREATE VIEW catalog_customer AS
  SELECT id,name,version,code AS internal_code,'VERIFIED'::text AS identity_status,
    'APPROVED'::text AS review_state,
    CASE WHEN state='ACTIVE' THEN NULL::timestamptz ELSE updated_at END AS archived_at
  FROM client;
CREATE VIEW catalog_establishment AS
  SELECT id,name,center AS geog,version,code AS source_key,NULL::uuid AS source_id,
    'CONFIRMED'::text AS classification,
    CASE WHEN state='ACTIVE' THEN NULL::timestamptz ELSE updated_at END AS archived_at
  FROM client_site;
CREATE VIEW catalog_customer_establishment AS
  SELECT client_id AS customer_id,id AS establishment_id FROM client_site;
CREATE VIEW catalog_source AS
  SELECT NULL::uuid AS id,NULL::text AS namespace WHERE false;
CREATE VIEW catalog_pin AS
  SELECT site_id AS id,revision::bigint AS version,center AS geog,
    site_id AS establishment_id,state
  FROM (SELECT DISTINCT ON (site_id) site_id,revision,center,state
        FROM client_geofence_revision ORDER BY site_id,revision DESC) current_geofence
  WHERE state='ACTIVE';

CREATE TABLE kmz_import_session (
  id uuid PRIMARY KEY,
  created_by uuid NOT NULL REFERENCES admin_user(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 160),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 240),
  compressed_bytes bigint NOT NULL CHECK (compressed_bytes BETWEEN 1 AND 33554432),
  expanded_bytes bigint NOT NULL DEFAULT 0 CHECK (expanded_bytes >= 0),
  state text NOT NULL CHECK (state IN ('PROCESSING','READY','FAILED')),
  record_count integer NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  review_of uuid REFERENCES kmz_import_session(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE (created_by,idempotency_key)
);
CREATE INDEX kmz_import_session_actor_created ON kmz_import_session(created_by,created_at DESC,id DESC);
CREATE INDEX kmz_import_session_hash ON kmz_import_session(created_by,sha256,created_at DESC);

CREATE TABLE kmz_import_file (
  import_id uuid PRIMARY KEY REFERENCES kmz_import_session(id) ON DELETE CASCADE,
  content bytea NOT NULL
);

CREATE TABLE kmz_import_record (
  id uuid PRIMARY KEY,
  import_id uuid NOT NULL REFERENCES kmz_import_session(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  source_path text NOT NULL CHECK (length(source_path) BETWEEN 1 AND 1200),
  parent_path text,
  source_kind text NOT NULL CHECK (source_kind IN
    ('DOCUMENT','FOLDER','TERRITORY_GROUP','WEEKLY_GROUP','CLIENT_POINT','WEEKLY_STOP','BRANCH_POINT','GEO_FEATURE','ROUTE_LINE','OTHER')),
  week_label text,
  original jsonb NOT NULL,
  normalized jsonb NOT NULL,
  geometry jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (import_id,ordinal),
  UNIQUE (import_id,source_path)
);
CREATE INDEX kmz_import_record_kind ON kmz_import_record(import_id,source_kind,ordinal);
