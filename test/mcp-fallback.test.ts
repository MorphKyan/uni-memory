import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const certPath = resolve('test/fixtures/mcp-test-cert.pem');
// Synthetic localhost certificate and key used only by the isolated test servers.
const tls = { cert: readFileSync(certPath), key: readFileSync('test/fixtures/mcp-test-key.pem') };
const token = 'synthetic-mcp-test';

test('MCP launcher supports initialize and server/discover, selects one route, and does not replay requests',
  { timeout: 15000 }, async t => {
    for (const ready of [true, false]) {
      const probes: Array<string | undefined> = [];
      const calls: Array<{ route: string; method: string; auth: string | undefined; protocol: string | undefined }> = [];
      const servers = ['lan', 'public'].map(route => createServer(tls, (req, res) => {
        if (route === 'lan' && req.url === '/readyz') {
          probes.push(req.headers.authorization);
          if (ready) res.end(JSON.stringify({ database: true, qdrant: true }));
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        req.setEncoding('utf8');
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          const message = JSON.parse(body);
          calls.push({
            route, method: message.method, auth: req.headers.authorization,
            protocol: req.headers['mcp-protocol-version']?.toString(),
          });
          if (message.method === 'notifications/initialized') {
            res.writeHead(202).end();
            return;
          }
          if (message.method === 'tools/call') {
            res.destroy();
            return;
          }
          if (message.method === 'initialize') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
              protocolVersion: '2025-11-25', capabilities: { tools: {} },
              serverInfo: { name: 'uni-memory-test', version: '1.0.0' },
            } }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { route } })}\n\n`);
        });
      }));
      for (const server of servers) server.listen(0, '127.0.0.1');
      await Promise.all(servers.map(server => once(server, 'listening')));
      const [lanPort, publicPort] = servers.map(server => {
        const address = server.address();
        assert(address && typeof address === 'object');
        return address.port;
      });

      const client = new StdioClientTransport({
        command: process.execPath,
        args: ['scripts/mcp-fallback.mjs', '--public-url', `https://localhost:${publicPort}/mcp`,
          '--lan-address', '127.0.0.1', '--lan-port', String(lanPort)],
        env: { NODE_EXTRA_CA_CERTS: certPath, UNI_MEMORY_TOKEN: token },
        stderr: 'pipe',
      });
      let stderr = '';
      client.stderr?.on('data', chunk => { stderr += chunk; });
      const timeout = AbortSignal.any([t.signal, AbortSignal.timeout(5000)]);
      try {
        await client.start();
        const modern = '2026-07-28';
        const legacy = '2025-11-25';
        const send = async (method: string, params: Record<string, unknown> = ready ? {} : {
          _meta: { 'io.modelcontextprotocol/protocolVersion': modern },
        }) => {
          const responses = new EventEmitter();
          client.onmessage = message => { responses.emit('response', message); };
          const response = once(responses, 'response', { signal: timeout });
          await client.send({ jsonrpc: '2.0', id: 1, method, params });
          return (await response)[0];
        };
        const route = ready ? 'lan' : 'public';
        const handshake = ready ? 'initialize' : 'server/discover';
        const initialized = await send(handshake, ready ? {
          protocolVersion: legacy, capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' },
        } : undefined);
        if (ready) {
          assert.equal(initialized.result.protocolVersion, legacy);
          await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        } else {
          assert.deepEqual(initialized.result, { route });
        }
        assert.deepEqual(await send('tools/list'), { jsonrpc: '2.0', id: 1, result: { route } });
        assert.equal((await send('tools/call')).error.code, -32000);
        assert.deepEqual(probes, [undefined]);
        assert.deepEqual(calls.map(({ method }) => method).sort(),
          [handshake, ...(ready ? ['notifications/initialized'] : []), 'tools/list', 'tools/call'].sort());
        for (const call of calls) {
          assert.equal(call.route, route);
          assert.equal(call.auth, `Bearer ${token}`);
          assert.equal(call.protocol, ready ? (call.method === handshake ? undefined : legacy) : modern);
        }
      } catch (error) {
        throw new Error(stderr || 'MCP launcher did not respond', { cause: error });
      } finally {
        for (const server of servers) { server.close(); server.closeAllConnections(); }
        await client.close();
      }
    }
  });
