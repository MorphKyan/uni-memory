ALTER TABLE memories ADD COLUMN device_tags text[] NOT NULL DEFAULT '{}';

UPDATE memory_events SET snapshot=jsonb_set(snapshot,'{device_tags}','[]');
UPDATE idempotency SET result=jsonb_set(result,'{memory,device_tags}','[]')
  WHERE jsonb_typeof(result->'memory')='object';
