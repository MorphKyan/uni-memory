# 首版验收记录

日期：2026-10-27。实现范围为用户批准的完整首版方案；使用合成数据，没有接入真实私人聊天或外部生成 API 凭据。

## 已通过

环境为 WSL Ubuntu x86_64、Node.js 24.22.1、Docker Compose，实际 PostgreSQL 18.6 和 Qdrant 1.19.2。TypeScript 构建通过，依赖版本锁定于 package-lock.json。

| 验收项 | 结果与证据 |
| --- | --- |
| 单元测试 | `npm test`，9 项通过：健康检查、SDK 实例、配置、迁移提交/回滚及篡改检查、scrypt/权限、限流、输入与 RRF |
| 真实数据组件集成 | `node scripts/test-local.mjs`，11 项通过；同套集成测试也曾在测试镜像内运行通过 |
| 跨客户端事实与并发 | 来源身份由认证确定、幂等重放/不一致拒绝、相同事实合并来源、纠正历史、版本冲突及并发创建保护通过 |
| 查询与删除 | 核心置顶、过期过滤、关键词降级、旧向量版本过滤；删除即时排除并清除正文/历史/来源/幂等正文，传播到全部注册集合；推理期间删除不会复活通过 |
| SQL Outbox | 真实 Qdrant 写入、故障退避/手动重试、消费者重新实例化恢复、全量重建和模型集合切换通过 |
| MCP | 官方 SDK 客户端通过真实 HTTP 初始化、发现六个工具、调用读写、权限隔离 |
| 认证与边界 | 客户端令牌哈希、过期/撤销、Host/Origin、请求大小、明显凭据拒绝和限流通过 |
| OAuth | 实际授权页面/登录、CSRF、授权码和 PKCE（含错误 verifier）、码重放拒绝、资源与回调限制、刷新轮换、授权撤销通过 |
| 可选整理 API | 模拟 OpenAI Compatible 服务验证成功、错误、超时、非法响应、未知来源 ID、默认禁用及仅发送明确选中事实；建议不自动写库 |
| 实际模型链路 | `node scripts/model-smoke.mjs` 显式 E5 Q8 CPU 推理、真实 Qdrant、跨语言混合检索及权威版本回查通过 |
| 三模型对比 | E5 Q8、BGE Q8、Gemma 2 文本 Q4 全部实际加载并完成同一测试集，见[报告](embedding-comparison.md) |
| 备份恢复 | `node scripts/test-recovery.mjs` 调用实际备份/恢复脚本：备份后新增事实被回滚、原事实恢复、旧向量集合清空、重建任务登记通过 |
| Compose | 多阶段镜像构建及三个服务启动通过，应用存活/依赖就绪通过；数据库无宿主机发布端口，应用只绑定本机 |
| 操作与客户端文档 | REST/MCP 规则、四客户端分别配置、OAuth 预注册、使用指令、NPM 网络、凭据管理、备份恢复和重建说明已提供 |

备份以 PostgreSQL、配置和签名密钥为恢复依据；14 天保留策略在运行备份脚本时执行。后续 Tower 部署已配置 User Scripts 每日 03:10 定时任务并通过首次备份。删除过的内容仍可能存在于保留期内旧备份，恢复旧备份可能重新引入它们。

## 2026-10-28 分区与 Shared Memory Policy v1

WSL Ubuntu、Node.js 24.22.1 下构建通过，11 项单元测试和 15 项真实 PostgreSQL/Qdrant 集成测试通过。新增验证包括：

- 写入必须显式 namespace/type/verification；查询必须显式 namespaces；按 key 读取必须提供 namespace。
- 同 key 在不同分区独立保存；global 与项目联合查询；精确范围、子分区边界和相似前缀排除；多标签 AND、type 和 verification 过滤。
- 待核实冲突保留双方内容、来源和旧版本；陈旧版本不覆盖，核实后按当前版本更新。
- 原表升级保留正文、来源、UUID、版本和历史，旧索引停用并登记重建；迁移可重复运行。
- 110 条更相似的其他分区向量不会挤掉目标分区结果；向量层级/标签/类型/核实状态过滤与数据库最终回查通过。
- 真实 MCP 初始化返回默认策略，新工具声明必填字段；规则安装保留其他指令、可重复执行，并拒绝覆盖不属于项目的同名技能。

shared-memory 技能通过 skill-creator 的 quick_validate.py；Windows Codex 全局 AGENTS.md 规则块及技能已安装。MCP 默认规则和客户端技能不保证每轮自动调用。此次未新增依赖、容器或外部出站字段。

真实备份/恢复复测通过，覆盖新增必填字段的备份后写入和恢复。Tower 已备份并升级应用镜像至 uni-memory:0.2.0，保留 28 条原记忆；原模型集合完成 payload 重建。实际 HTTP MCP + Gemma 2 验收通过，覆盖新策略和字段、跨分区同 key、层级范围、多属性过滤、跨语言检索、冲突版本与来源；两条合成事实已清理。详见 [Tower 部署记录](../docs/unraid.md)。

Tower 本机从更新后的 Dockerfile 构建独立 partition-test 镜像，容器内 11 项单元测试通过，包含规则安装测试所需策略文档与技能文件。最终检查：应用与 PostgreSQL healthy，索引任务 0，活动集合 1；28 条原记忆及 1 条用户确认的新项目组织决定有效，新决定保存于 projects/uni-memory 分区。没有留下有效的合成验收记忆。

## 环境侧待验证

| 项目 | 当前状态 |
| --- | --- |
| 生产 embedding | 已选 Gemma 2 文本版 Q4 / 768 维，初始化、模板及本机配置已应用；真实 CPU → Qdrant → 跨语言检索通过，Unraid 性能待实测 |
| SenseNova 真实服务 | 未配置 LLM_MODEL / LLM_API_KEY，未调用真实供应商；兼容性由模拟服务验证 |
| Unraid / NPM / EO | Tower 已通过 Compose Manager 部署、模型及 HTTP MCP 验收，见 [部署记录](../docs/unraid.md)；HTTPS/NPM/EO 尚未配置，整机重启恢复未测试 |
| ChatGPT 账号连接 | 未实测；已实现 OAuth + PKCE 和配置指引，账号工具权限、实际回调和调用行为待验证 |
| Codex 账号连接 | 本机配置已安装，CLI 两个独立会话通过自动保存/检索测试；桌面进程需重启读取环境变量，合成事实已清理 |
| CodeBuddy 账号连接 | 未实测；已提供独立 Bearer Token MCP 配置示例 |
| OpenClaw 账号连接 | 未实测；已提供 MCP 配置与插件/版本核实指引 |
| 每轮自动捕获 | Codex 自然表达触发保存与独立会话检索已通过；依赖客户端模型与使用指令，不保证每轮调用，不获取所有聊天 |

## 复现与空间处理

`npm test`；`bash scripts/test-integration.sh` 为容器内集成入口。WSL 复用已安装依赖时可用 `node scripts/test-local.mjs`。恢复测试只对 `uni-memory-test` 项目执行，生产库不作为测试目标。模型与恢复测试要求先启动专用测试数据库和 Qdrant。

本轮曾因 C 盘空间不足中断。已清理 npm 下载缓存、项目临时解包和下载归档，并对 WSL 稀疏盘执行 trim；保留项目、数据库卷、模型缓存及用户其他容器。恢复开发时 C 盘约 3.9 GiB 可用，后续构建仍需留意容量。
