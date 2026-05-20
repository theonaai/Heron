import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { HeronMCPServer, type ReportDiffer } from '../../src/server/mcp-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TSX_BIN = resolve(__dirname, '../../node_modules/.bin/tsx');
const STDIO_FIXTURE = resolve(__dirname, '../fixtures/mcp-server/stdio-heron-server.ts');

/**
 * Integration tests: spin up Heron's MCP server against a real transport
 * (stdio subprocess and in-process HTTP listener) and exercise the
 * tool registry end-to-end via the MCP SDK client. AAP-52 removed
 * audit_agent; the surface verified here is the three remaining tools.
 * start_audit_session has its own dedicated E2E test
 * (sampling-e2e.test.ts) so this file only proves the wrapper still
 * lists and routes correctly under both transports.
 */

describe('HeronMCPServer — stdio transport', () => {
  it('lists the four MCP tools', async () => {
    const client = await connectStdio();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'compare_reports',
        'get_report',
        'start_audit_session',
        'submit_answer',
      ]);
    } finally {
      await client.close();
    }
  }, 20_000);
});

describe('HeronMCPServer — HTTP transport', () => {
  let httpServer: Server;
  let port: number;

  beforeAll(async () => {
    const differ: ReportDiffer = {
      async diff() { return '## Summary\nhttp diff'; },
    };

    const transports: Record<string, StreamableHTTPServerTransport> = {};
    httpServer = createServer(async (req, res) => {
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
          // Build a fresh wrapper per session — the wrapper has no
          // module-level mutable state, so per-session instances cost
          // nothing and prove independence.
          const wrapper = new HeronMCPServer({ differ });
          const mcpServer = wrapper.buildMcpServer();
          await mcpServer.connect(transport);
        }
        await transport.handleRequest(req, res, body);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('HTTP transport error', err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        }
      }
    });
    await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', () => r()));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => httpServer.close(() => r()));
  });

  it('connects over HTTP transport and lists the four MCP tools', async () => {
    const client = new Client({ name: 'heron-integ-test', version: '0.0.1' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual([
        'compare_reports',
        'get_report',
        'start_audit_session',
        'submit_answer',
      ]);
    } finally {
      await client.close();
    }
  }, 15_000);
});

// ─── helpers ──────────────────────────────────────────────────────────────

async function connectStdio(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: TSX_BIN,
    args: [STDIO_FIXTURE],
    env: { ...process.env } as Record<string, string>,
  });
  const client = new Client(
    { name: 'heron-integ-test', version: '0.0.1' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

function readBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolveBody(undefined);
      try { resolveBody(JSON.parse(s)); } catch (e) { rejectBody(e); }
    });
    req.on('error', rejectBody);
  });
}
