# 部署与运维

## Docker Compose

Docker Compose 运行应用、PostgreSQL 和 Qdrant。初始化生成 `.env` 和 `.secrets/`，数据与模型缓存使用独立卷。默认仅在本机开放应用端口，数据库通过 Compose 内部网络访问。

反向代理部署时，`PUBLIC_URL` 使用实际 HTTPS 入口。`TRUST_PROXY` 只包含可信代理地址或网段，代理应保留 `Host` 和 `Authorization`，并传递原始协议。修改环境变量后重新创建应用容器。

## 模型与索引

默认使用 EmbeddingGemma 2 文本版 Q4，向量为 768 维。配置由 `EMBEDDING_MODEL` 和 `EMBEDDING_DTYPE` 控制。未启用模型时，检索使用关键词，索引写入任务等待，索引删除继续执行。

事实与索引任务在同一数据库事务中提交。索引可从 PostgreSQL 重建，模型切换时，新索引覆盖当前事实版本后才生效。

## 可选整理

整理默认关闭。启用时显式设置 `EXTERNAL_ORGANIZE_ENABLED`、`LLM_BASE_URL`、`LLM_MODEL` 和 `LLM_API_KEY`，并运行：

```sh
docker compose exec -T app node dist/src/cli.js organize --allow-external MEMORY_UUID
```

命令只向配置的 Chat Completions 接口发送选定事实的 ID、版本、键和正文，最多 20 条、16000 字符。返回结果是建议，采纳时通过记忆写入接口更新。
