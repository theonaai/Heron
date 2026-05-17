/**
 * AAP-52 — CLI tests for `heron scan --mcp ... --format html`.
 *
 * Verifies that the new format writes a self-contained `.html` file
 * (no external CSS/JS references) and that, when a scansDir/scanManager
 * is wired in, the same scan is registered for the browser dashboard.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMcpScan } from '../../src/commands/mcp-scan.js';
import { ScanManager } from '../../src/server/scans.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER_PATH = resolve(__dirname, '../fixtures/mcp/stdio-test-server.mjs');

describe('heron scan --format html', () => {
  let reportDir: string;
  let scansDir: string;

  beforeAll(() => {
    reportDir = mkdtempSync(join(tmpdir(), 'heron-scan-html-'));
    scansDir = mkdtempSync(join(tmpdir(), 'heron-scan-html-scans-'));
  });

  afterEach(() => {
    for (const f of readdirSync(reportDir)) {
      rmSync(join(reportDir, f), { recursive: true, force: true });
    }
    for (const f of readdirSync(scansDir)) {
      rmSync(join(scansDir, f), { recursive: true, force: true });
    }
  });

  it('writes a .html file in reportDir', async () => {
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'html',
      agentLabel: 'html-agent',
    });

    const htmlFiles = readdirSync(reportDir).filter(f => f.endsWith('.html'));
    expect(htmlFiles.length).toBe(1);

    const html = readFileSync(join(reportDir, htmlFiles[0]), 'utf-8');
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('MCP Tool Inventory');
    // Self-contained: no external CSS / JS.
    expect(html).not.toMatch(/<link\s+rel="stylesheet"\s+href=/i);
    expect(html).not.toMatch(/<script\s+src=/i);
    // CSS inlined.
    expect(html).toContain('<style>');
  }, 15_000);

  it('registers the scan in ScanManager when one is provided', async () => {
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    const mgr = new ScanManager(scansDir);

    await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'markdown',
      agentLabel: 'registered-agent',
      scansDir,
      scanManager: mgr,
    });

    const list = await mgr.list();
    expect(list.length).toBe(1);
    expect(list[0].agentLabel).toBe('registered-agent');
    expect(list[0].status).toBe('completed');
  }, 15_000);

  it('without ScanManager — markdown scans still mirror into scansDir on disk', async () => {
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'markdown',
      agentLabel: 'cli-only-agent',
      scansDir,
    });

    // The CLI mirror writes a record so `heron serve` can pick it up.
    const scanFiles = readdirSync(scansDir).filter(f => f.endsWith('.json'));
    expect(scanFiles.length).toBe(1);
    const rec = JSON.parse(readFileSync(join(scansDir, scanFiles[0]), 'utf-8'));
    expect(rec.agentLabel).toBe('cli-only-agent');
    expect(rec.status).toBe('completed');
  }, 15_000);

  it('--format html honors --output explicit path', async () => {
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    const outPath = join(reportDir, 'custom-name.html');

    await runMcpScan({
      mcp: cfg,
      reportDir,
      format: 'html',
      outputPath: outPath,
      agentLabel: 'explicit-out-agent',
    });

    const html = readFileSync(outPath, 'utf-8');
    expect(html).toMatch(/^<!DOCTYPE html>/);
  }, 15_000);
});
