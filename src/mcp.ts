import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AppError, memorySelector, writeSchema, deleteSchema, searchSchema } from './validation.js';
import { requireScope, type Identity } from './auth.js';
import type { Store } from './store.js';
import type { Search } from './search.js';
import { scopeSchema } from './scope.js';
import { sharedMemoryPolicy } from './policy.js';

export function createMcpServer(store?: Store, search?: Search, identity?: Identity) {
  const server = new McpServer({ name: 'uni-memory', version: '0.2.0' }, {
    instructions: sharedMemoryPolicy,
  });
  if (!store || !search || !identity) return server;
  function tool(name: string, description: string, schema: z.ZodType, scope: string, run: (input: unknown) => Promise<unknown>) {
    server.registerTool(name, {
      description, inputSchema: schema,
      annotations: { readOnlyHint: scope === 'memory:read', destructiveHint: name === 'memory_delete', idempotentHint: true, openWorldHint: false },
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: [scope] }] },
    }, async input => {
      try {
        requireScope(identity!, scope);
        const value = await run(input);
        return { content: [{ type: 'text', text: JSON.stringify(value) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error instanceof AppError ? error.code : error instanceof z.ZodError ? 'invalid_input' : 'operation_failed' }) }] };
      }
    });
  }
  tool('memory_search', '指定 namespaces 检索当前有效记忆；项目讨论优先 global 与对应项目分区，可显式包含子分区。支持多标签、type、verification 过滤；pending 不作已核实事实。degraded 表示向量检索不可用。', searchSchema, 'memory:read', input => search.search(input));
  tool('memory_get', '按 id，或 namespace+key 获取当前有效事实和来源；更新前读取版本。', memorySelector, 'memory:read', input => store.get(input));
  tool('memory_write', '遵循 Shared Memory Policy v1：写前搜索去重；指定 namespace/key/type/verification；明确变化按 expected_version 更新；不确定冲突保留双方及来源并标 pending。提交完整属性和最少来源，每个新操作使用唯一 idempotency_key；不存凭据、完整聊天或用户要求不保存的内容。', writeSchema, 'memory:write', input => store.write(identity.clientId, input));
  tool('memory_history', '按 id 或 namespace+key 查看尚未删除记忆的变更历史和来源。', memorySelector, 'memory:read', input => store.history(input));
  tool('memory_delete', '删除事实及其历史、来源，不能撤销；需当前版本和幂等键。', deleteSchema, 'memory:write', input => store.delete(identity.clientId, input));
  tool('memory_core', '指定 namespaces 读取置顶且当前有效的核心事实；pending 条目需核实。', scopeSchema, 'memory:read', input => store.core(input));
  return server;
}
