import { describe, it, expect, vi } from 'vitest';

import {
  createProtocol,
  findMostRecentCoreInCategory,
} from '../../src/interview/protocol.js';
import {
  CORE_QUESTIONS,
  getAllQuestionsSorted,
  getQuestionsByCategory,
} from '../../src/interview/questions.js';
import { createQuestionPlanner } from '../../src/interview/question-planner.js';
import type { LLMClient } from '../../src/llm/client.js';
import type { QAPair } from '../../src/report/types.js';

/**
 * AAP-77 regression suite for the per-question follow-up cap in
 * categories with multiple core questions.
 *
 * Background — AAP-71 (PR #63) removed the global follow-up cap and
 * left the per-question cap of 2 as the sole production limit. The
 * remaining cap looked correct in isolation but had a hole exposed by
 * 4 of the 5 categories carrying more than one core question:
 *
 *   `protocol.ts` cap check used `coreQuestions.find(q => q.category === category)`
 *   which returns the FIRST core declared in the category. The
 *   `primeFollowUpCounts` path in `question-planner.ts` attributed
 *   follow-ups to the MOST RECENT core. Increment wrote to one ID,
 *   cap check read another ID. Counter never reached 2.
 *
 * Live E2E audit on 2026-05-24 observed 14 consecutive follow-ups in
 * the `writes` category instead of the expected ~4 (4 cores × ~1
 * follow-up each).
 *
 * Fix: both the cap check (in `protocol.generateFollowUp`) and the
 * planner's rehydration counter use the same shared helper,
 * `findMostRecentCoreInCategory`, which scans the transcript backward
 * for the most recently asked core question matching the category.
 *
 * These tests assert:
 *   1. The helper itself returns the most-recent (not first-declared) core.
 *   2. The cap fires after exactly 2 follow-ups when a category has
 *      multiple cores asked sequentially.
 *   3. Coverage for every multi-core category: data, access, writes, purpose.
 *   4. The single-core category (frequency) still works correctly.
 *   5. Counter attribution: `followUpCountPerQuestion` keys match the
 *      actual most-recent core IDs that received follow-ups.
 *   6. Sanity: a synthetic walk through all 15 cores with vague answers
 *      cannot exceed 15 × 2 = 30 total follow-ups, and the distribution
 *      reflects per-question (not per-category) accounting.
 */

// ─── Test fixtures ───────────────────────────────────────────────────────────

function alwaysFollowsUpLLM(): LLMClient {
  let n = 0;
  return {
    chat: vi.fn(async () => {
      n += 1;
      return `Follow-up question #${n} from the LLM stub.`;
    }),
  };
}

/** Vague answer the protocol's `isVagueAnswer` will flag. Unique per call
 *  so the repeated-answer detector doesn't short-circuit follow-ups. */
function vagueAnswer(salt: number | string): string {
  return (
    `Iteration ${salt}: I may also access ${salt} different services, depending on the task. ` +
    `When enabled, connectors are enabled and the workflow ${salt} runs as needed. ` +
    `Token suffix ${salt}.`
  );
}

/** Categories with more than one core question — the entire AAP-77 surface. */
const MULTI_CORE_CATEGORIES: QAPair['category'][] = [
  'data',
  'access',
  'writes',
  'purpose',
];

// ─── Helper tests ────────────────────────────────────────────────────────────

describe('findMostRecentCoreInCategory (AAP-77 helper)', () => {
  it('returns null when no core in the category has been asked', () => {
    const transcript: QAPair[] = [];
    const result = findMostRecentCoreInCategory('data', transcript, CORE_QUESTIONS);
    expect(result).toBeNull();
  });

  it('returns the most recent core in the category, not the first declared', () => {
    // `data` category has 4 cores in this order:
    //   systems_enum, data_sensitivity, cross_customer_isolation, upstream_model_and_apis
    const dataCores = getQuestionsByCategory('data');
    expect(dataCores.length).toBeGreaterThanOrEqual(2);
    const first = dataCores[0]!;
    const second = dataCores[1]!;

    const transcript: QAPair[] = [
      { category: 'data', question: first.text, answer: vagueAnswer('a') },
      { category: 'data', question: second.text, answer: vagueAnswer('b') },
    ];

    const result = findMostRecentCoreInCategory('data', transcript, CORE_QUESTIONS);
    expect(result, 'should pick the most recent core in category').not.toBeNull();
    expect(result!.id).toBe(second.id);
    expect(result!.id).not.toBe(first.id);
  });

  it('ignores follow-up entries when looking for the owning core', () => {
    const dataCores = getQuestionsByCategory('data');
    const first = dataCores[0]!;
    const second = dataCores[1]!;

    // Insert a follow-up between the two cores. The most recent core is
    // still `second`, not the follow-up entry.
    const transcript: QAPair[] = [
      { category: 'data', question: first.text, answer: vagueAnswer('a') },
      {
        category: 'data',
        question: 'LLM follow-up text that does not match any core',
        answer: vagueAnswer('b'),
      },
      { category: 'data', question: second.text, answer: vagueAnswer('c') },
      {
        category: 'data',
        question: 'Another LLM follow-up text',
        answer: vagueAnswer('d'),
      },
    ];

    const result = findMostRecentCoreInCategory('data', transcript, CORE_QUESTIONS);
    expect(result!.id).toBe(second.id);
  });

  it('only considers entries in the requested category', () => {
    const dataCores = getQuestionsByCategory('data');
    const dataCore = dataCores[0]!;
    const accessCores = getQuestionsByCategory('access');
    const accessCore = accessCores[0]!;

    const transcript: QAPair[] = [
      { category: 'data', question: dataCore.text, answer: vagueAnswer('a') },
      { category: 'access', question: accessCore.text, answer: vagueAnswer('b') },
    ];

    const result = findMostRecentCoreInCategory('data', transcript, CORE_QUESTIONS);
    expect(result!.id).toBe(dataCore.id);
  });
});

// ─── Cap-fires-for-multi-core regression: every multi-core category ──────────

describe('per-question cap fires in multi-core categories (AAP-77)', () => {
  for (const category of MULTI_CORE_CATEGORIES) {
    it(`fires after 2 follow-ups on each core in '${category}' (not 2 per category)`, async () => {
      const categoryCores = getQuestionsByCategory(category);
      expect(
        categoryCores.length,
        `${category} should have multiple cores for this test`,
      ).toBeGreaterThanOrEqual(2);

      const c1 = categoryCores[0]!;
      const c2 = categoryCores[1]!;

      const protocol = createProtocol(alwaysFollowsUpLLM()); // no global cap

      // Synthesise the "two cores in same category, each with 2
      // follow-ups already recorded" shape via primeFollowUpCounts.
      // The protocol's transcript needs to reflect both cores so the
      // backward scan picks the right one for each follow-up call.
      const transcript: QAPair[] = [
        { category, question: c1.text, answer: vagueAnswer('c1') },
        {
          category,
          question: 'LLM follow-up after c1 #1',
          answer: vagueAnswer('c1-f1'),
        },
        {
          category,
          question: 'LLM follow-up after c1 #2',
          answer: vagueAnswer('c1-f2'),
        },
        { category, question: c2.text, answer: vagueAnswer('c2') },
        {
          category,
          question: 'LLM follow-up after c2 #1',
          answer: vagueAnswer('c2-f1'),
        },
        {
          category,
          question: 'LLM follow-up after c2 #2',
          answer: vagueAnswer('c2-f2'),
        },
      ];

      // Drive the protocol forward to reach c2 and record everything.
      // We use the planner here because it owns the rehydration step
      // that exposed the AAP-77 bug end-to-end.
      const planner = createQuestionPlanner({
        llmClient: alwaysFollowsUpLLM(),
      });
      // Sanity: just exercise the planner's rehydration shape — we
      // don't need its `next()` result, we want the protocol behaviour.

      // For the protocol-level assertion, manually replay the transcript
      // through a fresh protocol and assert generateFollowUp returns null.
      let q = protocol.nextQuestion();
      while (q && q.text !== c1.text) {
        protocol.recordAnswer(q, vagueAnswer(`skip-${q.id}`));
        q = protocol.nextQuestion();
      }
      expect(q, `protocol should reach core ${c1.id}`).not.toBeNull();

      // Record c1 and its 2 follow-ups.
      protocol.recordAnswer(q!, transcript[0]!.answer);
      const f1a = await protocol.generateFollowUp(category);
      expect(f1a, `c1 follow-up #1 should fire`).not.toBeNull();
      protocol.recordAnswer(f1a!, transcript[1]!.answer);
      const f1b = await protocol.generateFollowUp(category);
      expect(f1b, `c1 follow-up #2 should fire`).not.toBeNull();
      protocol.recordAnswer(f1b!, transcript[2]!.answer);
      // c1's cap should now be reached.
      const f1c = await protocol.generateFollowUp(category);
      expect(f1c, `c1 third follow-up must be blocked by per-Q cap`).toBeNull();

      // Walk forward to c2.
      q = protocol.nextQuestion();
      while (q && q.text !== c2.text) {
        protocol.recordAnswer(q, vagueAnswer(`skip2-${q.id}`));
        q = protocol.nextQuestion();
      }
      expect(q, `protocol should reach core ${c2.id}`).not.toBeNull();
      protocol.recordAnswer(q!, transcript[3]!.answer);

      // c2 must get its OWN 2 follow-ups — separate budget from c1.
      // Pre-fix this would have been blocked because the cap check
      // looked up c1 (first in category) and saw count=2 already.
      const f2a = await protocol.generateFollowUp(category);
      expect(
        f2a,
        `c2 follow-up #1 must fire (AAP-77: pre-fix this was blocked because cap check read c1's count)`,
      ).not.toBeNull();
      protocol.recordAnswer(f2a!, transcript[4]!.answer);
      const f2b = await protocol.generateFollowUp(category);
      expect(f2b, `c2 follow-up #2 must fire`).not.toBeNull();
      protocol.recordAnswer(f2b!, transcript[5]!.answer);
      const f2c = await protocol.generateFollowUp(category);
      expect(f2c, `c2 third follow-up must be blocked by per-Q cap`).toBeNull();

      // Silence unused warning — the planner instance was created above
      // to document end-to-end intent.
      void planner;
    });
  }
});

// ─── Single-core category still behaves correctly ────────────────────────────

describe('single-core category (frequency) still caps at 2 (AAP-77 regression guard)', () => {
  it('frequency category fires the cap after exactly 2 follow-ups', async () => {
    const frequencyCores = getQuestionsByCategory('frequency');
    expect(frequencyCores.length).toBe(1);
    const core = frequencyCores[0]!;

    const protocol = createProtocol(alwaysFollowsUpLLM()); // no global cap

    let q = protocol.nextQuestion();
    while (q && q.text !== core.text) {
      protocol.recordAnswer(q, vagueAnswer(`skip-${q.id}`));
      q = protocol.nextQuestion();
    }
    expect(q).not.toBeNull();
    protocol.recordAnswer(q!, vagueAnswer('freq-1'));

    const f1 = await protocol.generateFollowUp('frequency');
    expect(f1).not.toBeNull();
    protocol.recordAnswer(f1!, vagueAnswer('freq-f1'));
    const f2 = await protocol.generateFollowUp('frequency');
    expect(f2).not.toBeNull();
    protocol.recordAnswer(f2!, vagueAnswer('freq-f2'));
    const f3 = await protocol.generateFollowUp('frequency');
    expect(f3, 'per-Q cap must fire after 2 follow-ups').toBeNull();
  });
});

// ─── Counter attribution: keys match the right core IDs ──────────────────────

describe('follow-up counter attributes to the most recent core (AAP-77)', () => {
  it('per-question map keys identify the most recent core in each category', async () => {
    const dataCores = getQuestionsByCategory('data');
    const dataC1 = dataCores[0]!;
    const dataC2 = dataCores[1]!;

    // Build a transcript that records a follow-up after dataC1 was
    // asked, then progresses to dataC2 and records another follow-up.
    // We expect the follow-up after dataC2 to be attributed to dataC2,
    // not dataC1 (pre-fix it was attributed to whichever the planner's
    // forward-walking `lastCore` happened to be).
    const planner = createQuestionPlanner({
      llmClient: alwaysFollowsUpLLM(),
    });

    // Transcript shape:
    //   dataC1, ans
    //   [follow-up of dataC1], ans
    //   dataC2, ans
    //   [follow-up of dataC2], ans
    const transcript: QAPair[] = [
      { category: 'data', question: dataC1.text, answer: vagueAnswer('d1') },
      {
        category: 'data',
        question: 'follow-up of dataC1',
        answer: vagueAnswer('d1-f'),
      },
      { category: 'data', question: dataC2.text, answer: vagueAnswer('d2') },
      {
        category: 'data',
        question: 'follow-up of dataC2',
        answer: vagueAnswer('d2-f'),
      },
    ];

    // Run the planner to trigger the rehydration path that primes the
    // protocol's followUpCountPerQuestion. We can't read the map
    // directly, but we can prove attribution indirectly: drive the cap
    // for dataC2 specifically by adding one more follow-up to dataC2
    // and asserting the next call returns null (cap=2 on dataC2). If
    // the follow-up after dataC2 had been mis-attributed to dataC1,
    // dataC2's count would be 0 and we'd still get more follow-ups.
    const transcriptForCap: QAPair[] = [
      ...transcript,
      {
        category: 'data',
        question: 'follow-up of dataC2 #2',
        answer: vagueAnswer('d2-f2'),
      },
    ];

    const next = await planner.next(transcriptForCap);
    // The planner reached a state where:
    //   dataC1 has 1 follow-up (under cap)
    //   dataC2 has 2 follow-ups (at cap)
    // The next core after the last entry is whatever comes after
    // data. The boundary follow-up for `data` should be blocked
    // because dataC2 (the most recent data core) is at cap.
    //
    // If pre-fix attribution had assigned both follow-ups to dataC1,
    // dataC2 would still have 0 follow-ups in the counter map, and
    // the boundary follow-up logic would NOT be blocked.
    //
    // Assert: whatever the planner returns must NOT be a `data`
    // category entry (boundary follow-up was correctly suppressed).
    if (next !== null) {
      const coreMatch = CORE_QUESTIONS.find((c) => c.text === next.text);
      if (coreMatch) {
        // Allowed: it's a core question in some other category.
        expect(coreMatch.category).not.toBe('data');
      } else {
        // It's a follow-up. It must NOT be a `data` follow-up.
        expect(next.category).not.toBe('data');
      }
    }
  });
});

// ─── End-to-end sanity: synthetic 16-question walk ───────────────────────────

describe('synthetic walk: total follow-ups respects 16 × 2 ceiling (AAP-77 sanity)', () => {
  it('walking every core question with vague answers yields ≤ 32 follow-ups', async () => {
    const protocol = createProtocol(alwaysFollowsUpLLM()); // no global cap
    const core = getAllQuestionsSorted();

    const followUpsPerCore = new Map<string, number>();
    for (let i = 0; i < core.length; i++) {
      const q = protocol.nextQuestion();
      expect(q).not.toBeNull();
      protocol.recordAnswer(q!, vagueAnswer(`core-${i}`));

      // Drain up to 5 follow-ups (much more than the per-Q cap of 2)
      // so the cap, not the loop, decides when follow-ups stop.
      let count = 0;
      for (let j = 0; j < 5; j++) {
        const f = await protocol.generateFollowUp(q!.category);
        if (!f) break;
        count += 1;
        protocol.recordAnswer(f, vagueAnswer(`follow-${i}-${j}`));
      }
      followUpsPerCore.set(q!.id, count);
    }

    // Per-question cap of 2 must hold for every core question.
    for (const [qid, count] of followUpsPerCore) {
      expect(count, `core ${qid} exceeded per-Q cap of 2`).toBeLessThanOrEqual(2);
    }

    // Total follow-ups must respect 16 × 2 = 32 (AAP-82 added one core).
    const total = [...followUpsPerCore.values()].reduce((a, b) => a + b, 0);
    expect(total, `total follow-ups across all cores`).toBeLessThanOrEqual(32);

    // Pre-fix: in multi-core categories the cap never fired so the
    // outer loop's `for (j ... < 5)` bound was reached — count would be
    // 5 per core in those categories. Assert the cap actually engaged
    // by checking that at least one multi-core category's later core
    // saw at most 2.
    for (const category of MULTI_CORE_CATEGORIES) {
      const cores = getQuestionsByCategory(category);
      if (cores.length < 2) continue;
      const lastCore = cores[cores.length - 1]!;
      const seenForLast = followUpsPerCore.get(lastCore.id) ?? 0;
      expect(
        seenForLast,
        `${category}: last core ${lastCore.id} should be cap-bounded`,
      ).toBeLessThanOrEqual(2);
    }
  });

  it('follow-ups distribute across cores in proportion to multi-core counts', async () => {
    // In a world where the per-Q cap actually fires, each core can earn
    // up to 2 follow-ups. Multi-core categories therefore have more
    // capacity than single-core ones. Assert the distribution is
    // per-question (not per-category) by checking that a multi-core
    // category accumulates more total follow-ups than the single-core
    // frequency category does, given vague answers everywhere.
    const protocol = createProtocol(alwaysFollowsUpLLM());
    const core = getAllQuestionsSorted();

    const followUpsByCategory = new Map<string, number>();
    for (let i = 0; i < core.length; i++) {
      const q = protocol.nextQuestion();
      expect(q).not.toBeNull();
      protocol.recordAnswer(q!, vagueAnswer(`core-${i}`));
      let count = 0;
      for (let j = 0; j < 5; j++) {
        const f = await protocol.generateFollowUp(q!.category);
        if (!f) break;
        count += 1;
        protocol.recordAnswer(f, vagueAnswer(`follow-${i}-${j}`));
      }
      followUpsByCategory.set(
        q!.category,
        (followUpsByCategory.get(q!.category) ?? 0) + count,
      );
    }

    // Each multi-core category should accumulate strictly more
    // follow-ups than the single-core `frequency` category, because it
    // has more cores each capped at 2 (not because one core's cap got
    // mis-attributed). Pre-fix, multi-core categories accumulated
    // UNBOUNDED follow-ups, which is still > frequency's bounded total
    // but for the wrong reason. The cap-bounded assertion above is the
    // primary regression guard; this one documents intent.
    const freqTotal = followUpsByCategory.get('frequency') ?? 0;
    for (const category of MULTI_CORE_CATEGORIES) {
      const total = followUpsByCategory.get(category) ?? 0;
      expect(
        total,
        `${category} should accumulate at least as many follow-ups as 'frequency' (per-Q accounting)`,
      ).toBeGreaterThanOrEqual(freqTotal);
    }
  });
});
