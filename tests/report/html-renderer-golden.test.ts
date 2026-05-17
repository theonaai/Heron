/**
 * Golden/integration scenarios for renderVerificationReportHtml (AAP-54).
 *
 * Three scenarios validated end-to-end against the SOC-style HTML output:
 *   - HR failure: HR agent + critical HR signal + framework fail
 *   - Clean compliance: all controls verified, score 100, PASSED verdict
 *   - Scan without chain: approval section omitted from TOC + body
 *
 * Snapshots are intentionally NOT used here — the renderer is dense and
 * snapshot churn from minor copy edits would obscure real regressions.
 * Instead each scenario asserts the load-bearing strings: verdict,
 * score, section presence, section absence, key fixture data.
 */
import { describe, it, expect } from 'vitest';
import { renderVerificationReportHtml } from '../../src/report/html-renderer.js';
import type { VerificationReport } from '../../src/verification/types.js';

describe('renderVerificationReportHtml — golden scenarios', () => {
  it('HR failure scenario renders critical HR signal + FAILED verdict', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-17T09:00:00Z',
      agentLabel: 'Recruiter Bot',
      declared: [
        {
          source: 'agent-declaration',
          capturedAt: '2026-05-17T08:55:00Z',
          agent: {
            name: 'Recruiter Bot',
            purpose: 'Screens candidates and auto-rejects below threshold',
            owner: 'TalentOps',
          },
          tools: [{ name: 'screen_candidate' }],
        },
      ],
      sources: [
        {
          sourceId: 'mcp-tools',
          verdict: 'discrepancy',
          diffs: [
            {
              kind: 'extra',
              dimension: 'tool',
              source: 'mcp-tools',
              actual: { name: 'send_rejection_email' },
              severity: 'high',
              details: 'tool present in MCP but not declared',
            },
          ],
          inventory: {
            source: 'mcp-tools',
            capturedAt: '2026-05-17T09:00:00Z',
            tools: [{ name: 'screen_candidate' }, { name: 'send_rejection_email' }],
          },
        },
      ],
      frameworkMapping: {
        generatedAt: '2026-05-17T09:00:01Z',
        controls: [
          {
            framework: 'eu-ai-act',
            controlId: 'Annex III §4',
            controlName: 'High-Risk Employment AI',
            verdict: 'fail',
            severity: 'critical',
            rationale: 'Agent makes employment decisions without documented human oversight.',
            evidenceRefs: [{ kind: 'absence', ref: 'no human-review tool in inventory' }],
          },
          {
            framework: 'aiuc-1',
            controlId: 'B006',
            controlName: 'Scope Limitation',
            verdict: 'fail',
            severity: 'high',
            rationale: 'Extra send_rejection_email tool not declared.',
            evidenceRefs: [{ kind: 'diff', ref: 'diff[0]: extra tool send_rejection_email' }],
          },
        ],
        summary: {
          verifiedCount: 0,
          partialCount: 0,
          failCount: 2,
          unverifiedCount: 0,
          notApplicableCount: 0,
        },
      },
    };
    const html = renderVerificationReportHtml(report, {
      agentLabel: 'Recruiter Bot',
      evaluationId: 'scan-20260517-090000-deadbe',
      generatedAt: '2026-05-17T09:00:00Z',
      hrPack: {
        isHRAgent: true,
        signals: [
          {
            signalId: 'auto-rejection-without-disclosure',
            name: 'Auto-rejection without disclosure',
            verdict: 'detected',
            severity: 'critical',
            rationale: 'Agent purpose mentions auto-reject without disclosing human review.',
            evidenceRefs: [{ kind: 'declared', ref: 'agent.purpose' }],
            recommendation: 'Document human-review checkpoint in agent.purpose.',
          },
        ],
        summary: { detectedCount: 1, notDetectedCount: 0, unverifiedCount: 0, criticalDetected: 1, highDetected: 0 },
      },
    });

    expect(html).toContain('FAILED');
    expect(html).toContain('Recruiter Bot');
    expect(html).toContain('HR Vertical Signals');
    expect(html).toContain('Auto-rejection without disclosure');
    expect(html).toContain('Annex III §4');
    expect(html).toContain('High-Risk Employment AI');
    expect(html).toContain('Document human-review checkpoint');
    expect(html).toContain('sev-critical');
  });

  it('Clean-compliance scenario renders PASSED + 100.00 + no findings', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-17T10:00:00Z',
      agentLabel: 'Notes Summariser',
      declared: [
        {
          source: 'agent-declaration',
          capturedAt: '2026-05-17T09:50:00Z',
          agent: { name: 'Notes Summariser', purpose: 'Summarises meeting notes', owner: 'PMs' },
          tools: [{ name: 'fetch_notes' }],
        },
      ],
      sources: [
        {
          sourceId: 'mcp-tools',
          verdict: 'verified',
          diffs: [],
          inventory: {
            source: 'mcp-tools',
            capturedAt: '2026-05-17T10:00:00Z',
            tools: [{ name: 'fetch_notes' }],
          },
        },
      ],
      frameworkMapping: {
        generatedAt: '2026-05-17T10:00:01Z',
        controls: [
          {
            framework: 'aiuc-1', controlId: 'A003', controlName: 'Limit Data Access',
            verdict: 'verified', severity: 'medium', rationale: 'All declared scopes match actual.', evidenceRefs: [],
          },
          {
            framework: 'aiuc-1', controlId: 'D003', controlName: 'Data Minimisation',
            verdict: 'verified', severity: 'low', rationale: 'No excess tools.', evidenceRefs: [],
          },
          {
            framework: 'gdpr', controlId: 'Article 5', controlName: 'Data Minimisation',
            verdict: 'verified', severity: 'medium', rationale: 'Same as above.', evidenceRefs: [],
          },
        ],
        summary: {
          verifiedCount: 3, partialCount: 0, failCount: 0, unverifiedCount: 0, notApplicableCount: 0,
        },
      },
    };
    const html = renderVerificationReportHtml(report, {
      agentLabel: 'Notes Summariser',
      evaluationId: 'scan-20260517-100000-aaaaaa',
      generatedAt: '2026-05-17T10:00:00Z',
    });
    expect(html).toContain('PASSED');
    expect(html).toContain('100.00');
    expect(html).toContain('No discrepancies detected');
    expect(html).toContain('No remediation actions required');
    // No HR section in TOC for non-HR agent
    expect(html).not.toContain('HR Vertical Signals');
    // No approval section for scan without chain
    expect(html).not.toContain('Approval Audit Trail');
  });

  it('Scan-without-chain omits approval section from TOC and body', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-17T11:00:00Z',
      agentLabel: 'Plain Agent',
      declared: [],
      sources: [{
        sourceId: 'mcp-tools',
        verdict: 'verified',
        diffs: [],
        inventory: { source: 'mcp-tools', capturedAt: '2026-05-17T11:00:00Z', tools: [] },
      }],
    };
    const html = renderVerificationReportHtml(report, {
      agentLabel: 'Plain Agent',
      evaluationId: 'scan-xyz',
      generatedAt: '2026-05-17T11:00:00Z',
    });
    expect(html).not.toContain('Approval Audit Trail');
    expect(html).not.toContain('sec-approval');
    // TOC must still have Executive Summary + Conclusion + Appendix
    expect(html).toContain('Executive Summary');
    expect(html).toContain('Conclusion');
    expect(html).toContain('Appendix');
  });
});
