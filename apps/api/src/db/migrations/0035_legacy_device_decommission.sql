-- SPEC-04: terminal state. No data migration and no implicit device selection.
ALTER TABLE geops_device DROP CONSTRAINT geops_device_status_check;
ALTER TABLE geops_device ADD CONSTRAINT geops_device_status_check
  CHECK (status IN ('DRAFT','INVITED','PENDING_CONFIRMATION','ACTIVE',
    'SUSPENDED','REVOKED','RETIRED','DECOMMISSIONED'));

CREATE FUNCTION gps_reject_decommissioned_grant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid;
BEGIN
  target_id := CASE TG_TABLE_NAME
    WHEN 'gps_device_ownership' THEN NEW.device_id
    WHEN 'gps_policy_assignment' THEN NEW.device_id
    WHEN 'gps_group_member' THEN NEW.device_id
    WHEN 'gps_mdm_continuous_authorization' THEN NEW.device_id
    WHEN 'agent_device_link' THEN NEW.device_id
    WHEN 'gps_effective_assignment' THEN NEW.device_id
    WHEN 'gps_device_installation' THEN NEW.device_id
    WHEN 'gps_scheduled_session' THEN NEW.device_id
  END;
  IF target_id IS NOT NULL AND EXISTS
    (SELECT 1 FROM geops_device WHERE id=target_id AND status='DECOMMISSIONED') THEN
    IF TG_TABLE_NAME='gps_device_ownership' THEN
      IF NOT NEW.tracking_authorized THEN RETURN NEW; END IF;
    ELSIF TG_TABLE_NAME='gps_group_member' THEN
      IF NEW.valid_until IS NOT NULL THEN RETURN NEW; END IF;
    ELSIF TG_TABLE_NAME='gps_mdm_continuous_authorization' THEN
      IF NEW.revoked_at IS NOT NULL THEN RETURN NEW; END IF;
    ELSIF TG_TABLE_NAME='agent_device_link' THEN
      IF NEW.state<>'ACTIVE' THEN RETURN NEW; END IF;
    ELSIF TG_TABLE_NAME='gps_effective_assignment' THEN
      IF NEW.superseded_at IS NOT NULL THEN RETURN NEW; END IF;
    ELSIF TG_TABLE_NAME='gps_device_installation' THEN
      IF NEW.retired_at IS NOT NULL THEN RETURN NEW; END IF;
    ELSIF TG_TABLE_NAME='gps_scheduled_session' THEN
      IF NEW.state<>'SCHEDULED' THEN RETURN NEW; END IF;
    END IF;
    RAISE EXCEPTION 'decommissioned device cannot receive GPS grants' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gps_no_decommissioned_ownership_grant
  BEFORE INSERT OR UPDATE ON gps_device_ownership FOR EACH ROW
  EXECUTE FUNCTION gps_reject_decommissioned_grant();
CREATE TRIGGER gps_no_decommissioned_policy_assignment
  BEFORE INSERT OR UPDATE ON gps_policy_assignment FOR EACH ROW
  EXECUTE FUNCTION gps_reject_decommissioned_grant();
CREATE TRIGGER gps_no_decommissioned_group_member
  BEFORE INSERT OR UPDATE ON gps_group_member FOR EACH ROW
  EXECUTE FUNCTION gps_reject_decommissioned_grant();
CREATE TRIGGER gps_no_decommissioned_continuous_authorization
  BEFORE INSERT OR UPDATE ON gps_mdm_continuous_authorization FOR EACH ROW
  EXECUTE FUNCTION gps_reject_decommissioned_grant();
CREATE TRIGGER gps_no_decommissioned_agent_link
  BEFORE INSERT OR UPDATE ON agent_device_link FOR EACH ROW
  EXECUTE FUNCTION gps_reject_decommissioned_grant();
CREATE TRIGGER gps_no_decommissioned_effective_assignment
  BEFORE INSERT OR UPDATE ON gps_effective_assignment FOR EACH ROW
  EXECUTE FUNCTION gps_reject_decommissioned_grant();
CREATE TRIGGER gps_no_decommissioned_installation
  BEFORE INSERT OR UPDATE ON gps_device_installation FOR EACH ROW
  EXECUTE FUNCTION gps_reject_decommissioned_grant();
CREATE TRIGGER gps_no_decommissioned_schedule
  BEFORE INSERT OR UPDATE ON gps_scheduled_session FOR EACH ROW
  EXECUTE FUNCTION gps_reject_decommissioned_grant();
