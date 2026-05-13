/**
 * Integration test for F-1: the `audit_agent` handler must short-circuit
 * with `invalid_input` BEFORE any network call when given a target
 * endpoint that points at a private / link-local / loopback address.
 *
 * The handler is the user-visible chokepoint — the SSRF guard lives
 * elsewhere (`src/connectors/url-policy.ts`) but the wrapper has to wire
 * it in. The test fakes the audit pipeline so that any attempt to call
 * it would flip a flag; if the flag is still false after invocation,
 * we've proved no network call ever started.
 *
 * Tracking: PR #14 security audit round 3, finding F-1.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import {
  HeronMCPServer,
  type AuditPipeline,
  type ReportStore,
  type ReportDiffer,
  type StoredReport,
} from '../../src/server/mcp-server.js';
import type { ProgressNotification, RequestContext } from '../../src/server/mcp-types.js';

class TrackingPipeline implements AuditPipeline {
  public called = false;
  async run(
    _input: { targetEndpoint: string; options?: Record<string, unknown> },
    _ctx: { progress: (n: ProgressNotification) => void; signal: AbortSignal; sessionId: string },
  ): Promise<{
    reportId: string;
    target: string;
    report: string;
    summary: { riskLevel: string; findingsCount: number; recommendation?: string };
  }> {
    this.called = true;
    return {
      reportId: 'report_should_not_be_seen',
      target: _input.targetEndpoint,
      report: 'should not be seen',
      summary: { riskLevel: 'low', findingsCount: 0 },
    };
  }
}

class FakeStore implements ReportStore {
  private byId = new Map<string, StoredReport>();
  put(record: StoredReport): void { this.byId.set(record.reportId, record); }
  get(id: string): StoredReport | undefined { return this.byId.get(id); }
}

class FakeDiffer implements ReportDiffer {
  async diff(): Promise<string> { return ''; }
}

function makeContext(): RequestContext {
  return {
    authPrincipal: null,
    sessionId: 'sess_ssrf_test',
    progress: () => undefined,
    signal: new AbortController().signal,
  };
}

describe('audit_agent — SSRF guard (F-1)', () => {
  let pipeline: TrackingPipeline;
  let server: HeronMCPServer;

  beforeEach(() => {
    delete process.env.HERON_ALLOW_PRIVATE_TARGETS;
    pipeline = new TrackingPipeline();
    server = new HeronMCPServer({
      auditPipeline: pipeline,
      reportStore: new FakeStore(),
      differ: new FakeDiffer(),
    });
  });

  it('rejects AWS metadata IP with invalid_input and does not call the pipeline', async () => {
    const result = await server.invoke(
      'audit_agent',
      { target_endpoint: 'http://169.254.169.254/latest/meta-data/' },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    if (result.error.kind === 'invalid_input') {
      expect(result.error.field).toBe('target_endpoint');
    }
    expect(pipeline.called).toBe(false);
  });

  it('rejects loopback IP with invalid_input and does not call the pipeline', async () => {
    const result = await server.invoke(
      'audit_agent',
      { target_endpoint: 'http://127.0.0.1:6379/' },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    expect(pipeline.called).toBe(false);
  });

  it('rejects file:// scheme with invalid_input and does not call the pipeline', async () => {
    const result = await server.invoke(
      'audit_agent',
      { target_endpoint: 'file:///etc/passwd' },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    expect(pipeline.called).toBe(false);
  });

  it('rejects RFC1918 private IP with invalid_input and does not call the pipeline', async () => {
    const result = await server.invoke(
      'audit_agent',
      { target_endpoint: 'http://192.168.1.1/admin' },
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
    expect(pipeline.called).toBe(false);
  });
});
