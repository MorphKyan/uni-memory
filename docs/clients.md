# 四客户端接入

Codex 本机全局配置已安装，CLI 已通过 Tower HTTP MCP 的自动保存/检索测试；桌面进程需要重启读取令牌变量。其他三个客户端仍为步骤和模板，不表示账号已连通。不要关闭客户端原有记忆，直到替代链路实测通过。MCP 工具不会自动获得所有聊天，也不保证每轮触发。

## 通用配置

服务部署新版本后，重新发现 MCP 工具以使用 memory_namespaces 和 memory_list。不知道分区名称时先调用 memory_namespaces({})；浏览指定分区的全部有效记忆时使用 memory_list，保持过滤条件不变并按 next_cursor 翻页。两者沿用 memory:read，分区不隔离客户端权限；详见 [接口说明](api.md#分区发现与完整列表)。

查询记忆库概况使用 `memory_status({namespaces:["global","projects/uni-memory"]})`，沿用 `memory:read` 和现有范围过滤。记忆数量按范围统计，模型、索引和依赖状态反映整个实例；查询不会启动推理，状态是最近观测。该工具需部署本地新版本后重新发现，详见 [记忆库状态](api.md#记忆库状态)。

服务地址为 `https://memory.example.com/mcp`，使用实际域名替换。通过管理 CLI 为 Codex、CodeBuddy、OpenClaw 分别创建令牌：

```sh
docker compose exec -T app node dist/src/cli.js token-create codex memory:read,memory:write
docker compose exec -T app node dist/src/cli.js token-create codebuddy memory:read,memory:write
docker compose exec -T app node dist/src/cli.js token-create openclaw memory:read,memory:write
```

命令会一次性输出新令牌，只复制到客户端本地私密配置，不粘贴进项目文件、报告或聊天。默认 90 天有效，第三个参数可设 1–365 天；撤销使用 token-revoke ID。

## Codex

本机实际入口是 `http://192.168.1.200:3100/mcp`，使用 Windows 用户环境变量 UNI_MEMORY_TOKEN。全局 config.toml 与 AGENTS.md 已配置。初次写入新变量后要完全退出并重开桌面应用；单独打开新聊天可能仍使用旧进程环境。以下 HTTPS 模板用于后续公网部署。

官方支持 Streamable HTTP 和环境变量 Bearer Token。将新令牌放入启动 Codex 进程可读取的 `UNI_MEMORY_TOKEN` 环境变量，再把以下模板合并进本机 Codex 配置：

```toml
[mcp_servers.uni_memory]
url = "https://memory.example.com/mcp"
bearer_token_env_var = "UNI_MEMORY_TOKEN"
```

重启客户端，检查工具发现并以合成事实执行写入、读取和删除。[官方 MCP 文档](https://developers.openai.com/codex/mcp)

## CodeBuddy

在所用 CLI/IDE 的 MCP 设置中添加 HTTP 服务器，URL 填上面的 `/mcp`，请求头为 `Authorization: Bearer YOUR_LOCAL_TOKEN`。不同版本的 CLI/IDE 设置位置与可用传输可能不同，以下是结构示意，需在本机 MCP 设置中确认支持后保存，不能直接提交含真实令牌的文件：

```json
{
  "mcpServers": {
    "uni_memory": {
      "type": "http",
      "url": "https://memory.example.com/mcp",
      "headers": {"Authorization": "Bearer YOUR_LOCAL_TOKEN"}
    }
  }
}
```

若客户端提供环境变量或私密凭据存储，优先使用。官方页面本轮抓取返回 502，故配置位置与变量插值语法不做未经验证的断言。[CLI 文档](https://www.codebuddy.ai/docs/cli/mcp)、[IDE 文档](https://www.codebuddy.ai/docs/ide/User-guide/MCP)

## OpenClaw

优先使用安装版本的 outbound MCP 设置，添加 `/mcp` HTTP URL 和该客户端独立的 Bearer Token。先运行本机 `openclaw mcp --help` 检查已安装功能；如安装版本使用 MCPorter，可按其配置文档添加服务器。不要把 OpenClaw 作为 MCP 服务器对外提供会话的功能与这里的“消费共享记忆服务”混淆。

按当前 MCPorter 配置格式，可在本机私密配置中添加：

```json
{
  "mcpServers": {
    "uni_memory": {
      "baseUrl": "https://memory.example.com/mcp",
      "headers": {"Authorization": "Bearer YOUR_LOCAL_TOKEN"}
    }
  }
}
```

是否能在每轮后自动提交，需要另行核实当前版本的插件/消息钩子。首版提供工具及使用指令，不承诺已经安装自动捕获钩子。[OpenClaw MCP](https://docs.openclaw.ai/mcp)、[MCPorter 配置](https://github.com/openclaw/mcporter/blob/main/docs/config.md)

## ChatGPT

1. 确认当前账号能够添加自定义 MCP，且能够使用读写工具；实际权限以账号界面为准。
2. 设置 PUBLIC_URL 为公开 HTTPS 域名，配置 NPM。使用 ChatGPT 当前界面提供的准确 OAuth 回调 URL。
3. 在 `.env` 的 `OAUTH_CLIENTS_JSON` 中预注册客户端。示例：`[{"client_id":"chatgpt-personal","redirect_uris":["https://chatgpt.com/connector_platform_oauth_redirect"],"token_endpoint_auth_method":"none"}]`。回调地址必须与实际界面完全一致；如果界面要求 confidential client，生成至少 32 字符 client_secret 并改用 client_secret_post 或 client_secret_basic。
4. 重建应用容器使配置生效，在 ChatGPT 中填写 MCP URL 与预注册的客户端信息。访问授权页面，使用 `.secrets/owner-password` 中的个人口令登录并明确授权。
5. 服务提供 OAuth protected resource metadata 与 `/oauth/.well-known/oauth-authorization-server`，要求 PKCE S256，不开放动态客户端注册。
6. 使用合成事实验证 tools/list、写入、读取、纠正和删除，再使用私人记忆。

API Access Token 有效期 1 小时，Refresh Token 最长 14 天并轮换，个人会话 1 天。预注册客户端、grant 和 token 状态落 PostgreSQL；撤销授权命令 oauth-revoke GRANT_ID。授权范围只支持 memory:read/memory:write，管理权限不通过 ChatGPT 授予。

[OpenAI 官方认证说明](https://developers.openai.com/plugins/build/auth)

## 客户端记忆使用指令

默认规则采用 [Shared Memory Policy v1](shared-memory-policy.md)，MCP 初始化 instructions 和工具描述均提供相应规则。客户端仍须遵循指令，不能保证每轮自动调用。0.2.0 必须重新发现工具定义，不支持旧客户端缺字段的调用。

Codex 本机安装规则与 [shared-memory 技能](../skills/shared-memory/SKILL.md)：

```sh
npm run memory:install
# 也可指定另一 Codex 配置目录：
node scripts/install-memory-policy.mjs --codex-home /path/to/.codex
```

默认目标为 CODEX_HOME，未设置时使用用户目录下 `.codex`。安装器仅替换 AGENTS.md 内本项目的 uni-memory 标记块，保留其他指令，并在内容变化时备份原文件；技能安装到 `skills/shared-memory/SKILL.md`。重复执行不会重复添加规则；同名非本项目技能会拒绝覆盖。

重开 Codex 会话使新技能、规则和 MCP schema 一起加载。项目讨论传 `namespaces:["global","projects/uni-memory"]` 等明确范围；写入必须提供 namespace/type/verification。

其他客户端将 policy 文档放入各自支持的个人指令或项目规则；支持 SKILL.md 的客户端可以复制 shared-memory 技能目录。未验证其他客户端的技能加载位置与自动触发，不自动修改它们的配置。
