import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const install = (home: string, ...args: string[]) => execFileSync(process.execPath,
  [join(root, 'scripts/install-memory-policy.mjs'), '--home', home, ...args], { stdio: 'pipe' });

test('安装 Hook 保留其他设置及处理器，重复安装不累积，关闭只移除本项目处理器', async () => {
  const home = await mkdtemp(join(tmpdir(), 'memory hooks '));
  try {
    const path = join(home, 'hooks.json');
    const other = { type: 'command', command: 'echo other' };
    await writeFile(path, JSON.stringify({ description: '保留', hooks: { SessionStart: [{ hooks: [other] }], UserPromptSubmit: [{ hooks: [other] }] } }));
    install(home, '--client', 'codex', '--hooks', 'on');
    const first = await readFile(path, 'utf8');
    install(home, '--client', 'codex', '--hooks', 'on');
    assert.equal(await readFile(path, 'utf8'), first);
    const config = JSON.parse(first);
    assert.equal(config.description, '保留');
    assert.deepEqual(config.hooks.UserPromptSubmit, [{ hooks: [other] }]);
    assert.deepEqual(config.hooks.SessionStart[0], { hooks: [other] });
    const own = config.hooks.SessionStart[1];
    assert(new RegExp(own.matcher).test('compact'));
    for (const source of ['resume', 'fork', 'startup-other']) assert(!new RegExp(own.matcher).test(source));
    const run = (input: string) => process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-Command', own.hooks[0].command], { input, encoding: 'utf8', timeout: 4000 })
      : spawnSync(own.hooks[0].command, { shell: true, input, encoding: 'utf8', timeout: 4000 });
    if (process.platform === 'win32') {
      assert(own.hooks[0].command.startsWith('& "'));
      // 从旧版 cmd 命令升级时只保留一个处理器。
      const legacy = JSON.parse(first);
      for (const event of ['SessionStart', 'SubagentStart']) {
        for (const group of legacy.hooks[event]) for (const handler of group.hooks) {
          if (handler.command.startsWith('& ')) handler.command = handler.command.slice(2);
        }
      }
      await writeFile(path, JSON.stringify(legacy));
      install(home, '--client', 'codex', '--hooks', 'on');
      assert.equal(await readFile(path, 'utf8'), first);
    }
    for (const event of [
      { hook_event_name: 'SessionStart', source: 'startup' },
      { hook_event_name: 'SessionStart', source: 'clear' },
      { hook_event_name: 'SessionStart', source: 'compact' },
      { hook_event_name: 'SubagentStart', agent_type: 'explorer' },
    ]) {
      const result = run('\uFEFF' + JSON.stringify(event));
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout).hookSpecificOutput;
      assert.equal(output.hookEventName, event.hook_event_name);
      assert(output.additionalContext.includes('memory_context'));
      assert(output.additionalContext.includes('不保存密钥、密码、令牌、完整聊天'));
      assert(!output.additionalContext.includes('name: shared-memory'));
    }
    for (const input of ['not json', '{}', JSON.stringify({ hook_event_name: 'SessionStart', source: 'resume' }), JSON.stringify({ hook_event_name: 'UserPromptSubmit' })]) {
      const result = run(input); assert.equal(result.status, 0); assert.equal(result.stdout, '');
    }
    // 与他人的 handler 混在同一组时也必须保留。
    config.hooks.SessionStart[1].hooks.push(other);
    await writeFile(path, JSON.stringify(config));
    install(home, '--client', 'codex', '--hooks', 'off');
    const disabled = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(disabled.hooks.SubagentStart, undefined);
    assert(disabled.hooks.SessionStart.every((g: { hooks: unknown[] }) => g.hooks.every(h => JSON.stringify(h) === JSON.stringify(other))));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('不明环境不安装 Hook；CodeBuddy 合并 settings；配置损坏时拒绝部分安装', async () => {
  const home = await mkdtemp(join(tmpdir(), 'memory-client-'));
  try {
    install(home, '--client', 'generic');
    await assert.rejects(access(join(home, 'hooks.json')));
    const settings = join(home, 'settings.json');
    await writeFile(settings, JSON.stringify({ language: 'zh', hooks: {} }));
    install(home, '--client', 'codebuddy', '--hooks', 'on');
    const installed = JSON.parse(await readFile(settings, 'utf8'));
    assert.equal(installed.language, 'zh');
    assert(installed.hooks.SubagentStart);
    const agents = await readFile(join(home, 'AGENTS.md'), 'utf8');
    await writeFile(settings, '{bad');
    assert.throws(() => install(home, '--client', 'codebuddy', '--hooks', 'on'));
    assert.equal(await readFile(settings, 'utf8'), '{bad');
    assert.equal(await readFile(join(home, 'AGENTS.md'), 'utf8'), agents);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('原生插件实际产物包含 Skill 和两种启动 Hook，无 resume 或用户提交 Hook', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-plugin-'));
  const output = join(directory, 'plugin with spaces');
  const run = () => execFileSync(process.execPath, [join(root, 'scripts/build-agent-plugin.mjs'), '--output', output], { stdio: 'pipe' });
  try {
    run(); assert.throws(run);
    for (const host of ['.codex-plugin', '.claude-plugin']) {
      const manifest = JSON.parse(await readFile(join(output, host, 'plugin.json'), 'utf8'));
      assert.equal(manifest.hooks, './hooks/hooks.json');
      assert.equal(manifest.skills, './skills/');
    }
    const config = JSON.parse(await readFile(join(output, 'hooks/hooks.json'), 'utf8'));
    assert.deepEqual(Object.keys(config.hooks).sort(), ['SessionStart', 'SubagentStart']);
    assert.equal(new RegExp(config.hooks.SessionStart[0].matcher).test('resume'), false);
    for (const variable of ['PLUGIN_ROOT', 'CODEBUDDY_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT']) {
      const env = { ...process.env, PLUGIN_ROOT: '', CODEBUDDY_PLUGIN_ROOT: '', CLAUDE_PLUGIN_ROOT: '', [variable]: output };
      const command = config.hooks.SubagentStart[0].hooks[0].command;
      const result = spawnSync(command, { shell: true, env, input: JSON.stringify({ hook_event_name: 'SubagentStart' }), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert(JSON.parse(result.stdout).hookSpecificOutput.additionalContext.includes('Shared Memory Policy v1'));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
