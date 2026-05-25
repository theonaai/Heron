/**
 * AAP-63 — `renderMarkdownReport` Surface 2 sections.
 *
 * Verifies the new structure:
 *   - "## Verification Status" section appears (with "UNVERIFIED" stub
 *     when no verdict is attached or status='unverified', or with a
 *     per-source status table when partial/verified).
 *   - "## Discrepancies" section appears iff verdict.discrepancies is
 *     non-empty.
 *   - Findings section is split into "### Deterministic Findings
 *     (Surface 2)" + "### Self-Reported Findings (Surface 1)" with a
 *     Surface-1 disclaimer.
 *   - Executive Summary table widens from one Risk column to a pair of
 *     Verified Risk + Self-reported Risk columns when verdict is
 *     attached.
 */
import { describe, expect, it } from 'vitest';

import { renderMarkdownReport } from '../../src/report/templates.js';
import type { AuditReport } from '../../src/report/types.js';
import type { DiscoveryFinding } from '../../src/discovery/types.js';
import type { Verdict } from '../../src/verification/verdict.js';

function baseReport(): AuditReport {
  return {
    summary: 'Demo agent that reads invoices.',
    agentPurpose: 'Demo',
    systems: [],
    dataNeeds: [],
    accessAssessment: { claimed: [], actuallyNeeded: [], excessive: [], missing: [] },
    risks: [
      { severity: 'medium', title: 'Self-reported risk', description: 'self-reported description' },
    ],
    recommendations: [],
    overallRiskLevel: 'medium',
    transcript: [
      { question: 'q', answer: 'a', category: 'purpose' },
    ],
    metadata: {
      date: '2026-05-20',
      target: 'demo-agent',
      interviewDuration: 1000,
      questionsAsked: 1,
    },
  };
}

describe('AAP-63 renderMarkdownReport — Surface 2 sections', () => {
  it('emits a "Verification Status: UNVERIFIED" section by default (no verdict attached)', () => {
    const md = renderMarkdownReport(baseReport());
    expect(md).toContain('## Verification Status');
    expect(md).toContain('UNVERIFIED');
    expect(md).toContain('Surface 2');
  });

  it('emits "Verified Risk" + "Self-reported Risk" columns when verdict is attached', () => {
    const verdict: Verdict = {
      status: 'partial',
      deterministicRiskLevel: 'medium',
      interviewRiskLevel: 'high',
      primaryRiskLevel: 'medium',
      primaryRiskSource: 'deterministic',
      discrepancies: [],
    };
    const md = renderMarkdownReport(baseReport(), { verdict });
    expect(md).toContain('Verified Risk');
    expect(md).toContain('Self-reported Risk');
    expect(md).toContain('**MEDIUM**');
    expect(md).toContain('_HIGH (self-report only)_');
  });

  it('renders the Discrepancies section when verdict has discrepancies', () => {
    const verdict: Verdict = {
      status: 'partial',
      deterministicRiskLevel: 'medium',
      interviewRiskLevel: 'low',
      primaryRiskLevel: 'medium',
      primaryRiskSource: 'deterministic',
      discrepancies: [
        {
          claim: 'Interview said no Slack',
          evidence: 'slack: undisclosed EXTRA server with credentials',
          severity: 'high',
        },
      ],
    };
    const md = renderMarkdownReport(baseReport(), { verdict });
    expect(md).toContain('## Discrepancies');
    expect(md).toContain('Interview said no Slack');
    expect(md).toContain('undisclosed EXTRA server');
  });

  it('omits the Discrepancies section when discrepancies is empty', () => {
    const verdict: Verdict = {
      status: 'partial',
      deterministicRiskLevel: 'low',
      primaryRiskLevel: 'low',
      primaryRiskSource: 'deterministic',
      discrepancies: [],
    };
    const md = renderMarkdownReport(baseReport(), { verdict });
    expect(md).not.toContain('## Discrepancies');
  });

  it('splits Findings into Deterministic + Self-Reported subsections', () => {
    const discoveryFindings: DiscoveryFinding[] = [
      {
        kind: 'EXTRA',
        severity: 'HIGH',
        serverName: 'slack',
        runtime: 'codex',
        description: 'undisclosed slack server with credentials',
      },
    ];
    const verdict: Verdict = {
      status: 'partial',
      deterministicRiskLevel: 'medium',
      interviewRiskLevel: 'medium',
      primaryRiskLevel: 'medium',
      primaryRiskSource: 'deterministic',
      discrepancies: [],
    };
    const md = renderMarkdownReport(baseReport(), { verdict, discoveryFindings });
    expect(md).toContain('### Deterministic Findings (Surface 2)');
    expect(md).toContain('### Self-Reported Findings (Surface 1)');
    expect(md).toContain('supplementary narrative');
    expect(md).toContain('slack');
  });

  it('Surface 1 subsection appears even when no Surface 2 findings exist', () => {
    const verdict: Verdict = {
      status: 'partial',
      deterministicRiskLevel: 'low',
      primaryRiskLevel: 'low',
      primaryRiskSource: 'deterministic',
      discrepancies: [],
    };
    const md = renderMarkdownReport(baseReport(), { verdict, discoveryFindings: [] });
    expect(md).toContain('### Deterministic Findings (Surface 2)');
    expect(md).toContain('### Self-Reported Findings (Surface 1)');
    expect(md).toContain('No deterministic findings');
  });

  it('header risk-level label shows "UNVERIFIED" when verdict is unverified', () => {
    const verdict: Verdict = {
      status: 'unverified',
      primaryRiskLevel: 'unverified',
      primaryRiskSource: 'no-evidence',
      discrepancies: [],
    };
    const md = renderMarkdownReport(baseReport(), { verdict });
    expect(md).toContain('UNVERIFIED');
    expect(md).toContain('self-reported only');
  });

  it('AAP-80: header risk-level label shows "Verified" prefix when report.verification.status is verified', () => {
    // AAP-80 — the header label is now driven by
    // `report.verification.status`, not `verdict.primaryRiskSource`.
    // A verified report carries the Verified prefix.
    const verdict: Verdict = {
      status: 'verified',
      deterministicRiskLevel: 'high',
      primaryRiskLevel: 'high',
      primaryRiskSource: 'deterministic',
      discrepancies: [],
    };
    const report = {
      ...baseReport(),
      verification: {
        status: 'verified' as const,
        updatedAt: '2026-05-25T00:00:00.000Z',
      },
    };
    const md = renderMarkdownReport(report, { verdict });
    expect(md).toContain('Risk Level (Verified)');
    expect(md).not.toContain('Risk Level (Partially Verified)');
    expect(md).toContain('HIGH');
  });

  it('AAP-80: header risk-level label shows "Partially Verified" when report.verification.status is partially-verified', () => {
    // AAP-80 — discovery-only runs (the steady state pre-AAP-64) yield
    // a partial verdict and a `'partially-verified'` field. Header
    // label moves with it.
    const verdict: Verdict = {
      status: 'partial',
      deterministicRiskLevel: 'high',
      primaryRiskLevel: 'high',
      primaryRiskSource: 'deterministic',
      discrepancies: [],
    };
    const report = {
      ...baseReport(),
      verification: {
        status: 'partially-verified' as const,
        updatedAt: '2026-05-25T00:00:00.000Z',
      },
    };
    const md = renderMarkdownReport(report, { verdict });
    expect(md).toContain('Risk Level (Partially Verified)');
    expect(md).not.toContain('Risk Level (Verified)');
    expect(md).toContain('HIGH');
    // The amber AAP-80 banner copy is present.
    expect(md).toContain('Partially verified.');
  });

  it('AAP-80: header risk-level label shows "Unverified" when report.verification.status is verification-failed', () => {
    const verdict: Verdict = {
      status: 'unverified',
      primaryRiskLevel: 'unverified',
      primaryRiskSource: 'no-evidence',
      discrepancies: [],
    };
    const report = {
      ...baseReport(),
      verification: {
        status: 'verification-failed' as const,
        reason: 'workspace_hint missing on disk',
        updatedAt: '2026-05-25T00:00:00.000Z',
      },
    };
    const md = renderMarkdownReport(report, { verdict });
    expect(md).toContain('Risk Level (Unverified)');
    // The failure banner copy renders for verification-failed.
    expect(md).toContain('Verification failed.');
  });

  it('AAP-80: header falls back to "UNVERIFIED" when verdict attached but verification field absent (interrogation-only)', () => {
    // Pre-AAP-80 behaviour: a verdict attached AND no
    // `verification.status` on the report produced "Risk Level
    // (Verified)" if the verdict had any Surface 2 evidence. AAP-80
    // routes the label through `verification.status`, so the absence of
    // that field falls back to the interrogation-only copy regardless
    // of the verdict shape — exactly what callers that never patched
    // the report-level field should now see.
    const verdict: Verdict = {
      status: 'partial',
      deterministicRiskLevel: 'medium',
      primaryRiskLevel: 'medium',
      primaryRiskSource: 'deterministic',
      discrepancies: [],
    };
    const md = renderMarkdownReport(baseReport(), { verdict });
    expect(md).toContain('UNVERIFIED');
    expect(md).toContain('self-reported only');
    expect(md).not.toContain('Risk Level (Verified)');
    expect(md).not.toContain('Risk Level (Partially Verified)');
  });

  it('back-compat: report renders without verdict context', () => {
    const md = renderMarkdownReport(baseReport());
    // Legacy single-column risk table still appears.
    expect(md).toContain('| Risk | Systems | Findings |');
    // But the unverified status callout is also there.
    expect(md).toContain('## Verification Status');
  });
});
