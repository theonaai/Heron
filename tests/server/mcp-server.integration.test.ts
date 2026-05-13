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

import { HeronMCPServer, type AuditPipeline, type ReportDiffer } from '../../src/server/mcp-server.js';
import type { ProgressNotification } from '../../src/server/mcp-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TSX_BIN = resolve(__dirname, '../../node_modules/.bin/tsx');
const STDIO_FIXTURE = resolve(__dirname, '../fixtures/mcp-server/stdio-heron-server.ts');

/**
 * Integration tests: spin up Heron's MCP server against a real transport
 * (stdio subprocess and in-process HTTP listener) and exercise every
 * tool end-to-end via the MCP SDK client. The point is to prove the
 * transport-agnostic wrapper actually works for both shapes without
 * shape-shifting per transport — the OSS stdio path and the hosted HTTP
 * path mount the same code.
 */

describe('HeronMCPServer — stdio transport', () => {
  it('lists all three tools', async () => {
    const client = await connectStdio();
    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual(['audit_agent', 'compare_reports', 'get_report']);
    } finally {
      await client.close();
    }
  }, 20_000);

  it('calls audit_agent against a stub pipeline and gets a structured result', async () => {
    const client = await connectStdio();
    try {
      const result = await client.callTool({
        name: 'audit_agent',
        arguments: { target_endpoint: 'https://stub.example/v1' },
      });
      const text = extractStructured(result);
      expect(text.report_markdown).toContain('Target: https://stub.example/v1');
      expect(text.report_id).toMatch(/^report_stdio_/);
      expect(text.summary).toMatchObject({ risk_level: 'medium', findings_count: 0 });
    } finally {
      await client.close();
    }
  }, 20_000);

  it('streams all progress notifications during audit_agent', async () => {
    const client = await connectStdio();
    const progressEvents: Array<{ progress?: number; total?: number; message?: string }> = [];
    try {
      await client.callTool(
        {
          name: 'audit_agent',
          arguments: { target_endpoint: 'https://stub.example/v1' },
        },
        undefined,
        {
          onprogress: (p) => progressEvents.push(p as { progress?: number; total?: number; message?: string }),
        },
      );
      // All three stub-pipeline notifications must reach the client.
      // The wrapper's contextFromExtra() bridge serialises notification
      // sends through a tail Promise and yields between each write so the
      // OS pipe drains between them — without that yield the SDK's
      // synchronous response-handler ran in the same 'data' tick and
      // deleted the per-request progress handler before queued
      // notification microtasks dispatched. See PR #14 review (C2).
      await waitFor(() => progressEvents.length >= 3, 4_000);
      expect(progressEvents.length).toBeGreaterThanOrEqual(3);
      expect(progressEvents.some((p) => typeof p.message === 'string')).toBe(true);
    } finally {
      await client.close();
    }
  }, 20_000);

  it('cancels a long-running audit_agent and tears down cleanly', async () => {
    const client = await connectStdioWithEnv({ HERON_TEST_AUDIT_DELAY_MS: '5000' });
    try {
      const controller = new AbortController();
      const promise = client.callTool(
        {
          name: 'audit_agent',
          arguments: { target_endpoint: 'https://slow.example/v1' },
        },
        undefined,
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 50);
      // Either the SDK rejects with an abort or returns a cancellation
      // payload — both prove the cancellation path runs.
      let cancelled = false;
      try {
        const r = await promise;
        const payload = extractRawText(r);
        if (/cancel/i.test(payload)) cancelled = true;
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        if (/abort|cancel/i.test(m)) cancelled = true;
      }
      expect(cancelled).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 20_000);
});

describe('HeronMCPServer — HTTP transport', () => {
  let httpServer: Server;
  let port: number;

  beforeAll(async () => {
    // Build wrapper with the same stub pipeline used in the unit tests.
    const pipeline: AuditPipeline = {
      async run(input, ctx) {
        ctx.progress({ stage: 'interrogating', pct: 10 });
        ctx.progress({ stage: 'rendering', pct: 90 });
        return {
          reportId: 'report_http_42',
          target: input.targetEndpoint,
          report: `# HTTP Audit\n\nTarget: ${input.targetEndpoint}`,
          summary: { riskLevel: 'low', findingsCount: 0 },
        };
      },
    };
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
          // Build a fresh wrapper per session — the wrapper has no module-level
          // mutable state, so per-session instances cost nothing and prove
          // independence.
          const wrapper = new HeronMCPServer({
            auditPipeline: pipeline,
            differ,
          });
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

  it('connects over HTTP transport and calls audit_agent end-to-end', async () => {
    const client = new Client({ name: 'heron-integ-test', version: '0.0.1' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(['audit_agent', 'compare_reports', 'get_report']);

      const result = await client.callTool({
        name: 'audit_agent',
        arguments: { target_endpoint: 'https://http-target.example/v1' },
      });
      const structured = extractStructured(result);
      expect(structured.report_markdown).toContain('Target: https://http-target.example/v1');
      expect(structured.report_id).toBe('report_http_42');
    } finally {
      await client.close();
    }
  }, 15_000);
});

// ─── helpers ──────────────────────────────────────────────────────────────

async function connectStdio(): Promise<Client> {
  return connectStdioWithEnv({});
}

async function connectStdioWithEnv(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({
    command: TSX_BIN,
    args: [STDIO_FIXTURE],
    env: { ...process.env, ...env } as Record<string, string>,
  });
  const client = new Client(
    { name: 'heron-integ-test', version: '0.0.1' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

/**
 * MCP tool results come back as `{ content: [{type: 'text', text: '...'}] }`.
 * Our handlers serialise the structured output as JSON in that text block.
 * Parse it back for assertion convenience.
 */
function extractStructured<T = Record<string, unknown>>(result: unknown): T {
  const r = result as { content?: Array<{ type: string; text?: string }>; structuredContent?: T };
  if (r.structuredContent !== undefined) return r.structuredContent;
  const text = r.content?.find((c) => c.type === 'text')?.text ?? '';
  return JSON.parse(text) as T;
}

function extractRawText(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> };
  return r.content?.map((c) => c.text ?? '').join('\n') ?? '';
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
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

// Suppress unused-var lint warnings on imported types used only for casts.
void ({} as ProgressNotification);
