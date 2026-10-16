ALTER TABLE geops_device ADD COLUMN replacement_of uuid REFERENCES geops_device(id);
CREATE TABLE synthetic_rotation_exception (
  challenge_id uuid PRIMARY KEY REFERENCES device_challenge(id),
  operator_id uuid NOT NULL REFERENCES admin_user(id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);