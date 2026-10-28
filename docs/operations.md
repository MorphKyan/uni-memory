# 部署、模型与运维

## 本地与 Unraid

优先在 WSL/Linux 开发。运行版本为 Node.js 24 LTS；不要直接使用 WSL 系统自带的 Node.js 22 替代验收版本。

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm ci
npm run init
docker compose up -d --build
```

ONNX Runtime 包已带 CPU 运行库，环境变量跳过与本项目无关的额外 GPU 运行库下载。Dockerfile 也设置该变量，不使用 GPU。

初始化命令只在没有 `.env` 时生成随机密码和签名密钥；不会覆盖现有配置。`.env`、`.secrets/` 不提交版本库。应用容器以 UID 1000 运行；Linux 初始化以 root 执行时把 `.secrets` 所有权设为 1000。Unraid 上复制或恢复文件后，确保 UID 1000 可以读取 `.secrets/jwks.json`，而其他用户不可读。

三个常驻容器为应用、PostgreSQL 18.6、Qdrant 1.19.2。数据库没有宿主机端口映射。PostgreSQL 18 的数据卷挂载到 `/var/lib/postgresql`；Qdrant 和模型缓存使用独立卷。默认端口只绑定 `127.0.0.1:3000`。PUBLIC_URL 与实际访问域名、APP_PORT 需一致；修改后使用 `docker compose up -d --force-recreate app` 应用环境变更。

开发机手动运行服务时，必须另外配置 `DATABASE_URL`、`QDRANT_URL` 和访问凭据；不要为调试把数据库公开到公网。健康检查 `/healthz` 表示进程存活，`/readyz` 包含数据库、Qdrant 状态及是否配置 embedding。

## 连接已有 NPM

复制 `compose.npm.example.yaml` 为 `compose.npm.yaml`，替换已有 NPM 的外部 Docker 网络名称。设置 PUBLIC_URL 为实际 HTTPS 根域名，在 NPM 中把该域名代理到同网络的 `uni-memory:3000`，申请 HTTPS 证书。使用专用网络别名，避免其他 Compose 项目的通用 app 别名冲突。

```sh
docker compose -f compose.yaml -f compose.npm.yaml up -d --build
```

TRUST_PROXY 只填写 NPM 所在的实际可信网段或 IP，不能使用 true/任意公网。ALLOWED_ORIGINS 可填写逗号分隔的额外可信源，默认仅允许 PUBLIC_URL。保留 Host 和 Authorization，转发正确的 X-Forwarded-Proto。关闭 `/mcp` 的代理缓存，允许 JSON POST 和 OAuth 重定向；EO IPv4 与直接 IPv6 都需要实测。默认不开放单独 SSE 长连接，可减少代理长连接差异，但不能据此宣称 EO 链路已经通过。

## 模型与对比

已选择 EMBEDDING_MODEL=gemma2、EMBEDDING_DTYPE=q4（文本版、768 维）。初始化采用此配置，首次启动需下载模型文件，也可复用缓存。显式清空模型时可以完整读写事实、查看核心记忆和关键词检索；普通索引任务留在 PostgreSQL 等待。删除任务仍会消费，不能因模型未配置而保留旧向量。

运行对比：

```sh
npm run benchmark
# 单独重跑：
node scripts/benchmark.mjs e5
```

候选 e5/bge/gemma2 分别对应 multilingual-e5-small、BGE-small-zh-v1.5、EmbeddingGemma 2 文本版，测试精度分别为 Q8/Q8/Q4。Gemma 关闭 vision/audio 编码器配置。使用各自官方要求的前缀和池化，均归一化；模型配置不共享。30 条合成事实及 30 个查询包含跨语言、相近设备与项目名称、否定事实，检索质量只是小样本参考。

每个模型先在独立进程准备缓存，再在新进程测缓存已存在的冷启动和预热性能。prepare_ms 包括当前网络下载及首次加载，缓存已存在时不代表下载时间；cold_cached_start_ms 排除本轮权重下载。process_peak_rss_bytes 是整个测量进程及 Worker 的内存峰值，包含运行库，不能等同于模型权重大小。model_resource_bytes 是实际缓存内完整模型资源，不是容器大小；失败项不填虚构延迟或召回率。

用户已选 Gemma 2，`.env` 设置 EMBEDDING_MODEL=gemma2、EMBEDDING_DTYPE=q4。改配置后重建应用容器；全量事实自动登记索引任务。集合按模型、精度、维度隔离，新集合全部追上事实版本后才成为活动集合。迁移期间不同模型不会混用；服务可退化为关键词检索。

模型文件可以在持久化缓存中复用；切换模型后旧集合保留供排障，删除操作仍会传播到全部注册集合。下载和模型推理在独立 Worker 内串行执行，HTTP 向量查询超过 5 秒退化为关键词，模型下载/加载上限为 20 分钟。报告必须说明实际测试主机，WSL 跑分不是 Unraid 跑分。

## 后台任务及管理

```sh
docker compose exec -T app node dist/src/cli.js tasks
docker compose exec -T app node dist/src/cli.js retry
docker compose exec -T app node dist/src/cli.js reindex
docker compose exec -T app node dist/src/cli.js token-list
docker compose exec -T app node dist/src/cli.js token-revoke TOKEN_ID
```

索引任务和事实变更事务性登记，消费者由 PostgreSQL advisory lock 保证单实例执行。单次处理一条最新事实，失败指数退避至最多 1 小时，10 次失败后标记 failed，管理命令 retry 可以恢复。队列可跨应用重启恢复。索引中没有正文，仅 UUID、版本和向量。应用优雅退出时停止领取任务并关闭推理 Worker。

## 可选整理

日常 MCP 不调用后端整理 API。要主动整理时设置 EXTERNAL_ORGANIZE_ENABLED=true、LLM_MODEL 和 LLM_API_KEY，默认 LLM_BASE_URL 为 `https://token.sensenova.cn/v1`。不会自动选择模型或读取凭据。

```sh
docker compose exec -T app node dist/src/cli.js organize --allow-external MEMORY_UUID_1 MEMORY_UUID_2
```

只发送明确指定的当前事实 id/version/key/content，最多 20 条及 16000 字符，不发送标签、来源摘录、历史或其他记忆。调用 OpenAI Compatible 非流式 `/chat/completions`，30 秒超时。返回带 source_ids、input_versions 的建议，applied=false，不写入数据库；如需采纳，通过 memory_write 对原事实逐条携带当前版本更新。验证器拒绝未知来源 ID、无效 JSON 或明显凭据；整理仍可能有模型错误，需要核实。

## 备份与恢复

```sh
bash scripts/backup.sh
# 明确覆盖当前数据库与配置：
bash scripts/restore.sh --replace-current .backups/uni-memory/BACKUP_DIRECTORY
```

备份使用 PostgreSQL 自定义格式，并保存 `.env`、OAuth 私钥和个人登录口令；脚本在 Linux 上以私密权限创建文件，需要放在受保护的存储上。WSL 的 Windows 挂载盘可能不执行 chmod，须同时检查 Windows ACL，或把部署与备份目录放在 Linux 文件系统。每次备份清理 14 天以前的本项目备份；Tower 已在 User Scripts 配置每日 03:10 调度，其他部署需自行设置定时任务。Qdrant 不是权威备份，从 PostgreSQL 重新生成。

恢复覆盖当前事实、权限及 OAuth 状态，暂停应用后执行，并重建索引。若当前 PostgreSQL 数据卷已经初始化，保留当前实例的数据库密码；恢复到新宿主机先复制备份配置和 secrets 再启动空数据库。旧备份可能恢复曾删除事实，须根据实际删除要求核实；删除不会篡改历史备份，到保留期后才从备份生命周期移除。

## 测试

```sh
npm test
bash scripts/test-integration.sh
```

集成测试只允许专用 uni_memory_test 数据库，使用独立 uni-memory-test Compose 项目与卷，不触碰生产卷。测试中的 synthetic-test-only 向量只用于检验真实 Qdrant 的一致性、重试和集合切换，不用于模型召回指标。实际模型推理与质量以 benchmark 报告为依据。

生产和测试数据库容器保留用于复查。需要清理时明确指定项目：`docker compose -p uni-memory-test -f compose.yaml -f compose.test.yaml down -v`，不要对生产项目执行 down -v。
