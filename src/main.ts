import { createApp } from './app.js';
import { config } from './config.js';
import { createPool } from './db.js';
import { migrate, readMigrations } from './migrations.js';
import { Store } from './store.js';
import { Qdrant } from './qdrant.js';
import { Search } from './search.js';
import { Indexer } from './indexer.js';
import { EmbeddingWorker, type ModelName } from './embedding.js';
import { createOAuth } from './oauth.js';

const cfg = config();
const pool = createPool(process.env.DATABASE_URL);
let embedder: EmbeddingWorker | undefined;
try {
  await migrate(pool, await readMigrations(new URL('../../migrations/', import.meta.url)));
  const store = new Store(pool);
  const qdrant = new Qdrant(cfg);
  embedder = cfg.model ? new EmbeddingWorker(cfg.model as ModelName, process.env.EMBEDDING_DTYPE || undefined, cfg.modelCache) : undefined;
  const provider = cfg.oauthEnabled ? await createOAuth(pool, cfg) : undefined;
  const app = createApp({ cfg, store, qdrant, search: new Search(store, qdrant, embedder), provider });
  const indexer = new Indexer(pool, qdrant, embedder);
  const server = app.listen(cfg.port, cfg.host, () => {
    console.log('uni-memory 已启动');
    indexer.start();
  });
  server.on('error', () => { console.error('HTTP 监听失败'); void shutdown(); process.exitCode = 1; });
  let closing = false;
  async function shutdown() {
    if (closing) return; closing = true;
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    const force = setTimeout(() => server.closeAllConnections(), 5000); force.unref();
    await embedder?.close();
    await indexer.stop();
    await closed;
    clearTimeout(force);
    await pool.end();
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void shutdown(); });
} catch {
  await embedder?.close();
  await pool.end();
  console.error('启动失败，请检查配置、迁移和依赖状态');
  process.exitCode = 1;
}
