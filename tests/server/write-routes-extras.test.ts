/**
 * AAP-53 — additional coverage for the write workflows.
 *
 *  - Unit tests for `sanitiseDeclaredSlug` (hostile names, edge cases).
 *  - Render tests for the new form pages (no JavaScript, correct
 *    action attribute, correct fields).
 *  - End-to-end happy path: upload a declared baseline, then trigger
 *    a scan that references it via `file:` and observe the scan
 *    appear in the dashboard.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { startServer, sanitiseDeclaredSlug } from '../../src/server/index.js';
import * as llmModule from '../../src/llm/client.js';
import type { LLMClient } from '../../src/llm/client.js';
import type { ScanRunner } from '../../src/server/index.js';
import { readChain } from '../../src/approvals/store.js';

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
  return async ({ scanManager, agentLabel, mcpSummary, verifySources, declaredSourceSpec }) => {
    const rec = await scanManager.create({
      agentLabel,
      mcpConfig: mcpSummary,
      verifySources,
      ...(declaredSourceSpec ? { declaredSourceSpec } : {}),
    });
    await scanManager.complete(
      rec.id,
      {
        capturedAt: new Date().toISOString(),
        agentLabel,
        declared: [],
        sources: [],
      },
      `# Scan ${rec.id}\n\nFake scan referencing ${declaredSourceSpec ?? '(no declared source)'}\n`,
    );
    return rec.id;
  };
}

describe('sanitiseDeclaredSlug', () => {
  it('lowercases and slugifies typical names', () => {
    expect(sanitiseDeclaredSlug('Greenhouse Recruiter Bot')).toBe('greenhouse-recruiter-bot');
  });

  it('collapses runs of separators', () => {
    expect(sanitiseDeclaredSlug('foo  ___  bar')).toBe('foo-bar');
  });

  it('strips path traversal segments', () => {
    expect(sanitiseDeclaredSlug('../../etc/passwd')).toBe('etc-passwd');
  });

  it('rejects empty / whitespace / control-only input by returning empty string', () => {
    expect(sanitiseDeclaredSlug('')).toBe('');
    expect(sanitiseDeclaredSlug('   ')).toBe('');
    expect(sanitiseDeclaredSlug('\x00\x01\x02')).toBe('');
    expect(sanitiseDeclaredSlug('!@#$%^&*()')).toBe('');
  });

  it('strips leading/trailing dashes after sanitisation', () => {
    expect(sanitiseDeclaredSlug('---abc---')).toBe('abc');
  });

  it('caps at 64 chars and trims trailing dash from the cap point', () => {
    const long = 'a'.repeat(80);
    const out = sanitiseDeclaredSlug(long);
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out.endsWith('-')).toBe(false);
  });

  it('strips non-string input safely', () => {
    expect(sanitiseDeclaredSlug(undefined as unknown as string)).toBe('');
    expect(sanitiseDeclaredSlug(null as unknown as string)).toBe('');
  });
});

describe('AAP-53 render + end-to-end', () => {
  let reportDir: string;
  let scansDir: string;
  let approvalsDir: string;
  let declaredDir: string;
  let baseUrl: string;
  let server: Server | null = null;

  beforeEach(async () => {
    reportDir = mkdtempSync(join(tmpdir(), 'heron-x-report-'));
    scansDir = mkdtempSync(join(tmpdir(), 'heron-x-scans-'));
    approvalsDir = mkdtempSync(join(tmpdir(), 'heron-x-approvals-'));
    declaredDir = mkdtempSync(join(tmpdir(), 'heron-x-declared-'));

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
      declaredDir,
      scanRunner: fakeRunner(),
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
    rmSync(declaredDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // ─── Render — form pages have no JavaScript ────────────────

  it('scan trigger form has POST + correct action + no JS', async () => {
    const html = await fetch(`${baseUrl}/scans/new`).then((r) => r.text());
    expect(html).toContain('method="POST"');
    expect(html).toContain('action="/api/scans"');
    expect(html).not.toContain('<script');
    // All four verify sources rendered as checkboxes.
    expect(html).toContain('value="mcp-tools"');
    expect(html).toContain('value="oauth-scopes:greenhouse"');
    expect(html).toContain('value="oauth-scopes:bamboohr"');
    expect(html).toContain('value="oauth-scopes:google-workspace"');
  });

  it('approval form has all four radio actions + no JS', async () => {
    const html = await fetch(`${baseUrl}/approvals/agent-x/new`).then((r) => r.text());
    for (const a of ['declared', 'reviewed', 'approved', 'revoked']) {
      expect(html).toContain(`value="${a}"`);
    }
    expect(html).not.toContain('<script');
  });

  it('declared upload form uses multipart enctype + no JS', async () => {
    const html = await fetch(`${baseUrl}/declared/upload`).then((r) => r.text());
    expect(html).toContain('enctype="multipart/form-data"');
    expect(html).toContain('type="file"');
    expect(html).not.toContain('<script');
  });

  it('error page renders cleanly when POST is rejected', async () => {
    // POST without Origin -> 403, but a known-bad input on a valid origin should render an HTML error page.
    const body = new URLSearchParams({ mcp: 'not-a-known-scheme', 'agent-label': 'x' }).toString();
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
    const html = await r.text();
    expect(html).toContain('error-msg');
    expect(html).not.toContain('<script');
  });

  // ─── End-to-end happy paths ────────────────────────────────

  it('e2e: upload declared baseline + trigger scan referencing it + see in dashboard', async () => {
    // 1. Upload a baseline.
    const boundary = 'B';
    const json = JSON.stringify({
      agent: { name: 'recruiter-bot' },
      declared: { tools: [{ name: 'search_candidates' }] },
    });
    const uploadBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from('Content-Disposition: form-data; name="display-name"\r\n\r\n'),
      Buffer.from('recruiter-bot'),
      Buffer.from(`\r\n--${boundary}\r\n`),
      Buffer.from('Content-Disposition: form-data; name="file"; filename="x.json"\r\nContent-Type: application/json\r\n\r\n'),
      Buffer.from(json),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploadRes = await fetch(`${baseUrl}/api/declared`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Origin: baseUrl,
      },
      body: uploadBody,
      redirect: 'manual',
    });
    expect(uploadRes.status).toBe(303);
    const savedFiles = readdirSync(declaredDir);
    expect(savedFiles).toHaveLength(1);

    // 2. Trigger a scan that references it.
    const triggerBody = new URLSearchParams({
      mcp: 'stdio:node srv.js',
      'agent-label': 'recruiter-bot',
      'declared-source': `file:${join(declaredDir, savedFiles[0])}`,
    }).toString();
    const triggerRes = await fetch(`${baseUrl}/api/scans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: baseUrl,
      },
      body: triggerBody,
      redirect: 'manual',
    });
    expect(triggerRes.status).toBe(303);
    const loc = triggerRes.headers.get('location') ?? '';
    expect(loc).toMatch(/^\/scans\/scan-/);

    // 3. The scan shows up in /api/scans and /scans.
    const list = await fetch(`${baseUrl}/api/scans`).then((r) => r.json());
    expect(list.scans).toHaveLength(1);
    expect(list.scans[0].agentLabel).toBe('recruiter-bot');

    const detail = await fetch(`${baseUrl}${loc}`);
    expect(detail.status).toBe(200);
    const detailHtml = await detail.text();
    expect(detailHtml).toContain('recruiter-bot');
  });

  it('e2e: add approval entry from form, then chain page shows it', async () => {
    const body = new URLSearchParams({
      action: 'approved',
      'actor-name': 'Carol DPO',
      'actor-role': 'Data Protection Officer',
      'evidence-refs': 'ref://aap-53',
      comment: 'Approved for production',
    }).toString();
    const post = await fetch(`${baseUrl}/api/approvals/end-to-end-agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: baseUrl,
      },
      body,
      redirect: 'manual',
    });
    expect(post.status).toBe(303);
    expect(post.headers.get('location')).toBe('/approvals/end-to-end-agent');

    // Confirm via the store.
    const r = await readChain('end-to-end-agent', approvalsDir);
    expect(r.ok).toBe(true);

    // Confirm via the HTML chain page.
    const chainPage = await fetch(`${baseUrl}/approvals/end-to-end-agent`);
    expect(chainPage.status).toBe(200);
    const html = await chainPage.text();
    expect(html).toContain('Carol DPO');
    expect(html.toLowerCase()).toContain('approved');
  });

  it('Referer header (no Origin) is accepted when same-host', async () => {
    const u = new URL(baseUrl);
    const body = new URLSearchParams({
      action: 'declared',
      'actor-name': 'X',
      'actor-role': 'Y',
    }).toString();
    const r = await fetch(`${baseUrl}/api/approvals/referer-test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: `${baseUrl}/approvals/referer-test/new`,
        Host: u.host,
      },
      body,
      redirect: 'manual',
    });
    expect(r.status).toBe(303);
  });
});
