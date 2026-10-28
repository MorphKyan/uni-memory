// 仅安装本项目拥有的规则块与技能，保留其他全局指令。
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--codex-home')) throw new Error('用法：node scripts/install-memory-policy.mjs [--codex-home PATH]');
const targetHome = resolve(args[1] ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'));
const root = fileURLToPath(new URL('../', import.meta.url));
async function optional(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; return ''; }
}
const agentsPath = join(targetHome, 'AGENTS.md');
const skillPath = join(targetHome, 'skills', 'shared-memory', 'SKILL.md');
const previous = await optional(agentsPath);
const previousSkill = await optional(skillPath);
if (previousSkill && !previousSkill.includes('<!-- uni-memory:skill -->')) throw new Error('已有同名技能不属于本项目，请先处理命名冲突');
const begin = '<!-- uni-memory:begin -->'; const end = '<!-- uni-memory:end -->';
const beginCount = previous.split(begin).length - 1; const endCount = previous.split(end).length - 1;
if (beginCount !== endCount || beginCount > 1 || (beginCount && previous.indexOf(begin) > previous.indexOf(end))) throw new Error('现有记忆规则块边界异常，未修改文件');
const policy = (await readFile(join(root, 'docs', 'shared-memory-policy.md'), 'utf8')).trim();
const block = `${begin}\n## 共享长期记忆\n\nuni_memory MCP 是跨客户端长期记忆的权威来源；配套技能为 shared-memory。\n\n${policy}\n${end}`;
const next = beginCount ? previous.slice(0, previous.indexOf(begin)) + block + previous.slice(previous.indexOf(end) + end.length)
  : `${previous.trimEnd()}${previous.trim() ? '\n\n' : ''}${block}\n`;
await mkdir(targetHome, { recursive: true });
if (previous && next !== previous) await copyFile(agentsPath, `${agentsPath}.uni-memory-backup-${Date.now()}`);
await writeFile(agentsPath, next, 'utf8');
await mkdir(join(targetHome, 'skills', 'shared-memory'), { recursive: true });
await copyFile(join(root, 'skills', 'shared-memory', 'SKILL.md'), skillPath);
console.log(`已安装 Shared Memory Policy v1 和 shared-memory 技能：${targetHome}`);
