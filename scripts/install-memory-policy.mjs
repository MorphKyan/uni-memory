// 仅安装本项目拥有的规则块与技能，保留其他全局指令；Codex、CodeBuddy 与 Antigravity 各自独立处理。
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--codex-home', '--home', '--client', '--hooks'].includes(args[i]) || !args[i + 1] || options[args[i]]) {
    throw new Error('用法：node scripts/install-memory-policy.mjs [--client codex|codebuddy|antigravity|generic] [--home PATH] [--hooks auto|on|off]；兼容 --codex-home PATH');
  }
  options[args[i]] = args[i + 1];
}
const client = options['--client'] ?? (process.env.CODEBUDDY_PLUGIN_ROOT || process.env.CODEBUDDY_CONFIG_DIR ? 'codebuddy' : 'codex');
const hookMode = options['--hooks'] ?? 'auto';
if (!['codex', 'codebuddy', 'antigravity', 'generic'].includes(client) || !['auto', 'on', 'off'].includes(hookMode)) {
  throw new Error('不支持的客户端或 Hook 模式');
}
if (options['--codex-home'] && (client !== 'codex' || options['--home'])) {
  throw new Error('--codex-home 不能与其他客户端或 --home 混用');
}
if (client === 'generic' && (!options['--home'] || hookMode === 'on')) {
  throw new Error('generic 必须指定 --home，且不支持 Hook');
}

const defaultHome = client === 'codex'
  ? (process.env.CODEX_HOME ?? join(homedir(), '.codex'))
  : client === 'codebuddy'
    ? (process.env.CODEBUDDY_CONFIG_DIR ?? join(homedir(), '.codebuddy'))
    : client === 'antigravity'
      ? (process.env.ANTIGRAVITY_CONFIG_DIR ?? join(homedir(), '.gemini', 'config'))
      : '';
const targetHome = resolve(options['--home'] ?? options['--codex-home'] ?? defaultHome);
const root = fileURLToPath(new URL('../', import.meta.url));

async function optional(path) {
  try { return await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; return ''; }
}

const quote = value => {
  if (process.platform !== 'win32') return "'" + value.replaceAll("'", "'\\''") + "'";
  if (/["\r\n$`%!]/.test(value)) throw new Error('Hook 路径包含不支持的 Shell 字符');
  return '"' + value.replaceAll('\\', '/') + '"';
};

const agentsPath = join(targetHome, 'AGENTS.md');
const skillPath = join(targetHome, 'skills', 'shared-memory', 'SKILL.md');
const skillSourcePath = join(root, client === 'antigravity' ? 'antigravity/skills/shared-memory/SKILL.md' : 'skills/shared-memory/SKILL.md');
const previous = await optional(agentsPath);
const previousSkill = await optional(skillPath);
if (previousSkill && !previousSkill.includes('<!-- uni-memory:skill -->')) {
  throw new Error('已有同名技能不属于本项目，请先处理命名冲突');
}

const begin = '<!-- uni-memory:begin -->'; const end = '<!-- uni-memory:end -->';
const beginCount = previous.split(begin).length - 1; const endCount = previous.split(end).length - 1;
if (beginCount !== endCount || beginCount > 1 || (beginCount && previous.indexOf(begin) > previous.indexOf(end))) {
  throw new Error('现有记忆规则块边界异常，未修改文件');
}
const policy = (await readFile(join(root, 'docs', 'shared-memory-policy.md'), 'utf8')).trim();
const block = `${begin}\n## 共享长期记忆\n\nuni_memory MCP 是跨客户端长期记忆的权威来源；配套技能为 shared-memory。\n\n${policy}\n${end}`;
const next = beginCount
  ? previous.slice(0, previous.indexOf(begin)) + block + previous.slice(previous.indexOf(end) + end.length)
  : `${previous.trimEnd()}${previous.trim() ? '\n\n' : ''}${block}\n`;

async function planAntigravityHooks() {
  // WSL 下针对 Windows /mnt/<drive> 路径在 auto 模式不写入 Linux Node 路径。
  const isWslTargetingWindows = process.platform === 'linux' && /^\/mnt\/[a-z]\//i.test(targetHome);
  const enableHooks = hookMode === 'on' || (hookMode === 'auto' && !isWslTargetingWindows);
  const hooksPath = join(targetHome, 'hooks.json');
  const hookScript = join(targetHome, 'hooks', 'uni-memory-context.cjs');
  const hookSource = await readFile(join(root, 'antigravity/scripts/uni-memory-context.cjs'), 'utf8');
  const oldScript = await optional(hookScript);
  if (oldScript && !oldScript.includes('Antigravity 仅注入本地规则；不访问网络、凭据或会话历史。')) {
    throw new Error('已有同名 Hook 不属于本项目，未修改文件');
  }
  const hooksText = await optional(hooksPath);
  const config = hooksText ? JSON.parse(hooksText.replace(/^\uFEFF/, '')) : {};
  if (!config || Array.isArray(config) || typeof config !== 'object') {
    throw new Error('Antigravity Hook 配置结构无效，未修改文件');
  }
  if (config['uni-memory-context'] !== undefined && (Array.isArray(config['uni-memory-context']) || typeof config['uni-memory-context'] !== 'object' || !config['uni-memory-context'])) {
    throw new Error('Antigravity Hook 配置结构无效，未修改文件');
  }
  const nextConfig = { ...config };
  if (enableHooks) {
    // Antigravity 在 Windows 使用 cmd /c，在 Unix 使用 sh -c。
    const command = `${quote(process.execPath)} ${quote(hookScript)}`;
    nextConfig['uni-memory-context'] = {
      SessionStart: [{ type: 'command', command, timeout: 3 }],
    };
  } else {
    delete nextConfig['uni-memory-context'];
  }
  const nextHooks = JSON.stringify(nextConfig, null, 2) + '\n';
  return { enableHooks, hooksPath, hookScript, hookSource, hooksText, nextHooks };
}

async function planCodexOrCodebuddyHooks() {
  // auto 只在本机可核实的 Codex 能力上启用；其他客户端由安装 Agent 核对版本后显式选择 on。
  const probe = hookMode === 'auto' && client === 'codex'
    ? spawnSync('codex', ['exec', '--help'], { encoding: 'utf8', timeout: 5000, windowsHide: true }) : null;
  const enableHooks = hookMode === 'on' || (hookMode === 'auto' && client === 'codex' && probe?.status === 0 && probe.stdout.includes('--dangerously-bypass-hook-trust'));
  const hooksPath = join(targetHome, client === 'codebuddy' ? 'settings.json' : 'hooks.json');
  const hookScript = join(targetHome, 'hooks', 'uni-memory-context.cjs');
  const hookSource = await readFile(join(root, 'hooks/uni-memory-context.cjs'), 'utf8');
  const oldScript = await optional(hookScript);
  if (oldScript && !oldScript.includes('仅注入本地规则；不访问网络、凭据或会话历史。')) throw new Error('已有同名 Hook 不属于本项目，未修改文件');
  const hooksText = client === 'generic' ? '' : await optional(hooksPath);
  const config = hooksText ? JSON.parse(hooksText.replace(/^\uFEFF/, '')) : {};
  if (!config || Array.isArray(config) || typeof config !== 'object' || (config.hooks && (Array.isArray(config.hooks) || typeof config.hooks !== 'object'))) throw new Error('Hook 配置结构无效，未修改文件');
  const hooks = config.hooks ?? {};
  // Codex 在 Windows 使用 PowerShell；带引号的可执行路径必须用调用运算符。
  const command = `${process.platform === 'win32' && client === 'codex' ? '& ' : ''}${quote(process.execPath)} ${quote(hookScript)}`;
  // 只替换本项目的精确命令，不删除同一 matcher 中的其他处理器。
  for (const event of ['SessionStart', 'SubagentStart']) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) throw new Error('Hook 事件配置无效，未修改文件');
    hooks[event] = (hooks[event] ?? []).map(group => {
      if (!group || !Array.isArray(group.hooks)) throw new Error('Hook 处理器配置无效，未修改文件');
      return { ...group, hooks: group.hooks.filter(handler => !(oldScript && typeof handler.command === 'string' && handler.command.endsWith(` ${quote(hookScript)}`))) };
    }).filter(group => group.hooks.length);
    if (enableHooks) hooks[event].push({ ...(event === 'SessionStart' ? { matcher: '^(startup|clear|compact)$' } : {}), hooks: [{ type: 'command', command, timeout: 3 }] });
    if (!hooks[event].length) delete hooks[event];
  }
  const nextHooks = JSON.stringify({ ...config, hooks }, null, 2) + '\n';
  return { enableHooks, hooksPath, hookScript, hookSource, hooksText, nextHooks };
}

const hookPlan = client === 'antigravity'
  ? await planAntigravityHooks()
  : await planCodexOrCodebuddyHooks();

await mkdir(targetHome, { recursive: true });
if (previous && next !== previous) await copyFile(agentsPath, `${agentsPath}.uni-memory-backup-${Date.now()}`);
await writeFile(agentsPath, next, 'utf8');
await mkdir(join(targetHome, 'skills', 'shared-memory'), { recursive: true });
await copyFile(skillSourcePath, skillPath);
if (hookPlan.enableHooks) {
  await mkdir(join(targetHome, 'hooks'), { recursive: true });
  await writeFile(hookPlan.hookScript, hookPlan.hookSource, 'utf8');
}
if (client !== 'generic' && (hookPlan.enableHooks || hookPlan.hooksText) && hookPlan.nextHooks !== hookPlan.hooksText) {
  if (hookPlan.hooksText) await copyFile(hookPlan.hooksPath, `${hookPlan.hooksPath}.uni-memory-backup-${Date.now()}`);
  await writeFile(hookPlan.hooksPath, hookPlan.nextHooks, 'utf8');
}
console.log(`已安装 Shared Memory Policy v1 和 shared-memory 技能（${client}）：${targetHome}。${hookPlan.enableHooks ? 'Hook 已配置（非已启用证明），请在宿主中按要求审阅／信任并重启验收；勿再叠加安装原生插件。' : '未启用 Hook；auto 未确认客户端能力或已显式关闭，MCP＋Skill 仍可使用。'}`);
