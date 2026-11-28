# 客户端接入

uni-memory 使用 Streamable HTTP MCP。客户端配置指向服务的 `/mcp` 路径，可使用 Bearer Token 或 OAuth 授权码与 PKCE 认证。

## Bearer Token 与 OAuth 基础

为每个客户端生成独立令牌：

```sh
docker compose exec -T app node dist/src/cli.js token-create my-client memory:read,memory:write
```

在客户端的 MCP 设置中添加服务入口，通过私密配置发送 `Authorization: Bearer` 请求头。令牌默认有效 90 天。

如需 OAuth，设置服务的 HTTPS 入口、`OAUTH_ENABLED=true` 和私密 `DEPLOYMENT_TOKEN`，在 `OAUTH_CLIENTS_JSON` 中登记客户端 ID、回调地址及认证方式。公有客户端使用 `token_endpoint_auth_method: "none"`。本机原生客户端需要动态回调端口时，可用 `application_type: "native"` 登记 IP loopback 回调。

客户端从 `/.well-known/oauth-protected-resource/mcp` 和 `/.well-known/oauth-authorization-server/oauth` 发现授权服务器，用 `response_type=code`、PKCE `S256` 和指向服务 `/mcp` 的 `resource` 发起授权。授权时在 uni-memory 页面输入部署令牌并确认权限。换码时，客户端将授权码、`code_verifier`、原 `redirect_uri` 和 `resource` 提交到令牌端点。需要刷新时请求 `offline_access`，每次刷新使用新返回的刷新令牌。

## 内网优先，公网回退

Codex、CodeBuddy 和 Antigravity 可以共用本地 stdio 启动器。仓库需已运行 `npm ci`。为启动器进程通过私密环境提供 `UNI_MEMORY_TOKEN`，令牌应允许访问同一 uni-memory 实例的两个入口。

下面示例的脚本路径、域名、内网 IP 和端口需换成实际部署值。Windows 可用 `D:/path/to/uni-memory/scripts/mcp-fallback.mjs` 格式。内网端口默认 443，必须提供与公网域名匹配的可信 HTTPS 证书。

启动器每次启动只发送一次无凭据的内网 `/readyz` 探测，等待最多 250 ms，随后沿用选中的入口。切换网络后，重新启动 MCP 子进程即可重新探测。已经发送的 MCP 请求不会跨入口重发。OAuth 继续通过客户端的远程 HTTPS 配置接入。

## Codex

- **MCP 配置**：在 `~/.codex/config.toml` 配置 `[mcp_servers.uni_memory]`，使用 `url` 与 `bearer_token_env_var`（或 OAuth）。
- **规则、Skill 与 Hook**：使用 `skills/shared-memory/SKILL.md` 与 `hooks/hooks.json`（支持 `SessionStart` 与 `SubagentStart`），通过 `node scripts/install-memory-policy.mjs --client codex` 安装，或用 `npm run plugin:build:agent -- --output /new/path/uni-memory-agent` 生成 `.codex-plugin`。详见 [Hook 说明](hooks.md)。

启用回退时，在 `config.toml` 中替换该 MCP 的连接定义。

```toml
[mcp_servers.uni_memory]
command = "node"
args = [
  "/path/to/uni-memory/scripts/mcp-fallback.mjs",
  "--public-url", "https://memory.example.com/mcp",
  "--lan-address", "192.168.1.10",
  "--lan-port", "8443",
]
env_vars = ["UNI_MEMORY_TOKEN"]
```

## CodeBuddy

- **MCP 配置**：在 CodeBuddy 私密 MCP 配置中指向服务 `/mcp` 并配置 Bearer Token。
- **规则、Skill 与 Hook**：使用 `skills/shared-memory/SKILL.md` 与 `hooks/hooks.json`（合并到 `settings.json`），在核实版本支持后通过 `node scripts/install-memory-policy.mjs --client codebuddy --hooks on` 安装，或用 `npm run plugin:build:agent` 生成 `.claude-plugin`。详见 [Hook 说明](hooks.md)。

启用回退时，在 MCP 配置的 `mcpServers` 中使用以下定义。CodeBuddy CLI 会从启动环境展开 `${UNI_MEMORY_TOKEN}`。CodeBuddy IDE 的文档确认支持 `env`，可以在私密用户配置中通过它向脚本传入令牌。 [CodeBuddy CLI MCP 文档](https://www.codebuddy.ai/docs/zh/cli/mcp) · [CodeBuddy IDE MCP 文档](https://www.codebuddy.ai/docs/zh/ide/User-guide/MCP)

```json
{
  "mcpServers": {
    "uni_memory": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/path/to/uni-memory/scripts/mcp-fallback.mjs",
        "--public-url", "https://memory.example.com/mcp",
        "--lan-address", "192.168.1.10",
        "--lan-port", "8443"
      ],
      "env": {
        "UNI_MEMORY_TOKEN": "${UNI_MEMORY_TOKEN}"
      }
    }
  }
}
```

## Antigravity

Antigravity 支持本地 stdio 和远程 Streamable HTTP。配置本地 MCP 时使用 `command` 和 `args`。Antigravity 使用独立的插件与 Hook 格式。 [Antigravity MCP 配置](https://antigravity.google/docs/mcp/#mcp-configuration-structure)

启用回退时，在私密用户配置 `mcp_config.json` 中采用以下定义，用 `env` 给子进程传入令牌。示例中的占位值需替换为对应的私密令牌。

```json
{
  "mcpServers": {
    "uni_memory": {
      "command": "node",
      "args": [
        "/path/to/uni-memory/scripts/mcp-fallback.mjs",
        "--public-url", "https://memory.example.com/mcp",
        "--lan-address", "192.168.1.10",
        "--lan-port", "8443"
      ],
      "env": {
        "UNI_MEMORY_TOKEN": "YOUR_API_TOKEN"
      }
    }
  }
}
```

### MCP 配置（`mcp_config.json`）

在全局 `~/.gemini/config/mcp_config.json` 或工作区 `.agents/mcp_config.json` 中配置 `serverUrl`（也兼容 `url`）与 `headers`；建议为高频工具开启 `eager: true`：

```json
{
  "mcpServers": {
    "uni_memory": {
      "serverUrl": "https://your-server.example.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_TOKEN"
      },
      "tools": {
        "memory_context": { "eager": true },
        "memory_search": { "eager": true }
      }
    }
  }
}
```

若使用手动 OAuth 凭据模式，在 `OAUTH_CLIENTS_JSON` 登记 `https://antigravity.google/oauth-callback` 回调地址，并在 `mcp_config.json` 中配置 `"oauth": { "clientId": "YOUR_CLIENT_ID" }`。

### 规则、Skill、Hook 与原生插件

- **独立安装**（写入 `~/.gemini/config/`，或通过 `--home` 指定路径）：

```sh
node scripts/install-memory-policy.mjs --client antigravity
```

- **原生插件打包**（生成 `plugin.json`、`rules/AGENTS.md`、`skills/shared-memory/SKILL.md`、`hooks.json`、`scripts/uni-memory-context.cjs`、`assets/logo.svg`）：

```sh
npm run plugin:build:antigravity -- --output /new/path/uni-memory-antigravity
```

独立安装与原生插件二选一，避免叠加重复 Hook。详情见 [Hook 说明](hooks.md)。

## ChatGPT

ChatGPT 插件使用 OAuth 授权码与 PKCE，见 [ChatGPT 插件说明](chatgpt-plugin.md)。
