// 生成 Antigravity 原生插件目录；默认不在包内写入静态凭据。
import { mkdir, cp, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  const key = args[i];
  const value = args[i + 1];
  if (!['--output', '--hooks', '--mcp-url', '--auth', '--client-id'].includes(key) || !value || options[key]) {
    throw new Error('用法：node scripts/build-antigravity-plugin.mjs --output NEW_DIRECTORY [--hooks on|off] [--mcp-url URL] [--auth bearer|oauth|none] [--client-id CLIENT_ID]');
  }
  options[key] = value;
}

if (!options['--output']) throw new Error('必须指定 --output NEW_DIRECTORY');
const hookMode = options['--hooks'] ?? 'on';
if (!['on', 'off'].includes(hookMode)) throw new Error('--hooks 仅支持 on 或 off');
const authMode = options['--auth'] ?? 'bearer';
if (!['bearer', 'oauth', 'none'].includes(authMode)) throw new Error('--auth 仅支持 bearer、oauth 或 none');
if (options['--auth'] && !options['--mcp-url']) throw new Error('--auth 需要配合 --mcp-url 使用');
if (options['--client-id'] && (!options['--mcp-url'] || authMode !== 'oauth')) {
  throw new Error('--client-id 仅可在 --mcp-url 且 --auth oauth 时使用');
}
if (options['--mcp-url'] && authMode === 'oauth' && !options['--client-id']) {
  throw new Error('--auth oauth 需要同时指定 --client-id');
}
if (options['--client-id'] && !/^[A-Za-z0-9._-]{1,128}$/.test(options['--client-id'])) {
  throw new Error('client-id 格式无效');
}

let mcpUrl;
if (options['--mcp-url']) {
  mcpUrl = new URL(options['--mcp-url']);
  const isLocalHttp = mcpUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(mcpUrl.hostname);
  if ((!isLocalHttp && mcpUrl.protocol !== 'https:') || mcpUrl.username || mcpUrl.password || mcpUrl.search || mcpUrl.hash || mcpUrl.pathname !== '/mcp') {
    throw new Error('MCP 地址必须为不含凭据、查询参数或片段的 HTTPS（或本机 HTTP）/mcp 地址');
  }
}

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(options['--output']);
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(root, 'antigravity/plugin.json'), 'utf8'));
manifest.version = pkg.version;
const policy = (await readFile(join(root, 'docs/shared-memory-policy.md'), 'utf8')).trim();
const json = value => JSON.stringify(value, null, 2) + '\n';

await mkdir(output, { recursive: false });
await mkdir(join(output, 'assets'), { recursive: true });
await mkdir(join(output, 'rules'), { recursive: true });
await mkdir(join(output, 'skills/shared-memory'), { recursive: true });

await writeFile(join(output, 'plugin.json'), json(manifest), 'utf8');
await cp(join(root, 'antigravity/README.md'), join(output, 'README.md'));
await cp(join(root, 'antigravity/assets/logo.svg'), join(output, 'assets/logo.svg'));
await writeFile(join(output, 'rules/AGENTS.md'), `${policy}\n`, 'utf8');
await cp(join(root, 'antigravity/skills/shared-memory/SKILL.md'), join(output, 'skills/shared-memory/SKILL.md'));

if (hookMode === 'on') {
  await mkdir(join(output, 'scripts'), { recursive: true });
  await cp(join(root, 'antigravity/hooks.json'), join(output, 'hooks.json'));
  const scriptDest = join(output, 'scripts/uni-memory-context.cjs');
  await cp(join(root, 'antigravity/scripts/uni-memory-context.cjs'), scriptDest);
  if (process.platform !== 'win32') await chmod(scriptDest, 0o755);
}

if (mcpUrl) {
  const server = {
    serverUrl: mcpUrl.href,
    tools: {
      memory_context: { eager: true },
      memory_search: { eager: true },
    },
  };
  if (authMode === 'bearer') {
    server.headers = { Authorization: 'Bearer ${UNI_MEMORY_TOKEN}' };
    server.variables = [
      {
        name: 'UNI_MEMORY_TOKEN',
        title: 'uni-memory Bearer Token',
        description: '具备 memory:read 和 memory:write 权限的客户端 Bearer 令牌。',
      },
    ];
  } else if (authMode === 'oauth') {
    server.oauth = { clientId: options['--client-id'] };
  }
  await writeFile(join(output, 'mcp_config.json'), json({
    mcpServers: {
      memory: server,
    },
  }), 'utf8');
}

console.log(`已生成 Antigravity 插件：${output}。${mcpUrl ? '已包含 mcp_config.json；' : '请在 ~/.gemini/config/mcp_config.json 或 .agents/mcp_config.json 中配置 MCP 连接；'}可通过 Antigravity Customizations 或 ~/.gemini/config/plugins 加载。`);
