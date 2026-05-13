import { describe, it, expect } from 'vitest';
import type {
  MCPTransportConfig,
  ToolInventoryRecord,
  MCPClientError,
  MCPClientResult,
  MCPToolEntry,
} from '../../src/connectors/mcp-types.js';

/**
 * Lock-the-contract tests for the shared MCP types. These run at runtime but
 * are really there to fail the build if someone widens the public shape of
 * the types (e.g. drops a discriminant, adds a required field). Both Role A
 * (this PR) and Role B (follow-up PR) read from the same types module, so
 * keeping the shape stable is the whole reason they live in their own file.
 */
describe('MCP shared types', () => {
  it('MCPTransportConfig accepts a stdio config', () => {
    const cfg: MCPTransportConfig = { kind: 'stdio', command: 'node', args: ['server.js'] };
    expect(cfg.kind).toBe('stdio');
  });

  it('MCPTransportConfig accepts an http config with bearer', () => {
    const cfg: MCPTransportConfig = {
      kind: 'http',
      url: 'https://example.com/mcp',
      bearerToken: 'secret',
    };
    expect(cfg.kind).toBe('http');
  });

  it('ToolInventoryRecord requires server, tools, capturedAt', () => {
    const rec: ToolInventoryRecord = {
      server: 'stdio:node server.js',
      tools: [],
      capturedAt: new Date().toISOString(),
    };
    expect(rec.tools).toHaveLength(0);
  });

  it('MCPToolEntry preserves _extra fields', () => {
    const entry: MCPToolEntry = {
      name: 'foo',
      _extra: { customField: 'value' },
    };
    expect(entry._extra?.customField).toBe('value');
  });

  it('MCPClientError discriminates on kind', () => {
    const kinds: MCPClientError['kind'][] = ['connection', 'auth', 'parse', 'timeout'];
    expect(kinds).toHaveLength(4);
  });

  it('MCPClientResult discriminates on ok', () => {
    const ok: MCPClientResult<number> = { ok: true, value: 1 };
    const err: MCPClientResult<number> = {
      ok: false,
      error: { kind: 'connection', message: 'boom' },
    };
    if (ok.ok) expect(ok.value).toBe(1);
    if (!err.ok) expect(err.error.kind).toBe('connection');
  });
});
