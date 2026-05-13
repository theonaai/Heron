import { describe, it, expect } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  HeronMCPServer,
  type AuditPipeline,
  type ReportDiffer,
} from '../../src/server/mcp-server.js';

/**
 * In-process exercise of the SDK-bridging code in `mcp-server.ts` —
 * `contextFromExtra` and its `sendTail`/`flush()` machinery. The stdio
 * integration test covers the same bridge end-to-end but runs the server
 * in a subprocess, so v8 coverage doesn't attribute the executed bytes
 * to `mcp-server.ts`. Linking a Client and a HeronMCPServer through an
 * `InMemoryTransport` pair gives us:
 *
 *   - The full SDK request/response loop (so `_meta.progressToken` is
 *     populated when the client subscribes to progress events).
 *   - The wrapper's `registerTool` callbacks actually run in this
 *     process, which gives coverage tracking on `contextFromExtra` and
 *     the `sendTail` chain that fixes C2.
 *
 * The pipeline emits 3 progress events; we assert all 3 reach the
 * client (this is the same invariant `mcp-server.integration.test.ts`
 * checks under stdio).
 */

describe('HeronMCPServer — in-process bridge coverage', () => {
  it('delivers every progress notification through contextFromExtra', async () => {
    const pipeline: AuditPipeline = {
      async run(input, ctx) {
        ctx.progress({ stage: 'interrogating', pct: 5, message: 'start' });
        ctx.progress({ stage: 'analyzing', pct: 50, message: 'middle' });
        ctx.progress({ stage: 'rendering', pct: 95 });
        return {
          reportId: 'report_inmem_42',
          target: input.targetEndpoint,
          report: `# In-memory Audit\n\nTarget: ${input.targetEndpoint}`,
          summary: { riskLevel: 'low', findingsCount: 0 },
        };
      },
    };
    const differ: ReportDiffer = {
      async diff() { return ''; },
    };

    const wrapper = new HeronMCPServer({ auditPipeline: pipeline, differ });
    const mcp = wrapper.buildMcpServer();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'inmem-test', version: '0.0.1' }, { capabilities: {} });

    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

    const events: Array<{ progress?: number; total?: number; message?: string }> = [];
    try {
      const result = await client.callTool(
        {
          name: 'audit_agent',
          arguments: { target_endpoint: 'inmem://target' },
        },
        undefined,
        {
          onprogress: (p) => events.push(p as { progress?: number; total?: number; message?: string }),
        },
      );

      // Tool succeeded.
      const structured = (result as { structuredContent?: { report_id?: string } })
        .structuredContent;
      expect(structured?.report_id).toBe('report_inmem_42');

      // Give any straggler microtasks a chance to flush (in-memory
      // transport dispatches synchronously, but the SDK still routes
      // notifications through Promise.resolve().then(...)).
      for (let i = 0; i < 20 && events.length < 3; i++) {
        await new Promise<void>((r) => setTimeout(r, 5));
      }
      expect(events.length).toBe(3);
      expect(events.map((e) => e.progress)).toEqual([5, 50, 95]);
    } finally {
      await client.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
    }
  }, 10_000);
});
