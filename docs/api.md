# 服务接口

所有 `/v1` 与 `/mcp` 请求都需要 `Authorization: Bearer ...`。身份由服务端令牌确定；请求中不允许 `client_id`。`memory:admin` 包含读写权限。

| REST | 权限 | MCP |
| --- | --- | --- |
| `POST /v1/memories/search` | memory:read | memory_search |
| `GET /v1/memories?id=UUID` 或 `?namespace=NS&key=KEY` | memory:read | memory_get |
| `POST /v1/memories` | memory:write | memory_write |
| `GET /v1/memories/history?id=UUID` 或 `?namespace=NS&key=KEY` | memory:read | memory_history |
| `POST /v1/memories/delete` | memory:write | memory_delete |
| `GET /v1/memories/core?namespaces=global` | memory:read | memory_core |
| `GET /v1/tasks` | memory:admin | 不对模型暴露管理工具 |

MCP 使用无状态 Streamable HTTP，`POST /mcp` 返回 JSON；未启用独立 GET SSE 通道，GET/DELETE 返回 405。SDK 客户端以 tools/list、tools/call 使用工具。

## 写入

0.2.0 使用明确的新接口，不兼容旧字段缺失的客户端。每条记忆由 `(namespace,key)` 唯一确定，UUID 继续作为全库标识。

```json
{
  "namespace": "global",
  "key": "user.preference.language",
  "type": "preference",
  "verification": "confirmed",
  "content": "用户偏好简体中文交流。",
  "tags": ["preference"],
  "pinned": true,
  "expires_at": null,
  "source": {"reference": "conversation:synthetic-example", "excerpt": "请用中文回复"},
  "idempotency_key": "one-unique-operation-id"
}
```

`namespace`、`type`、`verification` 必填。namespace 最多 160 字符，使用小写字母、数字、下划线或短横线段，以 `/` 分层；每段以字母或数字开头，不允许空段、前后斜杠或 `.`/`..`。建议通用记忆为 `global`，项目记忆为 `projects/homelab` 等。

type 只能为 `preference`、`fact`、`decision`、`status`。verification 为 `confirmed` 或 `pending`，表示核实状态，不代表系统保证客观真伪；引用和推测不得转换为用户已确认事实。不确定冲突可按当前版本将双方陈述及归属合并进原正文，追加来源并标 pending；核实后再次按版本更新。

`key` 在写入、读取和历史查询时统一进行 NFKC 规范化并去除首尾空白，规范化后须为 1–160 字符；例如 `ｓｅｒｖｅｒ.①` 与 `server.1` 指向同一 key。正文最多 4000 字符，标签最多 20 个，每个 64 字符。来源引用及摘录各最多 512 字符。示例均为合成内容。不得提交完整私人会话或凭据；明显凭据格式会被拒绝，但正则检查不能识别所有敏感信息。

首次写入返回 `{status:"created",memory:...}`；相同 namespace/key、正文及属性合并来源，返回 merged；不同内容或属性且没有 `expected_version` 返回 conflict。纠正或调整类型、核实状态、标签、置顶、有效期时，先读取当前事实，提交完整新值并加 `expected_version`。未给出的 tags/pinned/expires_at 使用空数组/false/null，写入是完整状态而非 PATCH。改变 namespace/key 会指向另一条事实，不是移动操作；写前应跨 global 与当前项目分区去重。

REST 冲突状态码为 409，MCP 冲突是含 status=conflict 的业务结果；两者都不会覆盖现有事实。每个新操作更换幂等键，网络重试沿用原键。相同客户端、相同键、相同请求返回原结果；同键不同请求返回 idempotency_key_reused。来源身份按调用客户端登记。删除后，旧写入请求的重放只返回 deleted 标识，不恢复正文。

删除输入：`{id,expected_version,idempotency_key}`。删除不可撤销，会清除正文、所有历史与来源，并异步移除所有索引集合内的向量。旧备份到期前可能仍包含被删除内容。

## 检索与历史

检索示例：

```json
{
  "query": "家庭服务器系统选择",
  "namespaces": ["global", "projects/homelab"],
  "include_descendants": false,
  "tags": ["unraid", "linux"],
  "type": "decision",
  "verification": "confirmed",
  "limit": 10
}
```

`namespaces` 必填，1–20 个分区取并集；默认仅精确匹配，`include_descendants:true` 同时包含指定分区及其子分区。`projects/home` 不包含 `projects/homelab`。未提供 type/verification 不过滤对应字段，pending 会明确随记录返回。limit 为 1–50，tags 采用全部包含过滤。

返回 `{memories,degraded,reason}`。关键词检索使用子串及 pg_trgm，和向量排名按 RRF 融合。SQL 与 Qdrant 均在候选截断前执行范围及属性过滤，返回前再回查权威数据库。无模型、模型加载中、推理超时或向量服务失败时返回关键词结果并标记降级。embedding 推理在模型最大上下文处截断，完整正文仍保留供关键词搜索。

所有检索在返回前从 PostgreSQL 核对当前版本、删除状态及有效期；过期事实不能通过 memory_get/search/core 返回，但可显式通过 history 查看。核心记忆是最多 50 条置顶且有效的事实，不是自动生成摘要。

`memory_core` 接受同样的 namespaces/include_descendants/tags/type/verification 条件，不接受 query/limit。REST GET 示例：`/v1/memories/core?namespaces=global&namespaces=projects%2Fhomelab&include_descendants=true`，重复 tags 参数表示多个标签。GET 布尔参数仅接受 true/false。memory_get/history 使用 `{id}` 或 `{namespace,key}`，不接受含糊的单 key。

所有分区共用 PostgreSQL 和同一模型的 Qdrant 集合；payload 保存版本、namespace、祖先路径、tags、type、verification，不保存正文或来源。分区用于逻辑组织，不提供客户端权限隔离。

向量范围使用 namespace 精确匹配或祖先路径数组匹配，标签逐个加入 must 条件；数组与 match any 的语义参见 [Qdrant 官方过滤说明](https://qdrant.tech/documentation/search/filtering/)。

升级迁移 `0002_memory_partitions.sql` 将原记录归入 global/type=fact/verification=pending，保留 UUID、key、正文、版本和原始历史；不推断旧数据的项目归属及核实状态。旧向量集合停用后自动重建相同集合的 payload，完整前查询降级。需要人工核对的旧条目通过正常版本更新调整属性，不改写旧历史。

## 运维与安全

`/healthz` 只表示 HTTP 存活。`/readyz` 检查 PostgreSQL 和 Qdrant，并报告是否配置模型；它不保证模型已下载或索引已完成。

REST 错误使用 `{error:CODE}`；MCP 工具错误使用 `isError:true` 与 JSON 文本。错误不返回 SQL、凭据、事实正文或上游原始响应。请求体上限 32 KiB；Host/Origin 不匹配拒绝；服务默认每来源 IP 每分钟 120 请求，授权端点 30，交互提交 10。服务只信任配置的代理网段，不信任任意转发头。
