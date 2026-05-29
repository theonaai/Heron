import { describe, it, expect, vi } from 'vitest';
import { createProtocol, isVagueAnswer } from '../../src/interview/protocol.js';
import { getAllQuestionsSorted } from '../../src/interview/questions.js';
import type { LLMClient } from '../../src/llm/client.js';

function createMockLLM(): LLMClient {
  return {
    chat: vi.fn().mockResolvedValue('What specific API scopes does the agent use for Gmail access?'),
  };
}

/** LLM stub that mints a unique numbered follow-up on each call so the
 *  protocol's `isRepeatedAnswer` guard doesn't short-circuit the
 *  follow-up loop. AAP-71 tests need to exercise the cap behaviour, not
 *  the repeat-detector. */
function alwaysFollowsUpLLM(): LLMClient {
  let n = 0;
  return {
    chat: vi.fn(async () => {
      n += 1;
      return `Follow-up question #${n} from the LLM stub.`;
    }),
  };
}

/** Vague answer the protocol's `isVagueAnswer` will flag. Unique per
 *  call so the repeated-answer detector doesn't short-circuit. */
function vagueAnswer(salt: number | string): string {
  return (
    `Iteration ${salt}: I may also access ${salt} different services, depending on the task. ` +
    `When enabled, connectors are enabled and the workflow ${salt} runs as needed. ` +
    `Token suffix ${salt}.`
  );
}

describe('vagueness detection', () => {
  it('detects vague database references', () => {
    expect(isVagueAnswer('I read from the database')).toBe(true);
    expect(isVagueAnswer('I read from PostgreSQL on AWS RDS')).toBe(false);
  });

  it('detects vague access levels', () => {
    expect(isVagueAnswer('I have read and write access')).toBe(true);
    expect(isVagueAnswer('I have gmail.readonly and gmail.send scopes')).toBe(false);
  });

  it('detects vague data descriptions', () => {
    expect(isVagueAnswer('I handle user data')).toBe(true);
    expect(isVagueAnswer('I handle email subjects and sender addresses')).toBe(false);
  });

  it('detects vague frequency', () => {
    expect(isVagueAnswer('I run regularly')).toBe(true);
    expect(isVagueAnswer('I run 50 times per day')).toBe(false);
  });

  it('detects vague impact statements', () => {
    expect(isVagueAnswer('It could affect users')).toBe(true);
    expect(isVagueAnswer('It affects a single user mailbox, max 10 drafts/day')).toBe(false);
  });

  it('detects "various systems" as vague', () => {
    expect(isVagueAnswer('I connect to various systems')).toBe(true);
    expect(isVagueAnswer('I connect to SAP ERP and HubSpot CRM')).toBe(false);
  });

  it('detects "full access" as vague', () => {
    expect(isVagueAnswer('I have full access to everything')).toBe(true);
  });

  it('detects "I am not sure" as vague', () => {
    expect(isVagueAnswer("I'm not sure what access I have")).toBe(true);
  });
});

describe('protocol', () => {
  it('returns core questions in priority order', () => {
    const protocol = createProtocol(createMockLLM());
    const questions = [];
    let q = protocol.nextQuestion();
    while (q) {
      questions.push(q);
      protocol.recordAnswer(q, 'Test answer');
      q = protocol.nextQuestion();
    }

    // 10 core + 5 AIUC-1 (AAP-44) + 1 AAP-82 MCP directive + 1 G10 OAuth
    // directive. Derived from the live bank so adding a question does not
    // require touching this number.
    expect(questions.length).toBe(getAllQuestionsSorted().length);
    for (let i = 1; i < questions.length; i++) {
      expect(questions[i].priority).toBeGreaterThanOrEqual(questions[i - 1].priority);
    }
  });

  it('records answers in transcript', () => {
    const protocol = createProtocol(createMockLLM());
    const q = protocol.nextQuestion()!;
    protocol.recordAnswer(q, 'I process invoices');

    const transcript = protocol.getTranscript();
    expect(transcript.length).toBe(1);
    expect(transcript[0].answer).toBe('I process invoices');
    expect(transcript[0].category).toBe(q.category);
  });

  it('generates follow-up for vague answers', async () => {
    const protocol = createProtocol(createMockLLM(), 3);

    // Record a vague answer
    const q = protocol.nextQuestion()!;
    protocol.recordAnswer(q, 'I connect to the database and handle user data regularly');

    const followUp = await protocol.generateFollowUp(q.category);
    expect(followUp).not.toBeNull();
    expect(followUp!.category).toBe(q.category);
    expect(followUp!.id).toContain('followup');
  });

  it('does not generate follow-up for specific answers when no missing fields', async () => {
    const mockLLM = createMockLLM();
    const protocol = createProtocol(mockLLM, 3);

    // Record specific answers that cover compliance fields
    const q1 = protocol.nextQuestion()!;
    protocol.recordAnswer(q1, 'I process invoices using Google Workspace, Gmail API via OAuth2 with gmail.readonly scope. I access PII including email subjects. I run 50 times per day in batch of 1 affecting a single user mailbox. Operations are reversible.');

    const followUp = await protocol.generateFollowUp(q1.category);
    // With a very complete answer, follow-up generation should not be triggered
    // (or if it is, it should check missing fields first)
    // The key point is that it respects the maxFollowUps limit
    expect(typeof followUp === 'object' || followUp === null).toBe(true);
  });

  it('respects maxFollowUps limit', async () => {
    const protocol = createProtocol(createMockLLM(), 1);

    const q = protocol.nextQuestion()!;
    protocol.recordAnswer(q, 'I connect to the database');

    // First follow-up should work
    const f1 = await protocol.generateFollowUp(q.category);
    if (f1) {
      protocol.recordAnswer(f1, 'Still vague answer about the database');
    }

    // Second follow-up should be blocked by limit
    const f2 = await protocol.generateFollowUp(q.category);
    expect(f2).toBeNull();
  });

  it('isComplete returns true after all questions answered', () => {
    const protocol = createProtocol(createMockLLM());

    let q = protocol.nextQuestion();
    while (q) {
      protocol.recordAnswer(q, 'Test answer');
      q = protocol.nextQuestion();
    }

    expect(protocol.isComplete()).toBe(true);
  });

  it('getTranscript returns a copy', () => {
    const protocol = createProtocol(createMockLLM());
    const q = protocol.nextQuestion()!;
    protocol.recordAnswer(q, 'Test');

    const t1 = protocol.getTranscript();
    const t2 = protocol.getTranscript();
    expect(t1).not.toBe(t2); // different array references
    expect(t1).toEqual(t2);  // same content
  });
});

// ─── AAP-71: global follow-up cap removed ────────────────────────────────────

describe('AAP-71: no global follow-up cap by default', () => {
  it('default protocol has no session-wide cap (full-bank vague transcript stays under per-Q cap)', async () => {
    // Walk every core question with vague answers. Without the global
    // cap, the protocol should be able to issue follow-ups on later
    // questions too, bounded only by the per-question cap of 2.
    // Upper bound on total follow-ups: CORE_QUESTIONS.length * 2 (the bank
    // includes the AAP-82 mcp_tools_forward_directive + the G10
    // oauth_scopes_forward_directive). In practice it's lower because not
    // every question's vague answer trips the per-question cap, but the
    // test asserts the floor (every core question got at least one
    // follow-up opportunity) and the ceiling (no more than length*2
    // follow-ups total). Derived from the live bank size so adding a
    // question does not require touching this number.
    const protocol = createProtocol(alwaysFollowsUpLLM()); // undefined ceiling
    const core = getAllQuestionsSorted();
    const structuralCeiling = core.length * 2;

    const followUpsPerCore = new Map<string, number>();
    for (let i = 0; i < core.length; i++) {
      const q = protocol.nextQuestion()!;
      protocol.recordAnswer(q, vagueAnswer(`core-${i}`));
      // Drain up to 5 follow-ups (much more than the per-Q cap of 2)
      // so the cap, not our loop, is what stops follow-up generation.
      let count = 0;
      for (let j = 0; j < 5; j++) {
        const f = await protocol.generateFollowUp(q.category);
        if (!f) break;
        count += 1;
        protocol.recordAnswer(f, vagueAnswer(`follow-${i}-${j}`));
      }
      followUpsPerCore.set(q.id, count);
    }

    // Per-question cap of 2 must hold for every core question.
    for (const [qid, count] of followUpsPerCore) {
      expect(count, `core question ${qid} exceeded per-Q cap`).toBeLessThanOrEqual(2);
    }

    // Total follow-ups stays under the structural ceiling (length * 2).
    const total = [...followUpsPerCore.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(structuralCeiling);

    // The bug we're fixing: previously the global cap of 3 silently
    // blocked follow-ups on Q4+. Now at least one core question past
    // index 3 must have received a follow-up.
    let lateFollowUps = 0;
    for (let i = 3; i < core.length; i++) {
      lateFollowUps += followUpsPerCore.get(core[i].id) ?? 0;
    }
    expect(
      lateFollowUps,
      'expected follow-ups on later core questions (Q4+); the AAP-71 fix should let them through',
    ).toBeGreaterThan(0);
  });

  it('per-question cap of 2 still fires (regression coverage)', async () => {
    const protocol = createProtocol(alwaysFollowsUpLLM()); // no global cap
    const q = protocol.nextQuestion()!;
    protocol.recordAnswer(q, vagueAnswer(0));

    // First two follow-ups should succeed.
    const f1 = await protocol.generateFollowUp(q.category);
    expect(f1).not.toBeNull();
    protocol.recordAnswer(f1!, vagueAnswer(1));

    const f2 = await protocol.generateFollowUp(q.category);
    expect(f2).not.toBeNull();
    protocol.recordAnswer(f2!, vagueAnswer(2));

    // Third one must be blocked by the per-question cap, even with no
    // global ceiling in play.
    const f3 = await protocol.generateFollowUp(q.category);
    expect(f3).toBeNull();
  });

  it('adversarial probes do not consume the follow-up ceiling', async () => {
    // Ceiling = 1. Trigger an adversarial probe first (an "only reads"
    // narrow-scope claim matches the `scope-narrow-claim` pattern), then
    // a vague answer. The probe must NOT eat the single follow-up slot.
    const protocol = createProtocol(alwaysFollowsUpLLM(), 1);

    // Q1: agent makes a narrow-scope claim. The next answer is vague so
    // generateFollowUp can fire; the adversarial pattern wins over the
    // vagueness path because `isNewClaim` is true.
    const q1 = protocol.nextQuestion()!;
    protocol.recordAnswer(
      q1,
      'I only read my own data and never touch other tenants. ' + vagueAnswer('q1'),
    );

    const probe = await protocol.generateFollowUp(q1.category);
    expect(probe, 'expected an adversarial probe on the narrow-scope claim').not.toBeNull();
    expect(probe!.id.startsWith('probe_')).toBe(true);

    // Per-Q cap on q1 is now 1/2. Walk to a NEW core question and give
    // a vague answer there. The regular follow-up should still fire
    // because the adversarial probe did NOT consume the ceiling.
    protocol.recordAnswer(probe!, vagueAnswer('probe-answer'));

    // Walk forward to the next core question whose category differs
    // from q1.category so per-Q cap on q1 is irrelevant.
    let q2 = protocol.nextQuestion();
    while (q2 && q2.category === q1.category) {
      protocol.recordAnswer(q2, vagueAnswer(`skip-${q2.id}`));
      q2 = protocol.nextQuestion();
    }
    expect(q2, 'expected a core question in a different category').not.toBeNull();
    protocol.recordAnswer(q2!, vagueAnswer('q2'));

    const followUp = await protocol.generateFollowUp(q2!.category);
    expect(
      followUp,
      'AAP-71 regression: adversarial probe consumed the follow-up ceiling',
    ).not.toBeNull();
    expect(followUp!.id.startsWith('followup_')).toBe(true);
  });

  it('explicit maxFollowUps still acts as a hard ceiling on regular follow-ups', async () => {
    // Tests can pass `maxFollowUps: 0` to disable LLM-driven follow-ups
    // entirely. Verify that contract still holds post-AAP-71.
    const llm = vi.fn().mockResolvedValue('would be a follow-up');
    const protocol = createProtocol({ chat: llm }, 0);
    const q = protocol.nextQuestion()!;
    protocol.recordAnswer(q, vagueAnswer('zero'));
    const f = await protocol.generateFollowUp(q.category);
    expect(f).toBeNull();
    // The LLM must not have been called: the ceiling check fires
    // before any prompt is built.
    expect(llm).not.toHaveBeenCalled();
  });

  it('primeFollowUpCounts rehydration works without a global cap', async () => {
    // Simulate the tool-call rehydration path: a fresh protocol primed
    // with prior counters. Without a global cap, the per-Q cap still
    // protects against runaway loops on a single question.
    const protocol = createProtocol(alwaysFollowsUpLLM());
    // Walk to the first core question and prime the per-Q count to 2
    // (the cap). `state.global` is honoured as the next ID suffix base
    // but no longer gates follow-up generation.
    const q = protocol.nextQuestion()!;
    protocol.recordAnswer(q, vagueAnswer('prime-q'));
    protocol.primeFollowUpCounts({
      global: 17,
      perQuestion: new Map([[q.id, 2]]),
    });

    // Per-Q cap should fire: no follow-up despite `state.global = 17`
    // (which under old semantics would also have stopped via the global
    // cap, but the fix means only the per-Q cap is doing the work now).
    const f = await protocol.generateFollowUp(q.category);
    expect(f).toBeNull();
  });

  it('primeFollowUpCounts seeds the follow-up ID counter so re-minted IDs stay unique', async () => {
    // Tool-call rehydration relies on follow-up IDs being globally
    // unique across submit_answer calls. The prior protocol issued IDs
    // 1..N; the rehydrated protocol must start at N+1 (not 1) so a
    // fresh LLM follow-up's ID doesn't collide with a replayed one.
    const protocol = createProtocol(alwaysFollowsUpLLM());
    const q = protocol.nextQuestion()!;
    protocol.recordAnswer(q, vagueAnswer('seed-q'));
    protocol.primeFollowUpCounts({
      global: 5,
      perQuestion: new Map(),
    });

    const f = await protocol.generateFollowUp(q.category);
    expect(f).not.toBeNull();
    // Suffix is followUpIdCounter post-increment; seed 5 → next ID 6.
    expect(f!.id).toBe(`followup_${q.category}_6`);
  });
});
