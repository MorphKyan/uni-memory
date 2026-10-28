-- 旧条目原样保留在 global，不从正文推断项目或核实状态。旧历史保留原始快照。
ALTER TABLE memories
  ADD COLUMN namespace text NOT NULL DEFAULT 'global',
  ADD COLUMN type text NOT NULL DEFAULT 'fact',
  ADD COLUMN verification text NOT NULL DEFAULT 'pending';
ALTER TABLE memories
  DROP CONSTRAINT memories_key_key,
  ADD CONSTRAINT memories_namespace_key_unique UNIQUE(namespace,key),
  ADD CONSTRAINT memories_namespace_valid CHECK (length(namespace)<=160 AND namespace ~ '^[a-z0-9][a-z0-9_-]*(/[a-z0-9][a-z0-9_-]*)*$'),
  ADD CONSTRAINT memories_type_valid CHECK (type IN ('preference','fact','decision','status')),
  ADD CONSTRAINT memories_verification_valid CHECK (verification IN ('confirmed','pending')),
  ALTER COLUMN namespace DROP DEFAULT,
  ALTER COLUMN type DROP DEFAULT,
  ALTER COLUMN verification DROP DEFAULT;

-- 保持同一模型集合；在新 payload 完整前退化到带分区过滤的关键词查询。
UPDATE index_generations SET active=false;
DELETE FROM index_entries;
INSERT INTO index_jobs(memory_id) SELECT id FROM memories
  ON CONFLICT(memory_id) DO UPDATE SET attempts=0,failed=false,error_code=NULL,available_at=now();
