# uni-memory

uni-memory 是一个可自托管的个人长期记忆库。多个 AI 客户端可以通过 MCP 查询和保存共享记忆。服务支持按分区管理记忆、关键词与向量混合检索，并保留来源和版本历史。

## 安装

准备 Node.js 24 LTS、npm 和 Docker Compose。在仓库根目录运行：

```sh
npm run init
docker compose up -d --build
```

如需使用网页管理台，在启动前于本地 `.env` 中设置至少 16 字符的初始 `ADMIN_PASSWORD`。访问 `PUBLIC_URL` 对应的根路径，可管理记忆、管理员密码和 Bearer 凭据，查看服务状态和请求审计。[管理台使用说明](docs/admin-ui.md)

使用 Bearer Token 接入时，为每个客户端生成独立令牌，并将 Streamable HTTP MCP 地址设为服务的 `/mcp` 路径：

```sh
docker compose exec -T app node dist/src/cli.js token-create my-client memory:read,memory:write
```

令牌存入客户端的私密配置。OAuth 接入需要配置 HTTPS 入口和客户端回调地址。
