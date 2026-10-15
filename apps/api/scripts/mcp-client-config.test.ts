import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpClientConfig } from './mcp-client-config.ts';

const TOKEN = `nn_pat_${'a'.repeat(43)}`;
const OTHER = `nn_pat_${'b'.repeat(43)}`;
const KEYS = ['REOMI_MCP_URL', 'REOMI_MCP_TOKEN', 'REOMI_MCP_TOKEN_FILE', 'NEURONEXUS_MCP_URL', 'NEURONEXUS_MCP_TOKEN', 'NEURONEXUS_MCP_TOKEN_FILE'] as const;
const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

function clear() {
  for (const key of KEYS) delete process.env[key];
}

describe('MCP client bridge', () => {
  test('the historical NEURONEXUS_MCP variables are enough', () => {
    clear();
    process.env.NEURONEXUS_MCP_URL = 'http://127.0.0.1:3000/mcp';
    process.env.NEURONEXUS_MCP_TOKEN = TOKEN;
    const config = mcpClientConfig();
    expect(config.url.href).toBe('http://127.0.0.1:3000/mcp');
    expect(config.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  test('REOMI_MCP wins when both pairs are set', () => {
    clear();
    process.env.NEURONEXUS_MCP_URL = 'http://127.0.0.1:3000/old';
    process.env.NEURONEXUS_MCP_TOKEN = OTHER;
    process.env.REOMI_MCP_URL = 'https://api.reomi.ru/mcp';
    process.env.REOMI_MCP_TOKEN = TOKEN;
    const config = mcpClientConfig();
    expect(config.url.href).toBe('https://api.reomi.ru/mcp');
    expect(config.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  test('a REOMI token file wins over the legacy token variable', () => {
    clear();
    const dir = mkdtempSync(join(tmpdir(), 'reomi-mcp-'));
    const file = join(dir, 'token');
    writeFileSync(file, `${TOKEN}\n`);
    chmodSync(file, 0o600);
    process.env.NEURONEXUS_MCP_URL = 'http://localhost:3000/mcp';
    process.env.NEURONEXUS_MCP_TOKEN = OTHER;
    process.env.REOMI_MCP_TOKEN_FILE = file;
    expect(mcpClientConfig().headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });
});
