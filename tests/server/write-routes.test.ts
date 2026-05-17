/**
 * AAP-53 — Integration tests for the browser write workflows:
 *  - GET  /scans/new                — scan-trigger form (HTML)
 *  - POST /api/scans                — scan-trigger handler
 *  - GET  /approvals/:agentId/new   — approval-add form (HTML)
 *  - POST /api/approvals/:agentId   — approval-add handler
 *  - GET  /declared/upload          — declared-baseline upload form
 *  - POST /api/declared             — declared-baseline upload handler
 *  - GET  /declared                 — uploaded baseline list
 *
 * The scan-trigger POST test stubs `runMcpScan` via the `scanRunner`
 * config hook on `startServer` so the test does not need a real MCP
 * server. The hook is the same one production wiring uses; tests just
 * inject a fast in-process stub.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { startServer } from '../../src/server/index.js';
import * as llmModule from '../../src/llm/client.js';
import type { LLMClient } from '../../src/llm/client.js';
import { ScanManager } from '../../src/server/scans.js';
import type { ScanRunner } from '../../src/server/index.js';
import { appendEntry, readChain } from '../../src/approvals/store.js';

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

function fakeRunner(): ScanRunner {
  return async ({ scanManager, agentLabel, mcpSummary, verifySources }) => {
    const rec = await scanManager.create({
      agentLabel,
      mcpConfig: mcpSummary,
      verifySources,
    });
    await scanManager.complete(
      rec.id,
      {
        capturedAt: new Date().toISOString(),
        agentLabel,
        declared: [],
        sources: [],
      },
      `# Scan ${rec.id}\n\nFake scan for tests.\n`,
    );
    return rec.id;
  };
}

describe('AAP-53 write routes', () => {
  let reportDir: string;
  let scansDir: string;
  let approvalsDir: string;
  let declaredDir: string;
  let baseUrl: string;
  let host: string;
  let port: number;
  let server: Server | null = null;

  beforeEach(async () => {
    reportDir = mkdtempSync(join(tmpdir(), 'heron-write-report-'));
    scansDir = mkdtempSync(join(tmpdir(), 'heron-write-scans-'));
    approvalsDir = mkdtempSync(join(tmpdir(), 'heron-write-approvals-'));
    declaredDir = mkdtempSync(join(tmpdir(), 'heron-write-declared-'));

    const mockLLM: LLMClient = { chat: vi.fn().mockResolvedValue('') };
    vi.spyOn(llmModule, 'createLLMClient').mockResolvedValue(mockLLM);

    port = await getFreePort();
    host = `127.0.0.1:${port}`;
    server = await startServer({
      port,
      host: '127.0.0.1',
      llm: { provider: 'anthropic', apiKey: 'sk-ant-fake' },
      maxFollowUps: 0,
      reportDir,
      scansDir,
      approvalsDir,
      declaredDir,
      scanRunner: fakeRunner(),
    });
    baseUrl = `http://${host}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    rmSync(reportDir, { recursive: true, force: true });
    rmSync(scansDir, { recursive: true, force: true });
    rmSync(approvalsDir, { recursive: true, force: true });
    rmSync(declaredDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ─── Form pages ──────────────────────────────────────────────

  it('GET /scans/new renders the trigger form', async () => {
    const r = await fetch(`${baseUrl}/scans/new`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    const html = await r.text();
    expect(html).toContain('<form');
    expect(html).toContain('method="POST"');
    expect(html).toContain('action="/api/scans"');
    expect(html).toContain('name="mcp"');
    expect(html).toContain('name="verify"');
    expect(html).toContain('name="agent-label"');
    // No JavaScript in the form pages.
    expect(html).not.toContain('<script');
  });

  it('GET /approvals/:agentId/new renders the approval form', async () => {
    const r = await fetch(`${baseUrl}/approvals/test-agent/new`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('<form');
    expect(html).toContain('action="/api/approvals/test-agent"');
    expect(html).toContain('name="action"');
    expect(html).toContain('name="actor-name"');
    expect(html).toContain('name="actor-role"');
    expect(html).toContain('name="evidence-refs"');
    expect(html).not.toContain('<script');
  });

  it('GET /approvals/:agentId/new rejects hostile agentId', async () => {
    const r = await fetch(`${baseUrl}/approvals/${encodeURIComponent('../etc')}/new`);
    expect(r.status).toBe(404);
  });

  it('GET /declared/upload renders the upload form', async () => {
    const r = await fetch(`${baseUrl}/declared/upload`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('<form');
    expect(html).toContain('action="/api/declared"');
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toContain('type="file"');
    expect(html).not.toContain('<script');
  });

  it('GET /declared renders the empty list page when no baselines uploaded', async () => {
    const r = await fetch(`${baseUrl}/declared`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html.toLowerCase()).toContain('declared baselines');
  });

  // ─── POST /api/scans ─────────────────────────────────────────

  it('POST /api/scans with valid form body triggers a scan and redirects to detail page', async () => {
    const body = new URLSearchParams({
      mcp: 'stdio:node server.js',
      verify: 'mcp-tools',
      'agent-label': 'unit-test-agent',
    }).toString();
    const r = await fetch(`${baseUrl}/api/scans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: baseUrl,
      },
      body,
      redirect: 'manual',
    });
    expect(r.status).toBe(303);
    const loc = r.headers.get('location');
    expect(loc).toMatch(/^\/scans\/scan-\d{8}-\d{6}-[0-9a-f]{6}$/);

    // Scan record persisted.
    const list = await fetch(`${baseUrl}/api/scans`).then((res) => res.json());
    expect(list.scans).toHaveLength(1);
    expect(list.scans[0].agentLabel).toBe('unit-test-agent');
  });

  it('POST /api/scans rejects empty mcp value', async () => {
    const body = new URLSearchParams({
      mcp: '',
      'agent-label': 'x',
    }).toString();
    const r = await fetch(`${baseUrl}/api/scans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: baseUrl,
      },
      body,
      redirect: 'manual',
    });
    expect(r.status).toBe(400);
  });

  it('POST /api/scans rejects missing agent-label', async () => {
    const body = new URLSearchParams({ mcp: 'stdio:node s.js' }).toString();
    const r = await fetch(`${baseUrl}/api/scans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: baseUrl,
      },
      body,
      redirect: 'manual',
    });
    expect(r.status).toBe(400);
  });

  it('POST /api/scans rejects unknown verify source', async () => {
    const body = new URLSearchParams({
      mcp: 'stdio:node s.js',
      'agent-label': 'x',
      verify: 'oauth-scopes:unknown',
    }).toString();
    const r = await fetch(`${baseUrl}/api/scans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: baseUrl,
      },
      body,
      redirect: 'manual',
    });
    expect(r.status).toBe(400);
  });

  it('POST /api/scans rejects cross-origin Origin header', async () => {
    const body = new URLSearchParams({
      mcp: 'stdio:node s.js',
      'agent-label': 'x',
    }).toString();
    const r = await fetch(`${baseUrl}/api/scans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'http://evil.example.com',
      },
      body,
      redirect: 'manual',
    });
    expect(r.status).toBe(403);
  });

  it('POST /api/scans rejects missing Origin and Referer', async () => {
    const body = new URLSearchParams({
      mcp: 'stdio:node s.js',
      'agent-label': 'x',
    }).toString();
    const r = await fetch(`${baseUrl}/api/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual',
    });
    expect(r.status).toBe(403);
  });

  // ─── POST /api/approvals/:agentId ────────────────────────────

  it('POST /api/approvals/:agentId appends entry and redirects', async () => {
    const body = new URLSearchParams({
      action: 'declared',
      'actor-name': 'Jane Doe',
      'actor-role': 'DPO',
      'actor-email': 'jane@example.com',
      'evidence-refs': 'ref-1\nref-2',
      comment: 'initial declaration',
    }).toString();
    const r = await fetch(`${baseUrl}/api/approvals/my-agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: baseUrl,
      },
      body,
      redirect: 'manual',
    });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/approvals/my-agent');

    // Chain persisted on disk.
    const chainResult = await readChain('my-agent', approvalsDir);
    expect(chainResult.ok).toBe(true);
    if (chainResult.ok) {
      expect(chainResult.chain.entries).toHaveLength(1);
      const entry = chainResult.chain.entries[0];
      expect(entry.action).toBe('declared');
      expect(entry.actor.name).toBe('Jane Doe');
      expect(entry.actor.role).toBe('DPO');
      expect(entry.actor.email).toBe('jane@example.com');
      expect(entry.evidenceRefs).toEqual(['ref-1', 'ref-2']);
      expect(entry.comment).toBe('initial declaration');
    }
  });

  it('POST /api/approvals/:agentId rejects invalid email', async () => {
    const body = new URLSearchParams({
      action: 'approved',
      'actor-name': 'Alice',
      'actor-role': 'CISO',
      'actor-email': 'not-an-email',
    }).toString();
    const r = await fetch(`${baseUrl}/api/approvals/my-agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: baseUrl,
      },
      body,
      redirect: 'manual',
    });
    expect(r.status).toBe(400);
  });

  it('POST /api/approvals/:agentId rejects unknown action', async () => {
    const body = new URLSearchParams({
      action: 'frobnicate',
      'actor-name': 'Alice',
      'actor-role': 'CISO',
    }).toString();
    const r = await fetch(`${baseUrl}/api/approvals/my-agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: baseUrl,
      },
      body,
      redirect: 'manual',
    });
    expect(r.status).toBe(400);
  });

  it('POST /api/approvals/:agentId rejects hostile agentId', async () => {
    const body = new URLSearchParams({
      action: 'declared',
      'actor-name': 'Alice',
      'actor-role': 'CISO',
    }).toString();
    const r = await fetch(`${baseUrl}/api/approvals/${encodeURIComponent('../etc/passwd')}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: baseUrl,
      },
      body,
      redirect: 'manual',
    });
    expect(r.status).toBe(400);
  });

  // ─── POST /api/declared ─────────────────────────────────────

  function multipart(boundary: string, parts: Array<{ headers: string; body: string | Buffer }>): Buffer {
    const chunks: Buffer[] = [];
    for (const p of parts) {
      chunks.push(Buffer.from(`--${boundary}\r\n`));
      chunks.push(Buffer.from(`${p.headers}\r\n\r\n`));
      chunks.push(Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body));
      chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return Buffer.concat(chunks);
  }

  it('POST /api/declared accepts a valid JSON upload and redirects', async () => {
    const json = JSON.stringify({
      agent: { name: 'my-agent' },
      declared: { tools: [{ name: 'send_email' }] },
    });
    const boundary = 'XBOUND';
    const body = multipart(boundary, [
      { headers: 'Content-Disposition: form-data; name="display-name"', body: 'My Agent Baseline' },
      {
        headers: 'Content-Disposition: form-data; name="file"; filename="baseline.json"\r\nContent-Type: application/json',
        body: json,
      },
    ]);

    const r = await fetch(`${baseUrl}/api/declared`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Origin: baseUrl,
      },
      body,
      redirect: 'manual',
    });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/declared');

    // File saved on disk with sanitised name.
    const files = readdirSync(declaredDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^decl-my-agent-baseline\.json$/);
    const saved = JSON.parse(readFileSync(join(declaredDir, files[0]), 'utf-8'));
    expect(saved.agent.name).toBe('my-agent');
  });

  it('POST /api/declared rejects hostile display-name with traversal', async () => {
    const json = JSON.stringify({ agent: { name: 'x' } });
    const boundary = 'BD';
    const body = multipart(boundary, [
      { headers: 'Content-Disposition: form-data; name="display-name"', body: '../../etc/passwd' },
      {
        headers: 'Content-Disposition: form-data; name="file"; filename="x.json"\r\nContent-Type: application/json',
        body: json,
      },
    ]);
    const r = await fetch(`${baseUrl}/api/declared`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Origin: baseUrl,
      },
      body,
      redirect: 'manual',
    });
    // Sanitisation should strip dots/slashes — but result must still be inside declaredDir.
    if (r.status === 303) {
      const files = readdirSync(declaredDir);
      for (const f of files) {
        expect(f).not.toContain('..');
        expect(f).not.toContain('/');
        expect(f.startsWith('decl-')).toBe(true);
      }
    } else {
      expect(r.status).toBe(400);
    }
  });

  it('POST /api/declared rejects non-JSON file contents', async () => {
    const boundary = 'BD';
    const body = multipart(boundary, [
      { headers: 'Content-Disposition: form-data; name="display-name"', body: 'plain' },
      {
        headers: 'Content-Disposition: form-data; name="file"; filename="x.json"',
        body: 'this is not JSON at all',
      },
    ]);
    const r = await fetch(`${baseUrl}/api/declared`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Origin: baseUrl,
      },
      body,
      redirect: 'manual',
    });
    expect(r.status).toBe(400);
  });

  it('POST /api/declared rejects oversized body (>1 MiB)', async () => {
    const boundary = 'BD';
    const huge = Buffer.alloc(1024 * 1024 + 1024, 0x41);
    const body = multipart(boundary, [
      { headers: 'Content-Disposition: form-data; name="display-name"', body: 'huge' },
      {
        headers: 'Content-Disposition: form-data; name="file"; filename="x.bin"',
        body: huge,
      },
    ]);
    const r = await fetch(`${baseUrl}/api/declared`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Origin: baseUrl,
      },
      body,
      redirect: 'manual',
    });
    expect([400, 413]).toContain(r.status);
  });

  it('POST /api/declared rejects cross-origin Origin', async () => {
    const boundary = 'BD';
    const body = multipart(boundary, [
      { headers: 'Content-Disposition: form-data; name="display-name"', body: 'x' },
      {
        headers: 'Content-Disposition: form-data; name="file"; filename="x.json"',
        body: '{"agent":{"name":"x"}}',
      },
    ]);
    const r = await fetch(`${baseUrl}/api/declared`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Origin: 'http://evil.example.com',
      },
      body,
      redirect: 'manual',
    });
    expect(r.status).toBe(403);
  });

  it('GET /declared lists uploaded baselines', async () => {
    // Seed a baseline by hitting the endpoint.
    const boundary = 'BD';
    const body = multipart(boundary, [
      { headers: 'Content-Disposition: form-data; name="display-name"', body: 'sample' },
      {
        headers: 'Content-Disposition: form-data; name="file"; filename="x.json"',
        body: JSON.stringify({ agent: { name: 'x' } }),
      },
    ]);
    await fetch(`${baseUrl}/api/declared`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Origin: baseUrl,
      },
      body,
      redirect: 'manual',
    });

    const r = await fetch(`${baseUrl}/declared`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('decl-sample.json');
  });

  // ─── Landing page extension ─────────────────────────────────

  it('landing page surfaces quick-action links', async () => {
    const r = await fetch(`${baseUrl}/`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('/scans/new');
    expect(html).toContain('/declared/upload');
  });
});
