CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE memories (
  id uuid PRIMARY KEY,
  key text UNIQUE,
  content text,
  tags text[] NOT NULL DEFAULT '{}',
  pinned boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((deleted_at IS NULL AND key IS NOT NULL AND content IS NOT NULL)
    OR (deleted_at IS NOT NULL AND key IS NULL AND content IS NULL))
);
CREATE INDEX memories_content_trgm ON memories USING gin(content gin_trgm_ops);
CREATE TABLE memory_sources (
  memory_id uuid NOT NULL REFERENCES memories(id),
  client_id text NOT NULL,
  reference text NOT NULL,
  excerpt text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(memory_id, client_id, reference, excerpt)
);
CREATE TABLE memory_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  memory_id uuid NOT NULL REFERENCES memories(id),
  version integer NOT NULL,
  client_id text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE idempotency (
  client_id text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  memory_id uuid REFERENCES memories(id),
  result jsonb NOT NULL,
  PRIMARY KEY(client_id, key)
);
CREATE TABLE index_jobs (
  memory_id uuid PRIMARY KEY REFERENCES memories(id),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  failed boolean NOT NULL DEFAULT false,
  error_code text
);
CREATE TABLE index_generations (
  name text PRIMARY KEY,
  model text NOT NULL,
  dtype text NOT NULL,
  dimensions integer NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_active_generation ON index_generations(active) WHERE active;
CREATE TABLE index_entries (
  generation text NOT NULL REFERENCES index_generations(name) ON DELETE CASCADE,
  memory_id uuid NOT NULL REFERENCES memories(id),
  version integer NOT NULL,
  PRIMARY KEY(generation, memory_id)
);
CREATE TABLE client_tokens (
  id uuid PRIMARY KEY,
  client_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE oauth_state (
  model text NOT NULL,
  id text NOT NULL,
  payload jsonb NOT NULL,
  expires_at timestamptz,
  grant_id text,
  uid text,
  user_code text,
  PRIMARY KEY(model, id)
);
CREATE INDEX oauth_grants ON oauth_state(grant_id);
CREATE INDEX oauth_uid ON oauth_state(uid);
CREATE INDEX oauth_code ON oauth_state(user_code);
