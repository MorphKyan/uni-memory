# uni-memory

uni-memory 为多个客户端提供共享长期记忆。应用通过 REST 和 Streamable HTTP MCP 提供同一套记忆操作，并提供 Vue 管理台。Docker Compose 运行应用、PostgreSQL 和 Qdrant。

## 协作规则

- 默认使用中文。优先复用标准库、已有依赖和组件，优先在 WSL 中开发、构建和测试。
- 修改接口或记忆策略时，同步检查 REST、MCP、管理台、CLI、Skill、Plugin、安装器、模板和文档，并验证实际生成或安装的产物。
- 改动技术方向、模型、外部 API 供应商、隐私与出站内容、记忆更新或删除规则、公网认证前，先确认。
- 文档描述项目功能、配置和使用方式。部署地址、凭据、实例目录和运行记录保存在私密配置或共享记忆中。
- 记忆操作遵循 [共享记忆策略](docs/shared-memory-policy.md)。执行已授权的服务操作时，按 [服务连接策略](docs/service-access-policy.md) 使用私密凭据。

## 实现

- TypeScript、Node.js 24 LTS、Express 和 MCP TypeScript SDK。管理台使用 Vue、Vite 和同源 Cookie 会话。
- PostgreSQL 保存正文、来源、版本和任务。Qdrant 保存可重建向量索引。检索融合关键词和向量结果，返回前回查 PostgreSQL。
- 默认在本地 CPU 使用 EmbeddingGemma 2 文本版 Q4，向量为 768 维。可选整理功能通过配置的 Chat Completions 接口处理明确选中的事实。

## 项目说明

- [安装](README.md)
- [接口](docs/api.md)和[管理台](docs/admin-ui.md)
- [客户端接入](docs/clients.md)、[插件](docs/chatgpt-plugin.md)与[启动 Hook](docs/hooks.md)
- [部署与运维](docs/operations.md)
