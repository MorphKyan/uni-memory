# 客户端接入

uni-memory 使用 Streamable HTTP MCP。客户端配置指向服务的 `/mcp` 路径，可使用 Bearer Token 或 OAuth 授权码与 PKCE 认证。

## Bearer Token

为每个客户端生成独立令牌：

```sh
docker compose exec -T app node dist/src/cli.js token-create my-client memory:read,memory:write
```

在客户端的 MCP 设置中添加服务入口，通过私密配置发送 `Authorization: Bearer` 请求头。令牌默认有效 90 天。

## OAuth

设置服务的 HTTPS 入口与 `OAUTH_ENABLED=true`，在 `OAUTH_CLIENTS_JSON` 中登记客户端 ID、客户端提供的回调地址及认证方式。客户端使用服务的 OAuth 元数据发现授权与令牌端点。

## 自动记忆

客户端可安装 [shared-memory 技能](../skills/shared-memory/SKILL.md)，按共享记忆策略检索和更新事实。支持启动 Hook 的客户端可按 [Hook 说明](hooks.md)加载规则。MCP 提供读写工具，是否触发由客户端决定。
