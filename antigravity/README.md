# Uni Memory (Antigravity Plugin)

为 Antigravity 提供跨客户端共享长期记忆的工作流、规则与 `SessionStart` 启动 Hook。

## 包含组件

- **Rules (`rules/AGENTS.md`)**：插件启用时自动生效的共享长期记忆规则（Shared Memory Policy v1）。
- **Skill (`skills/shared-memory/SKILL.md`)**：按需加载的记忆检索、总览维护、去重与版本更新工作流，支持 `/shared-memory` 显式调用。
- **Hook (`hooks.json`)**：新会话启动时执行 `SessionStart` Hook，注入本地共享记忆提示（不联网、不读取凭据或会话历史）。

## MCP 连接配置

在全局 `~/.gemini/config/mcp_config.json` 或工作区 `.agents/mcp_config.json` 中配置 `uni_memory`（或在打包插件时传入 `--mcp-url` 生成插件内 `mcp_config.json`）：

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

若服务端开启了 OAuth，可在 `oauth` 中填入已登记的 `clientId` 并将 `https://antigravity.google/oauth-callback` 加入服务端允许回调列表。
