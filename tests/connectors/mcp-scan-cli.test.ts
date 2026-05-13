import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMcpScan, parseMcpFlag } from '../../src/commands/mcp-scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER_PATH = resolve(__dirname, '../fixtures/mcp/stdio-test-server.mjs');

/**
 * CLI-level integration test for `heron scan --mcp`. We don't shell out to
 * the binary — Vitest's worker can't easily inherit the parent's TTY — but
 * we exercise the same command module the CLI imports, with the same flag
 * parser, against a real stdio MCP server. Confirms the report file lands on
 * disk and contains the expected tool inventory section.
 */
describe('heron scan --mcp', () => {
  let reportDir: string;

  beforeAll(() => {
    reportDir = mkdtempSync(join(tmpdir(), 'heron-mcp-cli-'));
  });

  afterEach(() => {
    // Sweep generated reports between tests so we can assert on a single one.
    for (const f of readdirSync(reportDir)) {
      rmSync(join(reportDir, f));
    }
  });

  it('parseMcpFlag accepts JSON, http URL, and stdio: forms', async () => {
    // N3 (round 3): parseMcpFlag became async because every http(s)
    // URL now runs through the SSRF host-policy check (DNS lookup
    // for hostnames). example.com is a public host, so it passes.
    expect(await parseMcpFlag('http://example.com/mcp')).toEqual({
      kind: 'http', url: 'http://example.com/mcp',
    });
    expect(await parseMcpFlag('stdio:node server.js --foo')).toEqual({
      kind: 'stdio', command: 'node', args: ['server.js', '--foo'],
    });
    expect(await parseMcpFlag('{"kind":"stdio","command":"x","args":["y"]}')).toEqual({
      kind: 'stdio', command: 'x', args: ['y'],
    });
  });

  it('runs end-to-end against a real stdio server and writes a markdown report', async () => {
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    const rec = await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'markdown',
    });

    expect(rec.tools.map(t => t.name).sort()).toEqual(['echo', 'fake_delete', 'list_files']);
    const files = readdirSync(reportDir).filter(f => f.endsWith('.md'));
    expect(files).toHaveLength(1);
    const md = readFileSync(join(reportDir, files[0]), 'utf-8');
    expect(md).toContain('# MCP Tool Inventory');
    expect(md).toContain('`echo`');
    expect(md).toContain('`fake_delete`');
    expect(md).toContain('destructiveHint');
  }, 15_000);

  it('writes a JSON report when format=json', async () => {
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({ mcp: cfg, reportDir, format: 'json' });
    const files = readdirSync(reportDir).filter(f => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const parsed = JSON.parse(readFileSync(join(reportDir, files[0]), 'utf-8'));
    expect(parsed.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      'echo', 'fake_delete', 'list_files',
    ]);
  }, 15_000);
});
