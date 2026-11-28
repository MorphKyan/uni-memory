import { Agent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

function lanFetch(endpoint, address, port, agent) {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== endpoint.origin) throw new Error('MCP upstream origin changed');
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    const headers = Object.fromEntries(request.headers);
    headers.host = endpoint.host;
    if (body) headers['content-length'] = String(body.length);
    return new Promise((resolve, reject) => {
      const outgoing = httpsRequest({
        hostname: address, port, servername: endpoint.hostname, rejectUnauthorized: true,
        path: url.pathname + url.search, method: request.method,
        headers, signal: request.signal, agent,
      }, incoming => {
        const status = incoming.statusCode;
        const hasBody = request.method !== 'HEAD' && ![204, 205, 304].includes(status);
        if (!hasBody) incoming.resume();
        resolve(new Response(hasBody ? Readable.toWeb(incoming) : null, {
          status, headers: incoming.headersDistinct,
        }));
      });
      outgoing.once('error', reject);
      outgoing.end(body);
    });
  };
}

async function run() {
  const { values } = parseArgs({ options: {
    'public-url': { type: 'string' },
    'lan-address': { type: 'string' },
    'lan-port': { type: 'string', default: '443' },
  } });
  const endpoint = new URL(values['public-url']);
  const address = values['lan-address'];
  const port = Number(values['lan-port']);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
      || endpoint.pathname !== '/mcp' || endpoint.search || endpoint.hash
      || isIP(endpoint.hostname.replace(/^\[|\]$/g, ''))
      || !address || !isIP(address) || !/^\d+$/.test(values['lan-port'])
      || port < 1 || port > 65535) throw new Error('invalid MCP endpoint');
  const token = process.env.UNI_MEMORY_TOKEN?.trim();
  if (!token || !/^[A-Za-z0-9._~+/=-]+$/.test(token)) throw new Error('invalid MCP token');

  const agent = new Agent({ keepAlive: true });
  const direct = lanFetch(endpoint, address, port, agent);
  let useLan = false;
  try {
    const probe = await direct(new URL('/readyz', endpoint), { signal: AbortSignal.timeout(250) });
    if (probe.status === 200) {
      const status = await probe.json();
      useLan = status?.database === true && status.qdrant === true;
    } else await probe.body?.cancel();
  } catch { /* 探测失败时才选择已配置的公网入口。 */ }
  if (!useLan) agent.destroy();

  const remote = new StreamableHTTPClientTransport(endpoint, {
    ...(useLan ? { fetch: direct } : {}),
    requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
  });
  const local = new StdioServerTransport();
  console.error(`uni-memory MCP: ${useLan ? 'LAN HTTPS' : 'public HTTPS'}`);
  local.onclose = () => { void remote.close(); agent.destroy(); };
  remote.onmessage = message => {
    const version = message.result?.protocolVersion;
    if (typeof version === 'string') remote.setProtocolVersion(version);
    void local.send(message).catch(() => {});
  };
  local.onmessage = message => {
    void remote.send(message).catch(() => {
      if ('method' in message && 'id' in message) {
        void local.send({
          jsonrpc: '2.0', id: message.id,
          error: { code: -32000, message: 'uni-memory upstream request failed' },
        }).catch(() => {});
      }
    });
  };
  await remote.start();
  await local.start();
}

run().catch(() => {
  console.error('uni-memory MCP: expected --public-url HTTPS_URL/mcp --lan-address IP [--lan-port PORT] and UNI_MEMORY_TOKEN');
  process.exitCode = 1;
});
