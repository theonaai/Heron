import { describe, it, expect, beforeEach } from 'vitest';

import {
  HeronMCPServer,
  type AuditPipeline,
  type ReportStore,
  type ReportDiffer,
  type StoredReport,
} from '../../src/server/mcp-server.js';
import type {
  AuditAgentInput,
  CompareReportsInput,
  GetReportInput,
  ProgressNotification,
  RequestContext,
} from '../../src/server/mcp-types.js';

/**
 * Unit tests for the transport-agnostic MCP server wrapper.
 *
 * These tests do NOT spin up an MCP transport. They construct
 * `HeronMCPServer` with fake dependencies and call `invoke()` directly
 * with a mocked `RequestContext`. The goal is to exercise the handler
 * logic in isolation — schema validation, error mapping, progress
 * emission, cancellation propagation — without paying the cost of a
 * real stdio subprocess or HTTP listener.
 */

// ─── Fakes ────────────────────────────────────────────────────────────────

class FakeAuditPipeline implements AuditPipeline {
  private behavior: 'happy' | 'error' = 'happy';
  private slow = false;

  setBehavior(behavior: 'happy' | 'error'): void {
    this.behavior = behavior;
  }
  setSlow(slow: boolean): void {
    this.slow = slow;
  }

  async run(
    input: { targetEndpoint: string; options?: Record<string, unknown> },
    ctx: { progress: (p: ProgressNotification) => void; signal: AbortSignal; sessionId: string },
  ): Promise<{ report: string; reportId: string; summary: { riskLevel: string; findingsCount: number; recommendation?: string }; target: string }>{
    ctx.progress({ stage: 'interrogating', pct: 10 });
    if (this.slow) {
      // Wait until the abort signal fires (or 5s ceiling).
      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          ctx.signal.removeEventListener('abort', onAbort);
          resolve();
        };
        if (ctx.signal.aborted) return resolve();
        ctx.signal.addEventListener('abort', onAbort);
        setTimeout(resolve, 5_000);
      });
    }
    ctx.progress({ stage: 'analyzing', pct: 40 });
    if (this.behavior === 'error') {
      throw new Error('pipeline blew up');
    }
    if (ctx.signal.aborted) {
      throw new DOMException('aborted', 'AbortError');
    }
    ctx.progress({ stage: 'mapping', pct: 70 });
    ctx.progress({ stage: 'rendering', pct: 95 });
    return {
      report: `# Audit\n\nTarget: ${input.targetEndpoint}\nSession: ${ctx.sessionId}`,
      reportId: 'report_fake_123',
      target: input.targetEndpoint,
      summary: {
        riskLevel: 'medium',
        findingsCount: 1,
        recommendation: 'APPROVE WITH CONDITIONS',
      },
    };
  }
}

class FakeReportStore implements ReportStore {
  private byId = new Map<string, StoredReport>();
  put(record: StoredReport): void {
    this.byId.set(record.reportId, record);
  }
  get(id: string): StoredReport | undefined {
    return this.byId.get(id);
  }
}

class FakeDiffer implements ReportDiffer {
  async diff(reportA: StoredReport, reportB: StoredReport): Promise<string> {
    return `## Summary\nA (${reportA.reportId}) vs B (${reportB.reportId})\n## Resolved\n- nothing\n## Added\n- new finding`;
  }
}

function makeContext(overrides: Partial<RequestContext> = {}): {
  ctx: RequestContext;
  notifications: ProgressNotification[];
  controller: AbortController;
} {
  const notifications: ProgressNotification[] = [];
  const controller = new AbortController();
  const ctx: RequestContext = {
    authPrincipal: null,
    sessionId: 'sess_unit_test',
    signal: controller.signal,
    progress: (n) => notifications.push(n),
    ...overrides,
  };
  return { ctx, notifications, controller };
}

function makeServer(): {
  server: HeronMCPServer;
  pipeline: FakeAuditPipeline;
  store: FakeReportStore;
  differ: FakeDiffer;
} {
  const pipeline = new FakeAuditPipeline();
  const store = new FakeReportStore();
  const differ = new FakeDiffer();
  const server = new HeronMCPServer({ auditPipeline: pipeline, reportStore: store, differ });
  return { server, pipeline, store, differ };
}

// ─── audit_agent ──────────────────────────────────────────────────────────

describe('HeronMCPServer.audit_agent', () => {
  let server: HeronMCPServer;
  let pipeline: FakeAuditPipeline;
  let store: FakeReportStore;

  beforeEach(() => {
    const s = makeServer();
    server = s.server;
    pipeline = s.pipeline;
    store = s.store;
  });

  it('happy path: returns report markdown, id, and summary', async () => {
    const { ctx } = makeContext();
    const input: AuditAgentInput = { target_endpoint: 'https://agent.example.com/v1' };
    const result = await server.invoke('audit_agent', input, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report_markdown).toContain('Target: https://agent.example.com/v1');
    expect(result.value.report_id).toBe('report_fake_123');
    expect(result.value.summary).toEqual({
      risk_level: 'medium',
      findings_count: 1,
      recommendation: 'APPROVE WITH CONDITIONS',
    });
    // Pipeline output should also be stored so get_report can find it.
    expect(store.get('report_fake_123')?.target).toBe('https://agent.example.com/v1');
  });

  it('emits progress at each pipeline stage', async () => {
    const { ctx, notifications } = makeContext();
    await server.invoke('audit_agent', { target_endpoint: 'http://x' }, ctx);
    const stages = notifications.map((n) => n.stage);
    // The fake pipeline emits 4 stages; wrapper may add bookend stages.
    expect(stages).toEqual(expect.arrayContaining(['interrogating', 'analyzing', 'mapping', 'rendering']));
    // At least one notification carries a percentage.
    expect(notifications.some((n) => typeof n.pct === 'number')).toBe(true);
  });

  it('respects abort signal and returns cancelled error', async () => {
    pipeline.setSlow(true);
    const { ctx, controller } = makeContext();
    const promise = server.invoke('audit_agent', { target_endpoint: 'http://x' }, ctx);
    // Cancel before pipeline finishes.
    setTimeout(() => controller.abort(), 10);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('cancelled');
  });

  it('returns invalid_input on missing target_endpoint', async () => {
    const { ctx } = makeContext();
    // Cast through unknown to fabricate a malformed input the way an
    // upstream JSON-RPC payload could.
    const result = await server.invoke('audit_agent', {} as unknown as AuditAgentInput, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    if (result.error.kind === 'invalid_input') {
      expect(result.error.field).toBe('target_endpoint');
    }
  });

  it('returns invalid_input when target_endpoint is not a string', async () => {
    const { ctx } = makeContext();
    const result = await server.invoke(
      'audit_agent',
      { target_endpoint: 42 } as unknown as AuditAgentInput,
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('returns tool_failure when the pipeline throws', async () => {
    pipeline.setBehavior('error');
    const { ctx } = makeContext();
    const result = await server.invoke('audit_agent', { target_endpoint: 'http://x' }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('tool_failure');
    if (result.error.kind === 'tool_failure') {
      expect(result.error.message).toContain('pipeline blew up');
    }
  });

  it('does not touch process.stdin/stdout while handling a request', async () => {
    // Wrap process.stdin/stdout in proxies so any property access throws.
    // We only guard for the duration of invoke() — otherwise vitest's own
    // logging would trip the trap.
    const origStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    const origStdout = Object.getOwnPropertyDescriptor(process, 'stdout');
    let tripped = false;
    const trap = new Proxy({}, {
      get() {
        tripped = true;
        return undefined;
      },
    });
    Object.defineProperty(process, 'stdin', { value: trap, configurable: true });
    Object.defineProperty(process, 'stdout', { value: trap, configurable: true });
    try {
      const { ctx } = makeContext();
      await server.invoke('audit_agent', { target_endpoint: 'http://x' }, ctx);
    } finally {
      if (origStdin) Object.defineProperty(process, 'stdin', origStdin);
      if (origStdout) Object.defineProperty(process, 'stdout', origStdout);
    }
    expect(tripped).toBe(false);
  });
});

// ─── get_report ──────────────────────────────────────────────────────────

describe('HeronMCPServer.get_report', () => {
  it('happy path: returns a previously stored report', async () => {
    const { server, store } = makeServer();
    store.put({
      reportId: 'report_xyz',
      report: '# stored',
      target: 'http://agent',
      createdAt: '2026-05-13T12:00:00.000Z',
      summary: { riskLevel: 'low', findingsCount: 0 },
    });
    const { ctx } = makeContext();
    const result = await server.invoke('get_report', { report_id: 'report_xyz' } as GetReportInput, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.report_markdown).toBe('# stored');
    expect(result.value.metadata.report_id).toBe('report_xyz');
    expect(result.value.metadata.target).toBe('http://agent');
    expect(result.value.metadata.risk_level).toBe('low');
  });

  it('returns invalid_input when report_id is missing', async () => {
    const { server } = makeServer();
    const { ctx } = makeContext();
    const result = await server.invoke('get_report', {} as unknown as GetReportInput, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('returns tool_failure when id is not found', async () => {
    const { server } = makeServer();
    const { ctx } = makeContext();
    const result = await server.invoke(
      'get_report',
      { report_id: 'report_does_not_exist' } as GetReportInput,
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('tool_failure');
  });
});

// ─── compare_reports ──────────────────────────────────────────────────────

describe('HeronMCPServer.compare_reports', () => {
  it('happy path: returns diff markdown', async () => {
    const { server, store } = makeServer();
    store.put({
      reportId: 'a', report: '# a', target: 'x',
      createdAt: '2026-05-13T12:00:00.000Z',
      summary: { riskLevel: 'low', findingsCount: 0 },
    });
    store.put({
      reportId: 'b', report: '# b', target: 'x',
      createdAt: '2026-05-14T12:00:00.000Z',
      summary: { riskLevel: 'high', findingsCount: 2 },
    });
    const { ctx } = makeContext();
    const result = await server.invoke(
      'compare_reports',
      { report_id_a: 'a', report_id_b: 'b' } as CompareReportsInput,
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diff_markdown).toContain('## Summary');
    expect(result.value.diff_markdown).toContain('A (a) vs B (b)');
  });

  it('returns invalid_input when an id is missing', async () => {
    const { server } = makeServer();
    const { ctx } = makeContext();
    const result = await server.invoke(
      'compare_reports',
      { report_id_a: 'a' } as unknown as CompareReportsInput,
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('returns tool_failure when one report id is unknown', async () => {
    const { server, store } = makeServer();
    store.put({
      reportId: 'a', report: '# a', target: 'x',
      createdAt: '2026-05-13T12:00:00.000Z',
      summary: { riskLevel: 'low', findingsCount: 0 },
    });
    const { ctx } = makeContext();
    const result = await server.invoke(
      'compare_reports',
      { report_id_a: 'a', report_id_b: 'missing' } as CompareReportsInput,
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('tool_failure');
  });
});
