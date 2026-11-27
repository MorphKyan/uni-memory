# 部署与运维

## Docker Compose

Docker Compose 运行应用、PostgreSQL 和 Qdrant。初始化生成 `.env` 和 `.secrets/`，数据与模型缓存使用独立卷。默认仅在本机开放应用端口，数据库通过 Compose 内部网络访问。

反向代理部署时，`PUBLIC_URL` 使用实际 HTTPS 入口。`TRUST_PROXY` 只包含可信代理地址或网段，代理应保留 `Host` 和 `Authorization`，并传递原始协议。修改环境变量后重新创建应用容器。

审计来源 IP 与限流共用 Express 的代理信任配置。应用应只接受来自预期代理的回源连接。可由最后一层可信代理校验并覆盖 `X-Forwarded-For`，此时应用只需信任最后一层代理。若保留完整转发链，应用需要信任链中实际受控的代理地址或网段，并确保各层处理转发头时不会让访客伪造来源。未配置 `TRUST_PROXY` 时，来源 IP 是与应用直接建立连接的一跳。

## 部署令牌与升级

启用 OAuth 时，把 `DEPLOYMENT_TOKEN` 放在私密 `.env` 或容器环境变量中。使用 32 字节随机值的 Base64URL 编码，`npm run init` 会自动生成。部署令牌只在 uni-memory 的 OAuth 授权页输入。每个客户端通过授权码流程获得自己的访问令牌，并可请求刷新令牌。

从旧版升级时，先设置 `DEPLOYMENT_TOKEN`，保留 `OAUTH_COOKIE_KEY` 和原签名密钥，再重新构建并重建应用容器。旧的 `ADMIN_PASSWORD`、`OWNER_PASSWORD_HASH` 和本地所有者口令文件可以在迁移完成后移出配置。旧的管理台会话和 OAuth 浏览器会话结束，已签发的客户端访问令牌、刷新令牌和静态 Bearer 继续按原授权有效。更改部署令牌后同样需要重建容器，已签发的客户端令牌可通过下列命令单独撤销。

## 凭据与审计

在部署目录运行以下命令。每个静态 Bearer 独立签发、轮换和撤销，明文只在签发或轮换时显示。修改客户端 ID 会改变后续记忆的来源标识和幂等范围。

```sh
docker compose exec -T app node dist/src/cli.js token-create CLIENT memory:read,memory:write
docker compose exec -T app node dist/src/cli.js token-list
docker compose exec -T app node dist/src/cli.js token-edit ID VERSION CLIENT memory:read EXPIRES_AT
docker compose exec -T app node dist/src/cli.js token-rotate ID VERSION
docker compose exec -T app node dist/src/cli.js token-revoke ID
docker compose exec -T app node dist/src/cli.js oauth-list
docker compose exec -T app node dist/src/cli.js oauth-revoke GRANT_ID
docker compose exec -T app node dist/src/cli.js audit-list 'days=7&channel=mcp&outcome=error'
```

`VERSION` 来自 `token-list`，`EXPIRES_AT` 使用 ISO 8601 时间。轮换令牌立即停用旧值。OAuth 按授权 ID 撤销，不同客户端的授权单独管理。审计可按 `days`（1、7、30、90 或 365）、`channel`、`outcome`、`client` 筛选。首屏返回汇总与分页参数，后续同时传 `before`（上页的 `next`）和首屏的 `until`。以响应头 `X-Request-ID` 核对单次请求。

## 模型与索引

默认使用 EmbeddingGemma 2 文本版 Q4，向量为 768 维。配置由 `EMBEDDING_MODEL` 和 `EMBEDDING_DTYPE` 控制。未启用模型时，检索使用关键词，索引写入任务等待，索引删除继续执行。

事实与索引任务在同一数据库事务中提交。索引可从 PostgreSQL 重建，模型切换时，新索引覆盖当前事实版本后才生效。

## 可选整理

整理默认关闭。启用时显式设置 `EXTERNAL_ORGANIZE_ENABLED`、`LLM_BASE_URL`、`LLM_MODEL` 和 `LLM_API_KEY`，并运行：

```sh
docker compose exec -T app node dist/src/cli.js organize --allow-external MEMORY_UUID
```

命令只向配置的 Chat Completions 接口发送选定事实的 ID、版本、键和正文，最多 20 条、16000 字符。返回结果是建议，采纳时通过记忆写入接口更新。
