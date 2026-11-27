import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const install = (home: string, ...args: string[]) => execFileSync(process.execPath,
  [join(root, 'scripts/install-memory-policy.mjs'), '--client', 'antigravity', '--home', home, ...args], { stdio: 'pipe' });

test('Antigravity Skill 与通用共享记忆 Skill 保持一致并包含完整策略', async () => {
  const sharedSkill = (await readFile(join(root, 'skills/shared-memory/SKILL.md'), 'utf8')).replace(/\r\n/g, '\n');
  const agSkill = (await readFile(join(root, 'antigravity/skills/shared-memory/SKILL.md'), 'utf8')).replace(/\r\n/g, '\n');
  assert.equal(agSkill, sharedSkill);
});

test('Antigravity 独立安装保留其他 Hook、使用 SessionStart 与 injectSteps，且关闭只移除自身', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ag-hooks '));
  try {
    const hooksPath = join(home, 'hooks.json');
    const otherHook = { PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'echo lint' }] }] };
    await writeFile(hooksPath, JSON.stringify({ 'my-linter': otherHook }));
    install(home, '--hooks', 'on');
    const first = await readFile(hooksPath, 'utf8');
    install(home, '--hooks', 'on');
    assert.equal(await readFile(hooksPath, 'utf8'), first);

    const parsed = JSON.parse(first);
    assert.deepEqual(parsed['my-linter'], otherHook);
    assert.equal(parsed.hooks, undefined);
    const own = parsed['uni-memory-context'];
    assert.deepEqual(Object.keys(own), ['SessionStart']);
    assert.equal(own.SessionStart.length, 1);
    assert.equal(own.SessionStart[0].matcher, undefined);
    assert(!own.SessionStart[0].command.startsWith('& '));

    const command = own.SessionStart[0].command;
    const run = (input: string) => spawnSync(command, { shell: true, input, encoding: 'utf8', timeout: 4000 });
    for (const payload of [
      { hookEventName: 'SessionStart', conversationId: 'conv-1', workspacePaths: ['/tmp/ws'] },
      { conversationId: 'conv-2', workspacePaths: ['/tmp/ws'] },
    ]) {
      const result = run('\uFEFF' + JSON.stringify(payload));
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput, undefined);
      assert.equal(output.injectSteps.length, 1);
      const text = output.injectSteps[0].systemMessage.systemMessage;
      assert(text.includes('memory_context'));
      assert(text.includes('Shared Memory Policy v1'));
      assert(!text.includes('name: shared-memory'));
    }
    for (const ignored of ['not json', '[]', JSON.stringify({ hookEventName: 'PreToolUse' })]) {
      const result = run(ignored);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, '');
    }

    install(home, '--hooks', 'off');
    const disabled = JSON.parse(await readFile(hooksPath, 'utf8'));
    assert.deepEqual(disabled['my-linter'], otherHook);
    assert.equal(disabled['uni-memory-context'], undefined);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('Antigravity 配置损坏时拒绝部分安装', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ag-invalid-'));
  try {
    await writeFile(join(home, 'hooks.json'), '{bad');
    assert.throws(() => install(home, '--hooks', 'on'));
    await assert.rejects(access(join(home, 'AGENTS.md')));
    await assert.rejects(access(join(home, 'skills/shared-memory/SKILL.md')));
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('Antigravity 原生插件打包符合规范并支持可选 mcp_config.json', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ag-plugin-'));
  const output = join(directory, 'uni-memory-antigravity');
  const script = join(root, 'scripts/build-antigravity-plugin.mjs');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const run = (...extra: string[]) => execFileSync(process.execPath, [script, '--output', output, ...extra], { stdio: 'pipe' });
  try {
    run();
    assert.throws(() => run());
    const manifest = JSON.parse(await readFile(join(output, 'plugin.json'), 'utf8'));
    assert.equal(manifest.$schema, 'https://antigravity.google/schemas/v1/plugin.json');
    assert.equal(manifest.name, 'uni-memory');
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.logo, 'assets/logo.svg');
    await access(join(output, 'assets/logo.svg'));
    await access(join(output, 'README.md'));
    await assert.rejects(access(join(output, 'mcp_config.json')));

    const rule = await readFile(join(output, 'rules/AGENTS.md'), 'utf8');
    assert.equal(rule.replace(/\r\n/g, '\n').trim(), (await readFile(join(root, 'docs/shared-memory-policy.md'), 'utf8')).replace(/\r\n/g, '\n').trim());
    assert(!rule.startsWith('---'));

    const hooks = JSON.parse(await readFile(join(output, 'hooks.json'), 'utf8'));
    assert.deepEqual(Object.keys(hooks), ['uni-memory-context']);
    assert.deepEqual(Object.keys(hooks['uni-memory-context']), ['SessionStart']);
    assert.equal(hooks['uni-memory-context'].SessionStart[0].command, 'node ./scripts/uni-memory-context.cjs');

    const executed = spawnSync(hooks['uni-memory-context'].SessionStart[0].command, {
      cwd: output,
      shell: true,
      input: JSON.stringify({ hookEventName: 'SessionStart', conversationId: 'conv-plugin' }),
      encoding: 'utf8',
    });
    assert.equal(executed.status, 0, executed.stderr);
    assert(JSON.parse(executed.stdout).injectSteps[0].systemMessage.systemMessage.includes('Shared Memory Policy v1'));

    const withBearer = join(directory, 'with-bearer');
    execFileSync(process.execPath, [script, '--output', withBearer, '--mcp-url', 'https://memory.example.com/mcp', '--hooks', 'off'], { stdio: 'pipe' });
    await assert.rejects(access(join(withBearer, 'hooks.json')));
    const mcpBearer = JSON.parse(await readFile(join(withBearer, 'mcp_config.json'), 'utf8'));
    assert.equal(mcpBearer.mcpServers.memory.serverUrl, 'https://memory.example.com/mcp');
    assert.equal(mcpBearer.mcpServers.memory.headers.Authorization, 'Bearer ${UNI_MEMORY_TOKEN}');
    assert.equal(mcpBearer.mcpServers.memory.variables[0].name, 'UNI_MEMORY_TOKEN');
    assert.equal(mcpBearer.mcpServers.memory.tools.memory_context.eager, true);

    const withOauth = join(directory, 'with-oauth');
    execFileSync(process.execPath, [script, '--output', withOauth, '--mcp-url', 'https://memory.example.com/mcp', '--auth', 'oauth', '--client-id', 'ag-client'], { stdio: 'pipe' });
    const mcpOauth = JSON.parse(await readFile(join(withOauth, 'mcp_config.json'), 'utf8'));
    assert.equal(mcpOauth.mcpServers.memory.oauth.clientId, 'ag-client');
    assert.equal(mcpOauth.mcpServers.memory.headers, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
