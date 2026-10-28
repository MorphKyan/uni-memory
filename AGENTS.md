# uni-memory：统一记忆系统

最后更新：2026-10-28（Asia/Shanghai）。

## 项目概况

为 ChatGPT、OpenClaw、Codex、CodeBuddy 提供个人共享长期记忆。外部共享库是长期记忆的唯一权威来源；客户端负责识别、提交和检索事实，服务端负责校验、存储、索引与版本追踪。

首版已实现，Tower 已部署 0.2.0，局域网 MCP 与本机 Codex CLI、桌面工具调用已通过实测。本地后续代码清理已通过构建和测试，待部署 Tower。

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
| Tower | Unraid 6.12.11、x86_64、i7-4790、16 GB 内存；部署目录 `/mnt/cache/appdata/uni-memory` |
| 编排 | Docker Compose，由已有 Compose Manager 界面管理，已配置自动启动 |
| 本机 MCP | `http://192.168.1.200:3100/mcp`，独立 Bearer Token；应用绑定该 LAN 地址，允许私网 HTTP，局域网配置关闭 OAuth；公网接入使用 HTTPS |
| 公网基础 | IPv6 公网、IPv4 经 EO 代理、复用已有 NPM；项目链路待配置与实测 |
| 备份 | PostgreSQL 与配置保留 14 天，Tower User Scripts 每日 03:10 执行；Qdrant 从事实重建；备份到期前可能保留已删除内容 |
| 版本管理 | 本地 Git 仓库，基线为清理前源码；当前仅使用本地仓库，凭据、配置、缓存和备份排除 Git |
| 可选整理 API | `https://token.sensenova.cn/v1`，OpenAI Compatible Chat Completions；默认关闭，模型和密钥通过环境变量配置 |

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

Windows 私密文件为 `%USERPROFILE%\.codex\private-services\credentials.json`，以 `credential_ref` 为键，受独立 ACL 保护。仅在执行进程内读取目标条目并使用，凭据保持在私密配置与进程内部。Tower 复用已有 SSH 密钥，uni-memory 复用 `UNI_MEMORY_TOKEN` 环境变量。

SSH 保持主机指纹验证；HTTP 凭据仅发送至确认的服务地址。连接缺失、失效或不可达时，请用户在本机私密文件补充。共享记忆不可用时，Tower 恢复入口见 `docs/service-access.md`。

## 验证状态与待办

- 记忆库状态：本地新增 memory_status 与 GET /v1/status，沿用 memory:read 和范围过滤；记忆数量按范围统计，依赖、模型、索引任务及版本覆盖率反映整个实例。Worker 上报加载与推理状态，查询不触发推理；无新增依赖或数据库迁移，不添加变化日志。WSL Docker Node.js 24.22.1 构建、17 项单元测试及 21 项真实 PostgreSQL/Qdrant 集成测试通过，涵盖范围过滤、有效期、索引版本、九个 MCP 工具、权限和依赖失败；模型生命周期状态使用合成结果及真实线程未使用/退出验证，未重新运行真实模型推理。Tower 待部署，说明见 docs/api.md。

- 分区发现与完整列表：本地新增 memory_namespaces（可按父路径发现有效分区及直属数量）和 memory_list（复用过滤、按创建时间和 ID 游标分页）；REST/MCP 共用 PostgreSQL 查询，无新增依赖、无分区权限隔离。WSL Docker Node.js 24.22.1 构建、13 项单元测试、20 项真实 PostgreSQL/Qdrant 集成测试通过，涵盖 105 条事实分页、微秒游标、编辑/删除、过滤与八个 MCP 工具发现；复用已安装依赖的测试镜像并挂载当前源码、配置与测试，npm ls 校验直接依赖版本通过。Tower 部署待完成，接口说明见 docs/api.md。

- 分区总览：本地已实现自动置顶、长期有效期校验、core 优先返回及客户端维护规则；WSL Docker Node.js 24.22.1 构建、12 项单元测试、19 项真实 PostgreSQL/Qdrant 集成测试通过。本机 Codex 规则和技能已更新，Tower 部署与既有分区总览补建待完成。
- 本地：WSL Ubuntu、Node.js 24.22.1 下构建、11 项单元测试、18 项真实 PostgreSQL/Qdrant 集成测试通过。最新清理涵盖事务复用、key 的 NFKC 规范化、索引任务原子登记及真实 CLI 重试验证。
- Tower：已备份并升级至 0.2.0，保留 28 条原记忆，完成过滤 payload 重建；实际 MCP、Gemma 2 CPU、分区、跨语言检索、冲突历史及备份恢复验收通过，合成验收事实已清理。
- 数据迁移：旧记录采用 `global/type=fact/verification=pending`，保留 UUID、key、正文、来源、版本和历史。
- 模型：2026-10-27 23:36 WSL 测试 Recall@5 100%，查询中位 42.41 ms、P95 52.89 ms、缓存冷启动 3343 ms。报告区分测试设备、模型资源、容器大小和运行内存；Tower 性能与资源预算待量化。
- 本机凭据：JSON、ACL、全局规则保留、引用式 SSH 与认证 MCP 只读检查通过，详见 `docs/service-access.md`。
- 后续：部署本地清理版本；完成 HTTPS 域名、NPM 网络和 EO 链路；接入其他三个客户端；验证 Tower 整机开机恢复。可选整理 API 的模型及凭据待用户配置。

## 详细文档

- `README.md`：项目说明与使用入口。
- `docs/unraid.md`：Tower 部署与运维。
- `docs/clients.md`：客户端接入与规则。
- `docs/service-access.md`：服务通讯录、私密凭据与恢复入口。
- `docs/operations.md`：备份恢复与日常运维。
- `docs/api.md`：接口说明。
- `docs/shared-memory-policy.md`：共享记忆规则。
