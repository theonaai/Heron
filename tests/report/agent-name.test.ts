/**
 * #26 A1 — tests for the shared agent display-name extraction
 * (`src/report/agent-name.ts`).
 *
 * This logic was lifted out of `MinimalReportView.tsx` so the storage layer
 * can stamp the same name onto `meta.extractedAgentName`. The tests lock the
 * behavior the dashboard depends on — most importantly that the demo
 * session's Codex runtime name resolves to the Q1 "MVP Edu Content Agent",
 * not "Codex".
 */

import { describe, it, expect } from 'vitest';

import {
  extractProjectName,
  extractFromAgentPurpose,
  humanizeKebab,
  isUsefulName,
  type TranscriptEntryLike,
} from '../../src/report/agent-name.js';

describe('agent-name extraction', () => {
  describe('extractProjectName — source precedence', () => {
    it('uses the Q1 "Project/product name:" answer when agentPurpose has no clean noun phrase', () => {
      // The demo session: agentPurpose starts "The agent is an educational
      // content generation and publishing pipeline that …" — Pattern A is
      // blocked by the "and" lookahead, so extraction falls through to Q1.
      const agentPurpose =
        'The agent is an educational content generation and publishing pipeline that processes lesson/topic rows, generates Russian lectures, and stores them in Google Drive.';
      const transcript: TranscriptEntryLike[] = [
        {
          category: 'purpose',
          question: '1. Project/product name …',
          answer:
            '1. Project/product name: MVP Edu Content Agent, in workspace /Users/ilaivanov/Codex/Codex3.\n2. Owner: local Codex desktop user.',
        },
      ];
      const { name, isFallback } = extractProjectName(transcript, 'Codex', agentPurpose);
      expect(name).toBe('MVP Edu Content Agent');
      expect(isFallback).toBe(false);
    });

    it('prefers a clean agentPurpose noun phrase over the Q1 answer', () => {
      const agentPurpose = 'The Invoice Reconciliation pipeline matches payments to invoices nightly.';
      const transcript: TranscriptEntryLike[] = [
        {
          category: 'purpose',
          question: '1. …',
          answer: '1. Project/product name: Something Else Entirely',
        },
      ];
      const { name, isFallback } = extractProjectName(transcript, 'Codex', agentPurpose);
      expect(name).toBe('Invoice Reconciliation Pipeline');
      expect(isFallback).toBe(false);
    });

    it('falls back to the runtime name (isFallback=true) when nothing extracts', () => {
      const { name, isFallback } = extractProjectName(
        [{ category: 'purpose', answer: 'no structured name here' }],
        'Codex desktop coding agent',
        'short prose with no anchor',
      );
      expect(name).toBe('Codex desktop coding agent');
      expect(isFallback).toBe(true);
    });

    it('does NOT pin the uninformative runtime name as a real (non-fallback) result', () => {
      // No transcript, no purpose — pure fallback.
      const { name, isFallback } = extractProjectName(undefined, 'Codex', undefined);
      expect(name).toBe('Codex');
      expect(isFallback).toBe(true);
    });

    it('humanizes a backticked repo identifier from the Q1 answer (sub-pattern 2a)', () => {
      const transcript: TranscriptEntryLike[] = [
        {
          category: 'purpose',
          answer:
            'Codex desktop GPT-5 coding agent operating in workspace /tmp/x, whose repository is `mvp-edu-content-agent`.',
        },
      ];
      const { name, isFallback } = extractProjectName(transcript, 'Codex', undefined);
      expect(name).toBe('MVP Educational Content Agent');
      expect(isFallback).toBe(false);
    });
  });

  describe('extractFromAgentPurpose', () => {
    it('matches the outermost article-anchored noun phrase', () => {
      expect(extractFromAgentPurpose('A customer support triage system that routes tickets.')).toBe(
        'Customer Support Triage System',
      );
    });

    it('returns null when the purpose is the demo "… and publishing pipeline" shape (blocked by "and")', () => {
      expect(
        extractFromAgentPurpose(
          'The agent is an educational content generation and publishing pipeline that …',
        ),
      ).toBeNull();
    });

    it('returns null for empty / anchorless prose', () => {
      expect(extractFromAgentPurpose('')).toBeNull();
      expect(extractFromAgentPurpose('does stuff')).toBeNull();
    });
  });

  describe('humanizeKebab', () => {
    it('uppercases known short tokens and expands edu', () => {
      expect(humanizeKebab('mvp-edu-content-agent')).toBe('MVP Educational Content Agent');
      expect(humanizeKebab('api-gateway')).toBe('API Gateway');
    });
  });

  describe('isUsefulName', () => {
    it('rejects runtime-noise phrases', () => {
      expect(isUsefulName('Codex desktop coding agent')).toBe(false);
      expect(isUsefulName('the agent')).toBe(false);
      expect(isUsefulName('coding agent')).toBe(false);
    });
    it('accepts a real product name', () => {
      expect(isUsefulName('MVP Edu Content Agent')).toBe(true);
    });
    it('rejects too-short / too-long strings', () => {
      expect(isUsefulName('ab')).toBe(false);
      expect(isUsefulName('x'.repeat(81))).toBe(false);
    });
  });
});
