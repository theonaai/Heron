/**
 * Tests for HR_INTERVIEW_QUESTIONS constant (AAP-51).
 */

import { describe, it, expect } from 'vitest';

import { HR_INTERVIEW_QUESTIONS } from '../../../src/verification/hr-pack/interview-questions.js';

describe('HR_INTERVIEW_QUESTIONS', () => {
  it('exports exactly 7 questions', () => {
    expect(HR_INTERVIEW_QUESTIONS).toHaveLength(7);
  });

  it('each question has stable id, topic, question, expectedScopes', () => {
    for (const q of HR_INTERVIEW_QUESTIONS) {
      expect(q.id).toMatch(/^hr-\d{3}$/);
      expect(typeof q.topic).toBe('string');
      expect(q.topic.length).toBeGreaterThan(0);
      expect(typeof q.question).toBe('string');
      expect(q.question.length).toBeGreaterThan(0);
      expect(Array.isArray(q.expectedScopes)).toBe(true);
    }
  });

  it('ids are unique', () => {
    const ids = HR_INTERVIEW_QUESTIONS.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('topics cover the 7 HR risk categories', () => {
    const topics = HR_INTERVIEW_QUESTIONS.map((q) => q.topic);
    expect(topics).toContain('rejection-disclosure');
    expect(topics).toContain('salary-bands');
    expect(topics).toContain('do-not-contact');
    expect(topics).toContain('scoring');
    expect(topics).toContain('sub-agents');
    expect(topics).toContain('pii-logging');
    expect(topics).toContain('human-oversight');
  });
});
