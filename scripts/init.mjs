import { mkdir, writeFile, access, chown, chmod } from 'node:fs/promises';
import { generateKeyPairSync, randomBytes, scryptSync } from 'node:crypto';

try { await access('.env'); throw new Error('.env 已存在，不覆盖'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir('.secrets', { mode: 0o700 });
const password = randomBytes(24).toString('base64url');
const salt = randomBytes(16).toString('hex');
const hash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...privateKey.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid: randomBytes(8).toString('hex') };
await writeFile('.secrets/jwks.json', JSON.stringify({ keys: [jwk] }), { mode: 0o600, flag: 'wx' });
await writeFile('.secrets/owner-password', password, { mode: 0o600, flag: 'wx' });
await writeFile('.env', [
  'PUBLIC_URL=http://127.0.0.1:3000', 'APP_PORT=3000',
  `POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}`,
  `QDRANT_API_KEY=${randomBytes(32).toString('hex')}`,
  'OAUTH_ENABLED=true', `OWNER_PASSWORD_HASH=${hash}`, `OAUTH_COOKIE_KEY=${randomBytes(48).toString('base64url')}`,
  'OAUTH_CLIENTS_JSON=[]', 'EMBEDDING_MODEL=gemma2', 'EMBEDDING_DTYPE=q4',
  'EXTERNAL_ORGANIZE_ENABLED=false', 'LLM_BASE_URL=https://token.sensenova.cn/v1', 'LLM_MODEL=', 'LLM_API_KEY=', '',
].join('\n'), { mode: 0o600, flag: 'wx' });
if (process.platform === 'linux' && process.getuid?.() === 0) {
  for (const path of ['.secrets', '.secrets/jwks.json', '.secrets/owner-password']) await chown(path, 1000, 1000);
}
await chmod('.env', 0o600);
console.log('已生成本地配置及密钥。个人登录口令保存在 .secrets/owner-password，请勿提交或转发。');
