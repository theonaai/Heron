import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMcpScan, parseDeclaredSourceFlag } from '../../src/commands/mcp-scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER_PATH = resolve(__dirname, '../fixtures/mcp/stdio-test-server.mjs');
const FIXTURE_PATH = resolve(__dirname, '../fixtures/declared/sample-hr-agent.json');

/**
 * CLI integration tests for `heron scan --mcp ... --declared-source ...`.
 *
 * The flag accepts:
 *  - `file:<path>`            → file backend
 *  - `theona-mcp:<agentId>`   → Theona MCP stub (returns not_implemented)
 *
 * Mirrors the pattern in `mcp-scan-verify.test.ts`: we exercise the
 * command module the CLI imports, with the same flags wired through.
 */
describe('heron scan --declared-source — file backend', () => {
  let reportDir: string;

  beforeEach(() => {
    reportDir = mkdtempSync(join(tmpdir(), 'heron-decl-cli-'));
  });

  afterEach(() => {
    rmSync(reportDir, { recursive: true, force: true });
  });

  it('parseDeclaredSourceFlag — file:<path> form', () => {
    const cfg = parseDeclaredSourceFlag('file:/tmp/foo.json');
    expect(cfg.backend).toBe('file');
    if (cfg.backend !== 'file') return;
    expect(cfg.path).toBe('/tmp/foo.json');
  });

  it('parseDeclaredSourceFlag — theona-mcp:<agentId> form', () => {
    const cfg = parseDeclaredSourceFlag('theona-mcp:agent-xyz');
    expect(cfg.backend).toBe('theona-mcp');
    if (cfg.backend !== 'theona-mcp') return;
    expect(cfg.agentId).toBe('agent-xyz');
  });

  it('parseDeclaredSourceFlag — unknown backend throws', () => {
    expect(() => parseDeclaredSourceFlag('git:./foo')).toThrow();
  });

  it('parseDeclaredSourceFlag — missing colon throws', () => {
    expect(() => parseDeclaredSourceFlag('filenocolon')).toThrow();
  });

  it('--declared-source file:<fixture> → declared inventory used by verifier', async () => {
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
      declaredSource: { backend: 'file', path: FIXTURE_PATH },
      agentLabel: 'declared-source-file',
    });

    const files = readdirSync(reportDir).filter((f) => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');

    expect(md).toContain('## Verification');
    // The fixture declares list_candidates / send_email / schedule_meeting
    // and the stdio MCP server advertises echo / list_files / fake_delete.
    // → all stdio tools should appear as "extra", and at least one fixture
    // tool should appear as "missing".
    expect(md).toContain('Discrepancy');
    expect(md).toContain('list_candidates');
    expect(md).toContain('fake_delete');
  }, 15_000);

  it('--declared-source theona-mcp:agent-xyz → not_implemented surfaced cleanly', async () => {
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });
    // The theona-mcp stub returns not_implemented; the CLI must surface
    // that as a clear error without crashing and without writing a
    // misleading "Verified" report.
    await expect(
      runMcpScan({
        mcp: cfg,
        reportDir,
        format: 'markdown',
        verify: ['mcp-tools'],
        declaredSource: { backend: 'theona-mcp', agentId: 'agent-xyz' },
        agentLabel: 'declared-source-theona',
      }),
    ).rejects.toThrow(/not[_ ]?implemented/i);
  }, 15_000);

  it('both --declared-tools and --declared-source → warning, --declared-source wins', async () => {
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
      declaredTools: [{ name: 'will-be-ignored' }],
      declaredSource: { backend: 'file', path: FIXTURE_PATH },
      agentLabel: 'both-flags-warning',
    });
    const files = readdirSync(reportDir).filter((f) => f.endsWith('.md'));
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');
    // Fixture-side declared tools should drive the diff; legacy --declared-tools
    // is dropped on the floor (with a warning emitted to logger, not asserted
    // here because logger isn't captured).
    expect(md).not.toContain('will-be-ignored');
    expect(md).toContain('list_candidates');
  }, 15_000);

  it('no --declared-source and no --declared-tools → existing behaviour (empty declared)', async () => {
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
      agentLabel: 'no-declared-flag',
    });
    const files = readdirSync(reportDir).filter((f) => f.endsWith('.md'));
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');
    expect(md).toContain('## Verification');
    // Empty declared → every tool from the stdio server flagged as extra.
    expect(md).toContain('echo');
    expect(md).toContain('list_files');
    expect(md).toContain('fake_delete');
  }, 15_000);

  it('invalid path → clean error', async () => {
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });
    const missing = join(reportDir, 'no-such-decl.json');
    await expect(
      runMcpScan({
        mcp: cfg,
        reportDir,
        format: 'markdown',
        verify: ['mcp-tools'],
        declaredSource: { backend: 'file', path: missing },
        agentLabel: 'missing-file',
      }),
    ).rejects.toThrow(/not.found|no such file|enoent/i);
  }, 15_000);

  it('file backend integrates with --verify=mcp-tools end-to-end (diffs surfaced)', async () => {
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });
    // Build a custom declared file that matches one of the stdio server's
    // tools and adds an extra declared one — we expect ONE missing (extra
    // declared) plus the two un-declared stdio tools as extras.
    const customPath = join(reportDir, 'custom-decl.json');
    writeFileSync(
      customPath,
      JSON.stringify({
        agent: { name: 'Custom' },
        declared: {
          tools: [{ name: 'echo' }, { name: 'never_advertised' }],
        },
      }),
    );

    await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'markdown',
      verify: ['mcp-tools'],
      declaredSource: { backend: 'file', path: customPath },
      agentLabel: 'custom-decl',
    });
    const files = readdirSync(reportDir).filter((f) => f.endsWith('.md'));
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');
    // echo is declared AND actual → no diff line for it.
    // never_advertised is declared but not actual → missing.
    // list_files, fake_delete are actual but not declared → extras.
    expect(md).toContain('never_advertised');
    expect(md).toContain('list_files');
    expect(md).toContain('fake_delete');
  }, 15_000);
});
