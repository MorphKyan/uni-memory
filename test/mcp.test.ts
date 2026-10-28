import test from 'node:test';
import { createMcpServer } from '../src/mcp.js';

test('官方 MCP SDK 实例可创建并关闭', async () => {
  const server = createMcpServer();
  await server.close();
});
