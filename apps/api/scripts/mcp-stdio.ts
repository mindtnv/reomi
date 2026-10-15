// Transport bridge for clients that only launch local stdio servers. Domain
// authorization and confirmation remain on the remote Reomi HTTP server.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mcpClientConfig } from './mcp-client-config.ts';

const { url, headers } = mcpClientConfig();
const local = new StdioServerTransport();
const remote = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await Promise.allSettled([local.close(), remote.close()]);
}
remote.onmessage = message => { void local.send(message).catch(() => close()); };
local.onmessage = message => {
  void remote.send(message).catch(async () => {
    if ('id' in message && 'method' in message) await local.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Reomi connection failed; check endpoint and token.' } });
  });
};
local.onclose = () => { void close(); };
local.onerror = remote.onerror = () => { console.error('Reomi MCP transport error.'); };
process.on('SIGTERM', () => { void close(); });
process.on('SIGINT', () => { void close(); });
await remote.start();
await local.start();
