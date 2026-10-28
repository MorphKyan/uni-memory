import { createPool, transaction } from './db.js';
import { config } from './config.js';
import { issueToken, passwordHash } from './auth.js';
import { Store } from './store.js';
import { Indexer } from './indexer.js';
import { Qdrant } from './qdrant.js';
import { organize } from './organize.js';
import { AppError } from './validation.js';

const [command, ...args] = process.argv.slice(2);
if (command === 'password-hash') {
  let value = '';
  for await (const chunk of process.stdin) { value += chunk; if (value.length > 1025) throw new Error('口令过长'); }
  console.log(passwordHash(value.trimEnd()));
} else {
  const pool = createPool(process.env.DATABASE_URL);
  try {
    const cfg = config();
    switch (command) {
      case 'token-create': {
        if (!args[0] || !args[1]) throw new Error('用法 token-create CLIENT SCOPES [DAYS]');
        console.log(JSON.stringify(await issueToken(pool, args[0], args[1].split(','), Number(args[2] ?? 90))));
        break;
      }
      case 'token-list':
        console.log(JSON.stringify((await pool.query('SELECT id,client_id,scopes,expires_at,revoked_at FROM client_tokens ORDER BY expires_at')).rows, null, 2)); break;
      case 'token-revoke':
        await pool.query('UPDATE client_tokens SET revoked_at=now() WHERE id=$1', [args[0]]); console.log('已撤销'); break;
      case 'oauth-revoke':
        await pool.query("DELETE FROM oauth_state WHERE grant_id=$1 OR (model='Grant' AND id=$1)", [args[0]]); console.log('已撤销 OAuth 授权'); break;
      case 'reindex': await new Indexer(pool, new Qdrant(cfg)).rebuild(); console.log('已登记全量重建任务'); break;
      case 'reset-index': {
        if (args[0] !== '--confirm') throw new Error('reset-index 必须显式 --confirm，且应用主进程须停止');
        const qdrant = new Qdrant(cfg);
        let collections: { collections: { name: string }[] } | undefined;
        for (let attempt = 0; attempt < 20; attempt++) {
          try { collections = await qdrant.request('/collections') as { collections: { name: string }[] }; break; }
          catch { await new Promise(resolve => setTimeout(resolve, 1000)); }
        }
        if (!collections) throw new Error('Qdrant 尚未就绪');
        for (const item of collections.collections) {
          if (/^uni_mem_[a-f0-9]{20}$/.test(item.name)) await qdrant.request(`/collections/${item.name}`, 'DELETE');
        }
        await transaction(pool, async client => {
          await client.query('DELETE FROM index_entries');
          await client.query('DELETE FROM index_generations');
          await client.query(`INSERT INTO index_jobs(memory_id) SELECT id FROM memories ON CONFLICT(memory_id)
            DO UPDATE SET attempts=0,failed=false,error_code=NULL,available_at=now()`);
        });
        console.log('已清空本项目向量索引并登记重建'); break;
      }
      case 'retry':
        await pool.query('UPDATE index_jobs SET attempts=0,failed=false,error_code=NULL,available_at=now()');
        console.log('已重置索引重试状态'); break;
      case 'tasks': console.log(JSON.stringify((await pool.query('SELECT * FROM index_jobs ORDER BY available_at')).rows, null, 2)); break;
      case 'organize':
        if (args.shift() !== '--allow-external') throw new Error('整理需显式提供 --allow-external 及记忆 ID');
        console.log(JSON.stringify(await organize(new Store(pool), cfg, args), null, 2)); break;
      default: throw new Error('支持 token-create/token-list/token-revoke/oauth-revoke/reindex/reset-index/retry/tasks/organize/password-hash');
    }
  } catch (error) {
    console.error(error instanceof AppError ? error.code : '管理命令失败，请检查命令参数和依赖配置');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
