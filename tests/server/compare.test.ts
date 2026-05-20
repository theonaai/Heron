import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server, AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { startServer } from '../../src/server/index.js';
import type { LLMClient } from '../../src/llm/client.js';
import * as llmModule from '../../src/llm/client.js';

const MOCK_DIFF = `# Report Comparison

## Summary

| Resolved | Added | Severity changes | Systems +/− |
|----------|-------|------------------|-------------|
|    0     |   0   |        0         |     0 / 0   |

## Resolved
_(none)_

## Added
_(none)_
`;

/**
 * AAP-56: the analyzer no longer fabricates a clean-looking fallback when
 * the LLM returns garbage. These compare tests used to lean on that fallback
 * because their mock LLM always returned MOCK_DIFF, which JSON.parse never
 * accepted — the old code persisted a "medium / APPROVE WITH CONDITIONS"
 * report anyway and the session reached `complete`. With the new explicit
 * failure semantics the session would land on `analysis_failed`, so we now
 * dispatch the mock by prompt content: analyzer prompt → valid JSON,
 * everything else (diff renderer) → MOCK_DIFF.
 */
const MOCK_ANALYSIS_JSON = JSON.stringify({
  summary: 'Mock audit summary',
  agentPurpose: 'Test agent',
  agentTrigger: 'manual',
  systems: [],
  risks: [],
  recommendations: [],
  recommendation: 'APPROVE',
  overallRiskLevel: 'low',
});

describe('compare endpoints', () => {
  let tempDir: string;
  let baseUrl: string;
  let server: Server | null = null;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'heron-compare-test-'));

    const mockLLM: LLMClient = {
      chat: vi.fn(async (systemPrompt: string) => {
        // AAP-56: dispatch by prompt — analyzer needs JSON, diff renderer
        // wants markdown. The old all-MOCK_DIFF mock relied on the analyzer
        // silently masking parse failures with a fake-clean report.
        if (systemPrompt.includes('AI security analyst')) {
          return MOCK_ANALYSIS_JSON;
        }
        return MOCK_DIFF;
      }),
    };
    vi.spyOn(llmModule, 'createLLMClient').mockResolvedValue(mockLLM);

    const port = await getFreePort();
    server = await startServer({
      port,
      host: '127.0.0.1',
      llm: { provider: 'anthropic', apiKey: 'sk-ant-fake' },
      maxFollowUps: 0,
      reportDir: tempDir,
    });
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('POST /api/sessions/:id/compare writes diff file and returns 303 redirect', async () => {
    const sessionId = await runSessionToCompletion(baseUrl);

    const resp = await fetch(`${baseUrl}/api/sessions/${sessionId}/compare`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'text/markdown' },
      body: 'pretend old report',
    });

    expect(resp.status).toBe(303);
    expect(resp.headers.get('location')).toBe(`/sessions/${sessionId}/compare`);

    const diffPath = join(tempDir, `${sessionId}-diff.md`);
    expect(existsSync(diffPath)).toBe(true);
    expect(readFileSync(diffPath, 'utf-8')).toBe(MOCK_DIFF.trim());
  });

  it('GET /sessions/:id/compare renders saved diff as HTML', async () => {
    const sessionId = await runSessionToCompletion(baseUrl);
    const diffPath = join(tempDir, `${sessionId}-diff.md`);
    writeFileSync(diffPath, '## Summary\n\nHello diff.\n', 'utf-8');

    const resp = await fetch(`${baseUrl}/sessions/${sessionId}/compare`);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain('<h2>Summary</h2>');
    expect(html).toContain('Hello diff.');
    expect(html).toContain(`/sessions/${sessionId}`); // back link
  });

  it('GET /sessions/:id/compare returns 404 when no diff exists', async () => {
    const sessionId = await runSessionToCompletion(baseUrl);
    const resp = await fetch(`${baseUrl}/sessions/${sessionId}/compare`);
    expect(resp.status).toBe(404);
  });

  it('POST /api/sessions/:id/compare returns 413 for oversize bodies', async () => {
    const sessionId = await runSessionToCompletion(baseUrl);
    const huge = 'x'.repeat(200 * 1024); // 200 KB > 128 KB cap
    const resp = await fetch(`${baseUrl}/api/sessions/${sessionId}/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/markdown' },
      body: huge,
    });
    expect(resp.status).toBe(413);
  });

  it('landing page shows compare link for sessions with a diff on disk', async () => {
    const sessionId = await runSessionToCompletion(baseUrl);
    // Pre-place a diff file.
    writeFileSync(join(tempDir, `${sessionId}-diff.md`), '## Summary\n\n_(none)_', 'utf-8');

    const resp = await fetch(`${baseUrl}/`);
    const html = await resp.text();

    expect(html).toContain('<th>Compare</th>');
    expect(html).toContain(`<a href="/sessions/${sessionId}/compare">compare</a>`);
  });

  it('landing page JSON includes hasDiff for each session', async () => {
    const sessionId = await runSessionToCompletion(baseUrl);
    writeFileSync(join(tempDir, `${sessionId}-diff.md`), 'x', 'utf-8');

    const resp = await fetch(`${baseUrl}/api/sessions`);
    const data = (await resp.json()) as { sessions: Array<{ id: string; hasDiff: boolean }> };
    const s = data.sessions.find((x) => x.id === sessionId);
    expect(s).toBeDefined();
    expect(s!.hasDiff).toBe(true);
  });
});

// ──── Helpers ────

/** Pick a free TCP port by asking the OS for one via a throwaway listener. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

/**
 * Drives the existing `/v1/chat/completions` flow to completion so that
 * `session.report` is populated. The mocked LLM returns the same canned
 * markdown for every call — fine, because we only need status === 'complete'
 * and a non-null session.report for `compareWithUpload` to work.
 */
async function runSessionToCompletion(baseUrl: string): Promise<string> {
  let sessionId: string | undefined;
  for (let i = 0; i < 40; i++) {
    const body: Record<string, unknown> = {
      model: 'any',
      messages: [{ role: 'user', content: `answer ${i}` }],
    };
    if (sessionId) body.heron_session_id = sessionId;

    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await resp.json()) as {
      heron_session_id: string;
      heron_status?: string;
    };
    sessionId = data.heron_session_id;
    if (data.heron_status === 'complete') break;
  }
  if (!sessionId) throw new Error('could not complete session');

  // Wait up to ~3s for background analysis to finish.
  for (let i = 0; i < 30; i++) {
    const s = (await fetch(`${baseUrl}/api/sessions/${sessionId}`).then((r) => r.json())) as {
      status: string;
    };
    if (s.status === 'complete') return sessionId;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('session did not reach complete');
}
