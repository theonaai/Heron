import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runMcpScan } from '../../src/commands/mcp-scan.js';
import { listSessions, getSession } from '../../src/storage/sessions.js';
import type { ReportJson } from '../../lib/report-json.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STDIO_SERVER_PATH = resolve(__dirname, '../fixtures/mcp/stdio-test-server.mjs');

/**
 * `runMcpScan` (AAP-64 / PR #33-C) now writes an AuditSession into the
 * local-files store alongside the legacy `.heron/scans` mirror, so the
 * browser dashboard's sidebar lists MCP scans next to interview audits.
 *
 * This test pins:
 *   1. A new AuditSession appears under HERON_SESSIONS_DIR after the scan.
 *   2. The session meta carries status=complete, questionsAsked=0, and a
 *      riskLevel derived from the highest-severity finding.
 *   3. The persisted report.json deserialises into a ReportJson shape that
 *      includes the new mcpInventory section.
 *   4. When --verify=mcp-tools is used with declared tools, the report.json
 *      also carries the declaredDiff section.
 */
describe('runMcpScan writes AuditSession alongside legacy scan record', () => {
  let reportDir: string;
  let scansDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    reportDir = mkdtempSync(join(tmpdir(), 'heron-mcp-scan-sess-reports-'));
    scansDir = mkdtempSync(join(tmpdir(), 'heron-mcp-scan-sess-scans-'));
    sessionsDir = mkdtempSync(join(tmpdir(), 'heron-mcp-scan-sess-sessions-'));
    process.env.HERON_SESSIONS_DIR = sessionsDir;
  });

  afterEach(() => {
    delete process.env.HERON_SESSIONS_DIR;
    rmSync(reportDir, { recursive: true, force: true });
    rmSync(scansDir, { recursive: true, force: true });
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it('creates an AuditSession with mcpInventory in report.json', async () => {
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({
      mcp: cfg,
      reportDir,
      scansDir,
      format: 'markdown',
      agentLabel: 'mcp-session-agent',
    });

    const sessions = await listSessions();
    expect(sessions.length).toBe(1);
    const session = sessions[0];
    expect(session.status).toBe('complete');
    expect(session.questionsAsked).toBe(0);
    expect(session.agentName).toBe('mcp-session-agent');

    const detail = await getSession(session.id);
    expect(detail).not.toBeNull();
    const reportJson = detail!.reportJson as ReportJson | undefined;
    expect(reportJson).toBeDefined();
    expect(reportJson!.mcpInventory).toBeDefined();
    expect(reportJson!.mcpInventory!.tools.length).toBeGreaterThan(0);
    expect(reportJson!.mcpInventory!.tools.some((t) => t.name === 'echo')).toBe(true);

    // report.md is the inventory markdown.
    expect(detail!.report).toBeDefined();
    expect(detail!.report).toContain('# MCP Tool Inventory');

    // Legacy scan mirror still lands in scansDir — backward compat.
    const scanFiles = readdirSync(scansDir).filter((f) => f.endsWith('.json'));
    expect(scanFiles.length).toBeGreaterThan(0);
  }, 20_000);

  it('populates declaredDiff section when --verify=mcp-tools + declaredTools used', async () => {
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({
      mcp: cfg,
      reportDir,
      scansDir,
      format: 'markdown',
      verify: ['mcp-tools'],
      declaredTools: [{ name: 'echo' }, { name: 'list_files' }],
      agentLabel: 'mcp-session-with-diff',
    });

    const sessions = await listSessions();
    expect(sessions.length).toBe(1);
    const detail = await getSession(sessions[0].id);
    const reportJson = detail!.reportJson as ReportJson | undefined;
    expect(reportJson).toBeDefined();
    expect(reportJson!.declaredDiff).toBeDefined();
    // fake_delete is in the actual inventory but NOT declared — should be an extra.
    const extras = reportJson!.declaredDiff!.extra.map((e) => e.name);
    expect(extras).toContain('fake_delete');
    expect(reportJson!.mcpInventory).toBeDefined();

    // Risk level derived from a non-empty discrepancy ⇒ at least medium.
    expect(sessions[0].riskLevel).toBeDefined();
    expect(['medium', 'high', 'critical']).toContain(sessions[0].riskLevel!);
  }, 20_000);

  it('json format path does NOT write an AuditSession (no markdown to render)', async () => {
    const cfg = JSON.stringify({
      kind: 'stdio',
      command: process.execPath,
      args: [STDIO_SERVER_PATH],
    });

    await runMcpScan({
      mcp: cfg,
      reportDir,
      scansDir,
      format: 'json',
      agentLabel: 'mcp-session-json',
    });
    const sessions = await listSessions();
    // Backward compat: json-only mode keeps the historical behaviour of
    // dumping a tool-inventory JSON without registering a session.
    expect(sessions.length).toBe(0);

    // legacy scans dir untouched too (matches existing runMcpScan json-format behaviour).
    expect(existsSync(scansDir)).toBe(true);
  }, 20_000);
});
