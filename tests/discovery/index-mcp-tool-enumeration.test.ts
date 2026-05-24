/**
 * AAP-75 — runDiscovery + MCP tool enumeration integration.
 *
 * Verifies the aggregator wiring: when `enableMcpToolEnumeration: true`
 * is passed, every discovered MCP server gets a `toolEnumeration` field
 * attached, and the capability mirror on `agent.capabilities` reflects
 * the same enumeration result. Uses a stub MCPClient factory so the test
 * doesn't shell out.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDiscovery } from '../../src/discovery/index.js';
import type {
  McpClientFactory,
} from '../../src/discovery/mcp-tools-enumerator.js';
import type {
  MCPClientResult,
  ToolInventoryRecord,
} from '../../src/connectors/mcp-types.js';

function okFactory(tools: ToolInventoryRecord['tools']): McpClientFactory {
  return () => ({
    async listTools(): Promise<MCPClientResult<ToolInventoryRecord>> {
      return {
        ok: true,
        value: {
          server: 'fake',
          capturedAt: '2026-05-24T12:00:00.000Z',
          tools,
        },
      };
    },
    async close(): Promise<void> {
      /* noop */
    },
  });
}

describe('runDiscovery — MCP tool enumeration wire-up (AAP-75)', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'heron-aap75-'));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('attaches toolEnumeration to each mcpServer when enabled', async () => {
    // Configure one Codex MCP server (stdio command so the enumerator
    // accepts the projection — http would need a credential resolver).
    await mkdir(join(homeDir, '.codex'), { recursive: true });
    await writeFile(
      join(homeDir, '.codex/config.toml'),
      `
[mcp_servers.filesystem]
command = "/bin/echo"
args = ["hi"]
`,
    );

    const result = await runDiscovery({
      homeDir,
      enableMcpToolEnumeration: true,
      mcpToolEnumeration: {
        clientFactory: okFactory([
          { name: 'read_file', description: 'Read a file from disk.' },
          { name: 'write_file', description: 'Write a file to disk.' },
        ]),
      },
    });

    expect(result.agents).toHaveLength(1);
    const codex = result.agents[0];
    expect(codex.mcpServers).toHaveLength(1);
    const server = codex.mcpServers[0];
    expect(server.toolEnumeration?.state).toBe('ok');
    expect(server.toolEnumeration?.tools).toHaveLength(2);
    const byName = Object.fromEntries(
      (server.toolEnumeration?.tools ?? []).map((t) => [t.name, t.classification]),
    );
    expect(byName.read_file).toBe('read');
    expect(byName.write_file).toBe('write');
  });

  it('mirrors toolEnumeration onto capabilities[] mcp_server entry', async () => {
    await mkdir(join(homeDir, '.codex'), { recursive: true });
    await writeFile(
      join(homeDir, '.codex/config.toml'),
      `
[mcp_servers.fs]
command = "/bin/echo"
args = []
`,
    );

    const result = await runDiscovery({
      homeDir,
      enableMcpToolEnumeration: true,
      mcpToolEnumeration: {
        clientFactory: okFactory([{ name: 'read_x' }]),
      },
    });

    const agent = result.agents[0];
    const mcpCap = agent.capabilities?.find((c) => c.kind === 'mcp_server');
    expect(mcpCap).toBeDefined();
    if (mcpCap?.kind !== 'mcp_server') throw new Error('expected mcp_server capability');
    expect(mcpCap.toolEnumeration?.state).toBe('ok');
    expect(mcpCap.toolEnumeration?.tools?.[0].name).toBe('read_x');
  });

  it('does not enumerate when enableMcpToolEnumeration is omitted', async () => {
    await mkdir(join(homeDir, '.codex'), { recursive: true });
    await writeFile(
      join(homeDir, '.codex/config.toml'),
      `
[mcp_servers.fs]
command = "/bin/echo"
args = []
`,
    );

    // No factory passed; if enumeration ran by mistake it would
    // actually spawn /bin/echo which exits without speaking MCP,
    // yielding state: 'failed' rather than undefined. The assertion
    // that toolEnumeration is undefined is the load-bearing one.
    const result = await runDiscovery({ homeDir });
    expect(result.agents[0].mcpServers[0].toolEnumeration).toBeUndefined();
  });

  it('http servers without credentials emit state=skipped', async () => {
    await mkdir(join(homeDir, '.codex'), { recursive: true });
    await writeFile(
      join(homeDir, '.codex/config.toml'),
      `
[mcp_servers.remote]
url = "https://example.com/mcp"
`,
    );

    const result = await runDiscovery({
      homeDir,
      enableMcpToolEnumeration: true,
      mcpToolEnumeration: {
        // No httpAuthResolver -> enumerator returns state: 'skipped'.
      },
    });

    expect(result.agents[0].mcpServers[0].toolEnumeration?.state).toBe('skipped');
    expect(result.agents[0].mcpServers[0].toolEnumeration?.reason).toMatch(/no_credential/);
  });
});
