#!/usr/bin/env tsx
// Launch Heron's MCP server in stdio mode using a stub audit pipeline so
// integration tests do not need an LLM key or a live target.
//
// Same wrapper that ships under `heron mcp-serve`; only the audit
// dependency is swapped for a deterministic stub.

import { startStdioMCPServer, type AuditPipeline, type ReportDiffer } from '../../../src/server/mcp-server.js';

const stubPipeline: AuditPipeline = {
  async run(input, ctx) {
    ctx.progress({ stage: 'interrogating', pct: 5, message: 'stub start' });
    if (process.env.HERON_TEST_AUDIT_DELAY_MS) {
      const ms = Number(process.env.HERON_TEST_AUDIT_DELAY_MS);
      await new Promise<void>((r) => {
        if (ctx.signal.aborted) return r();
        const t = setTimeout(r, ms);
        ctx.signal.addEventListener(
          'abort',
          () => { clearTimeout(t); r(); },
          { once: true },
        );
      });
      if (ctx.signal.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
    }
    ctx.progress({ stage: 'analyzing', pct: 50, message: 'stub analysis' });
    ctx.progress({ stage: 'rendering', pct: 90 });
    const reportId = `report_stdio_${Buffer.from(input.targetEndpoint).toString('hex').slice(0, 8)}`;
    return {
      reportId,
      target: input.targetEndpoint,
      report: `# Stdio Audit\n\nTarget: ${input.targetEndpoint}\nSession: ${ctx.sessionId}`,
      summary: { riskLevel: 'medium', findingsCount: 0 },
    };
  },
};

const stubDiffer: ReportDiffer = {
  async diff(a, b) {
    return `## Summary\nDiff for ${a.reportId} vs ${b.reportId}\n## Resolved\n- nothing\n## Added\n- nothing`;
  },
};

await startStdioMCPServer({
  auditPipeline: stubPipeline,
  differ: stubDiffer,
});
