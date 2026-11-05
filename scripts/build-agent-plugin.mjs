// 与 ChatGPT OAuth 插件分开打包；MCP 地址和认证沿用客户端私密配置。
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output') throw new Error('用法：node scripts/build-agent-plugin.mjs --output NEW_DIRECTORY');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(args[1]);
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
await mkdir(output, { recursive: false });
for (const folder of ['.codex-plugin', '.claude-plugin']) {
  await mkdir(join(output, folder));
  await writeFile(join(output, folder, 'plugin.json'), JSON.stringify({
    name: 'uni-memory', version: pkg.version,
    description: '共享长期记忆规则、Skill 与会话／子 Agent 启动 Hook。MCP 连接须另行配置。',
    skills: './skills/', hooks: './hooks/hooks.json',
  }, null, 2) + '\n');
}
await cp(join(root, 'hooks'), join(output, 'hooks'), { recursive: true });
await cp(join(root, 'skills/shared-memory'), join(output, 'skills/shared-memory'), { recursive: true });
console.log(`已生成 Agent 插件：${output}。需在宿主中安装并按其要求信任 Hook；MCP 认证仍使用客户端私密配置。`);
