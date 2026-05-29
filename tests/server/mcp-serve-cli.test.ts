import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TSX_BIN = resolve(__dirname, '../../node_modules/.bin/tsx');
const HERON_BIN = resolve(__dirname, '../../bin/heron.ts');

/**
 * CLI smoke test: spawn `heron mcp-serve` (via tsx so we don't need a
 * build step) and verify a real MCP client can connect, list tools,
 * and see all three exposed tools by name.
 *
 * `get_report` is hit with an obviously-missing id — we only care that
 * the request round-trips and produces a structured tool_failure, not
 * that the sampling-driven interview ran (that needs a sampling-capable
 * MCP client; coverage lives in sampling-e2e.test.ts).
 */

describe('heron mcp-serve — stdio CLI', () => {
  it('launches as an MCP stdio server and answers tools/list', async () => {
    const transport = new StdioClientTransport({
      command: TSX_BIN,
      args: [HERON_BIN, 'mcp-serve', '--report-dir', '/tmp/heron-mcp-serve-cli-test'],
      env: {
        ...process.env,
        // Provide a dummy key so the LLM client constructor succeeds —
        // we never actually call the LLM in this test (we only do
        // listTools + a no-op get_report).
        HERON_LLM_API_KEY: 'sk-ant-fake-cli-smoke-key',
      } as Record<string, string>,
    });
    const client = new Client(
      { name: 'heron-cli-smoke', version: '0.0.1' },
      { capabilities: {} },
    );
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual([
        'compare_reports',
        'get_report',
        'report_mcp_tools_list',
        'report_oauth_scopes',
        'start_audit_session',
        'start_verification',
        'submit_answer',
      ]);

      // get_report against an unknown id should round-trip and report
      // tool_failure — that proves the handler is wired, the LLM
      // dependency loaded, and the transport works end-to-end.
      const result = await client.callTool({
        name: 'get_report',
        arguments: { report_id: 'report_does_not_exist_smoke' },
      });
      const r = result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
      expect(r.isError).toBe(true);
      const text = r.content?.[0]?.text ?? '';
      expect(text).toMatch(/tool_failure|report_not_found/);
    } finally {
      await client.close().catch(() => undefined);
    }
  }, 30_000);
});
