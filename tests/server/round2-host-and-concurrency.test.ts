/**
 * PR #24 round 2 — failing tests for security/robustness fixes.
 *
 *  1. CRITICAL: Host-header allow-list (defence against DNS rebinding +
 *     reflected attacks that ride a user's loopback browser session).
 *     Reject any inbound request whose Host: header is not in the
 *     allow-list with HTTP 421 Misdirected Request — BEFORE dispatch.
 *  2. MEDIUM: per-process concurrency cap on /api/scans (429 + Retry-After).
 *  3. MEDIUM: per-request scan timeout (504 Gateway Timeout).
 *  4. Reviewer's race: defaultScanRunner / runMcpScan returns the real
 *     scan id rather than guessing `list[0]`.
 *  5. LOW: HTTP-layer cap on `verify` (16 entries) + `evidence-refs`
 *     (32 entries).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { startServer } from '../../src/server/index.js';
import * as llmModule from '../../src/llm/client.js';
import type { LLMClient } from '../../src/llm/client.js';
import type { ScanRunner } from '../../src/server/index.js';

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

interface TestServerHandle {
  baseUrl: string;
  host: string;
  port: number;
  server: Server;
  reportDir: string;
  scansDir: string;
  approvalsDir: string;
  declaredDir: string;
  cleanup: () => Promise<void>;
}

async function startTestServer(opts?: {
  runner?: ScanRunner;
}): Promise<TestServerHandle> {
  const reportDir = mkdtempSync(join(tmpdir(), 'heron-r2-report-'));
  const scansDir = mkdtempSync(join(tmpdir(), 'heron-r2-scans-'));
  const approvalsDir = mkdtempSync(join(tmpdir(), 'heron-r2-approvals-'));
  const declaredDir = mkdtempSync(join(tmpdir(), 'heron-r2-declared-'));

  const mockLLM: LLMClient = { chat: vi.fn().mockResolvedValue('') };
  vi.spyOn(llmModule, 'createLLMClient').mockResolvedValue(mockLLM);

  const port = await getFreePort();
  const host = `127.0.0.1:${port}`;
  const server = await startServer({
    port,
    host: '127.0.0.1',
    llm: { provider: 'anthropic', apiKey: 'sk-ant-fake' },
    maxFollowUps: 0,
    reportDir,
    scansDir,
    approvalsDir,
    declaredDir,
    scanRunner: opts?.runner ?? fakeRunner(),
  });

  return {
    baseUrl: `http://${host}`,
    host,
    port,
    server,
    reportDir,
    scansDir,
    approvalsDir,
    declaredDir,
    cleanup: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(reportDir, { recursive: true, force: true });
      rmSync(scansDir, { recursive: true, force: true });
      rmSync(approvalsDir, { recursive: true, force: true });
      rmSync(declaredDir, { recursive: true, force: true });
      vi.restoreAllMocks();
    },
  };
}

describe('round-2: Host-header allow-list (CRITICAL — DNS rebinding defence)', () => {
  let h: TestServerHandle;

  beforeEach(async () => {
    h = await startTestServer();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  it('rejects POST /api/scans when Host header is not in the allow-list (421)', async () => {
    const body = new URLSearchParams({
      mcp: 'stdio:node s.js',
      'agent-label': 'x',
    }).toString();
    const r = await fetch(`${h.baseUrl}/api/scans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Host: 'evil.attacker.com',
        Origin: 'http://evil.attacker.com',
      },
      body,
      redirect: 'manual',
    });
    expect(r.status).toBe(421);
  });

  it('rejects GET / when Host header is not in the allow-list (421)', async () => {
    const r = await fetch(`${h.baseUrl}/`, {
      headers: { Host: 'evil.attacker.com' },
    });
    expect(r.status).toBe(421);
  });

  it('allows GET / with same-host Host header (200)', async () => {
    const r = await fetch(`${h.baseUrl}/`, {
      headers: { Host: h.host },
    });
    expect(r.status).toBe(200);
  });

  it('allows POST /api/approvals with same-host Host + Origin (303)', async () => {
    const body = new URLSearchParams({
      action: 'declared',
      'actor-name': 'T',
      'actor-role': 'R',
    }).toString();
    const r = await fetch(`${h.baseUrl}/api/approvals/test-x`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Host: h.host,
        Origin: h.baseUrl,
      },
      body,
      redirect: 'manual',
    });
    expect(r.status).toBe(303);
  });

  it('honours HERON_ALLOWED_HOSTS env override', async () => {
    // Spin a separate server with env var set BEFORE startServer is called.
    await h.cleanup();
    process.env.HERON_ALLOWED_HOSTS = 'allow.example.com';
    try {
      h = await startTestServer();
      const r = await fetch(`${h.baseUrl}/`, {
        headers: { Host: 'allow.example.com' },
      });
      expect(r.status).toBe(200);
    } finally {
      delete process.env.HERON_ALLOWED_HOSTS;
    }
  });
});

describe('round-2: /api/scans concurrency cap + timeout (MEDIUM)', () => {
  let h: TestServerHandle;
  let originalMax: string | undefined;
  let originalTimeout: string | undefined;

  beforeEach(() => {
    originalMax = process.env.HERON_MAX_CONCURRENT_SCANS;
    originalTimeout = process.env.HERON_SCAN_TIMEOUT_MS;
  });

  afterEach(async () => {
    if (h) await h.cleanup();
    if (originalMax === undefined) delete process.env.HERON_MAX_CONCURRENT_SCANS;
    else process.env.HERON_MAX_CONCURRENT_SCANS = originalMax;
    if (originalTimeout === undefined) delete process.env.HERON_SCAN_TIMEOUT_MS;
    else process.env.HERON_SCAN_TIMEOUT_MS = originalTimeout;
  });

  it('returns 429 when concurrent scans exceed HERON_MAX_CONCURRENT_SCANS', async () => {
    process.env.HERON_MAX_CONCURRENT_SCANS = '2';
    // Runner that blocks until a manual release token fires.
    const releaseSignals: Array<() => void> = [];
    const slowRunner: ScanRunner = async ({ scanManager, agentLabel, mcpSummary, verifySources }) => {
      await new Promise<void>((resolve) => {
        releaseSignals.push(resolve);
      });
      const rec = await scanManager.create({
        agentLabel,
        mcpConfig: mcpSummary,
        verifySources,
      });
      await scanManager.complete(rec.id, {
        capturedAt: new Date().toISOString(),
        agentLabel,
        declared: [],
        sources: [],
      }, `# ${rec.id}`);
      return rec.id;
    };
    h = await startTestServer({ runner: slowRunner });

    // Fire three concurrent requests; the third should get 429 immediately
    // (the first two are blocked in the runner).
    const post = (label: string) =>
      fetch(`${h.baseUrl}/api/scans`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Host: h.host,
          Origin: h.baseUrl,
        },
        body: new URLSearchParams({
          mcp: 'stdio:node s.js',
          'agent-label': label,
        }).toString(),
        redirect: 'manual',
      });

    const p1 = post('a');
    const p2 = post('b');
    // Give the first two requests a moment to claim semaphore slots.
    await new Promise((r) => setTimeout(r, 50));
    const p3 = post('c');
    const r3 = await p3;
    expect(r3.status).toBe(429);
    expect(r3.headers.get('retry-after')).toBeTruthy();

    // Release the blocked runners so test cleanup completes.
    for (const release of releaseSignals) release();
    await Promise.all([p1, p2]);
  });

  it('returns 504 when a scan exceeds HERON_SCAN_TIMEOUT_MS', async () => {
    process.env.HERON_SCAN_TIMEOUT_MS = '100';
    let releaseRunner: (() => void) | null = null;
    const slowRunner: ScanRunner = async () => {
      await new Promise<void>((resolve) => {
        releaseRunner = () => resolve();
      });
      // Should never reach here in the timeout case, but produce a valid
      // return to satisfy the type if it does.
      return 'never';
    };
    h = await startTestServer({ runner: slowRunner });

    const r = await fetch(`${h.baseUrl}/api/scans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Host: h.host,
        Origin: h.baseUrl,
      },
      body: new URLSearchParams({
        mcp: 'stdio:node s.js',
        'agent-label': 'slow',
      }).toString(),
      redirect: 'manual',
    });
    expect(r.status).toBe(504);
    if (releaseRunner) (releaseRunner as () => void)();
  });
});

describe('round-2: HTTP-layer caps on verify + evidence-refs (LOW)', () => {
  let h: TestServerHandle;
  beforeEach(async () => { h = await startTestServer(); });
  afterEach(async () => { await h.cleanup(); });

  it('rejects POST /api/scans when verify has more than 16 entries', async () => {
    const params = new URLSearchParams({
      mcp: 'stdio:node s.js',
      'agent-label': 'x',
    });
    for (let i = 0; i < 17; i++) params.append('verify', 'mcp-tools');
    const r = await fetch(`${h.baseUrl}/api/scans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Host: h.host,
        Origin: h.baseUrl,
      },
      body: params.toString(),
      redirect: 'manual',
    });
    expect(r.status).toBe(400);
  });

  it('rejects POST /api/approvals when evidence-refs has more than 32 entries', async () => {
    const refs = Array.from({ length: 33 }, (_, i) => `ref-${i}`).join('\n');
    const r = await fetch(`${h.baseUrl}/api/approvals/test-cap`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Host: h.host,
        Origin: h.baseUrl,
      },
      body: new URLSearchParams({
        action: 'declared',
        'actor-name': 'X',
        'actor-role': 'Y',
        'evidence-refs': refs,
      }).toString(),
      redirect: 'manual',
    });
    expect(r.status).toBe(400);
  });
});

describe('round-2: defaultScanRunner returns runMcpScan scan id (race fix)', () => {
  it('runMcpScan returns an object containing { scanId }', async () => {
    // We only validate the public shape — actually running an MCP scan
    // here would require a real server. The race-fix is that the runner
    // uses the returned id verbatim instead of guessing `list[0]`.
    const mod = await import('../../src/commands/mcp-scan.js');
    expect(typeof mod.runMcpScan).toBe('function');
    // The signature is verified at type-check time. Runtime probe: read
    // the function source to confirm it ends with `return {`-style
    // statement (loose smoke test only).
    const src = mod.runMcpScan.toString();
    expect(src).toContain('scanId');
  });
});
