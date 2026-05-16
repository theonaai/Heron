/**
 * Tests for `heron interview hr` (AAP-51).
 */

import { describe, it, expect } from 'vitest';

import { runInterview } from '../../src/commands/interview.js';
import { HR_INTERVIEW_QUESTIONS } from '../../src/verification/hr-pack/interview-questions.js';

describe('heron interview hr', () => {
  it('prints all 7 HR interview questions', () => {
    const lines: string[] = [];
    runInterview({ vertical: 'hr', out: (line) => lines.push(line) });

    const out = lines.join('\n');
    expect(out).toContain('Heron — HR Vertical Interview Questions');
    for (const q of HR_INTERVIEW_QUESTIONS) {
      expect(out).toContain(q.id);
      expect(out).toContain(q.topic);
      // The question text should appear (truncated check on first 30 chars)
      expect(out).toContain(q.question.slice(0, 30));
    }
  });

  it('refuses unknown verticals', () => {
    // @ts-expect-error — testing runtime rejection of bad input
    expect(() => runInterview({ vertical: 'sales', out: () => {} })).toThrow(
      /Unsupported interview vertical/,
    );
  });
});
