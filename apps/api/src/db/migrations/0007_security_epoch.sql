CREATE TABLE security_epoch (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  epoch uuid NOT NULL,
  quarantine_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
