-- 移除核实属性，保留事实、来源、版本及其余历史快照。
ALTER TABLE memories DROP COLUMN verification;
UPDATE memory_events SET snapshot=snapshot-'verification' WHERE snapshot ? 'verification';
UPDATE idempotency SET result=jsonb_set(result,'{memory}',(result->'memory')-'verification')
  WHERE jsonb_typeof(result->'memory')='object' AND (result->'memory') ? 'verification';

-- 重新写入 payload，完整前使用关键词检索。
UPDATE index_generations SET active=false;
DELETE FROM index_entries;
INSERT INTO index_jobs(memory_id) SELECT id FROM memories
  ON CONFLICT(memory_id) DO UPDATE SET attempts=0,failed=false,error_code=NULL,available_at=now();
