import { readFileSync, statSync } from 'node:fs';

function readToken(envName: string, fileName: string): string | undefined {
  const inline = process.env[envName]?.trim();
  if (inline) return inline;
  const tokenFile = process.env[fileName]?.trim();
  if (!tokenFile) return undefined;
  const stat = statSync(tokenFile);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('The token file must be private: chmod 600 <token-file>.');
  return readFileSync(tokenFile, 'utf8').trim();
}

function preferred(primary: string | undefined, alias: string | undefined): string | undefined {
  const next = primary?.trim();
  if (next) return next;
  const previous = alias?.trim();
  return previous || undefined;
}

/** Shared by smoke check and stdio bridge. Never print the returned headers.
 * `REOMI_MCP_*` is canonical. `NEURONEXUS_MCP_*` remains an alias and loses when both are set. */
export function mcpClientConfig() {
  const endpoint = preferred(process.env.REOMI_MCP_URL, process.env.NEURONEXUS_MCP_URL);
  if (!endpoint) throw new Error('Set REOMI_MCP_URL or NEURONEXUS_MCP_URL to the API /mcp endpoint.');
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('REOMI_MCP_URL must be a valid URL.'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('The MCP URL must not contain credentials, query parameters or fragments.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    throw new Error('Use HTTPS for remote MCP connections. Plain HTTP is limited to loopback.');
  const token = readToken('REOMI_MCP_TOKEN', 'REOMI_MCP_TOKEN_FILE')
    ?? readToken('NEURONEXUS_MCP_TOKEN', 'NEURONEXUS_MCP_TOKEN_FILE');
  if (!token || !/^nn_pat_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Set REOMI_MCP_TOKEN or NEURONEXUS_MCP_TOKEN to a valid personal token.');
  return { url, headers: { Authorization: `Bearer ${token}` } };
}
