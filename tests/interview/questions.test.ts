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

  it('AAP-92: context_anchor (Q01) asks about the current task and starting context, and tells fresh-chat agents to say so', () => {
    // Pre-AAP-92 Q01 prompted "what you specifically do in this project",
    // which fresh-chat Codex sessions interpreted as their general
    // capability surface (no current task in context). The rewrite asks
    // about the SPECIFIC current task plus the starting context, and
    // tells the agent to declare a fresh chat rather than synthesise.
    const q01 = CORE_QUESTIONS.find((q) => q.id === 'context_anchor');
    expect(q01).toBeDefined();
    expect(q01!.text).toMatch(
      /SPECIFIC task or workflow the user has asked you to do in this conversation right now/,
    );
    expect(q01!.text).toMatch(
      /What context \(files, folder, prior conversation\) did you have when you started this task\?/,
    );
    expect(q01!.text).toMatch(
      /If you are in a fresh chat with no prior context, say so explicitly\. Do not synthesize a generic capability description\./,
    );
    // The legacy phrasing must be gone — leaving it in would re-open
    // the same fresh-chat capability-list answer the audit hit.
    expect(q01!.text).not.toMatch(/what you specifically do in this project/);
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
