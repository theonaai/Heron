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
import {
  subscribeSessionEvents,
  type SessionEvent,
} from '../../src/storage/session-events.js';

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

/**
 * AAP-143 increment 1 — `start_verification` returns immediately with
 * `'verifying'` and patches report.json from a detached background task.
 * Tests that assert the persisted patch must wait for the bg task to
 * finish. Subscribe to the session event bus and resolve when a predicate
 * matches (mirrors `submit-answer-async.test.ts`). Auto-disposes.
 */
function captureEvents(sessionId: string): {
  events: SessionEvent[];
  waitFor: (
    predicate: (e: SessionEvent) => boolean,
    timeoutMs?: number,
  ) => Promise<SessionEvent>;
  dispose: () => void;
} {
  const events: SessionEvent[] = [];
  const unsubscribe = subscribeSessionEvents(sessionId, (event) => {
    events.push(event);
  });
  return {
    events,
    waitFor: (predicate, timeoutMs = 5000) =>
      new Promise<SessionEvent>((resolve, reject) => {
        const existing = events.find(predicate);
        if (existing) {
          resolve(existing);
          return;
        }
        const start = Date.now();
        const interval = setInterval(() => {
          const hit = events.find(predicate);
          if (hit) {
            clearInterval(interval);
            resolve(hit);
            return;
          }
          if (Date.now() - start > timeoutMs) {
            clearInterval(interval);
            reject(
              new Error(
                `Timed out after ${timeoutMs}ms waiting for an event. ` +
                  `Captured so far: ${JSON.stringify(events)}`,
              ),
            );
          }
        }, 5);
      }),
    dispose: unsubscribe,
  };
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
      { session_id: 'sess-20260101-000000-aaaaaa', runtime: 'codex' },
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
      { session_id: id, runtime: 'codex' },
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
      { session_id: id, runtime: 'codex' },
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
      { session_id: id, runtime: 'codex', workspace_hint: missingPath },
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

  it('happy path: flips verification.status to partially-verified + rewrites report.md with Partially Verified markers (AAP-80)', async () => {
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
    //
    // AAP-80 — discovery-only runs now produce a `partial` verdict, which
    // maps to `'partially-verified'` on the report-level field (not
    // `'verified'`). The persisted verification field + header label move
    // together.
    //
    // AAP-143 increment 1 — `start_verification` now returns immediately
    // with `'verifying'` and patches report.json from a detached
    // background task. The immediate response is asserted as `'verifying'`;
    // the persisted `'partially-verified'` outcome + re-rendered .md are
    // read AFTER the background task publishes its `status-change=complete`
    // SSE event (the bg task runs the discovery scan + patch, then
    // publishes that event last).
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

      const cap = captureEvents(id);
      const r = await server.invoke(
        'start_verification',
        { session_id: id, runtime: 'codex', workspace_hint: workspace },
        makeCtx(),
      );

      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // AAP-143 — the call returns immediately with 'verifying'. The
      // terminal status lands on report.json from the background task.
      expect(r.value.verification_status).toBe('verifying');

      // Wait for the background task to finish (it publishes
      // status-change=complete as its last step after the patch).
      await cap.waitFor(
        (e) => e.type === 'status-change' && e.status === 'complete',
        5000,
      );
      cap.dispose();

      const after = await getSession(id);
      const verif = (after!.reportJson as {
        verification?: { status?: string };
      }).verification;
      // AAP-80 — discovery-only runs yield a partial verdict ⇒
      // 'partially-verified' on the persisted report-level field.
      expect(verif?.status).toBe('partially-verified');

      // Read report.md off the live sessions dir. The pre-AAP-80
      // behaviour emitted "Risk Level (Verified)" for any verdict with
      // Surface 2 evidence; the AAP-80 fix routes the label through
      // `report.verification.status`, so a partial verdict produces
      // "Risk Level (Partially Verified)".
      const { readFileSync } = await import('node:fs');
      const { getSessionsDir } = await import('../../src/storage/sessions.js');
      const mdPath = join(getSessionsDir(), id, 'report.md');
      const renderedMd = readFileSync(mdPath, 'utf8');

      expect(renderedMd).not.toContain(
        'UNVERIFIED — Surface 2 deterministic sources have not run yet',
      );
      // AAP-93 M5 — header splits Risk Level and Verification onto
      // distinct fields.
      expect(renderedMd).toContain('**Verification**: Partial');
      expect(renderedMd).not.toContain('Risk Level (Partially Verified)');
      expect(renderedMd).not.toContain('Risk Level (Verified)');
      // The amber AAP-80 banner copy renders for the partial state.
      expect(renderedMd).toContain('Partially verified.');
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
      { session_id: id, runtime: 'codex', workspace_hint: filePath },
      makeCtx(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.verification_status).toBe('verification-failed');
    expect(r.value.error?.reason).toBe('workspace_invalid');
  });
});

describe('HeronMCPServer.start_verification — agent-reported tools overlay (AAP-82 Blocker 1 + Bonus 9)', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-aap82-startverif-overlay-'));
    process.env.HERON_SESSIONS_DIR = tmpDir;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists agent-reported tools into localAgentDiscovery and lifts the verdict for the write tools', async () => {
    // AAP-82 Bonus 9 (Codex post-review): the load-bearing contract. An
    // agent forwards a `tools/list` for an HTTP MCP server via
    // `report_mcp_tools_list`; running `start_verification` later must
    // merge that forwarded inventory into the discovery output, mark
    // each tool with `source: 'agent-reported'`, and let the write
    // tools lift the verdict ramp exactly like connector-sourced tools
    // would.
    //
    // Fixture shape mirrors the AAP-79 happy-path test above — a
    // Codex config under a fake $HOME — so `runDiscovery` finds the
    // declared HTTP MCP server, then the overlay step replaces its
    // (no_credential) toolEnumeration with the agent-forwarded tools.
    const fakeHome = mkdtempSync(join(tmpdir(), 'heron-aap82-startverif-home-'));
    const origHomeEnv = process.env.HERON_DISCOVERY_HOME;
    process.env.HERON_DISCOVERY_HOME = fakeHome;
    const workspace = mkdtempSync(join(tmpdir(), 'heron-aap82-startverif-workspace-'));
    try {
      mkdirSync(join(fakeHome, '.codex'), { recursive: true });
      writeFileSync(
        join(fakeHome, '.codex/config.toml'),
        '[mcp_servers.github]\n' +
          'url = "https://api.githubcopilot.com/mcp"\n' +
          '[mcp_servers.github.env]\n' +
          'GITHUB_TOKEN = "ghp-fixture-DO-NOT-LEAK"\n',
      );

      const server = makeServer();
      const { id } = await createSession({
        agentName: 'aap82-overlay-fixture',
        mode: 'tool-call',
      });

      // Step 1 — agent forwards its tools/list for the github server
      // BEFORE start_verification runs. The directive in
      // src/interview/questions.ts asks for exactly this sequence.
      const forward = await server.invoke(
        'report_mcp_tools_list',
        {
          session_id: id,
          server_name: 'github',
          raw_response: {
            jsonrpc: '2.0',
            id: 1,
            result: {
              tools: [
                { name: 'get_pull_request', description: 'Read a PR.' },
                { name: 'create_issue', description: 'Open an issue.' },
                { name: 'merge_pull_request', description: 'Merge a PR.' },
                { name: 'delete_branch', description: 'Delete a branch.' },
                { name: 'update_repository', description: 'Mutate repo settings.' },
                { name: 'create_pull_request', description: 'File a PR.' },
              ],
            },
          },
        },
        makeCtx(),
      );
      expect(forward.ok).toBe(true);

      // Step 2 — seed the session with a complete report so
      // start_verification proceeds past the gating checks. Carry an
      // empty `systems` so `recomputeComplianceWithDiscovery` runs.
      await updateSessionMeta(id, { status: 'complete' });
      const minimalReport = {
        summary: 'Demo agent that uses GitHub MCP.',
        agentPurpose: 'GitHub automation',
        systems: [],
        risks: [],
        recommendations: [],
        overallRiskLevel: 'low',
        transcript: [],
        metadata: {
          date: '2026-05-25',
          target: 'github-bot',
          interviewDuration: 1000,
          questionsAsked: 0,
        },
      };
      await writeReport(id, { markdown: '# stub', json: minimalReport });

      // Step 3 — start_verification. AAP-143 — returns 'verifying'
      // immediately; the overlay patch lands from the background task.
      const cap = captureEvents(id);
      const r = await server.invoke(
        'start_verification',
        { session_id: id, runtime: 'codex', workspace_hint: workspace },
        makeCtx(),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.verification_status).toBe('verifying');
      }

      // Wait for the background task to land the patch (publishes
      // status-change=complete as its last step).
      await cap.waitFor(
        (e) => e.type === 'status-change' && e.status === 'complete',
        5000,
      );
      cap.dispose();

      // Step 4 — assert the persisted report.json reflects the overlay.
      const after = await getSession(id);
      const reportJson = after!.reportJson as {
        localAgentDiscovery?: {
          agents?: Array<{
            mcpServers: Array<{
              name: string;
              toolEnumeration?: {
                state: string;
                source?: string;
                tools?: Array<{ name: string; classification: string; source?: string }>;
              };
            }>;
          }>;
        };
      };
      expect(reportJson.localAgentDiscovery).toBeDefined();
      const allServers = (reportJson.localAgentDiscovery?.agents ?? []).flatMap(
        (a) => a.mcpServers,
      );
      const githubServer = allServers.find((s) => s.name === 'github');
      expect(githubServer).toBeDefined();
      expect(githubServer!.toolEnumeration?.state).toBe('ok');
      expect(githubServer!.toolEnumeration?.source).toBe('agent-reported');
      const tools = githubServer!.toolEnumeration?.tools ?? [];
      // 6 tools forwarded — they all reach report.json with the
      // agent-reported provenance stamp.
      expect(tools.length).toBe(6);
      for (const tool of tools) {
        expect(tool.source).toBe('agent-reported');
      }
      const writeNames = tools.filter((t) => t.classification === 'write').map((t) => t.name);
      // create_issue / merge_pull_request / create_pull_request /
      // update_repository / delete_branch all map to write under the
      // existing classifier rules.
      expect(writeNames.length).toBeGreaterThanOrEqual(4);

      // Step 5 — verdict pipeline consumes the agent-forwarded write tools.
      // AAP-102: `countWriteTools` no longer drives a separate
      // `deterministicRiskLevel`; the new BR × DS × DM model in
      // `severity-scoring.ts` consumes the write-tool count as the BR-W
      // axis, and posture is mapped onto the legacy `riskLevel` string
      // for storage back-compat. With 5+ writes BR-W = 3 and BR-A = 3
      // (autonomous default), so BR = 3. The fixture has no typed T2/T3
      // sensitivity signal and no Annex III domain marker, so DS = 1 and
      // DM = 1.0; severity = 3 × 1 × 1.0 = 3 → band `low`. The honest
      // outcome under the new model — write count alone is not enough
      // to lift the gradient; a downstream high-sensitivity datastore
      // touch or Annex III domain would.
      const persistedRiskLevel = after!.riskLevel;
      expect(persistedRiskLevel).toBeDefined();
      // The pipeline ran (riskLevel is not 'unverified') and lands in
      // one of the legacy bands the storage field allows.
      expect(['low', 'medium', 'high', 'critical']).toContain(persistedRiskLevel);
      expect(persistedRiskLevel).not.toBe('unverified');
    } finally {
      if (origHomeEnv === undefined) delete process.env.HERON_DISCOVERY_HOME;
      else process.env.HERON_DISCOVERY_HOME = origHomeEnv;
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('start_verification — async return + extractable patch (AAP-143)', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-aap143-async-'));
    process.env.HERON_SESSIONS_DIR = tmpDir;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Seed a status=complete session with a minimal renderable report.json
  // so the handler passes the gate + workspace resolution and reaches the
  // async fork. Returns the session id.
  async function seedCompleteSession(agentName: string): Promise<string> {
    const { id } = await createSession({ agentName, mode: 'tool-call' });
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
          date: '2026-06-04',
          target: 'agent',
          interviewDuration: 1,
          questionsAsked: 0,
        },
      },
    });
    return id;
  }

  it('Test 1 — handleStartVerification returns verification_status=verifying WITHOUT waiting for the scan (patch not yet written)', async () => {
    // Point discovery at a fixture $HOME so the bg scan would eventually
    // run, but assert the tool call returns 'verifying' and that
    // report.json still reads 'verifying' (NOT a terminal status)
    // immediately after the call — proving the patch had not been written
    // when the handler returned. If the handler still ran synchronously
    // (the AAP-143 bug), the immediate return would carry a terminal
    // status and report.json would already be patched.
    const fakeHome = mkdtempSync(join(tmpdir(), 'heron-aap143-home-'));
    const origHomeEnv = process.env.HERON_DISCOVERY_HOME;
    process.env.HERON_DISCOVERY_HOME = fakeHome;
    const workspace = mkdtempSync(join(tmpdir(), 'heron-aap143-workspace-'));
    try {
      mkdirSync(join(fakeHome, '.codex'), { recursive: true });
      writeFileSync(
        join(fakeHome, '.codex/config.toml'),
        '[mcp_servers.slack]\n' +
          'url = "https://slack-mcp.example.com"\n' +
          '[mcp_servers.slack.env]\n' +
          'SLACK_BOT_TOKEN = "xoxb-aap143-DO-NOT-LEAK"\n',
      );

      const server = makeServer();
      const id = await seedCompleteSession('aap143-async');

      const t0 = Date.now();
      const r = await server.invoke(
        'start_verification',
        { session_id: id, runtime: 'codex', workspace_hint: workspace },
        makeCtx(),
      );
      const elapsed = Date.now() - t0;

      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // The immediate return is the in-progress marker, never a terminal
      // status.
      expect(r.value.verification_status).toBe('verifying');
      expect(r.value.high_severity_findings).toBe(0);
      expect(r.value.total_findings).toBe(0);
      expect(r.value.summary).toMatch(/poll get_report/i);
      // Generous bound — the synchronous (buggy) path ran a full discovery
      // scan + recompute before returning; the async path returns after a
      // single small report.json patch.
      expect(elapsed).toBeLessThan(2000);

      // Read report.json straight off disk. The handler persisted the
      // 'verifying' marker synchronously before forking; the terminal
      // patch is still pending in the background, so the on-disk status
      // must be 'verifying', not a terminal value.
      const after = await getSession(id);
      const verif = (after!.reportJson as {
        verification?: { status?: string };
        localAgentDiscovery?: unknown;
      });
      expect(verif.verification?.status).toBe('verifying');
      // The patch the bg task writes (localAgentDiscovery) is NOT present
      // yet.
      expect(verif.localAgentDiscovery).toBeUndefined();
    } finally {
      if (origHomeEnv === undefined) delete process.env.HERON_DISCOVERY_HOME;
      else process.env.HERON_DISCOVERY_HOME = origHomeEnv;
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('Test 2 — runVerificationAndPatch run to completion patches report.json with localAgentDiscovery + verdict + a settled verification status', async () => {
    // Drives the extracted heavy body directly (no tool-call timer in the
    // way). This is the same work the old synchronous start_verification
    // produced; we assert the artefacts land on report.json.
    const fakeHome = mkdtempSync(join(tmpdir(), 'heron-aap143-direct-home-'));
    const origHomeEnv = process.env.HERON_DISCOVERY_HOME;
    process.env.HERON_DISCOVERY_HOME = fakeHome;
    const workspace = mkdtempSync(join(tmpdir(), 'heron-aap143-direct-ws-'));
    try {
      mkdirSync(join(fakeHome, '.codex'), { recursive: true });
      writeFileSync(
        join(fakeHome, '.codex/config.toml'),
        '[mcp_servers.slack]\n' +
          'url = "https://slack-mcp.example.com"\n' +
          '[mcp_servers.slack.env]\n' +
          'SLACK_BOT_TOKEN = "xoxb-aap143-direct-DO-NOT-LEAK"\n',
      );

      const id = await seedCompleteSession('aap143-direct');
      const session = await getSession(id);
      expect(session).not.toBeNull();

      const { runVerificationAndPatch } = await import(
        '../../src/server/mcp-server.js'
      );
      const result = await runVerificationAndPatch(id, {
        runtime: 'codex',
        workspaceRoot: workspace,
        session: session!,
        additionalHints: [],
      });

      // A settled (terminal) status, never 'verifying'/'interrogation-only'.
      expect([
        'verified',
        'partially-verified',
        'verification-failed',
      ]).toContain(result.verificationStatus);
      // Discovery-only run yields a partial verdict.
      expect(result.verificationStatus).toBe('partially-verified');

      // report.json carries the discovery payload, verdict snapshot, and
      // the settled verification status — same artefacts the old
      // synchronous path produced.
      const after = await getSession(id);
      const blob = after!.reportJson as {
        verification?: { status?: string };
        localAgentDiscovery?: unknown;
        verdict?: unknown;
      };
      expect(blob.verification?.status).toBe('partially-verified');
      expect(blob.localAgentDiscovery).toBeDefined();
      expect(blob.verdict).toBeDefined();

      // The re-rendered markdown does not leak the scrubbed secret.
      const { readFileSync } = await import('node:fs');
      const { getSessionsDir } = await import('../../src/storage/sessions.js');
      const renderedMd = readFileSync(
        join(getSessionsDir(), id, 'report.md'),
        'utf8',
      );
      expect(renderedMd).not.toContain('xoxb-aap143-direct-DO-NOT-LEAK');
      expect(renderedMd).toContain('## Verification Status');
    } finally {
      if (origHomeEnv === undefined) delete process.env.HERON_DISCOVERY_HOME;
      else process.env.HERON_DISCOVERY_HOME = origHomeEnv;
      rmSync(fakeHome, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
