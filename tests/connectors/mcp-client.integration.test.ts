import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { MCPClient } from '../../src/connectors/mcp-client.js';
import type { MCPTransportConfig } from '../../src/connectors/mcp-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER_PATH = resolve(__dirname, '../fixtures/mcp/stdio-test-server.mjs');

/**
 * Integration tests for the MCP client. We spin up real MCP servers in
 * different shapes — a stdio subprocess, an HTTP listener, a deliberately
 * broken endpoint — and exercise the client end-to-end without mocking the
 * SDK. The fixtures live in tests/fixtures/mcp/ so they can be reused.
 */

describe('MCPClient — stdio transport', () => {
  it('happy path: connects to a real stdio MCP server and lists tools', async () => {
    const cfg: MCPTransportConfig = {
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    };
    const client = new MCPClient(cfg);
    const result = await client.listTools();
    await client.close();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.tools.map(t => t.name).sort();
    expect(names).toEqual(['echo', 'fake_delete', 'list_files']);
    const del = result.value.tools.find(t => t.name === 'fake_delete');
    expect(del?.annotations).toMatchObject({ destructiveHint: true });
  }, 15_000);

  it('connection failure: stdio command that does not exist returns connection error', async () => {
    const cfg: MCPTransportConfig = {
      kind: 'stdio',
      command: '/nonexistent/path/to/a/binary-that-does-not-exist',
      args: [],
    };
    const client = new MCPClient(cfg);
    const result = await client.listTools();
    await client.close().catch(() => undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('connection');
  }, 15_000);
});

describe('MCPClient — http transport', () => {
  let httpServer: Server;
  let port: number;
  let bearer: string;

  beforeAll(async () => {
    bearer = 'sk-test-' + Math.random().toString(36).slice(2);

    // Create one McpServer and its Streamable HTTP transport, wired together
    // by the SDK. The HTTP server below validates Bearer auth and then hands
    // requests off to the transport.
    const mcp = new McpServer({ name: 'http-test-server', version: '0.0.1' });
    mcp.registerTool(
      'http_tool',
      {
        description: 'A tool only reachable over HTTP.',
        inputSchema: { msg: z.string().describe('message to echo back') },
      },
      async ({ msg }) => ({ content: [{ type: 'text', text: msg }] }),
    );

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);

    httpServer = createServer(async (req, res) => {
      // Crude bearer check — good enough for the auth-failure path.
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${bearer}`) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      // Buffer request body, then defer to the transport.
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const bodyStr = Buffer.concat(chunks).toString('utf8');
        let body: unknown;
        try {
          body = bodyStr.length > 0 ? JSON.parse(bodyStr) : undefined;
        } catch {
          body = undefined;
        }
        transport.handleRequest(req, res, body).catch((err) => {
          // The transport handles its own error responses; only surface
          // unhandled rejections in test output.
          // eslint-disable-next-line no-console
          console.error('transport.handleRequest threw', err);
        });
      });
    });

    await new Promise<void>((resolveListen) => {
      httpServer.listen(0, '127.0.0.1', () => resolveListen());
    });
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => httpServer.close(() => r()));
  });

  it('happy path: connects over HTTP with bearer auth and lists tools', async () => {
    const cfg: MCPTransportConfig = {
      kind: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
      bearerToken: bearer,
    };
    const client = new MCPClient(cfg);
    const result = await client.listTools();
    await client.close();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tools.map(t => t.name)).toContain('http_tool');
  }, 15_000);

  it('auth failure: missing/incorrect bearer surfaces as auth error', async () => {
    const cfg: MCPTransportConfig = {
      kind: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
      bearerToken: 'wrong-token',
    };
    const client = new MCPClient(cfg);
    const result = await client.listTools();
    await client.close().catch(() => undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('auth');
  }, 15_000);
});
