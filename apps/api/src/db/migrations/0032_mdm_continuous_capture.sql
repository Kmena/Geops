-- A full civil day is valid only for a server-created, MDM-linked GPS policy.
-- Existing scheduled revisions and their checksums remain unchanged.
ALTER TABLE gps_policy_revision
  ADD COLUMN mdm_continuous boolean NOT NULL DEFAULT false;

DO $$
DECLARE old_check text;
BEGIN
  SELECT conname INTO old_check
  FROM pg_constraint
  WHERE conrelid = 'gps_policy_revision'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%start_local%end_local%valid_from%valid_until%';
  IF old_check IS NULL THEN
    RAISE EXCEPTION 'gps policy time check not found';
  END IF;
  EXECUTE format('ALTER TABLE gps_policy_revision DROP CONSTRAINT %I', old_check);
END;
$$;

ALTER TABLE gps_policy_revision
  ADD CONSTRAINT gps_policy_revision_time_mode_check CHECK (
    valid_from < valid_until AND
    ((NOT mdm_continuous AND start_local <> end_local) OR
      (mdm_continuous AND start_local = time '00:00' AND
       end_local = time '00:00' AND
       days_iso @> ARRAY[1,2,3,4,5,6,7]::smallint[]))
  );

CREATE TABLE gps_mdm_continuous_authorization (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES geops_device(id),
  policy_id uuid NOT NULL UNIQUE REFERENCES gps_policy(id),
  provider text NOT NULL CHECK (provider = 'manageengine'),
  region text NOT NULL,
  customer_id text NOT NULL,
  mdm_device_id text NOT NULL,
  approved_by uuid NOT NULL REFERENCES admin_user(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (revoked_at IS NULL OR revoked_at >= approved_at),
  FOREIGN KEY (provider,region,customer_id,mdm_device_id)
    REFERENCES mdm_inventory_device(provider,region,customer_id,mdm_device_id)
);
CREATE UNIQUE INDEX gps_mdm_continuous_one_active_device
  ON gps_mdm_continuous_authorization(device_id) WHERE revoked_at IS NULL;

-- MDM deployment can be asynchronous. Only a managed invitation may remain
-- valid for 24 hours; supervised QR invitations keep the ten-minute limit.
ALTER TABLE device_invitation DROP CONSTRAINT device_invitation_check;
ALTER TABLE device_invitation ADD CONSTRAINT device_invitation_expiry_mode_check CHECK (
  -- Preserve historical ability to shorten an invitation's expiry when
  -- invalidating it. The service rejects any expiry already in the past.
  ((delivery_mode='supervised_qr' AND expires_at<=issued_at+interval '10 minutes') OR
   (delivery_mode='managed_configuration' AND expires_at<=issued_at+interval '24 hours'))
);
