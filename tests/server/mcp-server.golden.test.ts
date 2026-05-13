import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  HeronMCPServer,
  type AuditPipeline,
  type ReportDiffer,
} from '../../src/server/mcp-server.js';
import type { AuditAgentInput, RequestContext } from '../../src/server/mcp-types.js';

/**
 * Golden snapshot tests pin Heron's public MCP surface:
 *
 *  1. The tool registry — names, descriptions, input schemas. Any
 *     accidental rename or shape change must surface as a snapshot diff.
 *  2. The result envelope of `audit_agent` against a deterministic
 *     fixture pipeline.
 *
 * Snapshots live on disk (`tests/snapshots/mcp-server/`) so reviewers can
 * see them alongside the implementation diff. Set HERON_UPDATE_GOLDEN=1
 * to regenerate after an intentional change.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS = resolve(__dirname, '../snapshots/mcp-server');

function loadOrWrite(name: string, actual: string): string {
  const path = resolve(SNAPSHOTS, name);
  if (process.env.HERON_UPDATE_GOLDEN === '1' || !existsSync(path)) {
    mkdirSync(SNAPSHOTS, { recursive: true });
    writeFileSync(path, actual);
  }
  return readFileSync(path, 'utf-8');
}

const deterministicPipeline: AuditPipeline = {
  async run(input, ctx) {
    ctx.progress({ stage: 'interrogating', pct: 1 });
    return {
      reportId: 'report_golden_fixture',
      target: input.targetEndpoint,
      report: `# Golden Audit\n\nTarget: ${input.targetEndpoint}\n`,
      summary: {
        riskLevel: 'medium',
        findingsCount: 2,
        recommendation: 'APPROVE WITH CONDITIONS',
      },
    };
  },
};

const stubDiffer: ReportDiffer = {
  async diff() { return '## Summary\nstub diff'; },
};

describe('HeronMCPServer — golden snapshots', () => {
  // SSRF guard (F-1) blocks the unresolvable `golden.example` host used
  // in the fixture. Flip the documented escape hatch for the suite —
  // the deterministic pipeline never makes a network call.
  let prevAllowPrivate: string | undefined;
  beforeEach(() => {
    prevAllowPrivate = process.env.HERON_ALLOW_PRIVATE_TARGETS;
    process.env.HERON_ALLOW_PRIVATE_TARGETS = '1';
  });
  afterEach(() => {
    if (prevAllowPrivate === undefined) delete process.env.HERON_ALLOW_PRIVATE_TARGETS;
    else process.env.HERON_ALLOW_PRIVATE_TARGETS = prevAllowPrivate;
  });

  it('tool registry matches snapshot', () => {
    const server = new HeronMCPServer({
      auditPipeline: deterministicPipeline,
      differ: stubDiffer,
    });
    const tools = server.listToolDefinitions();
    const actual = JSON.stringify(tools, null, 2) + '\n';
    const expected = loadOrWrite('tool-registry.json', actual);
    expect(actual).toBe(expected);
  });

  it('audit_agent result envelope matches snapshot', async () => {
    const server = new HeronMCPServer({
      auditPipeline: deterministicPipeline,
      differ: stubDiffer,
    });
    const ctx: RequestContext = {
      authPrincipal: null,
      sessionId: 'sess_golden',
      progress: () => undefined,
      signal: new AbortController().signal,
    };
    const input: AuditAgentInput = { target_endpoint: 'https://golden.example/v1' };
    const result = await server.invoke('audit_agent', input, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const actual = JSON.stringify(result.value, null, 2) + '\n';
    const expected = loadOrWrite('audit-agent-result.json', actual);
    expect(actual).toBe(expected);
  });
});
