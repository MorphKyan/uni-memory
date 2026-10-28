# Tower 更新验收（2026-10-28）

## 范围与升级前检查

本次将本地代码清理、分区总览、分区发现、游标分页和记忆库状态接口部署到 Tower。应用仍为 0.2.0，源码提交为 `0ea98d1`；无新增依赖或数据库迁移，保持既有模型、认证与网络配置。

WSL Docker Node.js 24.22.1 构建、直接依赖版本校验、17 项单元测试及 21 项真实 PostgreSQL/Qdrant 集成测试全部通过。生产升级前执行现有备份脚本，备份位置为 `/mnt/cache/appdata/uni-memory/.backups/uni-memory/20261028T153841Z-29731`，包含数据库、私密配置及签名密钥，按现有规则保留 14 天。

旧镜像保留为 `uni-memory:rollback-20261028`，镜像 ID 为 `sha256:8ae6702e8ce40baf53c31d3641b87d79cfa0dd23dc3cc72aa1e861be943aca95`。源码通过 Git archive 上传，在独立目录构建；同步源文件时不覆盖 `.env`、`.secrets`、模型、数据库、Qdrant 或备份目录。

升级前对 memories、memory_sources、memory_events 全表分别记录数量及有序行内容 MD5，仅用于检查本次替换应用是否改变既有数据。memories 的 38 行包含删除后的空墓碑，不能当成当前有效记忆数量。

## 部署与线上验收

Tower 从提交构建的最终镜像为 `sha256:211c347c0784c47f5532020766b95cfad278a6f37f935b3c67bd6e44da908f22`，app 已替换且 healthy。部署时明确使用 `docker-compose.yml`，不把仓库开发用的 `compose.yaml` 复制到生产根目录。

替换应用后、执行验收写入前，以下摘要与升级前完全一致：

| 表 | 行数 | 有序行内容 MD5 |
| --- | --- | --- |
| memories | 38 | b8ca8a8f5ff15c991e363b82182719f5 |
| memory_sources | 39 | d01edd3412b4c5aa76dbe3a44fd9a144 |
| memory_events | 40 | e7186fc7d726e9ab739c0bcafe788be3 |

Windows Node.js 24.22.1 运行官方 MCP SDK 的 `scripts/verify-remote.mjs`，通过九个工具发现、认证/Origin、默认策略及必填字段、跨分区同 key、层级边界、多标签/类型/核实过滤、分区总览自动置顶与 core 优先返回、分区发现、游标分页、状态及真实模型推理、Gemma 2 跨语言语义检索、待核实双方信息及版本历史。三条合成验收事实及其来源和历史均已清理。

## 记忆同步与最终状态

通过正常记忆接口及当前版本更新 global 的 `project.uni-memory.deployment`，以及 projects/uni-memory 的 `memory-status`、`maintenance-review`、`memory.organization` 与 `overview`；补建 global 的 overview。四条详细事实及两个总览均已读回核对，保留原来源和版本历史。旧 pending 条目的核实标记保持原状；本次已实测的部署记录更新为 confirmed。

2026-10-28 23:49（Asia/Shanghai）最终 REST/MCP 读回结果：

- 有效记忆 34 条，global 30 条、projects/uni-memory 4 条；pending 27 条、置顶 5 条、过期 0 条。
- 使用每页 7 条分页，5 页共 34 个唯一 UUID，无重复、无遗漏、无残留的合成验收分区；两个 overview 在 core 中优先返回。
- PostgreSQL 与 Qdrant 为 ok，EmbeddingGemma 2 Q4 / 768 维为 ready，检索模式 hybrid，总体状态 ok。
- 有效事实 34 条，目标集合中版本匹配 34 条，排队与失败任务均为 0。

这些是当时采样状态；本次执行真实模型烟测，没有重跑完整模型基准测试。

## 回退

如应用升级失败，可在 Tower 项目目录执行：

```sh
docker image tag uni-memory:rollback-20261028 uni-memory:0.2.0
docker compose up -d --no-deps --force-recreate --wait app
```

本次没有新增数据库迁移，应用回退无需恢复数据库。覆盖恢复会撤销升级后新增的记忆，只有确实需要且获授权时才按运维文档执行。

未重启 Tower 整机、PostgreSQL 或 Qdrant；公网 HTTPS/OAuth 和其他客户端接入仍按既有待办处理。
