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
import { getSession } from '../../src/storage/sessions.js';

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
    const fakeRunInterview = vi.fn(async (params: {
      sessionId: string;
      sampler: { createMessage: (args: unknown) => Promise<unknown> };
    }) => {
      // Touch the sampler so the test confirms it's wired through.
      await params.sampler.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: 'probe' } }],
        maxTokens: 16,
      });
      return {
        transcript: [
          { category: 'identity', question: 'Q1', answer: 'A1' },
          { category: 'systems', question: 'Q2', answer: 'A2' },
          { category: 'data', question: 'Q3', answer: 'A3' },
        ],
        questionsAsked: 3,
      };
    });

    const fakeAnalyze = vi.fn(async () => ({
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
    const fakeMcpServer = {
      createMessage: vi.fn(async () => ({
        role: 'assistant',
        content: { type: 'text', text: 'ok' },
        model: 'fake',
        stopReason: 'endTurn',
      })),
    };
    server.attachSamplingServer(fakeMcpServer as never);

    const { ctx } = makeCtx();
    const result = await server.invoke('start_audit_session', { agent_name: 'fixture-agent' }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.session_id).toMatch(/^sess-\d{8}-\d{6}-[a-z0-9]{6}$/);
    expect(result.value.status).toBe('complete');
    expect(fakeRunInterview).toHaveBeenCalledTimes(1);
    expect(fakeAnalyze).toHaveBeenCalledTimes(1);

    const stored = await getSession(result.value.session_id);
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
});
