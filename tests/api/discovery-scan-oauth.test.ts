/**
 * Discovery scan route — L6 OAuth scope verification wire-up (AAP-74).
 *
 * Locks in the four behaviours the ticket calls out:
 *
 *   1. Filesystem-only scans still work without `oauthSources` (regression).
 *   2. Filesystem + oauthSources scans merge both halves into report.json
 *      AND the computed verdict reflects L6 evidence.
 *   3. OAuth-only scans (`skipFilesystem: true`, hosted-agent simulation)
 *      bypass the consent check + filesystem readers and still produce a
 *      valid verdict against the L6 source alone.
 *   4. Shape errors on `oauthSources` map to `400 invalid_oauth_sources`
 *      so the dashboard can surface the right copy.
 *
 * Network calls are mocked at the per-connector test setter — no
 * outbound HTTPS leaves the test process.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { POST as scanPOST } from '@/app/api/discovery/scan/route';
import { POST as consentPOST } from '@/app/api/discovery/consent/route';
import { POST as reportPOST } from '@/app/api/audit/sessions/[id]/report/route';
import { createSession, getSession } from '@/src/storage/sessions';
import {
  __setGoogleWorkspaceHttpClientForTesting,
  __setGreenhouseHttpClientForTesting,
  __setBambooHRHttpClientForTesting,
} from '@/src/verification/sources/oauth-scopes';

const ORIGIN = 'http://127.0.0.1:3700';

const FAKE_GOOGLE_ACCESS_TOKEN = 'fake-google-access-token-1234567890ab';

function jsonRequest(
  url: string,
  body: unknown,
  init: { method?: string; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    host: '127.0.0.1:3700',
    'Sec-Fetch-Site': 'same-origin',
    ...(init.headers ?? {}),
  };
  return new Request(url, {
    method: init.method ?? 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * Stub for the Google Workspace tokeninfo endpoint. Returns the
 * scope list as a single space-separated string per Google's
 * documented contract.
 */
function googleTokenInfoOk(
  scopes: string[],
): (url: string) => Promise<Response> {
  return async (url: string) => {
    if (!url.includes('tokeninfo')) {
      throw new Error(`unexpected URL hit by test stub: ${url}`);
    }
    return new Response(JSON.stringify({ scope: scopes.join(' ') }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('POST /api/discovery/scan — L6 OAuth wire-up (AAP-74)', () => {
  let sessionsDir: string;
  let homeDir: string;
  let sessionId: string;

  beforeEach(async () => {
    sessionsDir = await mkdtemp(join(tmpdir(), 'heron-scan-oauth-sessions-'));
    homeDir = await mkdtemp(join(tmpdir(), 'heron-scan-oauth-home-'));
    process.env.HERON_SESSIONS_DIR = sessionsDir;
    process.env.HERON_DISCOVERY_HOME = homeDir;

    const created = await createSession({});
    sessionId = created.id;
    await reportPOST(
      jsonRequest(`${ORIGIN}/api/audit/sessions/${sessionId}/report`, {
        markdown: '# x',
        json: {
          summary: 's',
          agentPurpose: 'p',
          systems: [],
          risks: [],
          recommendations: [],
          overallRiskLevel: 'low',
        },
      }),
      { params: Promise.resolve({ id: sessionId }) } as never,
    );
  });

  afterEach(async () => {
    delete process.env.HERON_SESSIONS_DIR;
    delete process.env.HERON_DISCOVERY_HOME;
    __setGoogleWorkspaceHttpClientForTesting(undefined);
    __setGreenhouseHttpClientForTesting(undefined);
    __setBambooHRHttpClientForTesting(undefined);
    await rm(sessionsDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  // ── Regression — filesystem-only scans unchanged ──────────────────

  it('filesystem-only scan still works without oauthSources (regression)', async () => {
    // Grant consent on cwd so the scan can run.
    await consentPOST(
      jsonRequest(`${ORIGIN}/api/discovery/consent`, {
        workspace: process.cwd(),
        decision: 'allow-once',
      }),
    );
    const res = await scanPOST(
      jsonRequest(`${ORIGIN}/api/discovery/scan`, { sessionId, runtime: 'codex' }),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{
      agents?: unknown;
      findings?: unknown;
      oauthScopeVerification?: unknown;
    }>(res);
    // Filesystem half present.
    expect(body.agents).toBeDefined();
    expect(body.findings).toBeDefined();
    // No L6 half because no oauthSources were provided.
    expect(body.oauthScopeVerification).toBeUndefined();
  });

  // ── Filesystem + L6 → merged result + verdict reflects L6 ─────────

  it('filesystem + oauthSources merges both halves into the response', async () => {
    __setGoogleWorkspaceHttpClientForTesting(
      googleTokenInfoOk([
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/calendar.events',
      ]),
    );
    await consentPOST(
      jsonRequest(`${ORIGIN}/api/discovery/consent`, {
        workspace: process.cwd(),
        decision: 'allow-once',
      }),
    );
    const res = await scanPOST(
      jsonRequest(`${ORIGIN}/api/discovery/scan`, {
        sessionId,
        runtime: 'codex',
        oauthSources: [
          {
            kind: 'google-workspace',
            accessToken: FAKE_GOOGLE_ACCESS_TOKEN,
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{
      agents?: unknown;
      oauthScopeVerification?: {
        capturedAt: string;
        sources: Array<{
          connector: string;
          verdict: string;
          actualScopes: Array<{ scope: string; service: string }>;
          diffs: Array<{ kind: string; scope: string; severity: string }>;
        }>;
      };
    }>(res);

    expect(body.agents).toBeDefined();
    const verif = body.oauthScopeVerification;
    expect(verif).toBeDefined();
    expect(verif!.sources).toHaveLength(1);
    const src = verif!.sources[0];
    expect(src.connector).toBe('google-workspace');
    // No declared baseline from the dashboard yet, so every actual scope
    // surfaces as an EXTRA diff — that's the intended HR-vertical
    // behaviour per AAP-74.
    expect(src.actualScopes.length).toBeGreaterThan(0);
    expect(src.diffs.length).toBeGreaterThan(0);
    expect(src.diffs.every((d) => d.kind === 'extra')).toBe(true);

    // Verdict pipeline picked up the L6 evidence — session meta flips
    // off the 'unverified' sentinel.
    const updated = await getSession(sessionId);
    expect(updated!.verificationStatus).not.toBe('unverified');
  });

  // ── OAuth-only (hosted-agent simulation) ──────────────────────────

  it('skipFilesystem + oauthSources bypasses consent and produces a verdict', async () => {
    __setGoogleWorkspaceHttpClientForTesting(
      googleTokenInfoOk(['https://www.googleapis.com/auth/gmail.readonly']),
    );
    // Deliberately DO NOT grant consent — the OAuth-only path should
    // skip the consent check entirely.
    const res = await scanPOST(
      jsonRequest(`${ORIGIN}/api/discovery/scan`, {
        sessionId,
        skipFilesystem: true,
        oauthSources: [
          { kind: 'google-workspace', accessToken: FAKE_GOOGLE_ACCESS_TOKEN },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{
      agents?: unknown;
      oauthScopeVerification?: {
        sources: Array<{ connector: string; actualScopes: unknown[] }>;
      };
    }>(res);
    // No filesystem half — hosted-agent flow.
    expect(body.agents).toBeUndefined();
    expect(body.oauthScopeVerification).toBeDefined();
    expect(body.oauthScopeVerification!.sources).toHaveLength(1);
    expect(body.oauthScopeVerification!.sources[0].connector).toBe('google-workspace');
    expect(body.oauthScopeVerification!.sources[0].actualScopes.length).toBeGreaterThan(0);

    const updated = await getSession(sessionId);
    // 'partial' is correct: L6 ran, filesystem did not, so we have
    // Surface 2 evidence on at least one source — but not all.
    expect(updated!.verificationStatus).toBe('partial');
    // Verdict pipeline ran against an L6-only input — primary risk
    // is deterministic (low, given a clean read with no declared
    // baseline → extras at info severity).
    expect(updated!.deterministicRiskLevel).toBeDefined();

    // AAP-80 — the report-level `verification.status` now flips on the
    // OAuth-only path too (previously the patch was gated on
    // filesystem `finalResult`, leaving the report stuck in
    // 'interrogation-only' despite L6 evidence landing).
    const verif = (updated!.reportJson as {
      verification?: { status?: string };
    }).verification;
    expect(verif?.status).toBe('partially-verified');
  });

  it('AAP-80: skipFilesystem + oauthSources writes partially-verified into report.json + report.md', async () => {
    // Tightens the AAP-80 spec point 4: the OAuth-only path persists
    // both the JSON-level verification.status AND a refreshed
    // report.md. The previous regression let report.md keep the
    // interrogation-only banner even after L6 evidence landed.
    __setGoogleWorkspaceHttpClientForTesting(
      googleTokenInfoOk(['https://www.googleapis.com/auth/gmail.readonly']),
    );
    // Seed a richer report.md baseline so we can prove the re-render
    // happened (the AAP-79 stub copy carries "UNVERIFIED — Surface 2
    // deterministic sources have not run yet" which we expect to
    // disappear after the rewrite).
    await reportPOST(
      jsonRequest(`${ORIGIN}/api/audit/sessions/${sessionId}/report`, {
        markdown:
          '# Stub\n\n## Verification Status\n\n**Verification status:** ' +
          '_UNVERIFIED — Surface 2 deterministic sources have not run yet._\n',
        json: {
          summary: 's',
          agentPurpose: 'p',
          systems: [],
          risks: [],
          recommendations: [],
          overallRiskLevel: 'low',
          metadata: {
            date: '2026-05-25',
            target: 'demo',
            interviewDuration: 100,
            questionsAsked: 0,
          },
          transcript: [],
        },
      }),
      { params: Promise.resolve({ id: sessionId }) } as never,
    );

    const res = await scanPOST(
      jsonRequest(`${ORIGIN}/api/discovery/scan`, {
        sessionId,
        skipFilesystem: true,
        oauthSources: [
          { kind: 'google-workspace', accessToken: FAKE_GOOGLE_ACCESS_TOKEN },
        ],
      }),
    );
    expect(res.status).toBe(200);

    const updated = await getSession(sessionId);
    const verif = (updated!.reportJson as {
      verification?: { status?: string; updatedAt?: string };
    }).verification;
    expect(verif?.status).toBe('partially-verified');
    expect(verif?.updatedAt).toBeDefined();

    // Read report.md from disk. The AAP-80 re-render must have replaced
    // the UNVERIFIED stub with the partially-verified header marker.
    const { readFile } = await import('node:fs/promises');
    const mdPath = join(sessionsDir, sessionId, 'report.md');
    const md = await readFile(mdPath, 'utf8');
    expect(md).not.toContain(
      'UNVERIFIED — Surface 2 deterministic sources have not run yet',
    );
    // AAP-93 M5 — header now splits Risk Level and Verification.
    expect(md).toContain('**Verification**: Partial');
    expect(md).not.toContain('Risk Level (Partially Verified)');
    // Per-source table reflects "filesystem: skipped" honestly.
    expect(md).toContain('Filesystem discovery');
    expect(md).toMatch(/Filesystem discovery.*skipped/i);
  });

  // ── Validation errors ─────────────────────────────────────────────

  it('rejects skipFilesystem without oauthSources (400 invalid_body)', async () => {
    const res = await scanPOST(
      jsonRequest(`${ORIGIN}/api/discovery/scan`, {
        sessionId,
        skipFilesystem: true,
      }),
    );
    expect(res.status).toBe(400);
    const body = await readJson<{ code?: string; error?: string }>(res);
    expect(body.code).toBe('invalid_body');
  });

  it('rejects malformed oauthSources entries (400 invalid_oauth_sources)', async () => {
    const res = await scanPOST(
      jsonRequest(`${ORIGIN}/api/discovery/scan`, {
        sessionId,
        oauthSources: [
          // Missing required `accessToken` field.
          { kind: 'google-workspace' },
        ],
      }),
    );
    expect(res.status).toBe(400);
    const body = await readJson<{ code?: string; error?: string }>(res);
    expect(body.code).toBe('invalid_oauth_sources');
  });

  it('caps oauthSources at 8 entries', async () => {
    const tooMany = Array.from({ length: 9 }, () => ({
      kind: 'google-workspace' as const,
      accessToken: FAKE_GOOGLE_ACCESS_TOKEN,
    }));
    const res = await scanPOST(
      jsonRequest(`${ORIGIN}/api/discovery/scan`, {
        sessionId,
        skipFilesystem: true,
        oauthSources: tooMany,
      }),
    );
    expect(res.status).toBe(400);
    const body = await readJson<{ code?: string }>(res);
    expect(body.code).toBe('invalid_oauth_sources');
  });

  // ── Failed source read surfaces as 'unverified' (no crash) ────────

  it('unverified verdict propagates when the source read fails', async () => {
    // Return 401 from tokeninfo — connector reports `kind: 'unauthorized'`.
    __setGoogleWorkspaceHttpClientForTesting(async () => {
      return new Response(JSON.stringify({ error: 'invalid_token' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });
    const res = await scanPOST(
      jsonRequest(`${ORIGIN}/api/discovery/scan`, {
        sessionId,
        skipFilesystem: true,
        oauthSources: [
          { kind: 'google-workspace', accessToken: FAKE_GOOGLE_ACCESS_TOKEN },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{
      oauthScopeVerification?: {
        sources: Array<{ verdict: string; errorMessage?: string }>;
      };
    }>(res);
    expect(body.oauthScopeVerification!.sources[0].verdict).toBe('unverified');
    expect(body.oauthScopeVerification!.sources[0].errorMessage).toBeTruthy();
  });
});
