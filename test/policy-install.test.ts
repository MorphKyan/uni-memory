import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sharedMemoryPolicy } from '../src/policy.js';

test('MCP 策略与安装和插件打包的权威策略保持一致', async () => {
  const policy = await readFile(new URL('../../docs/shared-memory-policy.md', import.meta.url), 'utf8');
  assert.equal(sharedMemoryPolicy.replace(/\r\n/g, '\n').trim(), policy.replace(/\r\n/g, '\n').trim());
});

test('规则安装保留其他指令、可重复执行，并拒绝覆盖不属于项目的技能', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-policy-'));
  const script = fileURLToPath(new URL('../../scripts/install-memory-policy.mjs', import.meta.url));
  const path = join(directory, 'AGENTS.md');
  try {
    await writeFile(path, '# 用户规则\n保留这段。\n\n<!-- uni-memory:begin -->\n旧规则\n<!-- uni-memory:end -->\n\n尾部指令。\n');
    const run = () => execFileSync(process.execPath, [script, '--codex-home', directory], { stdio: 'pipe' });
    run();
    const installed = await readFile(path, 'utf8');
    assert.equal(await readFile(join(directory, 'skills/shared-memory/SKILL.md'), 'utf8'),
      await readFile(new URL('../../skills/shared-memory/SKILL.md', import.meta.url), 'utf8'));
    assert(installed.startsWith('# 用户规则\n保留这段。\n\n'));
    assert(installed.endsWith('\n\n尾部指令。\n'));
    assert(installed.includes('Shared Memory Policy v1')); assert(!installed.includes('旧规则'));
    run(); assert.equal(await readFile(path, 'utf8'), installed);
    await mkdir(join(directory, 'skills', 'shared-memory'), { recursive: true });
    await writeFile(join(directory, 'skills', 'shared-memory', 'SKILL.md'), '用户自建技能');
    assert.throws(run); assert.equal(await readFile(path, 'utf8'), installed);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
