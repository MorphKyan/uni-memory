import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('ChatGPT 插件打包校验连接地址、拒绝覆盖并包含完整记忆规则', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chatgpt-plugin-'));
  const script = fileURLToPath(new URL('../../scripts/build-chatgpt-plugin.mjs', import.meta.url));
  const output = join(directory, 'plugin');
  const run = (url = 'https://memory.example.com/mcp', client = 'chatgpt-personal') =>
    execFileSync(process.execPath, [script, '--mcp-url', url, '--client-id', client, '--output', output], { stdio: 'pipe' });
  try {
    for (const url of ['http://memory.example.com/mcp', 'https://user:secret@memory.example.com/mcp', 'https://memory.example.com/mcp?token=secret', 'https://memory.example.com/mcp#fragment', 'https://memory.example.com/other']) {
      assert.throws(() => run(url));
      await assert.rejects(access(output));
    }
    assert.throws(() => run(undefined, 'secret\nvalue'));
    await assert.rejects(access(output));
    run();
    const manifest = JSON.parse(await readFile(join(output, 'plugin.json'), 'utf8'));
    const mcp = JSON.parse(await readFile(join(output, 'mcp.json'), 'utf8'));
    assert.equal(manifest.name, 'uni-memory');
    assert.equal(mcp.mcpServers.uni_memory.url, 'https://memory.example.com/mcp');
    const auth = mcp.mcpServers.uni_memory.extensions['com.openai'].auth;
    assert.equal(auth.client.clientId, 'chatgpt-personal');
    assert.equal(auth.client.tokenEndpointAuthMethod, 'none');
    assert.equal(auth.authorizationUrl, 'https://memory.example.com/oauth/auth');
    assert.equal(auth.tokenUrl, 'https://memory.example.com/oauth/token');
    assert.equal(auth.resource, 'https://memory.example.com/mcp');
    assert.deepEqual(auth.baseScopes, ['memory:read', 'memory:write', 'offline_access']);
    assert.equal(await readFile(join(output, 'skills/auto-memory/references/policy.md'), 'utf8'),
      await readFile(fileURLToPath(new URL('../../docs/shared-memory-policy.md', import.meta.url)), 'utf8'));
    await access(join(output, 'skills/auto-memory/SKILL.md'));
    const policy = await readFile(join(output, 'skills/auto-memory/references/policy.md'), 'utf8');
    assert(policy.includes('memory_context'));
    assert(!policy.includes(['memory', 'core'].join('_')));
    assert.throws(() => run());
    assert.equal(await readFile(join(output, 'plugin.json'), 'utf8'), JSON.stringify(manifest, null, 2) + '\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
