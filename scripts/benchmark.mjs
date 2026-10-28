import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
const requested = process.argv.slice(2);
const names = requested.length ? requested : ['e5', 'bge', 'gemma2'];
if (names.some(name => !['e5', 'bge', 'gemma2'].includes(name))) throw new Error('模型参数仅允许 e5 bge gemma2');
async function run(name, stage) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['dist/src/benchmark-runner.js', name, stage], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let errors = '';
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-200000); });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8000); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 1500000);
    child.on('error', () => { clearTimeout(timeout); resolve({ ok: false, model: name, stage, error: 'process_start_failed' }); });
    child.on('close', code => {
      clearTimeout(timeout);
      try {
        const result = JSON.parse(output.trim().split('\n').at(-1));
        resolve({ ...result, exit_code: code, diagnostic: [result.diagnostic, errors].filter(Boolean).join('\n') || undefined });
      } catch { resolve({ ok: false, model: name, stage, exit_code: code, error: 'process_failed_or_timed_out', diagnostic: errors }); }
    });
  });
}
await mkdir('reports', { recursive: true });
for (const name of names) {
  console.log(`开始 ${name}：准备模型缓存及首次 CPU 推理`);
  const prepare = await run(name, 'prepare');
  const result = prepare.ok ? { ...await run(name, 'measure'), preparation: prepare } : prepare;
  await writeFile(`reports/benchmark-${name}.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(`${name}：${result.ok ? '完成' : '失败，详情已记录'}。未设置生产模型。`);
}
