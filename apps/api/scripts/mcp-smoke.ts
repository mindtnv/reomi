import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mcpClientConfig } from './mcp-client-config.ts';

const { url, headers } = mcpClientConfig();
const client = new Client({ name: 'reomi-smoke', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  const [tools, resources, prompts] = await Promise.all([client.listTools(), client.listResources(), client.listPrompts()]);
  const read = await client.callTool({ name: 'list_decks', arguments: {} });
  if (read.isError) throw new Error('Knowledge read failed');
  const connection = await client.readResource({ uri: 'reomi://connection' });
  console.log(JSON.stringify({ endpoint: url.origin + url.pathname, server: client.getServerVersion(), toolCount: tools.tools.length, resourceCount: resources.resources.length, promptCount: prompts.prompts.length, read: 'ok', connection: connection.contents.map(c => 'text' in c ? JSON.parse(c.text) : null) }, null, 2));
} catch {
  console.error('MCP smoke check failed. Check the endpoint, token expiry/scope and API readiness.');
  process.exitCode = 1;
} finally { await client.close(); }
