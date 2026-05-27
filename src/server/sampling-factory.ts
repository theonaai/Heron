/**
 * Production wiring for the AAP-52 sampling-driven interview tool.
 *
 * The `start_audit_session` MCP tool handler in `mcp-server.ts` depends
 * on two function-shaped deps: `runSamplingInterview` and
 * `analyzeAndRenderReport`. This module builds the real, LLM-backed
 * versions at server startup (stdio CLI or Next.js HTTP transport).
 *
 * Why a factory rather than top-level singletons: the LLM client owns
 * an API key, so it must be created lazily and with config-aware
 * resolution. Constructing one per request is wasteful; constructing
 * one per `HeronMCPServer` is right.
 */

import type { LLMClient } from '../llm/client.js';
import { createLLMClient } from '../llm/client.js';
import { SamplingConnector } from '../connectors/sampling-connector.js';
import { runSamplingInterview as runInterviewLoop } from '../interview/sampling-interview.js';
import {
  createQuestionPlanner,
  type QuestionPlanner,
} from '../interview/question-planner.js';
import { generateReportOutcome } from '../report/generator.js';
import { getSession } from '../storage/sessions.js';
import type {
  SamplingInterviewRunner,
  AnalyzeAndRenderReport,
} from './mcp-server.js';

export interface SamplingFactoryOptions {
  /** Pre-built LLM client. If omitted, the factory builds one from env + ~/.heron/credentials.json. */
  llmClient?: LLMClient;
  /**
   * Optional hard ceiling on LLM-driven follow-ups across the interview.
   * AAP-71: `undefined` (default) means no global cap; the per-question
   * cap of 2 is the only production limit. Tests pass `0` to disable.
   */
  maxFollowUps?: number;
}

export interface SamplingFactoryResult {
  runSamplingInterview: SamplingInterviewRunner;
  analyzeAndRenderReport: AnalyzeAndRenderReport;
  /**
   * AAP-55 — question planner for the tool-call interview path. Shares
   * the same LLM client + maxFollowUps as the sampling runner so both
   * paths surface the same audit surface on identical transcripts.
   */
  questionPlanner: QuestionPlanner;
}

/**
 * Build the production runners. Both share the same LLM client so we
 * pay the construction cost (provider detection + credentials lookup)
 * exactly once per HeronMCPServer.
 */
export async function buildSamplingDeps(
  options: SamplingFactoryOptions = {},
): Promise<SamplingFactoryResult> {
  // createLLMClient at runtime auto-detects provider from env / credentials;
  // the LLMConfig type insists on `provider` so we cast to satisfy the
  // checker without lying about the runtime behaviour.
  const llmClient =
    options.llmClient ?? (await createLLMClient({} as Parameters<typeof createLLMClient>[0]));
  // AAP-71: pass `maxFollowUps` through as-is. Default `undefined` means
  // no global cap; the per-question cap of 2 (enforced inside the
  // protocol) is the only production limit.
  const maxFollowUps = options.maxFollowUps;

  const runSamplingInterview: SamplingInterviewRunner = async ({ sessionId, sampler, signal, progress }) => {
    const connector = new SamplingConnector({ server: sampler });
    try {
      return await runInterviewLoop({
        sessionId,
        connector,
        llmClient,
        maxFollowUps,
        signal,
        ...(progress ? { progress } : {}),
      });
    } finally {
      await connector.close();
    }
  };

  const analyzeAndRenderReport: AnalyzeAndRenderReport = async ({ sessionId, transcript, agentName }) => {
    // AAP-92 — fix `interviewDuration: 0s` on every MCP-driven report.
    // The pre-fix code stamped both `startedAt` and `completedAt` with
    // `new Date()` at analyze time, so the generator's
    // `completedAt - startedAt` arithmetic always produced 0.
    // The session's actual start time is `meta.createdAt`, captured by
    // `createSession()` when start_audit_session first ran.
    // `completedAt` stays `new Date()` — it's the moment the interview
    // finished and analysis kicked off, which is the right wall-clock
    // boundary for the duration banner in the report.
    const completedAt = new Date();
    let startedAt = completedAt;
    try {
      const meta = await getSession(sessionId);
      if (meta?.createdAt) {
        const parsed = new Date(meta.createdAt);
        if (!Number.isNaN(parsed.getTime())) {
          startedAt = parsed;
        }
      }
    } catch {
      // Storage read failures are non-fatal — fall through to the
      // legacy 0-duration behaviour rather than aborting the report.
    }
    const interviewSession = {
      transcript,
      startedAt,
      completedAt,
      questionsAsked: transcript.length,
      id: sessionId,
    };
    const target = agentName ?? 'mcp-sampling-client';
    // AAP-56: branch on outcome rather than fall through to a fake-clean
    // report. The MCP server handler (start_audit_session) consumes both
    // branches: success path → writeReport, failure path → writeAnalysisFailure.
    const outcome = await generateReportOutcome(interviewSession, llmClient, {
      target,
      format: 'markdown',
    });
    if (!outcome.ok) {
      return {
        ok: false,
        markdown: outcome.report,
        analysisError: outcome.analysisError,
      };
    }
    return {
      ok: true,
      markdown: outcome.report,
      json: outcome.reportJson,
      ...(outcome.reportJson.overallRiskLevel
        ? { riskLevel: outcome.reportJson.overallRiskLevel }
        : {}),
    };
  };

  const questionPlanner = createQuestionPlanner({ llmClient, maxFollowUps });

  return { runSamplingInterview, analyzeAndRenderReport, questionPlanner };
}
