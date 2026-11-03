-- SPEC-03 W1-A-R: additive integrity and exactly-once denial audit per request.
CREATE UNIQUE INDEX audit_event_catalog_denial_request
  ON audit_event(correlation_id,action) WHERE action='catalog.access.denied';

CREATE FUNCTION catalog_assert_active_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_id IS NOT NULL THEN
    PERFORM 1 FROM catalog_source WHERE id=NEW.source_id AND archived_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Catalog source is unavailable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER catalog_establishment_source_active
  BEFORE INSERT OR UPDATE OF source_id ON catalog_establishment
  FOR EACH ROW EXECUTE FUNCTION catalog_assert_active_source();

CREATE FUNCTION catalog_assert_active_pin_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM catalog_establishment
    WHERE id=NEW.establishment_id AND archived_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Catalog establishment is unavailable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER catalog_pin_target_active
  BEFORE INSERT OR UPDATE OF establishment_id ON catalog_pin
  FOR EACH ROW EXECUTE FUNCTION catalog_assert_active_pin_target();

CREATE FUNCTION catalog_assert_active_stop_targets() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM catalog_route_version v JOIN catalog_route r ON r.id=v.route_id
    WHERE v.id=NEW.route_version_id AND v.state='DRAFT' AND r.state='DRAFT'
    FOR SHARE OF v,r;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Catalog route is unavailable' USING ERRCODE='23514';
  END IF;
  IF NEW.customer_id IS NOT NULL THEN
    PERFORM 1 FROM catalog_customer
      WHERE id=NEW.customer_id AND archived_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Catalog customer is unavailable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.establishment_id IS NOT NULL THEN
    PERFORM 1 FROM catalog_establishment
      WHERE id=NEW.establishment_id AND archived_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Catalog establishment is unavailable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.pin_id IS NOT NULL THEN
    PERFORM 1 FROM catalog_pin
      WHERE id=NEW.pin_id AND establishment_id=NEW.establishment_id AND state<>'ARCHIVED'
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Catalog pin is unavailable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER catalog_stop_targets_active
  BEFORE INSERT OR UPDATE OF route_version_id,customer_id,establishment_id,pin_id
  ON catalog_route_stop
  FOR EACH ROW EXECUTE FUNCTION catalog_assert_active_stop_targets();
