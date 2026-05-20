import { describe, it, expect } from 'vitest';
import { renderAnalysisFailedReport } from '../../src/report/templates.js';
import type { QAPair } from '../../src/report/types.js';

const sampleTranscript: QAPair[] = [
  { question: 'What is your purpose?', answer: 'I process invoices', category: 'purpose' },
  { question: 'What systems do you access?', answer: 'SAP ERP and HubSpot CRM', category: 'data' },
  { question: 'What permissions do you have?', answer: 'Full read on SAP, admin on HubSpot', category: 'access' },
];

const baseError = {
  reason: 'parse_failure' as const,
  message: '502 status code (no body)',
  attemptCount: 2,
  occurredAt: '2026-05-20T03:34:03.123Z',
};

describe('renderAnalysisFailedReport (AAP-56)', () => {
  it('starts with a REPORT GENERATION FAILED header', () => {
    const md = renderAnalysisFailedReport(sampleTranscript, {
      sessionId: 'sess-20260520-033403-bce018',
      questionsAsked: 3,
      analysisError: baseError,
    });
    expect(md.startsWith('# Agent Access Audit — REPORT GENERATION FAILED')).toBe(true);
  });

  it('surfaces the failure banner with attempt count, reason, and occurredAt', () => {
    const md = renderAnalysisFailedReport(sampleTranscript, {
      sessionId: 'sess-20260520-033403-bce018',
      questionsAsked: 3,
      analysisError: baseError,
    });
    expect(md).toContain('This audit could not produce a verified report.');
    expect(md).toContain('failed after 2 attempts');
    expect(md).toContain('Reason:');
    expect(md).toContain('502 status code (no body)');
    expect(md).toContain('2026-05-20T03:34:03.123Z');
    expect(md).toContain('Re-run the audit');
  });

  it('renders human-readable reason labels for each failure kind', () => {
    const parse = renderAnalysisFailedReport(sampleTranscript, {
      sessionId: 'sess-20260520-033403-aaaaaa',
      questionsAsked: 3,
      analysisError: { ...baseError, reason: 'parse_failure' },
    });
    expect(parse).toMatch(/LLM response could not be parsed/i);

    const unreachable = renderAnalysisFailedReport(sampleTranscript, {
      sessionId: 'sess-20260520-033403-bbbbbb',
      questionsAsked: 3,
      analysisError: { ...baseError, reason: 'llm_unreachable' },
    });
    expect(unreachable).toMatch(/LLM gateway unreachable/i);

    const unknown = renderAnalysisFailedReport(sampleTranscript, {
      sessionId: 'sess-20260520-033403-cccccc',
      questionsAsked: 3,
      analysisError: { ...baseError, reason: 'unknown' },
    });
    expect(unknown).toMatch(/Unknown analyzer failure/i);
  });

  it('renders the interview transcript verbatim', () => {
    const md = renderAnalysisFailedReport(sampleTranscript, {
      sessionId: 'sess-20260520-033403-bce018',
      questionsAsked: 3,
      analysisError: baseError,
    });
    expect(md).toContain('Interview transcript (3 questions)');
    expect(md).toContain('I process invoices');
    expect(md).toContain('SAP ERP and HubSpot CRM');
    expect(md).toContain('Full read on SAP, admin on HubSpot');
  });

  it('omits LOW/MEDIUM/HIGH risk badges, APPROVE verdicts, and "No risks identified" copy', () => {
    const md = renderAnalysisFailedReport(sampleTranscript, {
      sessionId: 'sess-20260520-033403-bce018',
      questionsAsked: 3,
      analysisError: baseError,
    });
    // The whole point of AAP-56: NEVER render these on the failure path.
    expect(md).not.toMatch(/Risk Level\s*:?\s*LOW/i);
    expect(md).not.toMatch(/Risk Level\s*:?\s*MEDIUM/i);
    expect(md).not.toMatch(/Risk Level\s*:?\s*HIGH/i);
    expect(md).not.toContain('APPROVE WITH CONDITIONS');
    expect(md).not.toContain('APPROVE WITHOUT CONDITIONS');
    expect(md).not.toContain('_No risks identified._');
    expect(md).not.toContain('No risks identified');
  });

  it('does NOT render Findings, Compliance, or Recommendations sections', () => {
    const md = renderAnalysisFailedReport(sampleTranscript, {
      sessionId: 'sess-20260520-033403-bce018',
      questionsAsked: 3,
      analysisError: baseError,
    });
    expect(md).not.toMatch(/^## Findings/m);
    expect(md).not.toMatch(/^## Compliance/m);
    expect(md).not.toMatch(/^## Verdict/m);
    expect(md).not.toMatch(/^## Recommendations/m);
    expect(md).not.toMatch(/^## Regulatory/m);
  });

  it('ends with an intentional-omission footer', () => {
    const md = renderAnalysisFailedReport(sampleTranscript, {
      sessionId: 'sess-20260520-033403-bce018',
      questionsAsked: 3,
      analysisError: baseError,
    });
    expect(md).toMatch(/_End of report\..*intentionally omitted/);
  });

  it('handles an empty transcript', () => {
    const md = renderAnalysisFailedReport([], {
      sessionId: 'sess-20260520-033403-empty1',
      questionsAsked: 0,
      analysisError: baseError,
    });
    expect(md).toContain('Interview transcript (0 questions)');
    expect(md).not.toContain('APPROVE');
  });

  it('includes the agentName in the header when provided', () => {
    const md = renderAnalysisFailedReport(sampleTranscript, {
      sessionId: 'sess-20260520-033403-bce018',
      agentName: 'codex.app',
      questionsAsked: 3,
      analysisError: baseError,
    });
    expect(md).toContain('codex.app');
  });
});
