import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { HeronMCPServer, type ReportDiffer } from '../../src/server/mcp-server.js';
import { createQuestionPlanner } from '../../src/interview/question-planner.js';
import { getSession } from '../../src/storage/sessions.js';
import type { QAPair } from '../../src/report/types.js';

/**
 * End-to-end test for the AAP-55 tool-call interview path.
 *
 * Sister of `sampling-e2e.test.ts`. The key difference: this test's
 * client declares ONLY `{ capabilities: {} }` — no sampling. Heron's
 * capability detection routes start_audit_session to the new tool-call
 * loop. The test then drives `submit_answer` in a while-loop until
 * the server flips to `status: 'complete'`, and asserts the resulting
 * session has the expected transcript + report.
 *
 * No real LLM. The analyzer is stubbed; the planner is a real planner
 * with maxFollowUps=0 so it only walks the core question list (no LLM
 * calls). That keeps the test hermetic + deterministic.
 */

describe('start_audit_session + submit_answer — tool-call E2E (AAP-55)', () => {
  let tmpDir: string;
  const origEnv = process.env.HERON_SESSIONS_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'heron-aap55-e2e-'));
    process.env.HERON_SESSIONS_DIR = tmpDir;
  });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.HERON_SESSIONS_DIR;
    else process.env.HERON_SESSIONS_DIR = origEnv;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('drives a full interview through start_audit_session + repeated submit_answer', async () => {
    // ── 1. Build the in-memory transport pair ─────────────────────────
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // ── 2. Build the server with a real planner (no LLM follow-ups) + stub analyzer.
    const fakeLLMClient = { chat: async () => '' };
    const planner = createQuestionPlanner({ llmClient: fakeLLMClient, maxFollowUps: 0 });

    const fakeAnalyze = vi.fn(async (params: {
      transcript: QAPair[];
      sessionId: string;
      agentName?: string;
    }) => {
      return {
        ok: true as const,
        markdown:
          `# Tool-Call Audit Report\n\n` +
          `Session: ${params.sessionId}\n` +
          `Agent: ${params.agentName ?? 'unknown'}\n` +
          `Questions: ${params.transcript.length}\n`,
        json: {
          overallRiskLevel: 'medium',
          risks: [],
          summary: 'Stubbed report for tool-call E2E test',
        },
        riskLevel: 'medium' as string,
      };
    });

    const differ: ReportDiffer = { async diff() { return ''; } };

    const wrapper = new HeronMCPServer({
      differ,
      analyzeAndRenderReport: fakeAnalyze,
      questionPlanner: planner,
      // runSamplingInterview not wired — we should never reach the
      // sampling path because the client declares no sampling capability.
    });
    const mcp = wrapper.buildMcpServer();

    // ── 3. Build a client that declares NO capabilities ───────────────
    const client = new Client(
      { name: 'tool-call-e2e-test-client', version: '0.0.1' },
      { capabilities: {} }, // <-- no sampling, no elicitation
    );

    // ── 4. Connect ─────────────────────────────────────────────────────
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

    try {
      // ── 5. Start ─────────────────────────────────────────────────────
      const startResult = await client.callTool({
        name: 'start_audit_session',
        arguments: { agent_name: 'tool-call-fixture' },
      });
      const start = startResult as {
        isError?: boolean;
        structuredContent?: {
          session_id?: string;
          status?: string;
          next_question?: string;
          instructions?: string;
        };
      };

      expect(start.isError).toBeFalsy();
      expect(start.structuredContent?.status).toBe('awaiting_answer');
      const sessionId = start.structuredContent!.session_id!;
      expect(sessionId).toMatch(/^sess-\d{8}-\d{6}-[a-z0-9]{6}$/);
      expect(typeof start.structuredContent?.next_question).toBe('string');
      expect(start.structuredContent!.next_question!.length).toBeGreaterThan(0);
      expect(start.structuredContent?.instructions).toMatch(/submit_answer/);

      // ── 6. Loop submit_answer until status === 'complete' ────────────
      // Compliance-flavoured answers so the protocol's vagueness /
      // stale detectors don't reject them. We use 20 unique strings to
      // out-run the dedup logic (planner walks 15 core questions; some
      // bookkeeping may surface a few extra turns).
      const answers = [
        'I am the HR-Sync bot. I copy candidate profiles from Greenhouse into Workday.',
        'I read Greenhouse via OAuth scope greenhouse.candidates.read; I write to Workday via SOAP API.',
        'Workday connector uses scope hr.candidates.write. Greenhouse uses candidates.read.',
        'I send PII (names, emails, phone numbers) to both. Sensitivity: confidential.',
        'I append new candidate rows to Workday. Volume: ~30 records per day.',
        'Worst case: a duplicated candidate row affecting one record. Recoverable by manual delete.',
        'I run hourly, 24 times per day. Batch size is 1 record per call.',
        'No scopes are unused. We revoke scopes we no longer call. Last audit: 2026-04-01.',
        'Worst realistic failure: PII leak into a wrong tenant. Mitigated by per-tenant API token.',
        'No, I do not make hiring decisions; a recruiter reviews every candidate I move.',
        'I have a dedicated service account "hr-sync-bot" with its own API key per system.',
        'Single-customer deployment. I do not retain context across customers.',
        'I invoke a fixed set of three internal tools: fetch_candidate, post_workday, log_event.',
        'I do not call MCP servers or A2A agents.',
        'Reasoning model: Claude 3 Haiku. APIs: Greenhouse REST, Workday SOAP, internal logger.',
        'extra answer slot 16', 'extra answer slot 17', 'extra answer slot 18',
        'extra answer slot 19', 'extra answer slot 20',
      ];
      let answerIdx = 0;
      let status: string | undefined = 'awaiting_answer';
      let safety = 0;
      let finalReport: string | undefined;
      let finalRiskLevel: string | undefined;
      while (status === 'awaiting_answer' && safety++ < 30) {
        const next = await client.callTool({
          name: 'submit_answer',
          arguments: {
            session_id: sessionId,
            answer: answers[Math.min(answerIdx, answers.length - 1)],
          },
        });
        answerIdx += 1;
        const n = next as {
          isError?: boolean;
          structuredContent?: {
            status?: string;
            next_question?: string;
            report_markdown?: string;
            risk_level?: string;
          };
        };
        expect(n.isError).toBeFalsy();
        status = n.structuredContent?.status;
        if (status === 'complete') {
          finalReport = n.structuredContent?.report_markdown;
          finalRiskLevel = n.structuredContent?.risk_level;
        }
      }

      expect(status).toBe('complete');
      expect(finalReport).toMatch(/Tool-Call Audit Report/);
      // AAP-63 — without a Surface 2 discovery scan the primary verdict
      // is 'unverified' regardless of the analyzer's self-reported risk
      // level. The dashboard's secondary "self-report" pill carries the
      // interview risk separately.
      expect(finalRiskLevel).toBe('unverified');
      expect(fakeAnalyze).toHaveBeenCalledTimes(1);

      // ── 7. Inspect persisted session ─────────────────────────────────
      const stored = await getSession(sessionId);
      expect(stored).not.toBeNull();
      expect(stored!.status).toBe('complete');
      expect(stored!.mode).toBe('tool-call');
      expect(stored!.agentName).toBe('tool-call-fixture');
      expect(stored!.transcript.length).toBeGreaterThanOrEqual(9);
      expect(stored!.report).toMatch(/Tool-Call Audit Report/);
      expect(stored!.riskLevel).toBe('unverified');
      expect(stored!.verificationStatus).toBe('unverified');
      expect(stored!.pendingQuestion ?? null).toBeNull();
    } finally {
      await client.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
    }
  }, 30_000);

  it('terminates within CORE_QUESTIONS.length + maxFollowUps + 2 turns even with a permissive LLM (AAP-60)', async () => {
    // AAP-60 — regression: pre-fix, the planner rebuilt its protocol on
    // every submit_answer with counters starting at zero, so the
    // follow-up cap never fired in tool-call mode. A permissive LLM
    // stub (one that returns a follow-up every time it's asked) would
    // keep the planner producing follow-ups in a single category until
    // the client gave up. The fix primes the rehydrated protocol's
    // follow-up counters from the transcript. This test exercises the
    // full MCP path with a permissive LLM and asserts the loop
    // terminates within CORE_QUESTIONS.length + maxFollowUps + 2.
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    let followUpsServed = 0;
    const permissiveLLM = {
      chat: async () => {
        followUpsServed += 1;
        return `Follow-up #${followUpsServed}: tell me more about that.`;
      },
    };
    const MAX_FOLLOW_UPS = 3;
    const planner = createQuestionPlanner({
      llmClient: permissiveLLM,
      maxFollowUps: MAX_FOLLOW_UPS,
    });

    const fakeAnalyze = vi.fn(async (params: {
      transcript: QAPair[];
      sessionId: string;
      agentName?: string;
    }) => ({
      ok: true as const,
      markdown: `# Report\n${params.sessionId}\n${params.transcript.length} entries\n`,
      json: { overallRiskLevel: 'low', risks: [], summary: 'stub' },
      riskLevel: 'low' as string,
    }));
    const differ: ReportDiffer = { async diff() { return ''; } };

    const wrapper = new HeronMCPServer({
      differ,
      analyzeAndRenderReport: fakeAnalyze,
      questionPlanner: planner,
    });
    const mcp = wrapper.buildMcpServer();
    const client = new Client(
      { name: 'aap-60-e2e-client', version: '0.0.1' },
      { capabilities: {} },
    );
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const startResult = await client.callTool({
        name: 'start_audit_session',
        arguments: { agent_name: 'aap60-fixture' },
      });
      const sessionId = (startResult as {
        structuredContent?: { session_id?: string };
      }).structuredContent!.session_id!;

      // Vague + unique answer per turn so:
      //   - the vagueness detector keeps firing (would generate follow-ups)
      //   - the repeat-answer guard does not short-circuit
      // The only thing that can stop the loop is the cap.
      const vagueUniqueAnswer = (n: number) =>
        `Turn ${n}: I may also access ${n} services, depending on the task. ` +
        `Connectors are enabled when needed. Workflow ${n} runs as needed. ` +
        `Suffix ${n}-${n * 13}.`;

      // The planner has CORE_QUESTIONS.length (15) core questions +
      // MAX_FOLLOW_UPS follow-ups budget; the loop must terminate
      // inside that envelope + a small slack for the planner's
      // bookkeeping turns.
      const ceiling = 15 + MAX_FOLLOW_UPS + 2;
      const HARD_STOP = ceiling + 30;
      let turns = 0;
      let status: string | undefined = 'awaiting_answer';
      while (status === 'awaiting_answer' && turns < HARD_STOP) {
        const r = await client.callTool({
          name: 'submit_answer',
          arguments: { session_id: sessionId, answer: vagueUniqueAnswer(turns) },
        });
        turns += 1;
        status = (r as { structuredContent?: { status?: string } })
          .structuredContent?.status;
      }

      expect(status).toBe('complete');
      expect(turns).toBeLessThanOrEqual(ceiling);

      const stored = await getSession(sessionId);
      expect(stored).not.toBeNull();
      expect(stored!.status).toBe('complete');
      // Follow-up total in the persisted transcript is bounded by the cap.
      const followUpEntries = stored!.transcript.filter(
        (e) => e.question.startsWith('Follow-up #'),
      );
      expect(followUpEntries.length).toBeLessThanOrEqual(MAX_FOLLOW_UPS);
    } finally {
      await client.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
    }
  }, 30_000);
});
