-- SPEC-03 release candidate: permit continuity evidence for GEOPS-owned devices
-- without an MDM binding. Existing binding foreign keys remain effective.
ALTER TABLE gps_continuity_alert ALTER COLUMN mdm_binding_id DROP NOT NULL;
CREATE TRIGGER gps_continuity_owner BEFORE INSERT OR UPDATE ON gps_continuity_alert
  FOR EACH ROW EXECUTE FUNCTION gps_geops_owner_guard();

-- PostgreSQL NULLS NOT DISTINCT preserves the one-open-episode invariant for
-- both MDM and GEOPS-only identities.
DROP INDEX gps_continuity_alert_one_open;
CREATE UNIQUE INDEX gps_continuity_alert_one_open
  ON gps_continuity_alert(tenant_id,device_id,scheduled_session_id,mdm_binding_id,installation_id)
  NULLS NOT DISTINCT WHERE resolved_at IS NULL;
