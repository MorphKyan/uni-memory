# ChatGPT 自动记忆插件

插件将 MCP 连接配置和自动记忆 Skill 打包在一起。MCP 使用 OAuth 授权码和 PKCE，服务在 `OAUTH_CLIENTS_JSON` 中登记客户端及回调。

在仓库根目录运行打包器，将 `MCP_URL` 替换为服务的 HTTPS MCP 入口，将 `CLIENT_ID` 替换为已登记的客户端 ID：

```sh
npm run plugin:build -- --mcp-url MCP_URL --client-id CLIENT_ID --output .cache/chatgpt-uni-memory
```

输出包含 `plugin.json`、`mcp.json` 和 `skills/`。打包时以输出目录内的文件和目录作为 ZIP 根目录。
