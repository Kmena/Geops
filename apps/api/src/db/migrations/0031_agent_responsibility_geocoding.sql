-- Post-B30 additive identity and geocoding support. Historical links and assignments remain intact.
CREATE TABLE agent_operational_identity (
  tenant_id text NOT NULL,
  agent_id uuid PRIMARY KEY,
  device_id uuid NOT NULL UNIQUE,
  established_at timestamptz NOT NULL DEFAULT now(),
  established_by uuid NOT NULL REFERENCES admin_user(id),
  source text NOT NULL CHECK (source IN ('B30_ACTIVE_LINK','ADMIN_LINK')),
  FOREIGN KEY (tenant_id,agent_id) REFERENCES agent(tenant_id,id),
  FOREIGN KEY (tenant_id,device_id) REFERENCES geops_device_tenant(tenant_id,device_id),
  UNIQUE (tenant_id,agent_id,device_id)
);

-- Only current, non-revoked B30 links establish the operational identity.
-- Previous links remain the authority for historical GPS attribution.
INSERT INTO agent_operational_identity(tenant_id,agent_id,device_id,established_at,established_by,source)
SELECT tenant_id,agent_id,device_id,valid_from,created_by,'B30_ACTIVE_LINK'
FROM agent_device_link
WHERE state='ACTIVE' AND valid_from<=now()
  AND NOT EXISTS (
    SELECT 1 FROM agent_device_link newer
    WHERE newer.agent_id=agent_device_link.agent_id AND newer.state='ACTIVE'
      AND (newer.valid_from,newer.id)>(agent_device_link.valid_from,agent_device_link.id)
  );

CREATE TABLE agent_responsibility (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  agent_id uuid NOT NULL,
  device_id uuid NOT NULL,
  person_name text NOT NULL CHECK (length(trim(person_name)) BETWEEN 1 AND 160),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  recorded_by uuid NOT NULL REFERENCES admin_user(id),
  ended_by uuid REFERENCES admin_user(id),
  reason text CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 8 AND 240),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,agent_id) REFERENCES agent(tenant_id,id),
  FOREIGN KEY (tenant_id,device_id) REFERENCES geops_device_tenant(tenant_id,device_id),
  FOREIGN KEY (tenant_id,agent_id,device_id)
    REFERENCES agent_operational_identity(tenant_id,agent_id,device_id),
  CHECK (valid_to IS NULL OR valid_to>valid_from),
  CHECK ((valid_to IS NULL AND ended_by IS NULL) OR (valid_to IS NOT NULL AND ended_by IS NOT NULL))
);
ALTER TABLE agent_responsibility ADD CONSTRAINT agent_responsibility_no_overlap
  EXCLUDE USING gist (tenant_id WITH =, agent_id WITH =,
    tstzrange(valid_from,coalesce(valid_to,'infinity'::timestamptz),'[)') WITH &&);
CREATE INDEX agent_responsibility_history ON agent_responsibility(tenant_id,agent_id,valid_from DESC,id);
CREATE FUNCTION agent_responsibility_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'responsibility history is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.valid_to IS NOT NULL OR NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id
    OR NEW.agent_id<>OLD.agent_id OR NEW.device_id<>OLD.device_id
    OR NEW.person_name<>OLD.person_name OR NEW.valid_from<>OLD.valid_from
    OR NEW.recorded_by<>OLD.recorded_by OR NEW.created_at<>OLD.created_at
    OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.valid_to<=OLD.valid_from
    OR NEW.ended_by IS NULL THEN
    RAISE EXCEPTION 'responsibility history is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_responsibility_no_history_change BEFORE UPDATE OR DELETE ON agent_responsibility
  FOR EACH ROW EXECUTE FUNCTION agent_responsibility_history_guard();

-- No raw search text is retained; the public provider's rate slot is shared by API replicas.
CREATE TABLE geocoding_cache (
  query_sha256 bytea PRIMARY KEY,
  results jsonb NOT NULL CHECK (jsonb_typeof(results)='array'),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX geocoding_cache_expiry ON geocoding_cache(expires_at);
CREATE TABLE geocoding_provider_slot (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  next_allowed_at timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO geocoding_provider_slot(singleton) VALUES(true);
CREATE TABLE geocoding_actor_bucket (
  admin_id uuid PRIMARY KEY REFERENCES admin_user(id),
  window_start timestamptz NOT NULL,
  requests integer NOT NULL CHECK (requests BETWEEN 0 AND 20)
);
