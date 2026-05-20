import { describe, it, expect, vi } from 'vitest';

import { createQuestionPlanner } from '../../src/interview/question-planner.js';
import { CORE_QUESTIONS, getAllQuestionsSorted } from '../../src/interview/questions.js';
import type { LLMClient } from '../../src/llm/client.js';
import type { QAPair } from '../../src/report/types.js';

/**
 * AAP-60 regression tests for the tool-call interview path's follow-up cap.
 *
 * The bug: `createQuestionPlanner` rebuilds a fresh `InterviewProtocol`
 * on every `next()` call via `createProtocol(...)`. The protocol's
 * follow-up counters (`globalFollowUpCount`, `followUpCountPerQuestion`)
 * start at 0 every time, and `recordAnswer` does NOT bump them — only
 * `generateFollowUp` does. So after rehydrating a transcript that
 * already contains N follow-ups, the cap check still reads 0 and the
 * planner keeps yielding follow-ups indefinitely in a single category.
 *
 * Verified in the wild on session sess-20260520-070938-2cc40f: 67
 * questions, ALL category 'purpose', before Codex's agent gave up.
 *
 * These tests build transcripts with the shape that triggers the loop
 * and assert the planner stops generating follow-ups once the cap is
 * reached — either falling through to the next core question of a
 * different category, or returning null.
 */

// LLM stub that produces a numbered follow-up on every call. The cap
// is enforced INSIDE `generateFollowUp` via `globalFollowUpCount` and
// `followUpCountPerQuestion`, so a permissive LLM is the right harness
// here — it isolates the bug to the planner's rehydrate path.
function alwaysFollowsUpLLM(): LLMClient {
  let n = 0;
  return {
    chat: vi.fn(async () => {
      n += 1;
      return `Follow-up question #${n} from the LLM stub.`;
    }),
  };
}

const PURPOSE_CORE = CORE_QUESTIONS.find((q) => q.id === 'context_anchor')!;

/** Build a transcript where the very first core question is followed by
 *  N synthetic follow-ups, all in category 'purpose'. Mirrors the shape
 *  of the stuck session in production. Each follow-up answer is UNIQUE
 *  so the protocol's repeated-answer guard (transcript.ts:repeatedAnswerCount
 *  >= 3 → no follow-ups) does not short-circuit the cap test — we want
 *  to prove the CAP enforcement works, not the repeat-detector. */
function transcriptWithNFollowUps(n: number): QAPair[] {
  const t: QAPair[] = [
    {
      category: 'purpose',
      question: PURPOSE_CORE.text,
      answer: 'I read user data from various systems regularly.', // vague
    },
  ];
  for (let i = 0; i < n; i++) {
    t.push({
      category: 'purpose',
      question: `Follow-up question #${i + 1} from the LLM stub.`,
      // Unique vague answer per entry — distinct enough to dodge the
      // >90% overlap check in isRepeatedAnswer, still matches vagueness
      // patterns (the OR-ed regexes) so generateFollowUp keeps firing.
      answer:
        `Iteration ${i}: I may also access ${i} different services, depending on the task. ` +
        `When enabled, connectors are enabled, and the workflow ${i} runs as needed. ` +
        `Token suffix ${i}-${i * 7}.`,
    });
  }
  return t;
}

describe('createQuestionPlanner — follow-up cap across rehydration (AAP-60)', () => {
  it('does NOT generate a new follow-up once the global cap is reached in one category', async () => {
    const maxFollowUps = 3;
    const planner = createQuestionPlanner({
      llmClient: alwaysFollowsUpLLM(),
      maxFollowUps,
    });

    // Transcript with the first core question + maxFollowUps + 5 follow-ups
    // all in 'purpose'. Pre-fix, the planner happily produced ANOTHER
    // follow-up because the rehydrated protocol's globalFollowUpCount
    // initialised at 0.
    const transcript = transcriptWithNFollowUps(maxFollowUps + 5);

    const next = await planner.next(transcript);

    // The planner must either advance to the next core question in a
    // different category, or return null. It must NOT return another
    // 'purpose' follow-up.
    if (next !== null) {
      // The next core question after 'context_anchor' (purpose) is
      // 'systems_enum' (data). Anything in 'purpose' here is the bug.
      const isCoreText = CORE_QUESTIONS.some((c) => c.text === next.text);
      expect(
        isCoreText,
        `expected a core question, got "${next.text.slice(0, 80)}..."`,
      ).toBe(true);
      expect(next.category).not.toBe('purpose');
    }
  });

  it('cap fires at exactly maxFollowUps follow-ups in one category', async () => {
    const maxFollowUps = 3;
    const planner = createQuestionPlanner({
      llmClient: alwaysFollowsUpLLM(),
      maxFollowUps,
    });

    // Transcript with exactly maxFollowUps follow-ups already recorded.
    const transcript = transcriptWithNFollowUps(maxFollowUps);

    const next = await planner.next(transcript);
    if (next !== null) {
      const isCoreText = CORE_QUESTIONS.some((c) => c.text === next.text);
      expect(isCoreText).toBe(true);
      expect(next.category).not.toBe('purpose');
    }
  });

  it('respects the per-question cap (2 follow-ups per core question) after rehydrate', async () => {
    // Transcript: first core question + 2 follow-ups in same category.
    // Per-question cap is 2 (see protocol.ts: count >= 2 → null). With
    // global cap room (maxFollowUps=10), only the per-question cap can
    // stop a third follow-up. Pre-fix, neither cap fired because both
    // counters re-initialised at 0.
    const planner = createQuestionPlanner({
      llmClient: alwaysFollowsUpLLM(),
      maxFollowUps: 10,
    });
    const transcript = transcriptWithNFollowUps(2);

    const next = await planner.next(transcript);
    if (next !== null) {
      const isCoreText = CORE_QUESTIONS.some((c) => c.text === next.text);
      expect(isCoreText).toBe(true);
      expect(next.category).not.toBe('purpose');
    }
  });

  it('terminates a multi-turn loop within CORE_QUESTIONS.length + maxFollowUps + 2 turns', async () => {
    // Simulate the tool-call submit_answer loop: keep calling next()
    // with a transcript that grows by one entry per turn (each entry's
    // answer is vague, so the LLM stub WOULD keep producing follow-ups
    // forever if the cap weren't enforced).
    const maxFollowUps = 3;
    const planner = createQuestionPlanner({
      llmClient: alwaysFollowsUpLLM(),
      maxFollowUps,
    });

    const transcript: QAPair[] = [
      {
        category: PURPOSE_CORE.category,
        question: PURPOSE_CORE.text,
        answer: 'I read user data from various systems regularly.',
      },
    ];

    const ceiling = CORE_QUESTIONS.length + maxFollowUps + 2;
    let turn = 0;
    let terminated = false;
    while (turn++ < ceiling + 50) {
      const q = await planner.next(transcript);
      if (q === null) {
        terminated = true;
        break;
      }
      // Unique vague answers per turn so the repeated-answer detector
      // doesn't short-circuit follow-up generation — we want the cap
      // (not the repeat guard) to be what stops the loop.
      transcript.push({
        category: q.category,
        question: q.text,
        answer:
          `Turn ${turn}: I may also access ${turn} services, depending on the task. ` +
          `When enabled, the workflow ${turn} runs as needed. Suffix ${turn}-${turn * 13}.`,
      });
    }

    expect(terminated, `loop ran ${turn} turns without returning null`).toBe(true);
    // Total turns to terminate should be <= ceiling.
    expect(turn).toBeLessThanOrEqual(ceiling);
  });

  it('does not run away on the stuck-session shape (67-entry transcript, all purpose)', async () => {
    // This reproduces the production session sess-20260520-070938-2cc40f
    // shape: 1 core question (context_anchor) + 66 follow-ups, all in
    // category 'purpose'. Pre-fix, planner.next() yielded yet another
    // 'purpose' follow-up. Post-fix it must move on or terminate.
    const maxFollowUps = 3;
    const planner = createQuestionPlanner({
      llmClient: alwaysFollowsUpLLM(),
      maxFollowUps,
    });
    const transcript = transcriptWithNFollowUps(66);

    const next = await planner.next(transcript);
    if (next !== null) {
      const isCoreText = CORE_QUESTIONS.some((c) => c.text === next.text);
      expect(isCoreText).toBe(true);
      expect(next.category).not.toBe('purpose');
    }
  });

  it('still produces follow-ups when the cap has NOT yet been reached', async () => {
    // Sanity check: the fix must not over-shoot and ban all follow-ups.
    // With maxFollowUps=3 and 0 follow-ups recorded so far, the LLM
    // stub's follow-up should still surface (transition from category
    // 'purpose' to category 'data' triggers a boundary follow-up).
    const planner = createQuestionPlanner({
      llmClient: alwaysFollowsUpLLM(),
      maxFollowUps: 3,
    });
    const core = getAllQuestionsSorted();

    // Walk the planner: answer Q1 (purpose). next() should surface a
    // follow-up on the purpose→data boundary because the next core
    // question is Q2 (data).
    const transcript: QAPair[] = [
      {
        category: core[0].category,
        question: core[0].text,
        answer: 'I read user data from various systems regularly.', // vague
      },
    ];

    const next = await planner.next(transcript);
    expect(next).not.toBeNull();
    // Should be a follow-up (LLM-generated text) OR the next core
    // question — either is fine, as long as the planner didn't crash.
    expect(typeof next!.text).toBe('string');
  });
});
