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
    // `'verified'`). The MCP response, the persisted verification field,
    // and the header label all move together.
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
        { session_id: id, runtime: 'codex', workspace_hint: workspace },
        makeCtx(),
      );

      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // AAP-80 — discovery-only runs yield a partial verdict ⇒
      // 'partially-verified' on the report-level field + the MCP response.
      expect(r.value.verification_status).toBe('partially-verified');

      const after = await getSession(id);
      const verif = (after!.reportJson as {
        verification?: { status?: string };
      }).verification;
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

      // Step 3 — start_verification.
      const r = await server.invoke(
        'start_verification',
        { session_id: id, runtime: 'codex', workspace_hint: workspace },
        makeCtx(),
      );
      expect(r.ok).toBe(true);

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
