# uni-memory

面向 ChatGPT、OpenClaw、Codex、CodeBuddy 的个人共享记忆项目。选型与约束见 [AGENTS.md](AGENTS.md)。

客户端模型通过 MCP 查询、提交事实；服务端提供版本、来源、幂等、冲突保护、删除、混合检索和可重建索引。日常读写不调用外部生成 API。

0.2.0 支持逻辑分区和层级 namespace、稳定 key、多标签、记忆类型和核实状态；底层共用数据库与同一模型的向量集合。写入必须指定 namespace/type/verification，查询必须指定 namespaces，不兼容旧接口。规则见 [Shared Memory Policy v1](docs/shared-memory-policy.md)，配套 [shared-memory 技能](skills/shared-memory/SKILL.md) 可用 `npm run memory:install` 安装到本机 Codex。

## 启动

每个分区使用 `key=overview` 保存总览记忆，客户端维护用途、现状和重要记忆入口；服务自动置顶，`memory_core` 优先返回。读写约定见 [分区总览](docs/api.md#分区总览)。

Tower 已提供 `memory_namespaces` 发现有效分区及直属数量，`memory_list` 按游标分页浏览指定范围内的全部当前有效记忆；支持现有分区、标签、类型和核实状态过滤。REST/MCP 用法见 [分区发现与完整列表](docs/api.md#分区发现与完整列表)，客户端重新发现工具后可使用。

`memory_status` 查询指定范围的有效、待核实、置顶和过期记忆数量，以及整个实例的数据库、Qdrant、模型、索引与检索状态；对应 `GET /v1/status`，查询不触发模型加载或推理。用法与状态含义见 [记忆库状态](docs/api.md#记忆库状态)，已部署 Tower。

要求 Node.js 24 LTS 和 npm，支持在 WSL/Linux 下开发。

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm ci
npm run init
npm test
docker compose up -d --build
```

默认访问 `http://127.0.0.1:3000/healthz`；`/readyz` 检查数据库和 Qdrant。Compose 只启动应用、PostgreSQL、Qdrant 三个常驻容器。配置及生成的密钥保存在本地忽略文件中，不要上传。

管理令牌按客户端分别生成，命令仅一次输出新令牌，请存到本机私密配置：

```sh
docker compose exec -T app node dist/src/cli.js token-create codex memory:read,memory:write
```

## 极简 MCP 安装（Codex）

Tower 已部署：`http://192.168.1.200:3100/mcp`；本机已配置。其他机器先在 Tower 终端生成该客户端独立令牌：

```sh
cd /mnt/cache/appdata/uni-memory
docker compose exec -T app node dist/src/cli.js token-create codex-other memory:read,memory:write
```

然后在 Windows PowerShell 执行（令牌仅填在本机，不发送到聊天）：

```powershell
[Environment]::SetEnvironmentVariable('UNI_MEMORY_TOKEN', '粘贴新令牌', 'User')
codex mcp add uni_memory --url http://192.168.1.200:3100/mcp --bearer-token-env-var UNI_MEMORY_TOKEN
```

完全退出并重开 Codex。需要主动识别记忆时，将 [记忆使用指令](docs/clients.md#客户端记忆使用指令) 加入客户端个人规则；本机全局规则已安装。HTTP 只用于当前局域网，公网接入使用 HTTPS。令牌默认 90 天，到期前重新签发并更新环境变量。

## 文档与验证

- [接口与事实规则](docs/api.md)
- [四客户端接入及记忆使用指令](docs/clients.md)
- [Unraid/NPM 部署、模型、备份恢复与管理](docs/operations.md)
- [Tower 已部署的位置、界面管理与验收](docs/unraid.md)
- [SQL 迁移](migrations/README.md)
- [模型配置与对比方法](docs/operations.md#模型与对比)
- [最新部署与记忆验收](docs/deployment-2026-10-28.md)

`npm test` 执行构建与单元测试；`bash scripts/test-integration.sh` 运行独立 Compose 项目的真实数据库、Qdrant、REST/MCP 与 OAuth 测试；`npm run benchmark` 对比三个 CPU 模型。

**已选 EmbeddingGemma 2 文本版 Q4 / 768 维**，初始化和模板配置为 EMBEDDING_MODEL=gemma2、EMBEDDING_DTYPE=q4，本机已启用。显式清空模型时保留事实读写和关键词检索，普通向量任务等待，索引删除仍然处理。可选 SenseNova 整理默认关闭，启用后只能从管理 CLI 显式发送选定事实，不自动改写。

Tower 已通过 Compose Manager 部署最新源码 0ea98d1，九个 MCP 工具与真实模型检索实测通过；记忆同步后共 34 条有效条目，全部版本已索引。本机 Codex CLI 已实测，客户端重新连接并发现工具。NPM/EO、公网 OAuth 和其他三个客户端账号仍待接入。外部整理模型及密钥需自行配置；不读取或上传完整私人聊天。具体测试结果和限制见[最新验收记录](docs/deployment-2026-10-28.md)。
