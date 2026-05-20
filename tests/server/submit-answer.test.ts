import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HeronMCPServer, type ReportDiffer } from '../../src/server/mcp-server.js';
import type { ProgressNotification, RequestContext } from '../../src/server/mcp-types.js';
import {
  createSession,
  getSession,
  setPendingQuestion,
  updateSessionMeta,
} from '../../src/storage/sessions.js';

/**
 * Unit tests for the AAP-55 submit_answer MCP tool.
 *
 * submit_answer is the second half of the tool-call interview path.
 * Lifecycle:
 *   1. start_audit_session sees a non-sampling client, creates a
 *      session with mode='tool-call', writes the first question to
 *      session.pendingQuestion, returns status='awaiting_answer'.
 *   2. The client calls submit_answer with the agent's answer.
 *      Handler appends to transcript, asks the planner for the next
 *      question. If one exists → write to pendingQuestion + return
 *      'awaiting_answer'. If exhausted → run analyzeAndRenderReport
 *      synchronously, write report, return 'complete'.
 *
 * These tests inject a stub planner + stub analyzer so we cover the
 * tool surface without dragging the real LLM in.
 */

const noopDiffer: ReportDiffer = { async diff() { return ''; } };

function makeCtx(): RequestContext {
  return {
    authPrincipal: null,
    sessionId: 'mcp-sess-1',
    progress: (_: ProgressNotification) => undefined,
    signal: new AbortController().signal,
  };
}

describe('HeronMCPServer.submit_answer (AAP-55)', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-aap55-submit-'));
    process.env.HERON_SESSIONS_DIR = tmpDir;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists submit_answer in the tool registry', () => {
    const server = new HeronMCPServer({ differ: noopDiffer });
    const defs = server.listToolDefinitions();
    expect(defs.map((d) => d.name)).toContain('submit_answer');
    const def = defs.find((d) => d.name === 'submit_answer')!;
    expect(def.description).toMatch(/submit_answer|in-progress|audit/i);
    const schemaText = JSON.stringify(def.inputSchema);
    expect(schemaText).toMatch(/session_id/);
    expect(schemaText).toMatch(/answer/);
  });

  it('advances the interview by one question on a happy-path call', async () => {
    const planner = {
      initial: vi.fn(() => ({ text: 'Q0', category: 'purpose' as const, index: 0 })),
      next: vi.fn(async () => ({ text: 'Q1', category: 'data' as const, index: 1 })),
      totalCoreQuestions: 9,
    };
    const server = new HeronMCPServer({
      differ: noopDiffer,
      questionPlanner: planner,
      analyzeAndRenderReport: async () => ({ ok: true, markdown: '# unused', json: {} }),
    });

    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    await setPendingQuestion(id, { text: 'Q0', category: 'purpose', index: 0 });

    const r = await server.invoke('submit_answer', { session_id: id, answer: 'A0' }, makeCtx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('awaiting_answer');
    expect(r.value.next_question).toBe('Q1');
    expect(r.value.questions_asked).toBe(1);

    const stored = await getSession(id);
    expect(stored!.transcript).toEqual([
      { category: 'purpose', question: 'Q0', answer: 'A0' },
    ]);
    expect(stored!.pendingQuestion).toEqual({ text: 'Q1', category: 'data', index: 1 });
  });

  it('runs analyzeAndRenderReport + returns status=complete when the planner is exhausted', async () => {
    const planner = {
      initial: vi.fn(() => ({ text: 'QA', category: 'purpose' as const, index: 0 })),
      next: vi.fn(async () => null),
      totalCoreQuestions: 1,
    };
    const analyze = vi.fn(async () => ({
      ok: true as const,
      markdown: '# Final Report',
      json: { overallRiskLevel: 'low' },
      riskLevel: 'low',
    }));
    const server = new HeronMCPServer({
      differ: noopDiffer,
      questionPlanner: planner,
      analyzeAndRenderReport: analyze,
    });

    const { id } = await createSession({ agentName: 'fixture', mode: 'tool-call' });
    await setPendingQuestion(id, { text: 'QA', category: 'purpose', index: 0 });

    const r = await server.invoke('submit_answer', { session_id: id, answer: 'AA' }, makeCtx());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('complete');
    expect(r.value.report_markdown).toBe('# Final Report');
    // AAP-63 — without a Surface 2 discovery scan the verdict is
    // 'unverified' regardless of the analyzer's self-reported risk.
    expect(r.value.risk_level).toBe('unverified');
    expect(r.value.questions_asked).toBe(1);
    expect(analyze).toHaveBeenCalledTimes(1);

    const stored = await getSession(id);
    expect(stored!.status).toBe('complete');
    expect(stored!.report).toBe('# Final Report');
    expect(stored!.pendingQuestion ?? null).toBeNull();
    // AAP-63 — verdict fields persisted.
    expect(stored!.verificationStatus).toBe('unverified');
    expect(stored!.riskLevel).toBe('unverified');
    // The analyzer JSON did not include `risks`, so interviewRiskLevel
    // stays undefined here.
    expect(stored!.deterministicRiskLevel).toBeUndefined();
  });

  it('errors when the session id is unknown', async () => {
    const server = new HeronMCPServer({
      differ: noopDiffer,
      questionPlanner: {
        initial: () => ({ text: 'Q', category: 'purpose', index: 0 }),
        next: async () => null,
        totalCoreQuestions: 0,
      },
      analyzeAndRenderReport: async () => ({ ok: true, markdown: '', json: {} }),
    });

    const r = await server.invoke(
      'submit_answer',
      { session_id: 'sess-20260101-000000-deadbe', answer: 'x' },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('tool_failure');
  });

  it('rejects a session that is already complete', async () => {
    const planner = {
      initial: () => ({ text: 'Q', category: 'purpose' as const, index: 0 }),
      next: async () => null,
      totalCoreQuestions: 0,
    };
    const server = new HeronMCPServer({
      differ: noopDiffer,
      questionPlanner: planner,
      analyzeAndRenderReport: async () => ({ ok: true, markdown: '', json: {} }),
    });
    const { id } = await createSession({ agentName: 'x', mode: 'tool-call' });
    await updateSessionMeta(id, { status: 'complete' });

    const r = await server.invoke('submit_answer', { session_id: id, answer: 'x' }, makeCtx());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('tool_failure');
  });

  it('rejects a session that is in the sampling-mode interviewing state', async () => {
    const planner = {
      initial: () => ({ text: 'Q', category: 'purpose' as const, index: 0 }),
      next: async () => null,
      totalCoreQuestions: 0,
    };
    const server = new HeronMCPServer({
      differ: noopDiffer,
      questionPlanner: planner,
      analyzeAndRenderReport: async () => ({ ok: true, markdown: '', json: {} }),
    });
    // Sampling mode session — status starts at 'interviewing'.
    const { id } = await createSession({ agentName: 'x' /* no mode */ });

    const r = await server.invoke('submit_answer', { session_id: id, answer: 'x' }, makeCtx());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('tool_failure');
  });

  it('rejects malformed input (missing session_id, non-string answer)', async () => {
    const planner = {
      initial: () => ({ text: 'Q', category: 'purpose' as const, index: 0 }),
      next: async () => null,
      totalCoreQuestions: 0,
    };
    const server = new HeronMCPServer({
      differ: noopDiffer,
      questionPlanner: planner,
      analyzeAndRenderReport: async () => ({ ok: true, markdown: '', json: {} }),
    });

    const r1 = await server.invoke(
      'submit_answer',
      { answer: 'x' } as unknown as { session_id: string; answer: string },
      makeCtx(),
    );
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.error.kind).toBe('invalid_input');

    const r2 = await server.invoke(
      'submit_answer',
      { session_id: 'sess-20260101-000000-abc123', answer: 42 as unknown as string },
      makeCtx(),
    );
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.kind).toBe('invalid_input');
  });
});
