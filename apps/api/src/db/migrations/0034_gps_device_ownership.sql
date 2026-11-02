-- Additive inventory only. This migration never enables capture or changes
-- existing policies, sessions, installation grants, routes or event ingestion.
CREATE TABLE gps_device_ownership (
  device_id uuid PRIMARY KEY REFERENCES geops_device(id),
  ownership text NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (ownership IN ('CORPORATE_MANAGED','PERSONAL_BYOD','UNVERIFIED')),
  mdm_state text NOT NULL DEFAULT 'UNKNOWN'
    CHECK (mdm_state IN ('VERIFIED','REVOKED','NOT_APPLICABLE','UNKNOWN')),
  verification_source text NOT NULL DEFAULT 'NONE'
    CHECK (verification_source IN ('MANAGEENGINE','ADMIN_EVIDENCE','NONE')),
  evidence_ref text CHECK (evidence_ref IS NULL OR length(trim(evidence_ref)) BETWEEN 8 AND 240),
  verified_at timestamptz,
  valid_until timestamptz,
  tracking_authorized boolean NOT NULL DEFAULT false,
  authorization_basis text CHECK (authorization_basis IS NULL OR length(trim(authorization_basis)) BETWEEN 8 AND 240),
  privacy_notice_at timestamptz,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid REFERENCES admin_user(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  change_reason text NOT NULL CHECK (length(trim(change_reason)) BETWEEN 8 AND 240),
  CHECK (valid_until IS NULL OR (verified_at IS NOT NULL AND valid_until > verified_at)),
  CHECK (NOT tracking_authorized OR
    (ownership<>'UNVERIFIED' AND authorization_basis IS NOT NULL AND
     privacy_notice_at IS NOT NULL AND verified_at IS NOT NULL AND valid_until IS NOT NULL)),
  CHECK (ownership<>'CORPORATE_MANAGED' OR
    (mdm_state='VERIFIED' AND verification_source='MANAGEENGINE' AND
     evidence_ref IS NOT NULL AND verified_at IS NOT NULL AND valid_until IS NOT NULL)),
  CHECK (ownership<>'PERSONAL_BYOD' OR
    (mdm_state='NOT_APPLICABLE' AND verification_source='ADMIN_EVIDENCE' AND
     evidence_ref IS NOT NULL AND verified_at IS NOT NULL AND valid_until IS NOT NULL))
);

CREATE TABLE gps_device_ownership_history (
  device_id uuid NOT NULL REFERENCES geops_device(id),
  version bigint NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id,version)
);
CREATE FUNCTION gps_device_ownership_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.version<>OLD.version+1 OR NEW.device_id<>OLD.device_id) THEN
    RAISE EXCEPTION 'ownership version must advance' USING ERRCODE='23514';
  END IF;
  INSERT INTO gps_device_ownership_history(device_id,version,snapshot)
    VALUES(NEW.device_id,NEW.version,to_jsonb(NEW));
  RETURN NEW;
END;
$$;
CREATE TRIGGER gps_device_ownership_record_change AFTER INSERT OR UPDATE ON gps_device_ownership
  FOR EACH ROW EXECUTE FUNCTION gps_device_ownership_record();
CREATE TRIGGER gps_device_ownership_history_immutable BEFORE UPDATE OR DELETE ON gps_device_ownership_history
  FOR EACH ROW EXECUTE FUNCTION gps_reject_immutable_change();
