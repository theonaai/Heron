import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HeronMCPServer } from '../../src/server/mcp-server.js';
import type {
  AuditPipeline,
  ReportDiffer,
} from '../../src/server/mcp-server.js';
import type { ProgressNotification, RequestContext } from '../../src/server/mcp-types.js';
import { appendTranscriptEntry, getSession } from '../../src/storage/sessions.js';

/**
 * Unit tests for the start_audit_session tool (AAP-52).
 *
 * The tool runs an MCP-sampling-driven interview: no target_endpoint
 * is involved, the audited agent is already on the MCP session.
 * The handler:
 *   1. createSession({ agentName })
 *   2. constructs a SamplingConnector against server.createMessage()
 *   3. runs the interview, appendTranscriptEntry as it goes
 *   4. analyzes the transcript, writeReport, status → 'complete'
 *
 * These tests stub the sampling channel + the interview runner so we
 * exercise the tool surface in isolation.
 */

const noopPipeline: AuditPipeline = {
  async run() {
    throw new Error('audit_agent pipeline must not be invoked from start_audit_session');
  },
};
const noopDiffer: ReportDiffer = {
  async diff() {
    return '';
  },
};

function makeCtx(): { ctx: RequestContext; controller: AbortController } {
  const controller = new AbortController();
  const ctx: RequestContext = {
    authPrincipal: null,
    sessionId: 'mcp-sess-1',
    progress: (_: ProgressNotification) => undefined,
    signal: controller.signal,
  };
  return { ctx, controller };
}

describe('HeronMCPServer.start_audit_session', () => {
  let tmpSessionsDir: string;
  const origSessionsEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpSessionsDir = mkdtempSync(join(tmpdir(), 'heron-aap52-'));
    process.env.HERON_SESSIONS_DIR = tmpSessionsDir;
  });
  afterEach(() => {
    if (origSessionsEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origSessionsEnv;
    rmSync(tmpSessionsDir, { recursive: true, force: true });
  });

  it('lists start_audit_session in the tool registry', () => {
    const server = new HeronMCPServer({
      auditPipeline: noopPipeline,
      differ: noopDiffer,
    });

    const defs = server.listToolDefinitions();
    const names = defs.map((d) => d.name);

    expect(names).toContain('start_audit_session');
    const startDef = defs.find((d) => d.name === 'start_audit_session')!;
    expect(startDef.description).toMatch(/sampling/i);
    // The tool must take NO target_endpoint — the agent IS the MCP client.
    expect(JSON.stringify(startDef.inputSchema)).not.toMatch(/target_endpoint/);
  });

  it('runs the sampling interview and writes a report to storage', async () => {
    // Fake interview runner: short transcript of 3 entries.
    // The production runner persists each Q/A via appendTranscriptEntry
    // as it goes; the fake mirrors that contract.
    const fakeRunInterview = vi.fn(async (params: {
      sessionId: string;
      sampler: { createMessage: (args: unknown) => Promise<unknown> };
    }) => {
      // Touch the sampler so the test confirms it's wired through.
      await params.sampler.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: 'probe' } }],
        maxTokens: 16,
      });
      const transcript = [
        { category: 'identity', question: 'Q1', answer: 'A1' },
        { category: 'systems', question: 'Q2', answer: 'A2' },
        { category: 'data', question: 'Q3', answer: 'A3' },
      ];
      for (const entry of transcript) {
        await appendTranscriptEntry(params.sessionId, entry);
      }
      return { transcript, questionsAsked: 3 };
    });

    const fakeAnalyze = vi.fn(async () => ({
      ok: true as const,
      markdown: '# Fake Report\nrisk: medium',
      json: { overallRiskLevel: 'medium', risks: [], dataQuality: { score: 80 } },
      riskLevel: 'medium' as string,
    }));

    const server = new HeronMCPServer({
      auditPipeline: noopPipeline,
      differ: noopDiffer,
      runSamplingInterview: fakeRunInterview,
      analyzeAndRenderReport: fakeAnalyze,
    });

    // Inject a fake sampling Server so the connector has something to talk to.
    // The stub declares sampling capability so the AAP-55 capability branch
    // routes to the sampling path (the original behaviour this test covers).
    const fakeMcpServer = {
      createMessage: vi.fn(async () => ({
        role: 'assistant',
        content: { type: 'text', text: 'ok' },
        model: 'fake',
        stopReason: 'endTurn',
      })),
      getClientCapabilities: () => ({ sampling: {} }),
    };
    server.attachSamplingServer(fakeMcpServer as never);

    const { ctx } = makeCtx();
    const result = await server.invoke('start_audit_session', { agent_name: 'fixture-agent' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // AAP-53.5 — tool call returns immediately with status 'interviewing'.
    // Background work continues; we poll for completion.
    expect(result.value.session_id).toMatch(/^sess-\d{8}-\d{6}-[a-z0-9]{6}$/);
    expect(result.value.status).toBe('interviewing');
    expect(result.value.questions_asked).toBe(0);

    // Wait for the background interview + analyze to settle. Poll the
    // store rather than rely on a fixed sleep; fake runners resolve
    // within a couple of microtask turns.
    const sessionId = result.value.session_id;
    let stored = await getSession(sessionId);
    const start = Date.now();
    // Wait for both status=complete AND riskLevel set — there's an
    // ordering race where writeReport flips status before
    // updateSessionMeta sets riskLevel.
    while (
      (stored?.status !== 'complete' || stored?.riskLevel === undefined) &&
      Date.now() - start < 5000
    ) {
      await new Promise((r) => setTimeout(r, 10));
      stored = await getSession(sessionId);
    }
    expect(fakeRunInterview).toHaveBeenCalledTimes(1);
    expect(fakeAnalyze).toHaveBeenCalledTimes(1);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe('complete');
    expect(stored!.transcript.length).toBe(3);
    expect(stored!.agentName).toBe('fixture-agent');
    expect(stored!.report).toMatch(/Fake Report/);
    expect(stored!.riskLevel).toBe('medium');
  });

  it('errors cleanly when no MCP sampling server is attached', async () => {
    const server = new HeronMCPServer({
      auditPipeline: noopPipeline,
      differ: noopDiffer,
    });
    const { ctx } = makeCtx();

    const result = await server.invoke('start_audit_session', {}, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('tool_failure');
  });

  // ─── AAP-56 — failure-mode propagation ──────────────────────────────────
  it('persists analysis_failed when analyzeAndRenderReport returns { ok: false }', async () => {
    const fakeRunInterview = vi.fn(async (params: {
      sessionId: string;
      sampler: { createMessage: (args: unknown) => Promise<unknown> };
    }) => {
      await params.sampler.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: 'probe' } }],
        maxTokens: 16,
      });
      const transcript = [
        { category: 'identity', question: 'Q1', answer: 'A1' },
      ];
      for (const entry of transcript) {
        await appendTranscriptEntry(params.sessionId, entry);
      }
      return { transcript, questionsAsked: 1 };
    });

    const occurredAt = '2026-05-20T03:34:03.123Z';
    const fakeAnalyze = vi.fn(async () => ({
      ok: false as const,
      markdown:
        '# Agent Access Audit — REPORT GENERATION FAILED\n\nverbatim transcript',
      analysisError: {
        reason: 'llm_unreachable' as const,
        message: '502 status code (no body)',
        attemptCount: 2,
        occurredAt,
      },
    }));

    const server = new HeronMCPServer({
      auditPipeline: noopPipeline,
      differ: noopDiffer,
      runSamplingInterview: fakeRunInterview,
      analyzeAndRenderReport: fakeAnalyze,
    });
    const fakeMcpServer = {
      createMessage: vi.fn(async () => ({
        role: 'assistant',
        content: { type: 'text', text: 'ok' },
        model: 'fake',
        stopReason: 'endTurn',
      })),
      // AAP-55 capability check: declare sampling so handleStartAuditSession
      // routes to the sampling-mode background path (where this test
      // exercises the AAP-56 analysis_failed branch).
      getClientCapabilities: vi.fn(() => ({ sampling: {} })),
    };
    server.attachSamplingServer(fakeMcpServer as never);

    const { ctx } = makeCtx();
    const result = await server.invoke('start_audit_session', { agent_name: 'codex.app' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sessionId = result.value.session_id;
    let stored = await getSession(sessionId);
    const start = Date.now();
    while ((stored?.status !== 'analysis_failed') && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 10));
      stored = await getSession(sessionId);
    }

    expect(fakeAnalyze).toHaveBeenCalledTimes(1);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe('analysis_failed');
    expect(stored!.report).toMatch(/REPORT GENERATION FAILED/);
    expect(stored!.analysisError).toBeDefined();
    expect(stored!.analysisError!.reason).toBe('llm_unreachable');
    expect(stored!.analysisError!.message).toContain('502');
    expect(stored!.analysisError!.attemptCount).toBe(2);
    expect(stored!.analysisError!.occurredAt).toBe(occurredAt);
    // Critically: no riskLevel + no fake-clean report.json contents.
    expect(stored!.riskLevel).toBeUndefined();
    expect(stored!.reportJson).toBeUndefined();
    // The misleading copy from the old buildFallbackAnalysis must NOT appear.
    expect(stored!.report).not.toContain('APPROVE WITH CONDITIONS');
    expect(stored!.report).not.toContain('LOW RISK');
  });

  it('rejects invalid input shapes', async () => {
    const server = new HeronMCPServer({
      auditPipeline: noopPipeline,
      differ: noopDiffer,
    });
    server.attachSamplingServer({ createMessage: async () => ({ content: { type: 'text', text: '' } }) } as never);
    const { ctx } = makeCtx();

    // agent_name must be a string when provided
    const result = await server.invoke('start_audit_session', { agent_name: 42 as unknown as string }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  // ─── AAP-55 — capability-driven branching ──────────────────────────────

  it('returns awaiting_answer + first question when the client does NOT declare sampling capability', async () => {
    const fakeRunInterview = vi.fn(async () => ({ transcript: [], questionsAsked: 0 }));
    const fakeAnalyze = vi.fn(async () => ({ ok: true, markdown: '', json: {} }));
    const planner = {
      initial: vi.fn(() => ({ text: 'first-question', category: 'purpose' as const, index: 0 })),
      next: vi.fn(async () => null),
      totalCoreQuestions: 9,
    };

    const server = new HeronMCPServer({
      auditPipeline: noopPipeline,
      differ: noopDiffer,
      runSamplingInterview: fakeRunInterview,
      analyzeAndRenderReport: fakeAnalyze,
      questionPlanner: planner,
    });
    // A "server" whose getClientCapabilities reports an empty bag — i.e. no sampling.
    server.attachSamplingServer({
      createMessage: async () => ({
        role: 'assistant',
        content: { type: 'text', text: '' },
        model: 'fake',
        stopReason: 'endTurn',
      }),
      getClientCapabilities: () => ({}),
    } as never);

    const { ctx } = makeCtx();
    const result = await server.invoke(
      'start_audit_session',
      { agent_name: 'codex-cli-fixture' },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe('awaiting_answer');
    expect(result.value.next_question).toBe('first-question');
    expect(result.value.questions_asked).toBe(0);
    expect(result.value.session_id).toMatch(/^sess-\d{8}-\d{6}-[a-z0-9]{6}$/);

    // Background sampling loop must NOT have been spawned.
    expect(fakeRunInterview).not.toHaveBeenCalled();
    expect(planner.initial).toHaveBeenCalledTimes(1);

    // Session row records mode='tool-call' and the pending question.
    const stored = await getSession(result.value.session_id);
    expect(stored).not.toBeNull();
    expect(stored!.mode).toBe('tool-call');
    expect(stored!.status).toBe('awaiting_answer');
    expect(stored!.pendingQuestion).toEqual({
      text: 'first-question',
      category: 'purpose',
      index: 0,
    });
  });

  it('keeps the sampling fire-and-forget path when the client DOES declare sampling', async () => {
    const fakeRunInterview = vi.fn(async (params: {
      sessionId: string;
      sampler: { createMessage: (args: unknown) => Promise<unknown> };
    }) => {
      void params;
      return { transcript: [], questionsAsked: 0 };
    });
    const fakeAnalyze = vi.fn(async () => ({
      ok: true as const,
      markdown: '# r',
      json: {},
      riskLevel: 'low' as string,
    }));
    const planner = {
      initial: vi.fn(() => ({ text: 'should-not-run', category: 'purpose' as const, index: 0 })),
      next: vi.fn(async () => null),
      totalCoreQuestions: 9,
    };

    const server = new HeronMCPServer({
      auditPipeline: noopPipeline,
      differ: noopDiffer,
      runSamplingInterview: fakeRunInterview,
      analyzeAndRenderReport: fakeAnalyze,
      questionPlanner: planner,
    });
    server.attachSamplingServer({
      createMessage: async () => ({
        role: 'assistant',
        content: { type: 'text', text: '' },
        model: 'fake',
        stopReason: 'endTurn',
      }),
      getClientCapabilities: () => ({ sampling: {} }),
    } as never);

    const { ctx } = makeCtx();
    const result = await server.invoke('start_audit_session', { agent_name: 'sampling-client' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('interviewing');
    // Planner must NOT be primed for tool-call mode.
    expect(planner.initial).not.toHaveBeenCalled();
  });
});
