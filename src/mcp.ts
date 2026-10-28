import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AppError, memorySelector, writeSchema, deleteSchema, searchSchema, namespacesSchema, listSchema } from './validation.js';
import { requireScope, type Identity } from './auth.js';
import type { Store } from './store.js';
import type { Search } from './search.js';
import { scopeSchema } from './scope.js';
import { sharedMemoryPolicy } from './policy.js';
import type { MemoryStatus } from './status.js';

export function createMcpServer(store: Store, search: Search, status: MemoryStatus, identity: Identity) {
  const server = new McpServer({ name: 'uni-memory', version: '0.2.0' }, {
    instructions: sharedMemoryPolicy,
  });
  function tool(name: string, description: string, schema: z.ZodType, scope: string, run: (input: unknown) => Promise<unknown>) {
    server.registerTool(name, {
      description, inputSchema: schema,
      annotations: { readOnlyHint: scope === 'memory:read', destructiveHint: name === 'memory_delete', idempotentHint: true, openWorldHint: false },
      _meta: { securitySchemes: [{ type: 'oauth2', scopes: [scope] }] },
    }, async input => {
      try {
        requireScope(identity, scope);
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
  tool('memory_core', '指定 namespaces 读取置顶且当前有效的核心事实，优先返回各分区 key=overview 的总览；总览由客户端创建和按版本维护，pending 条目需核实。', scopeSchema, 'memory:read', input => store.core(input));
  tool('memory_namespaces', '发现包含当前有效记忆的分区及直属条目数；可用 parent 限定自身及子分区，无需预先知道分区名。分区不隔离读取权限。', namespacesSchema, 'memory:read', input => store.namespaces(input));
  tool('memory_list', '指定 namespaces 分页浏览全部当前有效记忆，不需要搜索词；支持子分区、标签、类型和核实状态过滤。按创建时间和 ID 升序，使用 next_cursor 继续翻页并保持过滤条件不变；next_cursor=null 表示结束。返回当前正文与属性，来源和历史按需另查；不是快照导出。', listSchema, 'memory:read', input => store.list(input));
  tool('memory_status', '指定 namespaces 查询有效、待核实、置顶、过期记忆数量与最近更新时间；沿用子分区、标签、类型和核实状态过滤。运行状态反映整个实例：数据库、Qdrant、模型、索引任务和检索模式。查询不触发模型加载或推理；状态是采样和最近观测，不保证下一次检索成功。', scopeSchema, 'memory:read', input => status.get(input));
  return server;
}
