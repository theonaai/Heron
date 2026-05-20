import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { runMcpServe } from '../../src/commands/mcp-serve.js';

/**
 * Direct integration test for `startHttpServer` in `src/commands/mcp-serve.ts`.
 *
 * The other HTTP integration test (`mcp-server.integration.test.ts`) wires
 * its own `createServer` listener. That covers the wrapper, but NOT the
 * `startHttpServer` path that the production CLI (`heron mcp-serve --port`)
 * actually runs and that AAP-47 hosted will mount. This test fills that
 * gap: spin up the real `runMcpServe` HTTP entry point on an OS-assigned
 * port, then drive `tools/list` and `tools/call` through the SDK HTTP
 * client.
 *
 * Wired against a fake Anthropic key — start_audit_session would
 * normally call out to a real LLM via sampling/createMessage, but we
 * don't invoke it here. The point is to prove the wire-up: server
 * actually binds, listens, exposes the locked tool surface, and shuts
 * down cleanly.
 */

describe('runMcpServe — HTTP transport (direct integration)', () => {
  let handle: { close: () => Promise<void>; port?: number };
  let port: number;

  beforeAll(async () => {
    process.env.HERON_LLM_API_KEY = process.env.HERON_LLM_API_KEY ?? 'sk-ant-fake-http';
    const dir = mkdtempSync(resolve(tmpdir(), 'heron-mcp-http-'));
    handle = await runMcpServe({ port: 0, reportDir: dir });
    if (handle.port === undefined) {
      throw new Error('runMcpServe returned no port for HTTP mode');
    }
    port = handle.port;
  }, 15_000);

  afterAll(async () => {
    if (handle) {
      await handle.close();
    }
  });

  it('binds an OS-assigned port and returns it in the handle', () => {
    // `listen(0, ...)` must produce a positive bound port.
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);
  });

  it('lists all four tools through the streamable HTTP transport', async () => {
    const client = new Client(
      { name: 'heron-http-direct-test', version: '0.0.1' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );
    await client.connect(transport);
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
  }, 15_000);

  it('rejects malformed report_id over the HTTP wire (security guard surfaces end-to-end)', async () => {
    // get_report with a traversal-shaped id must come back as a typed
    // invalid_input error — not an unhandled exception, not a 5xx.
    const client = new Client(
      { name: 'heron-http-direct-test', version: '0.0.1' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: 'get_report',
        arguments: { report_id: '../../../etc/passwd' },
      });
      const r = result as {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
      };
      expect(r.isError).toBe(true);
      const text = r.content?.map((c) => c.text ?? '').join('\n') ?? '';
      expect(text).toMatch(/invalid_input/i);
      expect(text).toMatch(/report_id/i);
    } finally {
      await client.close();
    }
  }, 15_000);

  it('returns tool_failure for a well-formed but unknown report_id', async () => {
    const client = new Client(
      { name: 'heron-http-direct-test', version: '0.0.1' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    );
    await client.connect(transport);
    try {
      const result = await client.callTool({
        name: 'get_report',
        arguments: { report_id: 'report_aaaaaaaaaaaaaaaa' },
      });
      const r = result as {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
      };
      expect(r.isError).toBe(true);
      const text = r.content?.map((c) => c.text ?? '').join('\n') ?? '';
      // Either "not found" via the store, or a generic tool_failure —
      // both prove the request reached the handler and round-tripped a
      // structured error back across HTTP.
      expect(text).toMatch(/tool_failure|not found/i);
    } finally {
      await client.close();
    }
  }, 15_000);
});
