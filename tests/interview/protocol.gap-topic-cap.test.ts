import { describe, it, expect, vi } from 'vitest';

import {
  createProtocol,
  countPriorAsksForTopic,
  gapTopicsAtCap,
  topicContentWords,
  MAX_GAP_TOPIC_ASKS,
} from '../../src/interview/protocol.js';
import {
  buildFollowUpPrompt,
  buildAdversarialProbePrompt,
} from '../../src/llm/prompts.js';
import { getAllQuestionsSorted } from '../../src/interview/questions.js';
import type { LLMClient } from '../../src/llm/client.js';
import type { QAPair } from '../../src/report/types.js';

/**
 * AAP-146: the interview planner re-asked the same gap repeatedly and
 * injected ungrounded premises. Two live audits showed 45+ questions where
 * 58% circled two already-recorded gaps (deletion workflow, alert /
 * escalation) under many distinct phrasings.
 *
 * Resolved design: a session-level gap-topic ledger, cap 3 asks per topic
 * across the WHOLE interview (initial ask + 2 angles), enforced
 * deterministically post-generation. Topic identity = deterministic
 * content-word overlap (Jaccard >= 0.5). Plus a prompt-level "do not
 * re-probe" list once a topic is at cap and an always-present
 * premise-grounding rule.
 */

// ─── Fixtures ────────────────────────────────────────────────────────────────

/**
 * LLM stub that always proposes another DELETION-gap follow-up, varying
 * the phrasing across proposals to mirror the live evidence. Every
 * proposal is a distinct sentence (dodges the repeated-answer guard) but
 * all share the deletion gap subject, so they cluster into one topic.
 */
function deletionGapLLM(): LLMClient {
  const variants = [
    'Walk me through the concrete deletion flow end-to-end for user records.',
    'If an operator receives a deletion request, what concrete steps execute to remove the data?',
    'What concrete source of truth would an operator use to enumerate records before deletion?',
    'What concrete artifact, if any, confirms a deletion request actually completed across systems?',
    'What concrete mechanism today prevents stale records from surviving a deletion request?',
    'Describe the deletion propagation path: which downstream systems erase records, and how is removal verified?',
    'When a deletion request lands, what concrete process erases the records and proves completion?',
    'Concretely, what enforces deletion of records once an operator triggers a removal request?',
  ];
  let n = 0;
  return {
    chat: vi.fn(async () => {
      const v = variants[n % variants.length]!;
      n += 1;
      return v;
    }),
  };
}

/** Vague answer the protocol's isVagueAnswer flags. Unique per call so the
 *  repeated-answer detector does not short-circuit follow-up generation. */
function vagueAnswer(salt: number | string): string {
  return (
    `Iteration ${salt}: I may also access ${salt} different services, depending on the task. ` +
    `When enabled, connectors are enabled and the workflow ${salt} runs as needed. ` +
    `No deletion workflow exists. Token suffix ${salt}.`
  );
}

// ─── Unit: topic-identity helpers ────────────────────────────────────────────

describe('AAP-146 topic-identity helpers', () => {
  it('clusters distinct phrasings of the same deletion gap by content-word overlap', () => {
    const a = 'Walk me through the concrete deletion flow end-to-end for user records.';
    const b = 'What concrete mechanism today prevents stale records from surviving a deletion request?';
    // Both are about deletion of records, so they land in one cluster of 2.
    expect(countPriorAsksForTopic(b, [a])).toBe(1);
  });

  it('does NOT cluster genuinely distinct gap topics (no false positives)', () => {
    const deletion = 'Walk me through the concrete deletion flow end-to-end for user records.';
    const alerting = 'Which specific monitoring event triggers an escalation alert to an on-call operator?';
    expect(countPriorAsksForTopic(alerting, [deletion])).toBe(0);
  });

  it('gapTopicsAtCap returns a topic only once it has been asked MAX_GAP_TOPIC_ASKS times', () => {
    const asks = [
      'Walk me through the concrete deletion flow end-to-end for user records.',
      'What concrete mechanism prevents stale records from surviving a deletion request?',
      'What concrete artifact confirms a deletion request completed across the records systems?',
    ];
    expect(asks.length).toBe(MAX_GAP_TOPIC_ASKS);
    expect(gapTopicsAtCap(asks.slice(0, 2))).toEqual([]);
    expect(gapTopicsAtCap(asks).length).toBe(1);
  });

  it('topicContentWords strips stopwords and short tokens', () => {
    const words = topicContentWords('What concrete deletion flow exists for the user records?');
    expect(words.has('deletion')).toBe(true);
    expect(words.has('records')).toBe(true);
    // stopwords / scaffolding removed
    expect(words.has('what')).toBe(false);
    expect(words.has('concrete')).toBe(false);
    // length <= 3 removed
    expect(words.has('the')).toBe(false);
  });
});

// ─── Test 1: RED-FIRST runaway deletion re-asks get capped ───────────────────

describe('AAP-146 session-level gap-topic cap', () => {
  it('caps total deletion-topic asks at MAX_GAP_TOPIC_ASKS even when the LLM always proposes another', async () => {
    const protocol = createProtocol(deletionGapLLM());
    const core = getAllQuestionsSorted();

    let deletionAsks = 0;
    // Walk every core question with vague answers; after each, drain
    // follow-ups. The LLM always proposes a deletion-flavored follow-up.
    for (let i = 0; i < core.length; i++) {
      const q = protocol.nextQuestion()!;
      protocol.recordAnswer(q, vagueAnswer(`core-${i}`));
      for (let j = 0; j < 5; j++) {
        const f = await protocol.generateFollowUp(q.category);
        if (!f) break;
        deletionAsks += 1;
        protocol.recordAnswer(f, vagueAnswer(`follow-${i}-${j}`));
      }
    }

    // Before the fix this ran far past 3 (one deletion follow-up per core,
    // per-question cap doing nothing cross-question). After the fix the
    // whole-interview deletion topic tops out at MAX_GAP_TOPIC_ASKS.
    expect(deletionAsks).toBe(MAX_GAP_TOPIC_ASKS);

    // Interview still proceeds and completes without error.
    let q = protocol.nextQuestion();
    while (q) {
      protocol.recordAnswer(q, vagueAnswer(`tail-${q.id}`));
      q = protocol.nextQuestion();
    }
    expect(protocol.isComplete()).toBe(true);
  });

  it('cap is TOPIC-level: deletion follow-ups under DIFFERENT core questions share one ledger entry', async () => {
    // Drive follow-ups against two cores in different categories. Both get
    // deletion-flavored follow-ups from the stub. The ledger is keyed on
    // topic, not on the parent core, so the combined count caps at 3.
    const protocol = createProtocol(deletionGapLLM());
    const core = getAllQuestionsSorted();

    let deletionAsks = 0;
    const seenCategories = new Set<string>();
    for (let i = 0; i < core.length && seenCategories.size < 3; i++) {
      const q = protocol.nextQuestion()!;
      seenCategories.add(q.category);
      protocol.recordAnswer(q, vagueAnswer(`x-${i}`));
      // One follow-up attempt per core so no single core hits its own cap
      // of 2; any capping here is necessarily the cross-question topic cap.
      const f = await protocol.generateFollowUp(q.category);
      if (f) {
        deletionAsks += 1;
        protocol.recordAnswer(f, vagueAnswer(`xf-${i}`));
      }
    }

    expect(seenCategories.size).toBeGreaterThanOrEqual(3);
    expect(deletionAsks).toBeLessThanOrEqual(MAX_GAP_TOPIC_ASKS);
  });

  it('distinct gap topics are NOT throttled: three different topics each get their asks', async () => {
    // Stub rotates through three UNRELATED gap subjects. Each should be
    // allowed (none reaches the per-topic cap), so all three surface.
    const variants = [
      'Which specific OAuth scope grants the spreadsheet write capability you described?',
      'What is the maximum number of customer mailboxes a single run can touch?',
      'How many times per day does the billing reconciliation job execute?',
    ];
    let n = 0;
    const rotatingLLM: LLMClient = {
      chat: vi.fn(async () => {
        const v = variants[n % variants.length]!;
        n += 1;
        return v;
      }),
    };
    const protocol = createProtocol(rotatingLLM);
    const core = getAllQuestionsSorted();

    const askedTexts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const q = protocol.nextQuestion()!;
      protocol.recordAnswer(q, vagueAnswer(`d-${i}`));
      const f = await protocol.generateFollowUp(q.category);
      if (f) {
        askedTexts.push(f.text);
        protocol.recordAnswer(f, vagueAnswer(`df-${i}`));
      }
    }

    // All three distinct topics surfaced, no cross-topic false positive.
    expect(askedTexts.length).toBe(3);
    expect(gapTopicsAtCap(askedTexts)).toEqual([]);
  });
});

// ─── Test 4: rehydration rebuilds the ledger from the transcript ──────────────

describe('AAP-146 rehydration', () => {
  it('a fresh protocol primed from a transcript with 3 deletion asks blocks a 4th', async () => {
    // Simulate the tool-call path: a new protocol instance replays a
    // transcript that already contains MAX_GAP_TOPIC_ASKS deletion
    // follow-ups. The ledger is derived from the transcript, so the cap
    // must survive the "restart" and block the next deletion follow-up.
    const protocol = createProtocol(deletionGapLLM());
    const core = getAllQuestionsSorted();

    // Replay: core question, then 3 prior deletion follow-ups, all recorded
    // exactly the way rehydrate() in question-planner.ts would.
    const q0 = protocol.nextQuestion()!;
    protocol.recordAnswer(q0, vagueAnswer('rehydrate-core'));
    const priorDeletionAsks = [
      'Walk me through the concrete deletion flow end-to-end for user records.',
      'What concrete mechanism prevents stale records from surviving a deletion request?',
      'What concrete artifact confirms a deletion request completed across the records systems?',
    ];
    for (let i = 0; i < priorDeletionAsks.length; i++) {
      protocol.recordAnswer(
        {
          id: `replayed_followup_${q0.category}_${i}`,
          category: q0.category,
          text: priorDeletionAsks[i]!,
          priority: 1000,
        },
        vagueAnswer(`replayed-${i}`),
      );
    }

    // The next deletion follow-up the LLM proposes must be dropped: topic
    // already at cap in the replayed transcript.
    const f = await protocol.generateFollowUp(q0.category);
    expect(f).toBeNull();
  });
});

// ─── Test 5: prompt content ──────────────────────────────────────────────────

describe('AAP-146 prompt content', () => {
  const sampleQA = [{ question: 'Q', answer: 'A' }];

  it('follow-up prompt always contains the premise-grounding rule', () => {
    const prompt = buildFollowUpPrompt('writes', sampleQA);
    expect(prompt).toContain('GROUNDING RULE');
    expect(prompt.toLowerCase()).toContain('only reference facts the agent itself stated');
    expect(prompt).toContain('NEVER assert a framework');
  });

  it('adversarial probe prompt always contains the premise-grounding rule', () => {
    const prompt = buildAdversarialProbePrompt('deletion', 'probe hint', sampleQA);
    expect(prompt).toContain('GROUNDING RULE');
  });

  it('follow-up prompt contains the do-not-re-probe list once a topic hits the cap', () => {
    const atCap = ['Walk me through the concrete deletion flow end-to-end for user records.'];
    const prompt = buildFollowUpPrompt('writes', sampleQA, undefined, atCap);
    expect(prompt).toContain('already recorded');
    expect(prompt).toContain('do NOT ask about them again');
    expect(prompt).toContain(atCap[0]);
  });

  it('follow-up prompt omits the do-not-re-probe block when nothing is at cap', () => {
    const prompt = buildFollowUpPrompt('writes', sampleQA, undefined, []);
    expect(prompt).not.toContain('do NOT ask about them again');
    // grounding rule is still present unconditionally
    expect(prompt).toContain('GROUNDING RULE');
  });
});
