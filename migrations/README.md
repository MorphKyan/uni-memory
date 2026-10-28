# SQL 迁移

`0001_memory.sql` 创建事实、来源、历史、幂等、Outbox、索引代际、客户端令牌及 OAuth 状态表，并启用 PostgreSQL 自带 pg_trgm 扩展。

`0002_memory_partitions.sql` 增加 namespace/type/verification 和 `(namespace,key)` 唯一约束。原记录保留在 global，type=fact、verification=pending，不猜测项目归属；保留原始历史和版本。旧集合停用、索引记录清空并登记 Outbox 重建，完整后重新启用同一模型集合；期间按关键词查询。新接口不兼容旧客户端，升级后重新加载 MCP 工具。

后续添加 `0002_description.sql` 等 UTF-8 文件，按文件名顺序执行。
每个文件在同一事务内执行，不要自行添加 BEGIN/COMMIT，也不要使用要求事务外执行的语句。
已应用的文件不得修改或删除；变更通过新文件追加。

运行 `npm run build` 后设置 `DATABASE_URL`，再运行 `npm run migrate`。
迁移工具使用 PostgreSQL advisory lock 串行执行，并保存 SHA-256 校验值。
首次执行会创建工具自身的 `schema_migrations` 表，再执行尚未应用的业务迁移。服务启动也会检查和应用迁移；升级前先备份。
