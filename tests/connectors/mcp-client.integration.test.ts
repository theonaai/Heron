import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
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

    // Factory: each new MCP session gets its own server + transport pair.
    // Matches the SDK's canonical streamable-HTTP setup (see
    // examples/server/simpleStreamableHttp.js).
    const buildServer = () => {
      const mcp = new McpServer({ name: 'http-test-server', version: '0.0.1' });
      mcp.registerTool(
        'http_tool',
        {
          description: 'A tool only reachable over HTTP.',
          inputSchema: { msg: z.string().describe('message to echo back') },
        },
        async ({ msg }) => ({ content: [{ type: 'text', text: msg }] }),
      );
      return mcp;
    };

    // Buffer body once per request so we can both (a) sniff for the
    // initialize message and (b) hand it to handleRequest as parsedBody.
    const readBody = (req: import('node:http').IncomingMessage): Promise<unknown> =>
      new Promise((resolveBody, rejectBody) => {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c as Buffer));
        req.on('end', () => {
          const s = Buffer.concat(chunks).toString('utf8');
          if (!s) return resolveBody(undefined);
          try { resolveBody(JSON.parse(s)); } catch (e) { rejectBody(e); }
        });
        req.on('error', rejectBody);
      });

    const transports: Record<string, StreamableHTTPServerTransport> = {};

    httpServer = createServer(async (req, res) => {
      // Crude bearer check — good enough for the auth-failure path.
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${bearer}`) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      try {
        const body = await readBody(req);
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: StreamableHTTPServerTransport | undefined =
          sessionId ? transports[sessionId] : undefined;

        if (!transport) {
          if (!isInitializeRequest(body)) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
              jsonrpc: '2.0', id: null,
              error: { code: -32000, message: 'Bad Request: no session and not initialize' },
            }));
            return;
          }
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized: (sid) => { transports[sid] = transport!; },
          });
          const mcp = buildServer();
          await mcp.connect(transport);
        }

        await transport.handleRequest(req, res, body);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('transport.handleRequest threw', err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      }
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
