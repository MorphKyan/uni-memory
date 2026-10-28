# 三模型 CPU 对比

测试日期：2026-10-27。三项均成功完成实际推理，用户查看对比及重跑结果后已选择 Gemma 2 文本版 Q4 / 768 维，初始化和本机配置已更新。

## 环境与方法

WSL2 Ubuntu、Linux x64、Node.js 24.22.1，Intel Core i5-12400F（12 个逻辑 CPU），WSL 可见内存约 15.5 GiB。Transformers.js 4.3.1、ONNX Runtime 1.30.0，CPU 推理，ONNX intra-op 2 线程、inter-op 1 线程，单 Worker 串行处理。不是 Unraid 实测。

共用 [30 条合成事实与 30 个查询](../benchmark/corpus.json)，覆盖中文、英文、中英混合、跨语言、同义改写、否定及相近设备/项目名称。语料 SHA-256：`d9028dbdd0ea9c7b41ba5d40c1ff99ee3b99cecc74cce23e3a780e125b884d84`（解析后 JSON.stringify）。测量纯向量排序，未加入关键词或 RRF，避免混合检索掩盖模型差异。

每项先准备缓存，再启动独立新进程测量；冷启动包含加载、分词初始化和一次查询，排除下载。批处理为 30 条事实、每批至多 8 条；随后逐条测量 30 次查询。仅一次测量，延迟会受主机负载影响；没有统计置信区间。下载曾中断，补齐缓存后成功完成，网络耗时不作为性能结论。

## 实测结果

| 模型 | 精度 / 维度 | Recall@5 | MRR | 缓存冷启动 | 查询中位 / P95 | 30 条批处理 | 进程峰值 RSS | 完整缓存资源 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| multilingual-e5-small | Q8 / 384 | 96.67% | 0.8747 | 2231 ms | 3.31 / 4.37 ms | 92 ms | 582.4 MiB | 129.1 MiB |
| BGE-small-zh-v1.5 | Q8 / 512 | 83.33% | 0.7271 | 1185 ms | 2.98 / 4.72 ms | 68 ms | 174.1 MiB | 23.2 MiB |
| EmbeddingGemma 2 文本版（重跑） | Q4 / 768 | 100% | 1.0000 | 3343 ms | 42.41 / 52.89 ms | 1166 ms | 633.7 MiB | 197.1 MiB |

Gemma 2 于北京时间 2026-10-27 23:36 重跑，语料、精度、主机和线程设置保持一致。上次冷启动 2989 ms、查询中位/P95 为 43.93/56.36 ms、批处理 1241 ms；本次分别为 3343 ms、42.41/52.89 ms、1166 ms。查询中位耗时下降约 3.5%，批处理下降约 6.0%，冷启动上升约 11.8%；两次结果仍属于相近水平，不能据此推断稳定性能提升。表格和原始 Gemma JSON 更新为本次结果，E5/BGE 未重跑。

原始结果及逐查询排名：[E5](benchmark-e5.json)、[BGE](benchmark-bge.json)、[Gemma 2](benchmark-gemma2.json)。资源大小包含本次运行所需的配置、分词器、图及权重，排除未完成临时下载；并非仓库全部精度文件或镜像大小。RSS 包含 Node、Worker 和运行库，不能直接当作权重内存或部署资源上限。

E5 使用 query/passage 前缀、mean pooling；BGE 使用中文查询指令、CLS pooling；Gemma 2 使用检索 query/document 前缀、模型 sentence_embedding 输出，只启用文本部分。均归一化，按余弦相似度排序。代码见 [推理 Worker](../src/embedding-worker.ts)。

## 选择参考与限制

这个语料下，Gemma 2 排名最好，代价是更高的查询及批量推理耗时；E5 在跨语言召回和速度之间表现均衡；BGE 资源最小，但本集跨语言等查询拉低整体指标。30 条事实很容易覆盖，不足以证明真实长期记忆中的泛化效果，也不能把 Gemma 的满分解释为不会检索出错。

最终已选 Gemma 2 文本版 Q4 / 768 维。仍需在 Unraid 目标主机用更多合成语料复测。实际 E5 CPU → Qdrant → 跨语言混合检索已另行通过，集成测试中的合成向量不用于上表质量指标。

复现：`npm run benchmark`，或 `node scripts/benchmark.mjs e5 bge gemma2`。默认使用 `.cache/models`；首次需联网下载，部署模型缓存是独立持久卷。上游仓库当前使用 main，未来重下载可能变化，比较时保留本次 JSON 和模型缓存。
