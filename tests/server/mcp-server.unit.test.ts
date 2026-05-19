import { describe, it, expect } from 'vitest';

import {
  HeronMCPServer,
  type ReportStore,
  type ReportDiffer,
  type StoredReport,
} from '../../src/server/mcp-server.js';
import type {
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
 * with a mocked `RequestContext`. The audit_agent block was removed
 * under AAP-52 along with the tool itself; start_audit_session
 * coverage lives in `start-audit-session.test.ts`.
 */

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
  store: FakeReportStore;
  differ: FakeDiffer;
} {
  const store = new FakeReportStore();
  const differ = new FakeDiffer();
  const server = new HeronMCPServer({ reportStore: store, differ });
  return { server, store, differ };
}

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
