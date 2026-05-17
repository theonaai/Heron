/**
 * AAP-52 — Integration tests for scan + approval-chain HTTP routes
 * served by `heron serve`.
 *
 * Boots a real HTTP server with a temp scansDir + a temp approvalsDir,
 * uses fetch to hit the new endpoints.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { startServer } from '../../src/server/index.js';
import { ScanManager } from '../../src/server/scans.js';
import * as llmModule from '../../src/llm/client.js';
import type { LLMClient } from '../../src/llm/client.js';
import type { VerificationReport } from '../../src/verification/types.js';
import { appendEntry } from '../../src/approvals/store.js';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        s.close(() => resolve(port));
      } else {
        s.close();
        reject(new Error('no address'));
      }
    });
  });
}

function makeReport(label = 'agent-x'): VerificationReport {
  return {
    capturedAt: '2026-05-12T00:00:00.000Z',
    agentLabel: label,
    declared: [],
    sources: [
      {
        sourceId: 'mcp-tools',
        verdict: 'verified',
        diffs: [],
      },
    ],
  };
}

describe('scan + approval routes', () => {
  let reportDir: string;
  let scansDir: string;
  let approvalsDir: string;
  let baseUrl: string;
  let server: Server | null = null;

  beforeEach(async () => {
    reportDir = mkdtempSync(join(tmpdir(), 'heron-routes-report-'));
    scansDir = mkdtempSync(join(tmpdir(), 'heron-routes-scans-'));
    approvalsDir = mkdtempSync(join(tmpdir(), 'heron-routes-approvals-'));

    const mockLLM: LLMClient = { chat: vi.fn().mockResolvedValue('') };
    vi.spyOn(llmModule, 'createLLMClient').mockResolvedValue(mockLLM);

    const port = await getFreePort();
    server = await startServer({
      port,
      host: '127.0.0.1',
      llm: { provider: 'anthropic', apiKey: 'sk-ant-fake' },
      maxFollowUps: 0,
      reportDir,
      scansDir,
      approvalsDir,
    });
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    rmSync(reportDir, { recursive: true, force: true });
    rmSync(scansDir, { recursive: true, force: true });
    rmSync(approvalsDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('GET /scans renders the empty-state page when no scans exist', async () => {
    const r = await fetch(`${baseUrl}/scans`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    const html = await r.text();
    expect(html).toContain('No scans yet');
  });

  it('GET /api/scans returns JSON list (empty)', async () => {
    const r = await fetch(`${baseUrl}/api/scans`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.scans).toEqual([]);
  });

  it('shows a scan after one is dropped into the scansDir', async () => {
    // Use a separate ScanManager pointed at the same dir to seed a scan.
    const mgr = new ScanManager(scansDir);
    const rec = await mgr.create({
      agentLabel: 'sample-agent',
      mcpConfig: 'stdio:node s.js',
      verifySources: ['mcp-tools'],
    });
    await mgr.complete(rec.id, makeReport('sample-agent'), '# Sample\n\nA scan.');

    const list = await fetch(`${baseUrl}/api/scans`).then(r => r.json());
    expect(list.scans.length).toBe(1);
    expect(list.scans[0].id).toBe(rec.id);
    expect(list.scans[0].agentLabel).toBe('sample-agent');

    const detail = await fetch(`${baseUrl}/scans/${rec.id}`);
    expect(detail.status).toBe(200);
    const detailHtml = await detail.text();
    expect(detailHtml).toContain('sample-agent');
    // AAP-54: the new SOC-style renderer emits <h1 class="cover-title">
    // for the document heading; match the tag prefix instead of the
    // bare <h1> string the prior shell used.
    expect(detailHtml).toMatch(/<h1[\s>]/);
  });

  it('rejects a malformed scan id with 404 — never escapes scansDir', async () => {
    const bad = await fetch(`${baseUrl}/scans/${encodeURIComponent('../../etc/passwd')}`);
    expect(bad.status).toBe(404);
    const apiBad = await fetch(`${baseUrl}/api/scans/${encodeURIComponent('../../etc/passwd')}`);
    expect(apiBad.status).toBe(404);
  });

  it('GET /approvals/:agentId renders the chain', async () => {
    const agentId = 'agent-routes-1';
    await appendEntry(
      agentId,
      {
        timestamp: new Date().toISOString(),
        action: 'declared',
        actor: { name: 'Test Actor', role: 'DPO' },
      },
      approvalsDir,
    );
    const r = await fetch(`${baseUrl}/approvals/${agentId}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain(agentId);
    expect(html).toContain('Test Actor');
    // Integrity banner — green when intact.
    expect(html.toLowerCase()).toContain('integrity');
  });

  it('GET /approvals/:agentId returns 404 with a helpful message when chain missing', async () => {
    const r = await fetch(`${baseUrl}/approvals/agent-never-existed`);
    expect(r.status).toBe(404);
    const html = await r.text();
    expect(html).toContain('agent-never-existed');
    expect(html.toLowerCase()).toMatch(/heron approve/);
  });

  it('GET /approvals/:agentId rejects hostile agentId — never reaches the store', async () => {
    const r = await fetch(`${baseUrl}/approvals/${encodeURIComponent('../etc/passwd')}`);
    expect(r.status).toBe(404);
  });

  it('landing page links to /scans', async () => {
    const r = await fetch(`${baseUrl}/`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('/scans');
    expect(html.toLowerCase()).toContain('verification scans');
  });
});
