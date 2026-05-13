import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMcpScan } from '../../src/commands/mcp-scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER_PATH = resolve(__dirname, '../fixtures/mcp/stdio-test-server.mjs');

/**
 * End-to-end CLI test for `heron scan --mcp ... --verify=mcp-tools`. We do
 * not shell out (see mcp-scan-cli.test.ts rationale); instead we call the
 * same command module the CLI imports, with the same flags wired through.
 *
 * The in-process stdio MCP server advertises three tools (echo, list_files,
 * fake_delete). We supply a declared inventory of two of them + one different
 * name, and assert the rendered report carries a "Verification" section with
 * the expected verdict + at least one extra + at least one missing diff.
 */
describe('heron scan --mcp --verify=mcp-tools', () => {
  let reportDir: string;

  beforeAll(() => {
    reportDir = mkdtempSync(join(tmpdir(), 'heron-mcp-verify-cli-'));
  });

  afterEach(() => {
    for (const f of readdirSync(reportDir)) {
      rmSync(join(reportDir, f));
    }
  });

  it('renders a Verification section in the Markdown report', async () => {
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
        { name: 'echo' },
        { name: 'list_files' },
        { name: 'schedule_meeting' },
      ],
      agentLabel: 'cli-integration-agent',
    });

    const files = readdirSync(reportDir).filter(f => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');

    expect(md).toContain('# MCP Tool Inventory');
    expect(md).toContain('## Verification');
    expect(md).toContain('Discrepancy');
    expect(md).toContain('fake_delete');
    expect(md).toContain('schedule_meeting');
  }, 15_000);

  it('no --verify flag → no Verification section (backwards compatible)', async () => {
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({ mcp: cfg, reportDir, format: 'markdown' });
    const files = readdirSync(reportDir).filter(f => f.endsWith('.md'));
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');
    expect(md).toContain('# MCP Tool Inventory');
    expect(md).not.toContain('## Verification');
  }, 15_000);

  it('--verify=mcp-tools with empty declared → all actual tools flagged as extras', async () => {
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
      declaredTools: [],
      agentLabel: 'cli-empty-declared',
    });

    const files = readdirSync(reportDir).filter(f => f.endsWith('.md'));
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');
    expect(md).toContain('## Verification');
    expect(md).toContain('Discrepancy');
    expect(md).toContain('echo');
    expect(md).toContain('list_files');
    expect(md).toContain('fake_delete');
  }, 15_000);
});
