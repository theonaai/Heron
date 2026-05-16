/**
 * End-to-end CLI tests for `heron scan` with the HR vertical pack (AAP-51).
 *
 * Wires the same surface as the `heron scan` command: provides declared
 * scopes/tools through `declaredTools`/`declaredScopes` and asserts the
 * rendered Markdown includes the Executive Summary at the top and the
 * HR Signals section when an HR agent is detected.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMcpScan } from '../../src/commands/mcp-scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER_PATH = resolve(__dirname, '../fixtures/mcp/stdio-test-server.mjs');

describe('heron scan — HR vertical pack', () => {
  let reportDir: string;
  const origEnv = process.env.HERON_HR_PACK_DISABLED;

  beforeAll(() => {
    reportDir = mkdtempSync(join(tmpdir(), 'heron-hr-pack-cli-'));
  });

  afterEach(() => {
    for (const f of readdirSync(reportDir)) rmSync(join(reportDir, f));
  });

  afterAll(() => {
    if (origEnv === undefined) {
      delete process.env.HERON_HR_PACK_DISABLED;
    } else {
      process.env.HERON_HR_PACK_DISABLED = origEnv;
    }
  });

  it('HR-agent scan renders executive summary + HR signals section', async () => {
    delete process.env.HERON_HR_PACK_DISABLED;
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'markdown',
      verify: ['mcp-tools'],
      declaredTools: [
        { name: 'list_candidates', description: 'Read candidate pipeline from ATS' },
        { name: 'send_email', description: 'Send recruiter outreach emails' },
      ],
      declaredScopes: [{ service: 'greenhouse', scope: 'candidates:read' }],
      agentLabel: 'recruiter-outreach-agent',
    });

    const files = readdirSync(reportDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');
    expect(md).toContain('# Executive Summary');
    expect(md).toContain('## HR Vertical Signals');
  }, 15_000);

  it('non-HR agent scan renders executive summary, omits HR signals section', async () => {
    delete process.env.HERON_HR_PACK_DISABLED;
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'markdown',
      verify: ['mcp-tools'],
      declaredTools: [{ name: 'echo' }],
      declaredScopes: [{ service: 'quickbooks', scope: 'invoices:read' }],
      agentLabel: 'billing-bot',
    });

    const files = readdirSync(reportDir).filter((f) => f.endsWith('.md'));
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');
    expect(md).toContain('# Executive Summary');
    expect(md).toContain('Generic agent');
    expect(md).not.toContain('## HR Vertical Signals');
  }, 15_000);

  it('HERON_HR_PACK_DISABLED=true skips HR section but still renders exec summary', async () => {
    process.env.HERON_HR_PACK_DISABLED = 'true';
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'markdown',
      verify: ['mcp-tools'],
      declaredTools: [{ name: 'list_candidates' }],
      declaredScopes: [{ service: 'greenhouse', scope: 'candidates:read' }],
      agentLabel: 'recruiter-outreach-agent',
    });

    const files = readdirSync(reportDir).filter((f) => f.endsWith('.md'));
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');
    expect(md).toContain('# Executive Summary');
    expect(md).not.toContain('## HR Vertical Signals');
  }, 15_000);
});
