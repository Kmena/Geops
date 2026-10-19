-- Preserve the published name when a later draft changes gps_policy.name.
ALTER TABLE gps_policy_revision ADD COLUMN published_name text;
UPDATE gps_policy_revision r SET published_name = p.name
  FROM gps_policy p WHERE p.id = r.policy_id;
ALTER TABLE gps_policy_revision
  ALTER COLUMN published_name SET NOT NULL,
  ADD CONSTRAINT gps_revision_published_name_length
    CHECK (length(published_name) BETWEEN 1 AND 120);

CREATE FUNCTION gps_set_published_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.published_name IS NULL THEN
    SELECT name INTO NEW.published_name FROM gps_policy WHERE id = NEW.policy_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER gps_revision_published_name BEFORE INSERT ON gps_policy_revision
  FOR EACH ROW EXECUTE FUNCTION gps_set_published_name();
