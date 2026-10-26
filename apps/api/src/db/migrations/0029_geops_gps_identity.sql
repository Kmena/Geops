-- Wave 4B: additive GEOPS-owned GPS identity for an already authenticated device.
-- Existing MDM composite foreign keys remain in place for non-null bindings.
ALTER TABLE gps_device_installation DROP CONSTRAINT gps_installation_activation_pair;
ALTER TABLE gps_device_installation ADD CONSTRAINT gps_installation_activation_tenant
  CHECK (activation_binding_id IS NULL OR activation_tenant_id IS NOT NULL);
ALTER TABLE gps_policy_delivery DROP CONSTRAINT gps_policy_delivery_health_tenant_pair;
ALTER TABLE gps_policy_delivery ADD CONSTRAINT gps_policy_delivery_health_tenant_pair
  CHECK (health_mdm_binding_id IS NULL OR health_tenant_id IS NOT NULL);

ALTER TABLE gps_effective_session ALTER COLUMN mdm_binding_id DROP NOT NULL;
ALTER TABLE gps_session_event ALTER COLUMN mdm_binding_id DROP NOT NULL;
ALTER TABLE position_event ALTER COLUMN mdm_binding_id DROP NOT NULL;
ALTER TABLE gps_event_quarantine ALTER COLUMN mdm_binding_id DROP NOT NULL;
ALTER TABLE gps_device_health_event ALTER COLUMN mdm_binding_id DROP NOT NULL;

-- A missing binding is valid only with an immutable GEOPS tenant owner.
CREATE FUNCTION gps_geops_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_tenant text;
DECLARE binding uuid;
DECLARE tenant text;
BEGIN
  IF TG_TABLE_NAME='gps_device_installation' THEN
    binding := NEW.activation_binding_id; tenant := NEW.activation_tenant_id;
  ELSIF TG_TABLE_NAME='gps_policy_delivery' THEN
    binding := NEW.health_mdm_binding_id; tenant := NEW.health_tenant_id;
  ELSE
    binding := NEW.mdm_binding_id; tenant := NEW.tenant_id;
  END IF;
  IF binding IS NULL THEN
    IF tenant IS NULL THEN
      RAISE EXCEPTION 'GEOPS GPS tenant required' USING ERRCODE='23514';
    END IF;
    SELECT t.tenant_id INTO owner_tenant FROM geops_device_tenant t
      WHERE t.device_id=NEW.device_id;
    IF owner_tenant IS DISTINCT FROM tenant THEN
      RAISE EXCEPTION 'GEOPS GPS tenant mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gps_installation_owner BEFORE INSERT OR UPDATE ON gps_device_installation
  FOR EACH ROW EXECUTE FUNCTION gps_geops_owner_guard();
CREATE TRIGGER gps_delivery_owner BEFORE INSERT OR UPDATE ON gps_policy_delivery
  FOR EACH ROW EXECUTE FUNCTION gps_geops_owner_guard();
CREATE TRIGGER gps_effective_owner BEFORE INSERT OR UPDATE ON gps_effective_session
  FOR EACH ROW EXECUTE FUNCTION gps_geops_owner_guard();
CREATE TRIGGER gps_session_event_owner BEFORE INSERT OR UPDATE ON gps_session_event
  FOR EACH ROW EXECUTE FUNCTION gps_geops_owner_guard();
CREATE TRIGGER gps_position_owner BEFORE INSERT OR UPDATE ON position_event
  FOR EACH ROW EXECUTE FUNCTION gps_geops_owner_guard();
CREATE TRIGGER gps_quarantine_owner BEFORE INSERT OR UPDATE ON gps_event_quarantine
  FOR EACH ROW EXECUTE FUNCTION gps_geops_owner_guard();
CREATE TRIGGER gps_health_event_owner BEFORE INSERT OR UPDATE ON gps_device_health_event
  FOR EACH ROW EXECUTE FUNCTION gps_geops_owner_guard();

CREATE FUNCTION geops_device_tenant_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'GEOPS device tenant history is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER geops_device_tenant_no_change BEFORE UPDATE OR DELETE ON geops_device_tenant
  FOR EACH ROW EXECUTE FUNCTION geops_device_tenant_immutable();
