-- Inventory associations never grant GEOPS device authentication.
CREATE TABLE mdm_inventory_device (
  provider text NOT NULL CHECK (provider='manageengine'),
  region text NOT NULL,
  customer_id text NOT NULL,
  mdm_device_id text NOT NULL,
  platform text NOT NULL,
  status text NOT NULL,
  removed boolean NOT NULL DEFAULT false,
  display_name text,
  model text,
  os_version text,
  serial_number text,
  udid text,
  geops_device_id uuid REFERENCES geops_device(id),
  last_seen_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider,region,customer_id,mdm_device_id)
);
CREATE UNIQUE INDEX mdm_inventory_one_geops_device
  ON mdm_inventory_device(geops_device_id) WHERE geops_device_id IS NOT NULL;
CREATE INDEX mdm_inventory_customer ON mdm_inventory_device(region,customer_id,mdm_device_id);
CREATE TABLE mdm_sync_run (
  id uuid PRIMARY KEY,
  region text NOT NULL,
  customer_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text NOT NULL CHECK (outcome IN ('RUNNING','SUCCESS','FAILED')),
  device_count integer NOT NULL DEFAULT 0,
  error_code text
);
