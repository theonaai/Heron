/**
 * AAP-75 — enumerator integration test.
 *
 * Uses the existing stdio MCP server fixture in
 * tests/fixtures/mcp/stdio-test-server.mjs to exercise the enumerator
 * end-to-end: real subprocess spawn, real stdio JSON-RPC, real
 * `tools/list` response. Asserts the classification surfaces correctly
 * for the fixture's three tools (echo, list_files, fake_delete).
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { enumerateMcpServerTools } from '../../src/discovery/mcp-tools-enumerator.js';
import type { DiscoveredMcpServer } from '../../src/discovery/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER_PATH = resolve(__dirname, '../fixtures/mcp/stdio-test-server.mjs');

describe('enumerateMcpServerTools — real stdio MCP server', () => {
  it('connects, lists, and classifies the fixture tools', async () => {
    const server: DiscoveredMcpServer = {
      name: 'stdio-fixture',
      transport: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
      hasCredentials: false,
      redactedEnvKeys: [],
    };
    const result = await enumerateMcpServerTools(server, { timeoutMs: 15_000 });
    expect(result.state).toBe('ok');
    const names = (result.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(['echo', 'fake_delete', 'list_files']);

    const byName = Object.fromEntries(
      (result.tools ?? []).map((t) => [t.name, t.classification]),
    );
    // `list_files` -> read (name + annotation both agree)
    expect(byName.list_files).toBe('read');
    // `fake_delete` -> write (annotation destructiveHint:true OR name `delete*`)
    expect(byName.fake_delete).toBe('write');
    // `echo` -> unknown by name heuristic; description doesn't help either.
    expect(byName.echo).toBe('unknown');
  }, 30_000);
});
