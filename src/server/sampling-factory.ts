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
import { generateReport } from '../report/generator.js';
import type {
  SamplingInterviewRunner,
  AnalyzeAndRenderReport,
} from './mcp-server.js';

export interface SamplingFactoryOptions {
  /** Pre-built LLM client. If omitted, the factory builds one from env + ~/.heron/credentials.json. */
  llmClient?: LLMClient;
  /** Forwarded to the protocol — max follow-ups per category. Defaults to 3. */
  maxFollowUps?: number;
}

export interface SamplingFactoryResult {
  runSamplingInterview: SamplingInterviewRunner;
  analyzeAndRenderReport: AnalyzeAndRenderReport;
}

/**
 * Build the production runners. Both share the same LLM client so we
 * pay the construction cost (provider detection + credentials lookup)
 * exactly once per HeronMCPServer.
 */
export async function buildSamplingDeps(
  options: SamplingFactoryOptions = {},
): Promise<SamplingFactoryResult> {
  const llmClient = options.llmClient ?? (await createLLMClient({}));
  const maxFollowUps = options.maxFollowUps ?? 3;

  const runSamplingInterview: SamplingInterviewRunner = async ({ sessionId, sampler, signal }) => {
    const connector = new SamplingConnector({ server: sampler });
    try {
      return await runInterviewLoop({
        sessionId,
        connector,
        llmClient,
        maxFollowUps,
        signal,
      });
    } finally {
      await connector.close();
    }
  };

  const analyzeAndRenderReport: AnalyzeAndRenderReport = async ({ sessionId, transcript, agentName }) => {
    const interviewSession = {
      transcript,
      startedAt: new Date(),
      completedAt: new Date(),
      questionsAsked: transcript.length,
      id: sessionId,
    };
    const target = agentName ?? 'mcp-sampling-client';
    const { report, reportJson } = await generateReport(interviewSession, llmClient, {
      target,
      format: 'markdown',
    });
    return {
      markdown: report,
      json: reportJson,
      ...(reportJson.overallRiskLevel ? { riskLevel: reportJson.overallRiskLevel } : {}),
    };
  };

  return { runSamplingInterview, analyzeAndRenderReport };
}
