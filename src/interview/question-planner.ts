/**
 * AAP-55 — shared question planner for Heron's interview loops.
 *
 * Sister abstraction to `createProtocol` in `protocol.ts`, written so the
 * tool-call interview path can drive the same Q/A walk without owning a
 * long-running connector.
 *
 * Sampling path (`runSamplingInterview`): one process, one connector,
 *   answers stream in via MCP sampling/createMessage.
 * Tool-call path (`submit_answer` MCP tool, AAP-55): each answer arrives
 *   as a fresh tool call. The planner is stateless across calls — every
 *   `next()` looks at the persisted transcript and decides what to ask.
 *
 * Why a separate module: the tool-call handler has no persistent
 * `InterviewProtocol` instance to carry follow-up state in. Rather than
 * marshalling protocol internals (`globalFollowUpCount`, the per-question
 * map, the adversarial-claim cache) across MCP tool invocations, the
 * planner reconstructs the relevant state from the running transcript on
 * every call. That keeps the storage layer thin (only `transcript.jsonl`
 * + `pendingQuestion` need to survive a process restart) and matches how
 * the sampling-path protocol naturally evolves.
 *
 * Both paths share the same vagueness / repeat / missing-fields heuristics
 * (re-exported from `protocol.ts`) so the audit surface stays identical.
 */

import type { LLMClient } from '../llm/client.js';
import type { QAPair } from '../report/types.js';
import { createProtocol } from './protocol.js';
import { CORE_QUESTIONS, getAllQuestionsSorted, type InterviewQuestion } from './questions.js';

export interface Question {
  /** Question text to surface to the audited agent. */
  text: string;
  /** Compliance category the question belongs to. */
  category: QAPair['category'];
  /** 0-based ordinal in the planner's "asked so far" sequence. */
  index: number;
}

export interface QuestionPlanner {
  /** Number of core questions the planner will walk through. */
  readonly totalCoreQuestions: number;
  /** Returns the first question for a fresh session. */
  initial(opts?: { agentName?: string }): Question;
  /** Given the running transcript, returns the next question or null if done. */
  next(transcript: QAPair[]): Promise<Question | null>;
}

export interface QuestionPlannerOptions {
  llmClient: LLMClient;
  /**
   * Max LLM-driven follow-ups across the whole interview. Matches the
   * `maxFollowUps` knob in `createProtocol`. Default 3 (production).
   * Tests use 0 to keep the LLM out of the path.
   */
  maxFollowUps?: number;
}

/**
 * Build a stateless QuestionPlanner.
 *
 * The planner rebuilds an internal `InterviewProtocol` from the current
 * transcript on every `next()` call. We replay the transcript through
 * `protocol.recordAnswer` so the protocol's follow-up bookkeeping
 * (vagueness, repeats, adversarial-claim cache) sees the same history a
 * single long-running protocol instance would have seen. Then the
 * planner walks forward by exactly one question.
 *
 * The replay cost is O(N) per next() — at ~15 questions per interview
 * and a sub-millisecond protocol implementation this is negligible.
 * Adding persistent planner state would force every transition to write
 * a JSON blob to disk; replaying from the transcript keeps the storage
 * model identical to the sampling path.
 */
export function createQuestionPlanner(
  options: QuestionPlannerOptions,
): QuestionPlanner {
  const { llmClient, maxFollowUps = 3 } = options;
  const orderedCore = getAllQuestionsSorted();

  function firstCore(): InterviewQuestion {
    const q = orderedCore[0];
    if (!q) throw new Error('CORE_QUESTIONS is empty — planner cannot run.');
    return q;
  }

  function toExternal(q: InterviewQuestion, index: number): Question {
    return { text: q.text, category: q.category, index };
  }

  /**
   * Rebuild a protocol whose internal state reflects everything in
   * `transcript`. The returned protocol's `nextQuestion()` is the
   * planner's authoritative "what to ask next" oracle for both core
   * questions and LLM-generated follow-ups.
   *
   * Important: we must NOT include `transcript` answers that were
   * generated as follow-ups in the core-walk cursor — `recordAnswer`
   * appends to `transcript` and the protocol's `currentIndex` advances
   * only via `nextQuestion`. So the rehydration loop calls
   * `nextQuestion()` once for every transcript entry whose question
   * text matches a core question (skipping over LLM follow-ups), and
   * for follow-up entries it generates a placeholder follow-up question
   * to drain the queue.
   *
   * AAP-60 — after replaying answers, we walk the transcript a SECOND
   * time to reconstruct the follow-up cap counters (global +
   * per-question) and prime the protocol with them. `recordAnswer`
   * doesn't bump those counters — only `generateFollowUp` does — so
   * without this step the fresh protocol's `globalFollowUpCount`
   * stays at zero and the cap check inside `generateFollowUp` never
   * fires across `submit_answer` calls. Symptom: planner yields
   * follow-ups indefinitely in one category (see
   * sess-20260520-070938-2cc40f: 67 turns, all 'purpose').
   */
  async function rehydrate(transcript: QAPair[]): Promise<ReturnType<typeof createProtocol>> {
    const protocol = createProtocol(llmClient, maxFollowUps);

    // Index core questions by text for fast lookup.
    const byText = new Map<string, InterviewQuestion>();
    for (const c of CORE_QUESTIONS) byText.set(c.text, c);

    for (const entry of transcript) {
      const coreMatch = byText.get(entry.question);
      if (coreMatch) {
        // Walk the protocol forward to the matching core question and
        // record the answer there. `nextQuestion()` returns questions
        // in priority order, so we drain until we hit this one.
        let q = protocol.nextQuestion();
        while (q && q.text !== entry.question) {
          q = protocol.nextQuestion();
        }
        if (q) {
          protocol.recordAnswer(q, entry.answer);
        }
      } else {
        // LLM-generated follow-up. Synthesise a question with the same
        // text + category so the protocol's bookkeeping registers the
        // answer. Priority 100+ matches what `generateFollowUp` uses.
        const synthetic: InterviewQuestion = {
          id: `replayed_followup_${entry.category}_${transcript.indexOf(entry)}`,
          category: entry.category as QAPair['category'],
          text: entry.question,
          priority: 1000,
        };
        protocol.recordAnswer(synthetic, entry.answer);
      }
    }

    // AAP-60 — reconstruct follow-up counters from the transcript and
    // prime the protocol. A transcript entry is a follow-up iff its
    // question text does NOT match any core question text exactly.
    // Each follow-up is attributed to the most recent preceding core
    // question (mirrors protocol.ts:291-293, which finds `lastCoreQ`
    // by matching category against transcript entries).
    let global = 0;
    const perQuestion = new Map<string, number>();
    let lastCore: InterviewQuestion | null = null;
    for (const entry of transcript) {
      const coreMatch = byText.get(entry.question);
      if (coreMatch) {
        lastCore = coreMatch;
        continue;
      }
      // Follow-up entry.
      global += 1;
      if (lastCore) {
        perQuestion.set(lastCore.id, (perQuestion.get(lastCore.id) ?? 0) + 1);
      }
    }
    protocol.primeFollowUpCounts({ global, perQuestion });

    return protocol;
  }

  return {
    totalCoreQuestions: orderedCore.length,

    initial(_opts: { agentName?: string } = {}): Question {
      void _opts;
      return toExternal(firstCore(), 0);
    },

    async next(transcript: QAPair[]): Promise<Question | null> {
      const protocol = await rehydrate(transcript);

      // First, ask the protocol for the next core question.
      const nextCore = protocol.nextQuestion();

      // Between core questions, mirror `runSamplingInterview`'s
      // "follow-up at category boundaries" behaviour: if the upcoming
      // core question moves to a new category, give the previous
      // category one chance to surface a follow-up. The protocol
      // internally enforces the per-question + global follow-up caps,
      // so this is idempotent across replays.
      if (nextCore && transcript.length > 0) {
        const lastCat = transcript[transcript.length - 1]!.category as QAPair['category'];
        if (lastCat !== nextCore.category) {
          const followUp = await protocol.generateFollowUp(lastCat);
          if (followUp) {
            return toExternal(followUp, transcript.length);
          }
        }
      }

      if (nextCore) {
        return toExternal(nextCore, transcript.length);
      }

      // Core questions exhausted. Try to generate one final follow-up
      // on the most recent category — matches the tail behaviour in
      // `runSamplingInterview` so both paths surface the same number of
      // questions on identical transcripts.
      if (transcript.length === 0) return null;
      const lastCategory = transcript[transcript.length - 1]!.category as QAPair['category'];
      const followUp = await protocol.generateFollowUp(lastCategory);
      if (followUp) {
        return toExternal(followUp, transcript.length);
      }

      return null;
    },
  };
}
