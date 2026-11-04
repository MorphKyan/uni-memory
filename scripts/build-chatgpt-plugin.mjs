// 生成独立插件目录；凭据通过 ChatGPT OAuth 连接流程提供。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length !== 6 || args[0] !== '--mcp-url' || args[2] !== '--client-id' || args[4] !== '--output') {
  throw new Error('用法：node scripts/build-chatgpt-plugin.mjs --mcp-url https://HOST/mcp --client-id CLIENT_ID --output NEW_DIRECTORY');
}
const url = new URL(args[1]);
if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') {
  throw new Error('MCP 地址必须为不含凭据、查询参数或片段的 HTTPS /mcp 地址');
}
if (!/^[A-Za-z0-9._-]{1,128}$/.test(args[3])) throw new Error('client-id 格式无效');
const root = fileURLToPath(new URL('../', import.meta.url));
const skill = await readFile(join(root, 'plugins/uni-memory/skills/auto-memory/SKILL.md'), 'utf8');
const policy = await readFile(join(root, 'docs/shared-memory-policy.md'), 'utf8');
const manifest = JSON.parse(await readFile(join(root, 'plugins/uni-memory/plugin.json'), 'utf8'));
const output = resolve(args[5]);
// 拒绝覆盖，防止把其他插件或旧连接配置混入新包。
await mkdir(output, { recursive: false });
await mkdir(join(output, 'skills/auto-memory/references'), { recursive: true });
const json = value => JSON.stringify(value, null, 2) + '\n';
await writeFile(join(output, 'plugin.json'), json(manifest));
await writeFile(join(output, 'mcp.json'), json({
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
  mcpServers: {
    uni_memory: {
      type: 'streamable-http', url: url.href,
      extensions: { 'com.openai': { auth: {
        type: 'oauth', client: { mode: 'provided', clientId: args[3], tokenEndpointAuthMethod: 'none' },
        authorizationUrl: `${url.origin}/oauth/auth`, tokenUrl: `${url.origin}/oauth/token`,
        authorizationServerBase: `${url.origin}/oauth`, resource: url.href,
        baseScopes: ['memory:read', 'memory:write', 'offline_access'],
      } } },
    },
  },
}));
await writeFile(join(output, 'skills/auto-memory/SKILL.md'), skill);
await writeFile(join(output, 'skills/auto-memory/references/policy.md'), policy);
console.log(`已生成插件目录：${output}。尚未安装或完成 OAuth 授权。`);
