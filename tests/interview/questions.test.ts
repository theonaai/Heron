import { describe, it, expect } from 'vitest';
import { getAllQuestionsSorted, getQuestionsByCategory, CORE_QUESTIONS } from '../../src/interview/questions.js';

describe('questions', () => {
  it('has questions for all categories', () => {
    const categories = new Set(CORE_QUESTIONS.map(q => q.category));
    expect(categories).toContain('purpose');
    expect(categories).toContain('data');
    expect(categories).toContain('frequency');
    expect(categories).toContain('access');
    expect(categories).toContain('writes');
  });

  it('getAllQuestionsSorted returns questions in priority order', () => {
    const questions = getAllQuestionsSorted();
    for (let i = 1; i < questions.length; i++) {
      expect(questions[i].priority).toBeGreaterThanOrEqual(questions[i - 1].priority);
    }
  });

  it('getQuestionsByCategory filters correctly', () => {
    const purposeQuestions = getQuestionsByCategory('purpose');
    expect(purposeQuestions.length).toBeGreaterThan(0);
    expect(purposeQuestions.every(q => q.category === 'purpose')).toBe(true);
  });

  it('each question has unique id', () => {
    const ids = CORE_QUESTIONS.map(q => q.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('AAP-94: context_anchor (Q01) asks about the default deployment task and instructs the agent to inspect the workspace', () => {
    // AAP-92 moved the prompt away from "what you specifically do in this project"
    // (which produced generic capability answers from fresh-chat Codex sessions).
    // AAP-94 takes the next step: the AAP-92 wording asked about the task the
    // user asked you to do IN THIS CHAT — which then surfaces the audit itself,
    // a recursive and useless answer. We now ask about the agent's DEPLOYMENT
    // task — what it does for its normal users, regardless of who invoked this
    // audit. The agent is instructed to actively inspect workspace files, not
    // synthesise from generic capability knowledge, and to admit there is no
    // ongoing task if inspection finds none.
    const q01 = CORE_QUESTIONS.find((q) => q.id === 'context_anchor');
    expect(q01).toBeDefined();
    expect(q01!.text).toMatch(
      /default \/ ongoing task this workspace exists for/,
    );
    expect(q01!.text).toMatch(
      /what you do for your normal users, NOT for whoever invoked this audit/,
    );
    expect(q01!.text).toMatch(
      /Inspect workspace files, project structure, and recent activity/,
    );
    expect(q01!.text).toMatch(
      /If no ongoing task is found after inspecting, say so explicitly — do not invent one/,
    );
    expect(q01!.text).toMatch(/Do not synthesize a generic capability description\./);
    // Pre-AAP-92 / pre-AAP-94 phrasings must be gone.
    expect(q01!.text).not.toMatch(/what you specifically do in this project/);
    expect(q01!.text).not.toMatch(/the user has asked you to do in this conversation right now/);
  });

  it('AAP-82: includes the mcp_tools_forward_directive after mcp_a2a_auth', () => {
    const sorted = getAllQuestionsSorted();
    const q14Index = sorted.findIndex((q) => q.id === 'mcp_a2a_auth');
    const directiveIndex = sorted.findIndex((q) => q.id === 'mcp_tools_forward_directive');
    expect(q14Index).toBeGreaterThanOrEqual(0);
    expect(directiveIndex).toBe(q14Index + 1);

    // The directive must explicitly name the report_mcp_tools_list tool
    // and the "raw_response" forwarding instruction so the agent's LLM
    // has a concrete tool name + protocol step to follow. This is the
    // load-bearing change for the audit — without these substrings the
    // agent has no signal to call the AAP-82 tool at all.
    const directive = sorted[directiveIndex]!;
    expect(directive.text).toMatch(/report_mcp_tools_list/);
    expect(directive.text).toMatch(/tools\/list/);
    expect(directive.category).toBe('access');
  });
});
