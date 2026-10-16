CREATE TABLE mdm_integration (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  region text NOT NULL,
  customer_id text NOT NULL,
  status text NOT NULL,
  encrypted_refresh_token bytea,
  token_iv bytea,
  token_tag bytea,
  token_key_version integer,
  scopes text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,region,customer_id)
);