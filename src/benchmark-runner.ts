import { readFile, readdir, stat } from 'node:fs/promises';
import { cpus, totalmem, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { EmbeddingWorker, models, type ModelName } from './embedding.js';

const name = process.argv[2] as ModelName;
const stage = process.argv[3];
const cache = process.env.MODEL_CACHE ?? './.cache/models';
const worker = new EmbeddingWorker(name, undefined, cache);
async function size(path: string): Promise<number> {
  if (path.includes('.tmp.')) return 0;
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return info.size;
    return (await Promise.all((await readdir(path)).map(child => size(`${path}/${child}`)))).reduce((a, b) => a + b, 0);
  } catch { return 0; }
}
try {
  const corpus = JSON.parse(await readFile(new URL('../../benchmark/corpus.json', import.meta.url), 'utf8')) as {
    memories: string[]; queries: { text: string; relevant: number[]; category: string }[];
  };
  const start = performance.now();
  await worker.embed(['合成测试：这是一次本地 CPU 检索验证。'], true);
  const cold = performance.now() - start;
  if (stage === 'prepare') { console.log(JSON.stringify({ ok: true, prepare_ms: cold })); }
  else {
    const batchStart = performance.now();
    const vectors: number[][] = [];
    for (let offset = 0; offset < corpus.memories.length; offset += 8) vectors.push(...await worker.embed(corpus.memories.slice(offset, offset + 8)));
    const batchMs = performance.now() - batchStart;
    const results = [];
    for (const query of corpus.queries) {
      const before = performance.now();
      const [vector] = await worker.embed([query.text], true);
      const latency = performance.now() - before;
      const ranked = vectors.map((doc, index) => ({ index, score: doc.reduce((sum, value, i) => sum + value * vector![i]!, 0) }))
        .sort((a, b) => b.score - a.score);
      const rank = ranked.findIndex(hit => query.relevant.includes(hit.index)) + 1;
      const recall = ranked.slice(0, 5).filter(hit => query.relevant.includes(hit.index)).length / query.relevant.length;
      results.push({ query: query.text, category: query.category, rank, recall_at_5: recall, mrr: rank ? 1 / rank : 0, latency_ms: latency });
    }
    const latencies = results.map(row => row.latency_ms).sort((a, b) => a - b);
    console.log(JSON.stringify({ ok: true, measured_at: new Date().toISOString(), corpus_sha256: createHash('sha256').update(JSON.stringify(corpus)).digest('hex'),
      model: name, repo: models[name].repo, dtype: worker.dtype, dimensions: worker.dimensions,
      environment: { platform: process.platform, release: release(), arch: process.arch, node: process.version, cpu: cpus()[0]?.model, logical_cpus: cpus().length, total_memory_bytes: totalmem(), onnx_threads: 2 },
      cold_cached_start_ms: cold, batch_count: vectors.length, batch_ms: batchMs,
      recall_at_5: results.reduce((s, x) => s + x.recall_at_5, 0) / results.length,
      mrr: results.reduce((s, x) => s + x.mrr, 0) / results.length,
      latency_median_ms: latencies[Math.floor(latencies.length / 2)], latency_p95_ms: latencies[Math.ceil(latencies.length * .95) - 1],
      process_peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
      model_resource_bytes: await size(`${cache}/${models[name].repo}`), results,
    }));
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, model: name, stage, error: error instanceof Error ? error.message : 'benchmark_failed', diagnostic: worker.failure, process_peak_rss_bytes: process.resourceUsage().maxRSS * 1024 }));
  process.exitCode = 1;
} finally { await worker.close(); }
