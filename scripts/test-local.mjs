// 在 WSL 中复用独立测试容器，从宿主机 Node 运行相同集成测试。
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const env = parseEnv(readFileSync('.env', 'utf8'));
execFileSync('docker', ['compose', '-p', 'uni-memory-test', '-f', 'compose.yaml', '-f', 'compose.test.yaml', 'stop', 'app'], { stdio: 'inherit' });
function address(service) {
  const id = execFileSync('docker', ['compose', '-p', 'uni-memory-test', '-f', 'compose.yaml', '-f', 'compose.test.yaml', 'ps', '-q', service], { encoding: 'utf8' }).trim();
  if (!id) throw new Error('请先启动独立测试数据库及 Qdrant');
  const info = JSON.parse(execFileSync('docker', ['inspect', id], { encoding: 'utf8' }));
  return Object.values(info[0].NetworkSettings.Networks)[0].IPAddress;
}
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', 'dist/test/service.integration.js'], {
  stdio: 'inherit', env: { ...process.env, ...env,
    DATABASE_URL: `postgresql://uni_memory:${env.POSTGRES_PASSWORD}@${address('postgres')}:5432/uni_memory_test`,
    QDRANT_URL: `http://${address('qdrant')}:6333`,
  },
});
child.on('close', code => { process.exitCode = code ?? 1; });
