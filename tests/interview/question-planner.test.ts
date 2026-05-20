import { describe, it, expect, vi } from 'vitest';

import { createQuestionPlanner } from '../../src/interview/question-planner.js';
import { CORE_QUESTIONS, getAllQuestionsSorted } from '../../src/interview/questions.js';
import type { LLMClient } from '../../src/llm/client.js';
import type { QAPair } from '../../src/report/types.js';

/**
 * Unit tests for the AAP-55 QuestionPlanner.
 *
 * The planner is the shared brain behind both the sampling interview
 * loop and the tool-call interview loop. It owns:
 *   - the ordered list of core questions
 *   - LLM-driven follow-up generation (delegated to the same protocol
 *     primitives used by `runSamplingInterview`)
 *
 * It is stateless across calls — every `next()` reads the running
 * transcript and decides what to ask. Tool-call mode can therefore
 * recover from a process restart by re-loading the transcript from
 * disk and replaying `next()`.
 */

function silentLLM(): LLMClient {
  return {
    chat: vi.fn(async () => ''),
  };
}

describe('createQuestionPlanner', () => {
  it('returns the first core question from initial()', () => {
    const planner = createQuestionPlanner({ llmClient: silentLLM() });
    const q = planner.initial({ agentName: 'fixture' });

    const expected = getAllQuestionsSorted()[0];
    expect(q.text).toBe(expected.text);
    expect(q.category).toBe(expected.category);
    expect(q.index).toBe(0);
  });

  it('walks through every core question via next() and then returns null', async () => {
    const planner = createQuestionPlanner({ llmClient: silentLLM() });
    const core = getAllQuestionsSorted();
    const transcript: QAPair[] = [];

    // Simulate the loop: planner.initial() then answer + planner.next() repeatedly.
    const first = planner.initial({});
    transcript.push({ category: first.category, question: first.text, answer: 'A0' });

    const seen = new Set<string>([first.text]);
    let safety = 0;
    while (safety++ < 200) {
      const q = await planner.next(transcript);
      if (!q) break;
      seen.add(q.text);
      transcript.push({ category: q.category, question: q.text, answer: `answer-${seen.size}` });
    }

    // Every core question text shows up exactly once.
    for (const c of core) {
      expect(seen.has(c.text)).toBe(true);
    }
    // We didn't infinite-loop.
    expect(safety).toBeLessThan(200);
    // Final next() resolves to null.
    const tail = await planner.next(transcript);
    expect(tail).toBeNull();
  });

  it('asks a follow-up when the LLM produces one mid-interview', async () => {
    // Stub LLM that returns a single follow-up the first time it's
    // asked, then empty strings thereafter. The planner should surface
    // that follow-up via next() after the relevant core question is
    // answered but before walking off the end.
    let chats = 0;
    const llm: LLMClient = {
      chat: vi.fn(async () => {
        chats += 1;
        return chats === 1 ? 'Tell me more about the OAuth scope you just mentioned.' : '';
      }),
    };
    const planner = createQuestionPlanner({ llmClient: llm, maxFollowUps: 2 });

    // Vague answer that triggers follow-up generation. Use a phrase
    // matched by the existing vagueness detector.
    const vagueAnswer = 'I read user data from various systems regularly.';

    const transcript: QAPair[] = [];
    const first = planner.initial({});
    transcript.push({ category: first.category, question: first.text, answer: vagueAnswer });

    // Drain at most 40 next() calls and confirm the LLM-generated text
    // appears as one of the planner's questions.
    let sawFollowUp = false;
    let safety = 0;
    while (safety++ < 40) {
      const q = await planner.next(transcript);
      if (!q) break;
      if (q.text === 'Tell me more about the OAuth scope you just mentioned.') {
        sawFollowUp = true;
      }
      transcript.push({ category: q.category, question: q.text, answer: vagueAnswer });
    }

    expect(sawFollowUp).toBe(true);
  });

  it('returns null once both core questions and follow-up budget are exhausted', async () => {
    const planner = createQuestionPlanner({ llmClient: silentLLM(), maxFollowUps: 0 });

    // Build a transcript with all core questions already asked + answered.
    const core = getAllQuestionsSorted();
    const transcript: QAPair[] = core.map((c) => ({
      category: c.category,
      question: c.text,
      answer: `substantive answer about ${c.id}`,
    }));

    const q = await planner.next(transcript);
    expect(q).toBeNull();
  });

  it('exposes the total core-question count', () => {
    const planner = createQuestionPlanner({ llmClient: silentLLM() });
    expect(planner.totalCoreQuestions).toBe(CORE_QUESTIONS.length);
  });
});
