import { mkdir, writeFile, access, chown, chmod } from 'node:fs/promises';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

try { await access('.env'); throw new Error('.env 已存在，不覆盖'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir('.secrets', { mode: 0o700 });
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...privateKey.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid: randomBytes(8).toString('hex') };
await writeFile('.secrets/jwks.json', JSON.stringify({ keys: [jwk] }), { mode: 0o600, flag: 'wx' });
await writeFile('.env', [
  'PUBLIC_URL=http://127.0.0.1:3000', 'APP_PORT=3000',
  `POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}`,
  `QDRANT_API_KEY=${randomBytes(32).toString('hex')}`,
  'OAUTH_ENABLED=true', `DEPLOYMENT_TOKEN=${randomBytes(32).toString('base64url')}`, `OAUTH_COOKIE_KEY=${randomBytes(48).toString('base64url')}`,
  'OAUTH_CLIENTS_JSON=[]', 'EMBEDDING_MODEL=gemma2', 'EMBEDDING_DTYPE=q4',
  'EXTERNAL_ORGANIZE_ENABLED=false', 'LLM_BASE_URL=', 'LLM_MODEL=', 'LLM_API_KEY=', '',
].join('\n'), { mode: 0o600, flag: 'wx' });
if (process.platform === 'linux' && process.getuid?.() === 0) {
  for (const path of ['.secrets', '.secrets/jwks.json']) await chown(path, 1000, 1000);
}
await chmod('.env', 0o600);
console.log('已生成本地配置及密钥。OAuth 部署令牌保存在私密 .env，请勿提交或转发。');
