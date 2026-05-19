import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  HeronMCPServer,
  type ReportDiffer,
} from '../../src/server/mcp-server.js';
import { SamplingConnector } from '../../src/connectors/sampling-connector.js';
import { runSamplingInterview } from '../../src/interview/sampling-interview.js';
import { getSession } from '../../src/storage/sessions.js';
import type { QAPair } from '../../src/report/types.js';

/**
 * End-to-end test for the AAP-52 MCP-sampling-driven interrogation.
 *
 * Wires a Heron MCP server to an MCP client through an in-memory
 * transport pair. The client declares the `sampling` capability and
 * registers a `createMessage` handler that returns canned compliance
 * answers for each of Heron's 9 core questions. Then it calls the
 * `start_audit_session` tool. We assert:
 *
 *   - The tool succeeds with a session_id and status='complete'
 *   - The transcript persisted to ~/.heron/sessions has at least 9
 *     Q/A entries (one per core question)
 *   - The report.json is well-formed
 *
 * The LLM is stubbed via injected runSamplingInterview /
 * analyzeAndRenderReport deps so the test doesn't need an API key.
 */

interface StubLLMResponses {
  answers: string[];
  cursor: number;
}

function makeStubServerSetup(answers: string[]): {
  setup: (client: Client) => void;
  state: StubLLMResponses;
} {
  const state: StubLLMResponses = { answers, cursor: 0 };
  const setup = (client: Client): void => {
    client.setRequestHandler(CreateMessageRequestSchema, async () => {
      const text = state.answers[Math.min(state.cursor, state.answers.length - 1)];
      state.cursor += 1;
      return {
        role: 'assistant',
        content: { type: 'text', text },
        model: 'stub-client-model',
        stopReason: 'endTurn',
      };
    });
  };
  return { setup, state };
}

describe('start_audit_session — MCP sampling E2E', () => {
  let tmpSessionsDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpSessionsDir = mkdtempSync(join(tmpdir(), 'heron-aap52-e2e-'));
    process.env.HERON_SESSIONS_DIR = tmpSessionsDir;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origEnv;
    rmSync(tmpSessionsDir, { recursive: true, force: true });
  });

  it('runs a full interview over MCP sampling, persists transcript, and writes a report', async () => {
    // 9 canned answers for the 9 core questions. The protocol asks them
    // in priority order; we don't care which one lands at which slot —
    // we just need 9 substantive strings so the stale-detector / vague
    // detector don't reject them.
    const answers = [
      'I am the HR-Sync bot. I copy candidate profiles from Greenhouse into our Workday HR system.',
      'I read Greenhouse via OAuth scope greenhouse.candidates.read; I write to Workday via SOAP API.',
      'Workday connector uses scope hr.candidates.write. Greenhouse uses candidates.read.',
      'We send PII to both — names, emails, phone numbers. Sensitivity classified as confidential.',
      'I append new candidate rows to Workday. Volume: roughly 30 records per day.',
      'Worst case: a duplicated candidate row affecting one record. Recoverable by manual delete.',
      'I run hourly, 24 times per day. Batch size is 1 record at a time.',
      'No scopes are unused; we revoke every scope we no longer call. Last audit: 2026-04-01.',
      'Worst realistic failure: PII leak into a wrong tenant. Mitigated by per-tenant API token.',
    ];

    // ── 1. Build the in-memory transport pair ─────────────────────────
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // ── 2. Build the server with stub LLM-backed runners ──────────────
    const fakeAnalyze = async (params: { transcript: QAPair[]; sessionId: string; agentName?: string }) => {
      return {
        markdown: `# Audit Report\n\nSession: ${params.sessionId}\nAgent: ${params.agentName ?? 'unknown'}\nQuestions: ${params.transcript.length}\n`,
        json: {
          overallRiskLevel: 'medium',
          risks: [{ category: 'data', severity: 'medium', description: 'PII handled across systems' }],
          summary: 'Stubbed report for sampling E2E test',
        },
        riskLevel: 'medium',
      };
    };

    const differ: ReportDiffer = { async diff() { return ''; } };

    // The server's start_audit_session calls runSamplingInterview which
    // needs an LLM client for follow-ups. We pass a runner that uses
    // the real SamplingConnector against the captured server.server,
    // but with maxFollowUps=0 so the protocol never asks the LLM —
    // every question is a core question answered directly through
    // sampling.
    const fakeLLMClient = {
      chat: async () => '', // never invoked when maxFollowUps=0
    };

    const wrapper = new HeronMCPServer({
      differ,
      runSamplingInterview: async ({ sessionId, sampler, signal }) => {
        const connector = new SamplingConnector({ server: sampler });
        try {
          return await runSamplingInterview({
            sessionId,
            connector,
            llmClient: fakeLLMClient,
            maxFollowUps: 0,
            signal,
          });
        } finally {
          await connector.close();
        }
      },
      analyzeAndRenderReport: fakeAnalyze,
    });
    const mcp = wrapper.buildMcpServer();

    // ── 3. Build the client with the sampling handler ─────────────────
    const client = new Client(
      { name: 'sampling-e2e-test-client', version: '0.0.1' },
      { capabilities: { sampling: {} } },
    );
    const stub = makeStubServerSetup(answers);
    stub.setup(client);

    // ── 4. Connect & call ─────────────────────────────────────────────
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const result = await client.callTool({
        name: 'start_audit_session',
        arguments: { agent_name: 'sampling-e2e-fixture' },
      });

      // The result envelope must be a non-error structured payload.
      const r = result as {
        isError?: boolean;
        structuredContent?: {
          session_id?: string;
          status?: string;
          questions_asked?: number;
          risk_level?: string;
          report_markdown?: string;
        };
      };
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent?.status).toBe('complete');
      expect(r.structuredContent?.session_id).toMatch(/^sess-\d{8}-\d{6}-[a-z0-9]{6}$/);
      expect(r.structuredContent?.questions_asked).toBeGreaterThanOrEqual(9);
      expect(r.structuredContent?.report_markdown).toMatch(/Audit Report/);

      // The transcript and the report blob must round-trip through the
      // filesystem store the dashboard reads from.
      const sessionId = r.structuredContent!.session_id!;
      const stored = await getSession(sessionId);
      expect(stored).not.toBeNull();
      expect(stored!.status).toBe('complete');
      expect(stored!.transcript.length).toBeGreaterThanOrEqual(9);
      expect(stored!.agentName).toBe('sampling-e2e-fixture');
      expect(stored!.report).toMatch(/Audit Report/);
      expect(stored!.reportJson).toMatchObject({ overallRiskLevel: 'medium' });
    } finally {
      await client.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
    }
  }, 30_000);
});
