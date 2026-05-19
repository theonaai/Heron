#!/usr/bin/env tsx
// Launch Heron's MCP server in stdio mode for integration tests. No
// audit pipeline is wired — under AAP-52 the audit_agent tool is gone,
// and start_audit_session needs an MCP client that supports sampling
// (the integration tests in this file only exercise the tool registry,
// not the full sampling flow — that's covered in sampling-e2e.test.ts).

import { startStdioMCPServer, type ReportDiffer } from '../../../src/server/mcp-server.js';

const stubDiffer: ReportDiffer = {
  async diff(a, b) {
    return `## Summary\nDiff for ${a.reportId} vs ${b.reportId}\n## Resolved\n- nothing\n## Added\n- nothing`;
  },
};

await startStdioMCPServer({
  differ: stubDiffer,
});
