/**
 * AAP-79 — start_verification handler tests.
 *
 * These were deferred during the first pass of AAP-79 (the integration
 * tests in `tests/server/mcp-server.integration.test.ts` only proved
 * the tool was registered + listed). Code review on PR #69 surfaced
 * five behaviours the handler needs to lock down explicitly:
 *
 *   1. Missing `session_id` → `invalid_input`.
 *   2. Unknown `session_id` → `tool_failure` with cause `session_not_found`.
 *   3. Session still in `awaiting_answer` → `tool_failure` with cause
 *      `interview_not_complete`.
 *   4. Session in `analysis_failed` → `tool_failure` with cause
 *      `analysis_failed`. Pre-PR-#69-fix the handler accepted these and
 *      wrote a partial `report.json`, violating `writeAnalysisFailure`'s
 *      "no report.json for failed analyses" invariant AND publishing a
 *      misleading `status: 'complete'` SSE event.
 *   5. Workspace_hint pointing at a non-existent directory →
 *      `verification-failed` with reason `workspace_invalid`, and the
 *      session.verification field flips to `verification-failed` on disk.
 *
 * These exercise the handler at the public `invoke()` entry point (the
 * same surface MCP clients hit). We do NOT run `runDiscovery` against
 * the real filesystem here — case 5 fails fast at the workspace_hint
 * stat call, before discovery is invoked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HeronMCPServer, type ReportDiffer } from '../../src/server/mcp-server.js';
import type { ProgressNotification, RequestContext } from '../../src/server/mcp-types.js';
import {
  createSession,
  getSession,
  setPendingQuestion,
  updateSessionMeta,
  writeAnalysisFailure,
  writeReport,
} from '../../src/storage/sessions.js';

const noopDiffer: ReportDiffer = { async diff() { return ''; } };

function makeCtx(): RequestContext {
  return {
    authPrincipal: null,
    sessionId: 'mcp-start-verification-test',
    progress: (_: ProgressNotification) => undefined,
    signal: new AbortController().signal,
  };
}

function makeServer(): HeronMCPServer {
  return new HeronMCPServer({ differ: noopDiffer });
}

describe('HeronMCPServer.start_verification — input + state validation', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-aap79-start-verif-'));
    process.env.HERON_SESSIONS_DIR = tmpDir;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects empty input with invalid_input on the session_id field', async () => {
    const server = makeServer();
    const r = await server.invoke(
      'start_verification',
      {} as unknown as Parameters<HeronMCPServer['invoke']>[1],
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
    if (r.error.kind !== 'invalid_input') return;
    expect(r.error.field).toBe('session_id');
  });

  it('rejects an unknown session_id with tool_failure (session_not_found)', async () => {
    const server = makeServer();
    const r = await server.invoke(
      'start_verification',
      { session_id: 'sess-20260101-000000-aaaaaa' },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('tool_failure');
    if (r.error.kind !== 'tool_failure') return;
    expect(r.error.cause).toBe('session_not_found');
  });

  it('rejects a session still in awaiting_answer with cause=interview_not_complete', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'still-running', mode: 'tool-call' });
    // setPendingQuestion is what flips the session to awaiting_answer.
    await setPendingQuestion(id, { text: 'Q', category: 'purpose', index: 0 });
    const r = await server.invoke(
      'start_verification',
      { session_id: id },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('tool_failure');
    if (r.error.kind !== 'tool_failure') return;
    expect(r.error.cause).toBe('interview_not_complete');
  });

  it('rejects a session in analysis_failed with cause=analysis_failed (no report.json patch)', async () => {
    const server = makeServer();
    const { id } = await createSession({ agentName: 'analyzer-broke', mode: 'tool-call' });
    await writeAnalysisFailure(
      id,
      {
        reason: 'parse_failure',
        message: 'Analyzer rejected the LLM blob.',
        attemptCount: 1,
        occurredAt: '2026-05-25T00:00:00.000Z',
      },
      '# Analysis failed\n\nThe analyzer could not produce a verdict.',
    );

    const r = await server.invoke(
      'start_verification',
      { session_id: id },
      makeCtx(),
    );

    // Handler refuses the call entirely. Pre-PR-#69-fix the handler ran
    // the discovery scan + patched report.json with localAgentDiscovery,
    // violating `writeAnalysisFailure`'s "no report.json on failure"
    // invariant. The fix is the explicit rejection below.
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('tool_failure');
    if (r.error.kind !== 'tool_failure') return;
    expect(r.error.cause).toBe('analysis_failed');
    expect(r.error.message).toMatch(/analysis_failed/);

    // Storage invariant: writeAnalysisFailure leaves report.json absent
    // on disk, and the rejecting handler must NOT have created one.
    const after = await getSession(id);
    expect(after!.status).toBe('analysis_failed');
    expect(after!.reportJson).toBeUndefined();
  });

  it('records verification-failed with workspace_invalid when workspace_hint is missing on disk', async () => {
    const server = makeServer();

    // Build a session with status=complete + a minimal report.json so
    // the handler reaches the workspace-resolution step. We can't easily
    // run `runDiscovery` from a unit test (it scans the real $HOME), but
    // we can prove the workspace-hint rejection branch flips
    // `verification.status` to `verification-failed` on disk and short-
    // circuits before discovery ever runs.
    const { id } = await createSession({ agentName: 'verifies', mode: 'tool-call' });
    await updateSessionMeta(id, { status: 'complete' });
    const minimalReport = {
      summary: 's',
      agentPurpose: 'p',
      systems: [],
      risks: [],
      recommendations: [],
      overallRiskLevel: 'low',
      transcript: [],
      metadata: {
        date: '2026-05-25',
        target: 'agent',
        interviewDuration: 1,
        questionsAsked: 0,
      },
    };
    await writeReport(id, {
      markdown: '# stub',
      json: minimalReport,
    });

    const missingPath = join(tmpDir, 'does-not-exist');
    const r = await server.invoke(
      'start_verification',
      { session_id: id, workspace_hint: missingPath },
      makeCtx(),
    );

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.verification_status).toBe('verification-failed');
    expect(r.value.error?.reason).toBe('workspace_invalid');

    const after = await getSession(id);
    const verif = (after!.reportJson as { verification?: { status?: string; reason?: string } })
      .verification;
    expect(verif?.status).toBe('verification-failed');
    expect(verif?.reason).toMatch(/workspace_hint/);
  });

  it('happy path: flips verification.status to verified + rewrites report.md with Verified markers', async () => {
    // End-to-end success path through the public `invoke()` surface.
    // The handler runs `runDiscovery` against a temp $HOME that carries a
    // fixture Codex config, secretlint-scrubs the result, recomputes
    // compliance, persists the verdict, and re-renders report.md.
    //
    // Codex review on PR #69 caught two regressions this test pins:
    //   1. `renderMarkdownReport` ran without verdict context, BEFORE
    //      `computeVerdictFromArtifacts` resolved, so the .md kept the
    //      UNVERIFIED stub even on a successful scan.
    //   2. The handler accepted `analysis_failed` sessions and wrote a
    //      partial `report.json` against `writeAnalysisFailure`'s
    //      "no report.json for failed analyses" invariant — covered
    //      separately by the analysis_failed rejection test above.
    const fakeHome = mkdtempSync(join(tmpdir(), 'heron-aap79-success-home-'));
    const origHomeEnv = process.env.HERON_DISCOVERY_HOME;
    process.env.HERON_DISCOVERY_HOME = fakeHome;
    const workspace = mkdtempSync(join(tmpdir(), 'heron-aap79-success-workspace-'));
    try {
      // Fixture Codex MCP config (same shape the existing discovery
      // route tests use). secretlintScrub redacts the token before it
      // reaches the synthesised evidence; only the env-key NAME flows
      // into the recompute path.
      mkdirSync(join(fakeHome, '.codex'), { recursive: true });
      writeFileSync(
        join(fakeHome, '.codex/config.toml'),
        '[mcp_servers.slack]\n' +
          'url = "https://slack-mcp.example.com"\n' +
          '[mcp_servers.slack.env]\n' +
          'SLACK_BOT_TOKEN = "xoxb-success-DO-NOT-LEAK"\n',
      );

      // Seed the session with a status=complete + minimal renderable
      // report.json. The starting markdown carries the UNVERIFIED stub
      // copy so we can prove the re-render replaced it.
      const server = makeServer();
      const { id } = await createSession({
        agentName: 'aap79-happy-path',
        mode: 'tool-call',
      });
      await updateSessionMeta(id, { status: 'complete' });
      const minimalReport = {
        summary: 'Demo agent that posts Slack messages.',
        agentPurpose: 'Slack reminders',
        systems: [],
        risks: [],
        recommendations: [],
        overallRiskLevel: 'low',
        transcript: [],
        metadata: {
          date: '2026-05-25',
          target: 'slack-bot',
          interviewDuration: 1000,
          questionsAsked: 0,
        },
      };
      const stubMd =
        '# Stub\n\n## Verification Status\n\n**Verification status:** ' +
        '_UNVERIFIED — Surface 2 deterministic sources have not run yet._\n';
      await writeReport(id, { markdown: stubMd, json: minimalReport });

      const r = await server.invoke(
        'start_verification',
        { session_id: id, workspace_hint: workspace },
        makeCtx(),
      );

      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.verification_status).toBe('verified');

      const after = await getSession(id);
      const verif = (after!.reportJson as {
        verification?: { status?: string };
      }).verification;
      expect(verif?.status).toBe('verified');

      // Read report.md off the live sessions dir. The pre-fix
      // behaviour left the UNVERIFIED stub in place; the fix replaces
      // it with the per-source Verification Status table and a
      // "Verified" header tag.
      const { readFileSync } = await import('node:fs');
      const { getSessionsDir } = await import('../../src/storage/sessions.js');
      const mdPath = join(getSessionsDir(), id, 'report.md');
      const renderedMd = readFileSync(mdPath, 'utf8');

      expect(renderedMd).not.toContain(
        'UNVERIFIED — Surface 2 deterministic sources have not run yet',
      );
      expect(renderedMd).toContain('Risk Level (Verified)');
      expect(renderedMd).toContain('## Verification Status');
      expect(renderedMd).toContain('Filesystem discovery');
      // Secret value never appears in the rendered .md.
      expect(renderedMd).not.toContain('xoxb-success-DO-NOT-LEAK');
    } finally {
      if (origHomeEnv === undefined) delete process.env.HERON_DISCOVERY_HOME;
      else process.env.HERON_DISCOVERY_HOME = origHomeEnv;
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('rejects workspace_hint that exists but is a file, not a directory', async () => {
    // Tightens the contract from the previous test: the path exists but
    // isn't a directory. Same `verification-failed` outcome — the resolved
    // workspace must be a directory, anything else is `workspace_invalid`.
    const server = makeServer();
    const { id } = await createSession({ agentName: 'verifies', mode: 'tool-call' });
    await updateSessionMeta(id, { status: 'complete' });
    await writeReport(id, {
      markdown: '# stub',
      json: {
        summary: 's',
        agentPurpose: 'p',
        systems: [],
        risks: [],
        recommendations: [],
        overallRiskLevel: 'low',
        transcript: [],
        metadata: {
          date: '2026-05-25',
          target: 'agent',
          interviewDuration: 1,
          questionsAsked: 0,
        },
      },
    });

    // Drop a regular file at a deterministic path under tmpDir.
    const filePath = join(tmpDir, 'not-a-directory.txt');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(filePath, 'I am a file, not a workspace.\n');

    const r = await server.invoke(
      'start_verification',
      { session_id: id, workspace_hint: filePath },
      makeCtx(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.verification_status).toBe('verification-failed');
    expect(r.value.error?.reason).toBe('workspace_invalid');
  });
});
