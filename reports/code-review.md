# 代码审查与精简（2026-10-28）

按个人单实例服务的实际用途审查 src、管理和验证脚本、迁移、测试、构建及部署配置。未新增依赖，未改变记忆更新/删除规则、模型选择或出站内容。

## 已处理

| 问题 | 修改 |
| --- | --- |
| OAuth 初始化失败后，已创建的推理线程阻止进程退出 | 启动失败路径关闭线程；新增子进程回归测试，修复前 15 秒超时，修复后正常以状态 1 退出 |
| localhost 例外允许 ftp/file/ws 等非 HTTP 地址 | OAuth 回调及整理 API 明确限制为 HTTPS 或本机 HTTP，补充拒绝测试 |
| 迁移和事实操作重复实现事务与回滚 | 事务集中到 db.ts，复用原有回滚失败时丢弃连接的保护 |
| 写入历史快照和返回结果重复读取来源 | 同一次查询结果用于快照和返回，并验证来源合并、历史及当前事实一致 |
| 无意义包装及测试专用运行分支 | 删除 text、hashToken、namespacePaths；内联 snapshot、Indexer.ensure；删除空 MCP 工厂分支及对应空壳测试 |
| 无效字段及导出 | 删除 Config.dtype、EmbeddingWorker.name 实例字段和 TEST_DATABASE 环境变量；identifier、enqueue 改为模块内部使用 |
| 删除源码后旧编译结果仍执行 | npm build 前清理 dist；删除的 MCP 空壳测试不再残留执行 |
| 测试文件进入生产镜像 | 生产阶段只复制 dist/src；保留独立测试阶段 |
| 新的未使用变量容易积累 | 启用 TypeScript noUnusedLocals/noUnusedParameters；未新增检查依赖 |

单行方法不按行数机械删除：OAuth Adapter 的 find/destroy 等属于 SDK 契约；requireScope、collectionName、sources、retry 和 close 分别承担共享校验、集合标识、查询复用和资源生命周期。保留这些方法，避免把同一规则复制到调用方。Express 路由回调及构造函数也保留。

## 验证

- WSL Ubuntu，独立 Node.js 24.22.1：`npm test`，构建及 11 项单元测试通过。
- `node scripts/test-local.mjs`：独立 uni-memory-test PostgreSQL/Qdrant 的 16 项集成测试通过，包含 REST/MCP、OAuth/PKCE、权限、并发、旧数据迁移、来源/历史、删除传播、索引失败恢复与模型集合切换。
- `docker build -t uni-memory:review-local .` 成功；禁用外部网络的临时容器中加载运行模块、验证 healthz 返回 200，并确认运行入口存在，dist/test、.env、.secrets 均不存在。
- `git diff --check` 通过。

Git 基线为 `ba61551`，仅保存在本机。源码、合成测试和文档纳入版本管理；真实 .env、.secrets、模型缓存与数据库备份由忽略规则排除。

此次未部署 Tower，未重跑真实模型性能对比、备份恢复或公网客户端接入。索引、来源和事务重构已在专用数据组件上验证；部署后的硬件与外部链路行为仍按原验收范围处理。
