import { createPool } from './db.js';
import { migrate, readMigrations } from './migrations.js';

try {
  const files = await readMigrations(new URL('../../migrations/', import.meta.url));
  const pool = createPool(process.env.DATABASE_URL);
  try {
    const applied = await migrate(pool, files);
    console.log(`迁移完成，本次执行 ${applied.length} 个文件`);
  } finally {
    await pool.end();
  }
} catch {
  // 数据库错误可能包含连接或 SQL 内容，不直接输出。
  console.error('迁移失败，请检查数据库连接、迁移文件及已执行文件校验值');
  process.exitCode = 1;
}
