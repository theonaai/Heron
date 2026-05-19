/**
 * Sampling-driven interview runner.
 *
 * Sister of `runInterview` (which writes to stdout for the CLI flow).
 * This variant is the engine behind `start_audit_session`:
 *   - drives the InterviewProtocol Q/A loop against an AgentConnector
 *   - persists each Q/A pair to ~/.heron/sessions/<id>/transcript.jsonl
 *   - emits a `transcript-append` event on the session-events bus so the
 *     dashboard SSE stream can stream live updates to the browser
 *
 * No stdout side-effects — we run inside a JSON-RPC handler. The caller
 * is responsible for status-change events (interviewing / analyzing /
 * complete) and for the final report write.
 */

import type { AgentConnector } from '../connectors/types.js';
import type { LLMClient } from '../llm/client.js';
import type { QAPair } from '../report/types.js';
import { createProtocol } from './protocol.js';
import { appendTranscriptEntry } from '../storage/sessions.js';
import { publishSessionEvent } from '../storage/session-events.js';

export interface SamplingInterviewOptions {
  sessionId: string;
  connector: AgentConnector;
  llmClient: LLMClient;
  maxFollowUps?: number;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
}

export interface SamplingInterviewResult {
  transcript: QAPair[];
  questionsAsked: number;
}

export async function runSamplingInterview(
  options: SamplingInterviewOptions,
): Promise<SamplingInterviewResult> {
  const { sessionId, connector, llmClient, maxFollowUps = 3, signal } = options;

  const protocol = createProtocol(llmClient, maxFollowUps);
  const total = protocol.totalCoreQuestions;
  let prevCategory: QAPair['category'] | null = null;

  const persistAndEmit = async (
    question: { category: QAPair['category']; text: string },
    answer: string,
  ): Promise<void> => {
    const entry = {
      category: question.category,
      question: question.text,
      answer,
    };
    await appendTranscriptEntry(sessionId, entry);
    publishSessionEvent(sessionId, { type: 'transcript-append', entry });
  };

  for (let i = 0; i < total; i++) {
    if (signal?.aborted) break;
    const question = protocol.nextQuestion();
    if (!question) break;

    if (prevCategory && question.category !== prevCategory) {
      const followUp = await protocol.generateFollowUp(prevCategory);
      if (followUp) {
        const answer = await connector.sendMessage(followUp.text);
        protocol.recordAnswer(followUp, answer);
        await persistAndEmit(followUp, answer);
      }
    }

    const answer = await connector.sendMessage(question.text);
    protocol.recordAnswer(question, answer);
    await persistAndEmit(question, answer);
    prevCategory = question.category;
  }

  // Final follow-up on the last category.
  const transcript = protocol.getTranscript();
  if (transcript.length > 0 && !signal?.aborted) {
    const lastCategory = transcript[transcript.length - 1]!.category;
    const finalFollowUp = await protocol.generateFollowUp(lastCategory);
    if (finalFollowUp) {
      const answer = await connector.sendMessage(finalFollowUp.text);
      protocol.recordAnswer(finalFollowUp, answer);
      await persistAndEmit(finalFollowUp, answer);
    }
  }

  const finalTranscript = protocol.getTranscript();
  return {
    transcript: finalTranscript,
    questionsAsked: finalTranscript.length,
  };
}
