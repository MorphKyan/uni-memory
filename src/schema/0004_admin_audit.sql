CREATE TABLE admin_password (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  password_hash text NOT NULL
);

ALTER TABLE client_tokens ADD COLUMN version integer NOT NULL DEFAULT 1;

CREATE TABLE request_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  channel text NOT NULL,
  route text NOT NULL,
  method text NOT NULL,
  status integer,
  duration_ms integer NOT NULL,
  client_id text,
  token_id uuid,
  rpc_method text,
  tool text,
  outcome text NOT NULL,
  details jsonb NOT NULL
);
CREATE INDEX request_audit_time ON request_audit (started_at, id);
