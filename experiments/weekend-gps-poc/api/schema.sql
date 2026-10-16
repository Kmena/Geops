CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE IF NOT EXISTS poc_invitation (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL CHECK (environment_id = 'weekend-gps-poc-v1'),
  secret_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS poc_device (
  id uuid PRIMARY KEY,
  environment_id text NOT NULL CHECK (environment_id = 'weekend-gps-poc-v1'),
  token_hash text NOT NULL UNIQUE,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS poc_location (
  device_id uuid NOT NULL REFERENCES poc_device(id),
  event_id uuid NOT NULL,
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  geom geography(Point,4326) NOT NULL,
  accuracy_m double precision NOT NULL CHECK (accuracy_m > 0 AND accuracy_m <= 10000),
  digest text NOT NULL,
  PRIMARY KEY (device_id,event_id)
);
CREATE INDEX IF NOT EXISTS poc_location_capture_idx ON poc_location (device_id,captured_at DESC);
CREATE INDEX IF NOT EXISTS poc_location_received_idx ON poc_location (received_at);
