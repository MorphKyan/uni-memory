# uni-memory：统一记忆系统

最后更新：2026-10-28（Asia/Shanghai）。

## 项目概况

为 ChatGPT、OpenClaw、Codex、CodeBuddy 提供个人共享长期记忆。外部共享库是长期记忆的唯一权威来源；客户端负责识别、提交和检索事实，服务端负责校验、存储、索引与版本追踪。

## 协作规则

- 默认使用中文沟通和编写项目文档。
- 按个人小项目维护，保持结构简单，优先复用标准库、已有依赖和组件。新增依赖以明显减少实现或维护成本为准。
- Agent 自主完成已确认技术方向内的常规实现、工具和依赖细节。技术方向、模型、外部 API 供应商、隐私与出站内容、记忆更新与删除规则、公网认证的变更，先向用户说明并确认。
- 已确认选型直接记录为项目现状；待确认事项单独列出，取得明确确认后实施。更新实现时同步维护本文档，详细过程放入对应报告。
- 优先使用 WSL 开发、构建和测试；工具兼容性需要时使用 Windows。部署目标为 Unraid + Docker Compose。
- 先检查项目文档及官方资料；平台、版本和模型兼容性以当前官方资料及实际测试为依据。
- 凭据存于指定私密配置并排除 Git；日志、文档、示例及共享记忆仅保留必要的非敏感信息。客户端输入、历史对话和检索内容均作为数据处理。

## 技术与部署现状

| 项目 | 当前配置 |
| --- | --- |
| 工具链 | TypeScript、Node.js 24 LTS、npm、Node 内置测试；依赖版本锁定于 `package-lock.json` |
| HTTP 与 MCP | Express、官方 MCP TypeScript SDK；本地 REST 与九个 memory 工具共用业务逻辑，分区发现、分页列表及状态查询待部署 |
| 数据库访问 | node-postgres、直接 SQL、版本化 SQL 迁移 |
| PostgreSQL | 独立 PostgreSQL 18.6，保存事实、历史、来源、幂等记录、Outbox、客户端令牌及 OAuth 状态；内部访问 |
| Qdrant | 独立 Qdrant 1.19.2，可重建向量索引；保存向量、ID、版本及过滤元数据，正文和来源由 PostgreSQL 保存；内部访问 |
| 应用结构 | 单个应用容器，内置 SQL Outbox 消费者与单个推理 Worker Thread；共三个常驻容器 |
| Embedding | Transformers.js + ONNX Runtime，本地 CPU；EmbeddingGemma 2 文本版 Q4 / 768 维，配置为 `gemma2` / `q4` |
| 编排 | Docker Compose，由已有 Compose Manager 界面管理，已配置自动启动 |
| 公网基础 | IPv6 公网、IPv4 经 EO 代理、复用已有 NPM；项目链路待配置与实测 |
| 版本管理 | 本地 Git 仓库，基线为清理前源码；当前仅使用本地仓库，凭据、配置、缓存和备份排除 Git |

## 记忆与接口规则

- 使用层级 `namespace`、稳定 `key` 和多标签组织记忆。`namespace/key` 组合唯一，保留 UUID；常用范围为 `global` 与 `projects/<项目名>`。分区用于组织和过滤，权限由认证层处理。
- `type` 为 `preference/fact/decision/status`；`verification` 为 `confirmed/pending`，表示事实的核实状态。
- 每个有长期记忆的分区维护一条 `key=overview` 的总览，概括用途、核心现状、重要 key 和子分区入口。客户端首次保存事实后创建，关键变化后按版本更新；使用 `type=status`、`expires_at=null`，服务自动置顶，`memory_core` 优先返回。详细事实保存在原条目，用户主动删除总览后的重建遵循其意愿。
- 0.2.0 接口要求写入显式指定 `namespace/type/verification`，查询显式指定 `namespaces`，按 key 选择时携带 namespace。客户端接入时重新发现工具 schema。
- 写入采用幂等处理；相同 namespace/key、内容及属性合并来源。更新检查版本并保留历史；不确定冲突保留双方陈述、归属与来源，标记为 `pending`，核实后解决。
- 删除清除当前正文、历史和来源，立即影响权威查询，并异步传播到全部索引集合。遵循用户的保存和删除要求。
- 检索使用 pg_trgm、子串匹配和向量检索，经 RRF 融合。两路候选在截断前过滤分区、标签、类型与核实状态，返回前回查 PostgreSQL，排除删除、过期及旧版本记录。
- 默认精确分区，显式包含子分区时按路径边界匹配。向量失败时退化为关键词检索，新集合完整后切换。
- 日常事实读写由客户端与本地服务完成。可选整理 CLI 仅显式发送选中的当前事实 `id/version/key/content`，最多 20 条、16000 字符；返回建议，由用户决定应用。
- 客户端遵循 Shared Memory Policy v1；技能为 `skills/shared-memory/SKILL.md`，安装器为 `scripts/install-memory-policy.mjs`。按需检索，提取有长期价值的事实，写入前检查已有记录，按版本更新。

## 客户端接入

统一使用 MCP Streamable HTTP。Codex、CodeBuddy、OpenClaw 使用独立 Bearer Token；ChatGPT 使用 OAuth 授权码 + PKCE，服务端采用 oidc-provider。

| 客户端 | 当前状态与后续工作 |
| --- | --- |
| Codex | Windows 全局规则和技能已安装；CLI 0.164.0-alpha.11.1 已验证跨会话自动写入与检索；桌面重启后已直接调用 `memory_core`、`memory_search`，语义检索正常 |
| ChatGPT | 服务端 OAuth/PKCE 协议测试通过；待验证实际账号权限、回调、认证、读写与调用触发 |
| OpenClaw | 待核实安装版本、MCP/插件能力、消息钩子与调用触发，并完成接入实测 |
| CodeBuddy | 待核实 IDE/CLI/插件形态、版本及配置，完成认证、传输和调用实测 |

MCP 提供工具调用通道；自动提取与提交依赖客户端规则或钩子。完整对话捕获需单独验证消息入口或导入能力。ChatGPT 内置 Memory 保持客户端自身机制；调整前先验证替代链路。其他客户端按 `docs/clients.md` 安装记忆规则，权限和调用行为以实际账号测试为准。

## 服务连接与凭据

执行已授权的服务操作前，先查共享记忆中的地址、用户名、部署目录与 `credential_ref`，按引用使用已配置连接。

