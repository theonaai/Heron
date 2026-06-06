/**
 * G10 — end-to-end: agent-forwarded OAuth scopes flow into the
 * `start_verification` verdict + posture.
 *
 * This is the load-bearing wire test. It drives the real
 * `report_oauth_scopes` tool to persist a forwarded tokeninfo response,
 * then runs `start_verification` on the same session and asserts:
 *
 *   1. The forwarded scopes become a Verified OAU finding that lands in
 *      `report.json.verdict.findings` with `evidenceSource: 'OAU'`.
 *   2. The `oauthScopeVerification` section is persisted on report.json.
 *   3. The re-rendered markdown header reflects OAuth as a source (was
 *      always "OAuth N/A" on the MCP path before G10).
 *   4. NAME-ONLY: no token value appears in ANY session file on disk.
 *   5. The honest expired-token path lands an `unverified` OAuth section,
 *      not a silent N/A or a false verified.
 *
 * Mirrors the discovery happy-path test in `start-verification.test.ts`
 * (fake HERON_DISCOVERY_HOME + real workspace dir) so discovery runs for
 * real alongside the forwarded OAuth replay.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HeronMCPServer, type ReportDiffer } from '../../src/server/mcp-server.js';
import type { ProgressNotification, RequestContext } from '../../src/server/mcp-types.js';
import {
  createSession,
  getSession,
  getSessionsDir,
  updateSessionMeta,
  writeReport,
} from '../../src/storage/sessions.js';
import {
  subscribeSessionEvents,
  type SessionEvent,
} from '../../src/storage/session-events.js';

const noopDiffer: ReportDiffer = { async diff() { return ''; } };

/**
 * AAP-143 increment 1 — `start_verification` returns `'verifying'`
 * immediately and patches report.json from a detached background task.
 * Tests that read the persisted patch must wait for the bg task to
 * publish its `status-change=complete` event first.
 */
function waitForComplete(sessionId: string, timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const isComplete = (e: SessionEvent): boolean =>
      e.type === 'status-change' && e.status === 'complete';
    const seen: SessionEvent[] = [];
    const unsubscribe = subscribeSessionEvents(sessionId, (event) => {
      seen.push(event);
      if (isComplete(event)) {
        unsubscribe();
        resolve();
      }
    });
    const start = Date.now();
    const interval = setInterval(() => {
      if (seen.some(isComplete)) {
        clearInterval(interval);
        unsubscribe();
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        unsubscribe();
        reject(new Error(`Timed out waiting for status-change=complete on ${sessionId}`));
      }
    }, 5);
  });
}

function makeCtx(): RequestContext {
  return {
    authPrincipal: null,
    sessionId: 'mcp-g10-e2e-test',
    progress: (_: ProgressNotification) => undefined,
    signal: new AbortController().signal,
  };
}

function makeServer(): HeronMCPServer {
  return new HeronMCPServer({ differ: noopDiffer });
}

// The agent's forwarded tokeninfo body — broad Google grant. The
// access_token field is present (a real tokeninfo body can echo extra
// fields) so we can prove it never lands on disk.
const FORWARDED_TOKENINFO_BROAD = {
  scope:
    'https://www.googleapis.com/auth/drive ' +
    'https://www.googleapis.com/auth/spreadsheets',
  aud: '1234.apps.googleusercontent.com',
  access_token: 'ya29.E2E-TOKEN-MUST-NOT-LEAK',
  expires_in: 3599,
};

const MINIMAL_REPORT = {
  summary: 'Agent that edits Google Sheets and Drive.',
  agentPurpose: 'Sheets automation',
  systems: [],
  risks: [],
  recommendations: [],
  overallRiskLevel: 'low',
  transcript: [],
  metadata: {
    date: '2026-05-29',
    target: 'sheets-agent',
    interviewDuration: 1000,
    questionsAsked: 0,
  },
};

const STUB_MD =
  '# Stub\n\n## Verification Status\n\n**Verification status:** ' +
  '_UNVERIFIED — Surface 2 deterministic sources have not run yet._\n';

describe('G10 — start_verification with agent-forwarded OAuth scopes', () => {
  let tmpDir: string;
  const origSessions = process.env.HERON_SESSIONS_DIR;
  const origHome = process.env.HERON_DISCOVERY_HOME;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-g10-e2e-'));
    process.env.HERON_SESSIONS_DIR = tmpDir;
  });
  afterEach(() => {
    if (origSessions === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origSessions;
    if (origHome === undefined) delete process.env.HERON_DISCOVERY_HOME;
    else process.env.HERON_DISCOVERY_HOME = origHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('forwarded broad scopes → Verified OAU finding in posture + persisted section + OAuth in header', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'heron-g10-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'heron-g10-ws-'));
    process.env.HERON_DISCOVERY_HOME = fakeHome;
    try {
      // Minimal codex runtime so discovery has something to read.
      mkdirSync(join(fakeHome, '.codex'), { recursive: true });
      writeFileSync(join(fakeHome, '.codex/config.toml'), '# no mcp servers\n');

      const server = makeServer();
      const { id } = await createSession({ agentName: 'g10-e2e', mode: 'tool-call' });
      await updateSessionMeta(id, { status: 'complete' });
      await writeReport(id, { markdown: STUB_MD, json: MINIMAL_REPORT });

      // 1. Agent forwards its OWN introspection result (Heron never sees
      //    the token — the agent called tokeninfo itself).
      const forward = await server.invoke(
        'report_oauth_scopes',
        {
          session_id: id,
          provider: 'google-workspace',
          raw_response: FORWARDED_TOKENINFO_BROAD,
        },
        makeCtx(),
      );
      expect(forward.ok).toBe(true);
      if (!forward.ok) return;
      expect(forward.value.state).toBe('ok');
      expect(forward.value.scope_count).toBe(2);

      // 2. Run verification — discovery + the forwarded OAuth replay.
      //    AAP-143 — subscribe BEFORE invoking so the bg task's completion
      //    event is never missed; the call returns 'verifying' immediately.
      const completed = waitForComplete(id);
      const r = await server.invoke(
        'start_verification',
        { session_id: id, runtime: 'codex', workspace_hint: workspace },
        makeCtx(),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.verification_status).toBe('verifying');

      // Wait for the background task to land the OAuth patch (a Surface 2
      // source ran + produced a discrepancy ⇒ partial, since the broad
      // grant is an EXTRA). The settled status is read off report.json.
      await completed;

      const after = await getSession(id);
      const reportJson = after!.reportJson as {
        verdict?: {
          findings?: Array<{ evidenceSource: string; title: string }>;
          posture?: number;
        };
        oauthScopeVerification?: {
          sources?: Array<{ connector: string; verdict: string; actualScopes?: unknown[] }>;
        };
      };

      // OAU finding present + posture moved.
      const oauFindings = (reportJson.verdict?.findings ?? []).filter(
        (f) => f.evidenceSource === 'OAU',
      );
      expect(oauFindings.length).toBeGreaterThan(0);
      expect(reportJson.verdict?.posture ?? 0).toBeGreaterThan(0);

      // oauthScopeVerification section persisted with the two granted scopes.
      expect(reportJson.oauthScopeVerification?.sources?.[0]?.connector).toBe(
        'google-workspace',
      );
      expect(reportJson.oauthScopeVerification?.sources?.[0]?.actualScopes).toHaveLength(2);

      // 3. Re-rendered markdown header reflects OAuth as a source.
      const md = readFileSync(join(getSessionsDir(), id, 'report.md'), 'utf8');
      expect(md).toContain('## Verification Status');
      // The OAuth introspection row renders (provider name shown) rather
      // than the "skipped" placeholder.
      expect(md.toLowerCase()).toContain('oauth');

      // 4. NAME-ONLY: the token appears in NO session file.
      assertNoTokenOnDisk(id, 'ya29.E2E-TOKEN-MUST-NOT-LEAK');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('forwarded expired token → honest unverified OAuth section, not a silent N/A or false verified', async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'heron-g10-home-exp-'));
    const workspace = mkdtempSync(join(tmpdir(), 'heron-g10-ws-exp-'));
    process.env.HERON_DISCOVERY_HOME = fakeHome;
    try {
      mkdirSync(join(fakeHome, '.codex'), { recursive: true });
      writeFileSync(join(fakeHome, '.codex/config.toml'), '# no mcp servers\n');

      const server = makeServer();
      const { id } = await createSession({ agentName: 'g10-exp', mode: 'tool-call' });
      await updateSessionMeta(id, { status: 'complete' });
      await writeReport(id, { markdown: STUB_MD, json: MINIMAL_REPORT });

      // Agent's tokeninfo call returned an error (expired token) — it
      // forwards the error body anyway.
      const forward = await server.invoke(
        'report_oauth_scopes',
        {
          session_id: id,
          provider: 'google-workspace',
          raw_response: { error: 'invalid_token', error_description: 'Token has been expired or revoked.' },
        },
        makeCtx(),
      );
      expect(forward.ok).toBe(true);
      if (!forward.ok) return;
      expect(forward.value.state).toBe('introspection-error');

      // AAP-143 — subscribe before invoking; the call returns 'verifying'
      // and the OAuth patch lands from the background task.
      const completed = waitForComplete(id);
      const r = await server.invoke(
        'start_verification',
        { session_id: id, runtime: 'codex', workspace_hint: workspace },
        makeCtx(),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.verification_status).toBe('verifying');
      }
      await completed;

      const after = await getSession(id);
      const reportJson = after!.reportJson as {
        verdict?: { findings?: Array<{ evidenceSource: string }> };
        oauthScopeVerification?: {
          sources?: Array<{ verdict: string; errorMessage?: string }>;
        };
      };

      // Honest unverified OAuth section — NOT verified, NOT absent.
      const oauthSource = reportJson.oauthScopeVerification?.sources?.[0];
      expect(oauthSource?.verdict).toBe('unverified');
      expect(oauthSource?.errorMessage).toMatch(/token|expired|invalid|rejected/i);

      // AAP-115 — the failed introspection surfaces as ONE informational OAU
      // finding (visible, not silently empty). It carries no severity, so it
      // does not move posture, but it IS present in the findings list.
      const oauFindings = (reportJson.verdict?.findings ?? []).filter(
        (f) => f.evidenceSource === 'OAU',
      );
      expect(oauFindings).toHaveLength(1);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

/**
 * Walk every file in the session directory and assert the token string
 * appears in none of them. This is the hard name-only guarantee: Heron
 * holds only the introspection RESULT, never the token.
 */
function assertNoTokenOnDisk(sessionId: string, token: string): void {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
  const dir = join(getSessionsDir(), sessionId);
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const contents = readFileSync(full, 'utf8');
      expect(contents, `token leaked into ${full}`).not.toContain(token);
    }
  };
  walk(dir);
}
