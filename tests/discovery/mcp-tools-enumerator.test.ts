/**
 * AAP-75 — enumerator unit tests.
 *
 * These tests inject a fake MCPClient factory so the enumerator's
 * behavior is exercised without spinning up a real subprocess or HTTP
 * server. Integration coverage (real stdio MCP server end-to-end) is
 * in tests/discovery/mcp-tools-enumerator.integration.test.ts.
 */

import { describe, it, expect } from 'vitest';

import {
  enumerateMcpServerTools,
  enumerateAllServers,
  type McpClientFactory,
} from '../../src/discovery/mcp-tools-enumerator.js';
import type {
  DiscoveredMcpServer,
  DiscoveredAgent,
} from '../../src/discovery/types.js';
import type {
  MCPClientResult,
  ToolInventoryRecord,
} from '../../src/connectors/mcp-types.js';

const FIXED_TS = '2026-05-24T12:00:00.000Z';

function fixedNow(): Date {
  return new Date(FIXED_TS);
}

function fakeOk(tools: ToolInventoryRecord['tools']): McpClientFactory {
  return () => ({
    async listTools(): Promise<MCPClientResult<ToolInventoryRecord>> {
      return {
        ok: true,
        value: {
          server: 'fake',
          capturedAt: FIXED_TS,
          tools,
        },
      };
    },
    async close(): Promise<void> {
      /* noop */
    },
  });
}

function fakeError(
  kind: 'connection' | 'auth' | 'parse' | 'timeout',
  message: string,
): McpClientFactory {
  return () => ({
    async listTools(): Promise<MCPClientResult<ToolInventoryRecord>> {
      return { ok: false, error: { kind, message } };
    },
    async close(): Promise<void> {
      /* noop */
    },
  });
}

function fakeListToolsThrows(error: Error): McpClientFactory {
  return () => ({
    async listTools(): Promise<MCPClientResult<ToolInventoryRecord>> {
      throw error;
    },
    async close(): Promise<void> {
      /* noop */
    },
  });
}

const stdioServer = (overrides: Partial<DiscoveredMcpServer> = {}): DiscoveredMcpServer => ({
  name: 'filesystem',
  transport: 'stdio',
  command: '/bin/echo',
  args: ['hi'],
  hasCredentials: false,
  redactedEnvKeys: [],
  ...overrides,
});

const httpServer = (overrides: Partial<DiscoveredMcpServer> = {}): DiscoveredMcpServer => ({
  name: 'remote-vendor',
  transport: 'http',
  url: 'https://mcp.example.com/v1',
  hasCredentials: false,
  redactedEnvKeys: [],
  ...overrides,
});

describe('enumerateMcpServerTools — stdio happy path', () => {
  it('returns state=ok with classified tools', async () => {
    const factory = fakeOk([
      { name: 'read_file', description: 'Read a file from disk.' },
      { name: 'write_file', description: 'Write a file to disk.' },
      { name: 'list_directory', description: 'List directory entries.' },
      { name: 'echo', description: 'Echo input back.' },
    ]);
    const result = await enumerateMcpServerTools(stdioServer(), {
      clientFactory: factory,
      now: fixedNow,
    });
    expect(result.state).toBe('ok');
    expect(result.attemptedAt).toBe(FIXED_TS);
    expect(result.tools).toHaveLength(4);
    const byName = Object.fromEntries(
      (result.tools ?? []).map((t) => [t.name, t.classification]),
    );
    expect(byName.read_file).toBe('read');
    expect(byName.write_file).toBe('write');
    expect(byName.list_directory).toBe('read');
    // 'echo' has no semantic match → unknown
    expect(byName.echo).toBe('unknown');
  });

  it('attaches description and inputSchema when provided', async () => {
    const factory = fakeOk([
      {
        name: 'read_file',
        description: 'Read a file from disk.',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]);
    const result = await enumerateMcpServerTools(stdioServer(), {
      clientFactory: factory,
      now: fixedNow,
    });
    expect(result.state).toBe('ok');
    expect(result.tools?.[0].description).toBe('Read a file from disk.');
    expect(result.tools?.[0].inputSchema).toMatchObject({
      type: 'object',
    });
  });

  it('honours allowlist for slack.send_message', async () => {
    const factory = fakeOk([{ name: 'send_message' }]);
    const result = await enumerateMcpServerTools(
      stdioServer({ name: 'slack' }),
      { clientFactory: factory, now: fixedNow },
    );
    expect(result.state).toBe('ok');
    expect(result.tools?.[0].classification).toBe('write');
  });
});

describe('enumerateMcpServerTools — failure modes', () => {
  it('connect failure -> state=failed with connect_failed reason', async () => {
    const factory = fakeError('connection', 'ECONNREFUSED');
    const result = await enumerateMcpServerTools(stdioServer(), {
      clientFactory: factory,
      now: fixedNow,
    });
    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/^connect_failed/);
    expect(result.attemptedAt).toBe(FIXED_TS);
    expect(result.tools).toBeUndefined();
  });

  it('auth failure -> state=failed with auth_failed reason', async () => {
    const factory = fakeError('auth', '401 unauthorized');
    const result = await enumerateMcpServerTools(stdioServer(), {
      clientFactory: factory,
      now: fixedNow,
    });
    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/^auth_failed/);
  });

  it('parse failure -> state=failed with parse_failed reason', async () => {
    const factory = fakeError('parse', 'unexpected token');
    const result = await enumerateMcpServerTools(stdioServer(), {
      clientFactory: factory,
      now: fixedNow,
    });
    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/^parse_failed/);
  });

  it('listTools throwing is caught and reported as unexpected', async () => {
    const factory = fakeListToolsThrows(new Error('boom'));
    const result = await enumerateMcpServerTools(stdioServer(), {
      clientFactory: factory,
      now: fixedNow,
    });
    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/^unexpected/);
  });

  it('timeout in listTools is reported as timeout', async () => {
    const slowFactory: McpClientFactory = () => ({
      listTools(): Promise<MCPClientResult<ToolInventoryRecord>> {
        return new Promise((resolve) => {
          setTimeout(
            () => resolve({ ok: true, value: { server: 'x', capturedAt: FIXED_TS, tools: [] } }),
            500,
          );
        });
      },
      async close(): Promise<void> {
        /* noop */
      },
    });
    const result = await enumerateMcpServerTools(stdioServer(), {
      clientFactory: slowFactory,
      timeoutMs: 30,
      now: fixedNow,
    });
    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/^timeout/);
  });

  it('stdio config missing command -> state=failed invalid_config', async () => {
    const factory = fakeOk([]);
    const broken = stdioServer({ command: undefined });
    const result = await enumerateMcpServerTools(broken, {
      clientFactory: factory,
      now: fixedNow,
    });
    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/invalid_config/);
  });
});

describe('enumerateMcpServerTools — http transport requires auth', () => {
  it('http without resolver -> state=skipped no_credential', async () => {
    const factory = fakeOk([{ name: 'read_x' }]);
    const result = await enumerateMcpServerTools(httpServer(), {
      clientFactory: factory,
      now: fixedNow,
    });
    expect(result.state).toBe('skipped');
    expect(result.reason).toMatch(/no_credential/);
  });

  it('http with resolver that returns null -> state=skipped no_credential', async () => {
    const factory = fakeOk([{ name: 'read_x' }]);
    const result = await enumerateMcpServerTools(httpServer(), {
      clientFactory: factory,
      httpAuthResolver: () => null,
      now: fixedNow,
    });
    expect(result.state).toBe('skipped');
    expect(result.reason).toMatch(/no_credential/);
  });

  it('http with resolver token -> state=ok', async () => {
    const factory = fakeOk([
      { name: 'send_message' },
      { name: 'read_channel' },
    ]);
    const result = await enumerateMcpServerTools(
      httpServer({ name: 'slack' }),
      {
        clientFactory: factory,
        httpAuthResolver: () => 'fake-bearer-token',
        now: fixedNow,
      },
    );
    expect(result.state).toBe('ok');
    expect(result.tools?.find((t) => t.name === 'send_message')?.classification).toBe('write');
    expect(result.tools?.find((t) => t.name === 'read_channel')?.classification).toBe('read');
  });

  it('http resolver that throws -> state=failed auth_resolver_threw', async () => {
    const factory = fakeOk([]);
    const result = await enumerateMcpServerTools(httpServer(), {
      clientFactory: factory,
      httpAuthResolver: () => {
        throw new Error('vault unavailable');
      },
      now: fixedNow,
    });
    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/auth_resolver_threw/);
  });

  it('http config missing url -> state=failed invalid_config', async () => {
    const factory = fakeOk([]);
    const broken = httpServer({ url: undefined });
    const result = await enumerateMcpServerTools(broken, {
      clientFactory: factory,
      httpAuthResolver: () => 'token',
      now: fixedNow,
    });
    expect(result.state).toBe('failed');
    expect(result.reason).toMatch(/invalid_config/);
  });
});

describe('enumerateAllServers — bulk over agents[]', () => {
  it('attaches toolEnumeration to every mcpServer entry', async () => {
    const agents: DiscoveredAgent[] = [
      {
        runtime: 'claude-code',
        configPath: '/home/x/.claude/mcp.json',
        mcpServers: [
          stdioServer({ name: 'filesystem' }),
          stdioServer({ name: 'github', command: '/bin/echo' }),
        ],
        capabilities: [],
      },
    ];
    const factory = fakeOk([
      { name: 'read_file' },
      { name: 'write_file' },
    ]);
    await enumerateAllServers(agents, { clientFactory: factory, now: fixedNow });
    expect(agents[0].mcpServers).toHaveLength(2);
    for (const s of agents[0].mcpServers) {
      expect(s.toolEnumeration?.state).toBe('ok');
      expect(s.toolEnumeration?.tools).toHaveLength(2);
    }
  });

  it('does not re-enumerate servers that already carry toolEnumeration', async () => {
    let calls = 0;
    const factory: McpClientFactory = () => ({
      async listTools(): Promise<MCPClientResult<ToolInventoryRecord>> {
        calls += 1;
        return { ok: true, value: { server: 'x', capturedAt: FIXED_TS, tools: [] } };
      },
      async close(): Promise<void> {},
    });
    const agents: DiscoveredAgent[] = [
      {
        runtime: 'claude-code',
        configPath: '/x',
        mcpServers: [
          stdioServer({
            toolEnumeration: {
              state: 'ok',
              tools: [],
              attemptedAt: '2026-01-01T00:00:00.000Z',
            },
          }),
          stdioServer({ name: 'second' }),
        ],
        capabilities: [],
      },
    ];
    await enumerateAllServers(agents, { clientFactory: factory, now: fixedNow });
    // Only the second server should have been enumerated this pass.
    expect(calls).toBe(1);
  });

  it('one failing server does not prevent another from enumerating', async () => {
    const okFactory = fakeOk([{ name: 'read_x' }]);
    const failFactory = fakeError('connection', 'down');
    const agents: DiscoveredAgent[] = [
      {
        runtime: 'claude-code',
        configPath: '/x',
        mcpServers: [
          stdioServer({ name: 'good' }),
          stdioServer({ name: 'bad' }),
        ],
        capabilities: [],
      },
    ];
    // Mixed factory: chooses based on server name.
    const factory: McpClientFactory = (config) => {
      if (config.kind === 'stdio') {
        // We can't see the server name directly, so use args/command to disambiguate.
        // The fake stdioServer helper sets command = /bin/echo with args=['hi']
        // for both, so we use a different mechanism: counter.
      }
      return (callIdx++ % 2 === 0 ? okFactory(config) : failFactory(config));
    };
    let callIdx = 0;
    await enumerateAllServers(agents, { clientFactory: factory, now: fixedNow });
    const states = agents[0].mcpServers.map((s) => s.toolEnumeration?.state);
    expect(states).toContain('ok');
    expect(states).toContain('failed');
  });
});
