import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HeronMCPServer, type ReportDiffer } from '../../src/server/mcp-server.js';
import type {
  ProgressNotification,
  RequestContext,
} from '../../src/server/mcp-types.js';
import {
  createSession,
  getSession,
  setPendingQuestion,
} from '../../src/storage/sessions.js';
import {
  subscribeSessionEvents,
  type SessionEvent,
} from '../../src/storage/session-events.js';

/**
 * AAP-66 — async submit_answer regression suite.
 *
 * Pre-AAP-66, the planner-exhausted branch of `handleSubmitAnswer`
 * blocked the MCP tool response on `await analyzeAndRenderReport(...)`.
 * The 2026-05-21 live Codex.app run (session
 * `sess-20260521-025238-e8f1b3`) hit Codex CLI's 120s tool-call ceiling
 * on the final submit_answer — the audit completed server-side but the
 * client lost the response. AAP-66 moves analyze + verdict computation
 * to a detached background promise (the same pattern AAP-53.5 applied
 * to the sampling path).
 *
 * These tests cover:
 *   1. Tool returns immediately with `status: 'analyzing'` (no blocking).
 *   2. Background success publishes `'complete'` SSE + writes report + persists verdict.
 *   3. Background analyzer failure publishes `'analysis_failed'` SSE.
 *   4. Background unexpected throw publishes `'error'` SSE + flips session to 'error'.
 *   5. Final tool response never carries analysis output (SSE-only delivery).
 *   6. Pre-planner-exhausted path still resolves synchronously with the next question.
 */

const noopDiffer: ReportDiffer = { async diff() { return ''; } };

function makeCtx(): RequestContext {
  return {
    authPrincipal: null,
    sessionId: 'mcp-sess-aap67',
    progress: (_: ProgressNotification) => undefined,
    signal: new AbortController().signal,
  };
}

/**
 * Subscribe to a session's SSE-flavoured event bus and return a small
 * helper to query what was published. Auto-unsubscribes on `dispose()`.
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
    waitFor: (predicate, timeoutMs = 1000) =>
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

describe('HeronMCPServer.submit_answer — async final question (AAP-66)', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-aap67-submit-async-'));
    process.env.HERON_SESSIONS_DIR = tmpDir;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns immediately with status=analyzing when the planner is exhausted', async () => {
    // analyzeAndRenderReport NEVER resolves within the test window. If
    // the tool response is still synchronous on this branch (the pre-67
    // bug), this test hangs / fails on the deadline. If AAP-66 is wired
    // correctly, the tool returns in well under 100ms.
    const planner = {
      initial: () => ({ text: 'Q0', category: 'purpose' as const, index: 0 }),
      next: vi.fn(async () => null),
      totalCoreQuestions: 1,
    };
    const neverResolving = new Promise<never>(() => {});
    const analyze = vi.fn(() => neverResolving);

    const server = new HeronMCPServer({
      differ: noopDiffer,
      questionPlanner: planner,
      analyzeAndRenderReport: analyze as never,
    });

    const { id } = await createSession({ agentName: 'aap67-fixture', mode: 'tool-call' });
    await setPendingQuestion(id, { text: 'Q0', category: 'purpose', index: 0 });

    const t0 = Date.now();
    const r = await server.invoke(
      'submit_answer',
      { session_id: id, answer: 'A0' },
      makeCtx(),
    );
    const elapsed = Date.now() - t0;

    // The synchronous (pre-AAP-66) path would have hung indefinitely on
    // the never-resolving analyzer; vitest's 5000ms test ceiling caught
    // it cold. A small generous bound here (500ms) leaves headroom for
    // CI load while still being well below any conceivable analyzer
    // duration.
    expect(elapsed).toBeLessThan(500);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('analyzing');
    expect(r.value.session_id).toBe(id);
    expect(r.value.questions_asked).toBe(1);
    expect(r.value.report_markdown).toBeUndefined();
    expect(r.value.risk_level).toBeUndefined();
    expect(r.value.next_question).toBeUndefined();
  });

  it('background success publishes status-change=complete SSE and writes the report', async () => {
    const planner = {
      initial: () => ({ text: 'QA', category: 'purpose' as const, index: 0 }),
      next: vi.fn(async () => null),
      totalCoreQuestions: 1,
    };
    const analyze = vi.fn(async () => ({
      ok: true as const,
      markdown: '# AAP-66 Async Report',
      json: { overallRiskLevel: 'low', risks: [], summary: 'stub' },
      riskLevel: 'low' as string,
    }));

    const server = new HeronMCPServer({
      differ: noopDiffer,
      questionPlanner: planner,
      analyzeAndRenderReport: analyze,
    });

    const { id } = await createSession({ agentName: 'aap67-success', mode: 'tool-call' });
    await setPendingQuestion(id, { text: 'QA', category: 'purpose', index: 0 });

    const cap = captureEvents(id);
    try {
      const r = await server.invoke(
        'submit_answer',
        { session_id: id, answer: 'AA' },
        makeCtx(),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.status).toBe('analyzing');

      // Wait for the background promise to flip to 'complete'.
      const complete = (await cap.waitFor(
        (e) => e.type === 'status-change' && e.status === 'complete',
        2000,
      )) as Extract<SessionEvent, { type: 'status-change' }>;
      expect(complete.status).toBe('complete');
      // AAP-63 — without a Surface 2 scan the verdict is 'unverified',
      // regardless of the analyzer's self-reported risk level. The SSE
      // event carries that string under riskLevel.
      expect(complete.riskLevel).toBe('unverified');

      // Confirm the analyzer ran exactly once and the report landed on disk.
      expect(analyze).toHaveBeenCalledTimes(1);
      const stored = await getSession(id);
      expect(stored).not.toBeNull();
      expect(stored!.status).toBe('complete');
      expect(stored!.report).toBe('# AAP-66 Async Report');
      // AAP-63 — verdict persisted (same path as the synchronous version).
      expect(stored!.verificationStatus).toBe('unverified');
      expect(stored!.riskLevel).toBe('unverified');
    } finally {
      cap.dispose();
    }
  });

  it('background analyzer failure publishes status-change=analysis_failed SSE', async () => {
    const planner = {
      initial: () => ({ text: 'QA', category: 'purpose' as const, index: 0 }),
      next: vi.fn(async () => null),
      totalCoreQuestions: 1,
    };
    const analyze = vi.fn(async () => ({
      ok: false as const,
      markdown: '# Analysis failed — diagnostic payload',
      analysisError: {
        reason: 'parse_failure' as const,
        message: 'mock parse failure',
        attemptCount: 2,
        occurredAt: '2026-05-21T03:00:00.000Z',
      },
    }));

    const server = new HeronMCPServer({
      differ: noopDiffer,
      questionPlanner: planner,
      analyzeAndRenderReport: analyze,
    });

    const { id } = await createSession({ agentName: 'aap67-fail', mode: 'tool-call' });
    await setPendingQuestion(id, { text: 'QA', category: 'purpose', index: 0 });

    const cap = captureEvents(id);
    try {
      const r = await server.invoke(
        'submit_answer',
        { session_id: id, answer: 'AA' },
        makeCtx(),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.status).toBe('analyzing');

      const failed = (await cap.waitFor(
        (e) => e.type === 'status-change' && e.status === 'analysis_failed',
        2000,
      )) as Extract<SessionEvent, { type: 'status-change' }>;
      expect(failed.status).toBe('analysis_failed');

      const stored = await getSession(id);
      expect(stored).not.toBeNull();
      expect(stored!.status).toBe('analysis_failed');
      // writeAnalysisFailure persists the diagnostic envelope + failure markdown.
      expect(stored!.report).toBe('# Analysis failed — diagnostic payload');
      expect(stored!.analysisError?.reason).toBe('parse_failure');
    } finally {
      cap.dispose();
    }
  });

  it('background unexpected throw publishes type=error SSE and flips session to error', async () => {
    const planner = {
      initial: () => ({ text: 'QA', category: 'purpose' as const, index: 0 }),
      next: vi.fn(async () => null),
      totalCoreQuestions: 1,
    };
    const analyze = vi.fn(async () => {
      throw new Error('analyzer-blew-up');
    });

    const server = new HeronMCPServer({
      differ: noopDiffer,
      questionPlanner: planner,
      analyzeAndRenderReport: analyze as never,
    });

    const { id } = await createSession({ agentName: 'aap67-throw', mode: 'tool-call' });
    await setPendingQuestion(id, { text: 'QA', category: 'purpose', index: 0 });

    const cap = captureEvents(id);
    try {
      const r = await server.invoke(
        'submit_answer',
        { session_id: id, answer: 'AA' },
        makeCtx(),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.status).toBe('analyzing');

      const errEvent = (await cap.waitFor(
        (e) => e.type === 'error',
        2000,
      )) as Extract<SessionEvent, { type: 'error' }>;
      expect(errEvent.message).toMatch(/analyzer-blew-up/);

      const stored = await getSession(id);
      expect(stored).not.toBeNull();
      expect(stored!.status).toBe('error');
    } finally {
      cap.dispose();
    }
  });

  it('final tool response never carries analysis output, even if analyze finishes instantly', async () => {
    // Sanity check: even with a pre-resolved analyzer, the tool response
    // payload is still the bare `analyzing` envelope. report_markdown +
    // risk_level only ever arrive over SSE / via get_report.
    const planner = {
      initial: () => ({ text: 'QA', category: 'purpose' as const, index: 0 }),
      next: vi.fn(async () => null),
      totalCoreQuestions: 1,
    };
    const analyze = vi.fn(async () => ({
      ok: true as const,
      markdown: '# instant',
      json: { overallRiskLevel: 'low', risks: [], summary: 'stub' },
      riskLevel: 'low' as string,
    }));

    const server = new HeronMCPServer({
      differ: noopDiffer,
      questionPlanner: planner,
      analyzeAndRenderReport: analyze,
    });

    const { id } = await createSession({ agentName: 'aap67-instant', mode: 'tool-call' });
    await setPendingQuestion(id, { text: 'QA', category: 'purpose', index: 0 });

    const r = await server.invoke(
      'submit_answer',
      { session_id: id, answer: 'AA' },
      makeCtx(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('analyzing');
    expect(r.value).not.toHaveProperty('report_markdown');
    expect(r.value).not.toHaveProperty('risk_level');
    // questions_asked must still be present (callers track progress on it).
    expect(r.value.questions_asked).toBe(1);
  });

  it('non-exhausted planner branch still resolves synchronously with the next question', async () => {
    // Sanity check: the AAP-66 change only touches the planner-exhausted
    // branch. When `planner.next` returns a question, the tool must
    // continue to behave exactly like the pre-67 happy path.
    const planner = {
      initial: vi.fn(() => ({ text: 'Q0', category: 'purpose' as const, index: 0 })),
      next: vi.fn(async () => ({ text: 'Q1', category: 'data' as const, index: 1 })),
      totalCoreQuestions: 9,
    };
    const analyze = vi.fn(async () => ({
      ok: true as const,
      markdown: '# unused',
      json: {},
    }));

    const server = new HeronMCPServer({
      differ: noopDiffer,
      questionPlanner: planner,
      analyzeAndRenderReport: analyze,
    });

    const { id } = await createSession({ agentName: 'aap67-next', mode: 'tool-call' });
    await setPendingQuestion(id, { text: 'Q0', category: 'purpose', index: 0 });

    const r = await server.invoke(
      'submit_answer',
      { session_id: id, answer: 'A0' },
      makeCtx(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('awaiting_answer');
    expect(r.value.next_question).toBe('Q1');
    expect(r.value.questions_asked).toBe(1);
    // Analyzer must NOT run on the non-exhausted branch.
    expect(analyze).not.toHaveBeenCalled();
  });
});
