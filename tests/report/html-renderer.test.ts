/**
 * Tests for `src/report/html-renderer.ts` — AAP-54.
 *
 * Covers:
 *   - computeComplianceScore: PASSED / PARTIAL / FAILED / no framework mapping
 *   - HTML escape on user-controlled strings
 *   - Severity pill class mapping
 *   - Cover renders evaluation id + timestamp + score + verdict
 *   - TOC conditional sections (HR / approval-chain)
 *   - End-to-end integration: full VerificationReport produces well-formed HTML
 *   - Backwards compat: missing frameworkMapping → FAILED + fallback
 *   - Missing approvalChain → section omitted
 *   - HR agent present → HR section rendered
 *   - Non-HR agent → HR section omitted
 */
import { describe, it, expect } from 'vitest';
import {
  computeComplianceScore,
  renderVerificationReportHtml,
  severityPillClass,
} from '../../src/report/html-renderer.js';
import type { VerificationReport } from '../../src/verification/types.js';
import type {
  FrameworkControl,
  FrameworkMapping,
} from '../../src/verification/frameworks/types.js';

function makeMapping(controls: FrameworkControl[]): FrameworkMapping {
  const summary = {
    verifiedCount: controls.filter((c) => c.verdict === 'verified').length,
    partialCount: controls.filter((c) => c.verdict === 'partial').length,
    unverifiedCount: controls.filter((c) => c.verdict === 'unverified').length,
    failCount: controls.filter((c) => c.verdict === 'fail').length,
    notApplicableCount: controls.filter((c) => c.verdict === 'not-applicable').length,
  };
  return {
    generatedAt: '2026-05-17T12:00:00Z',
    controls,
    summary,
  };
}

function ctrl(
  partial: Partial<FrameworkControl> & { verdict: FrameworkControl['verdict'] },
): FrameworkControl {
  return {
    framework: 'aiuc-1',
    controlId: 'A001',
    controlName: 'Sample Control',
    rationale: 'sample',
    evidenceRefs: [],
    severity: 'medium',
    ...partial,
  };
}

function makeReport(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    capturedAt: '2026-05-17T12:00:00Z',
    agentLabel: 'TestAgent',
    declared: [
      {
        source: 'interview',
        capturedAt: '2026-05-17T11:00:00Z',
        tools: [{ name: 'tool_a' }],
        scopes: [{ service: 'greenhouse', scope: 'applications:read' }],
      },
    ],
    sources: [
      {
        sourceId: 'mcp-tools',
        verdict: 'verified',
        diffs: [],
        inventory: {
          source: 'mcp-tools',
          capturedAt: '2026-05-17T12:00:00Z',
          tools: [{ name: 'tool_a' }],
        },
      },
    ],
    ...overrides,
  };
}

describe('computeComplianceScore', () => {
  it('returns FAILED with score 0 when frameworkMapping is missing', () => {
    const report = makeReport();
    const r = computeComplianceScore(report);
    expect(r.score).toBe(0);
    expect(r.verdict).toBe('FAILED');
    expect(r.threshold).toBe(70);
  });

  it('returns FAILED with score 0 when total evaluable controls is zero', () => {
    const report = makeReport({
      frameworkMapping: makeMapping([
        ctrl({ verdict: 'not-applicable' }),
        ctrl({ verdict: 'not-applicable', controlId: 'A002' }),
      ]),
    });
    const r = computeComplianceScore(report);
    expect(r.score).toBe(0);
    expect(r.verdict).toBe('FAILED');
  });

  it('returns PASSED when all controls verified (100% score)', () => {
    const report = makeReport({
      frameworkMapping: makeMapping([
        ctrl({ verdict: 'verified', controlId: 'A001' }),
        ctrl({ verdict: 'verified', controlId: 'A002' }),
        ctrl({ verdict: 'verified', controlId: 'A003' }),
        ctrl({ verdict: 'verified', controlId: 'A004' }),
      ]),
    });
    const r = computeComplianceScore(report);
    expect(r.score).toBe(100);
    expect(r.verdict).toBe('PASSED');
  });

  it('returns PARTIAL when one high-severity fail but score >= 70', () => {
    const controls: FrameworkControl[] = [];
    for (let i = 0; i < 10; i++) {
      controls.push(ctrl({ verdict: 'verified', controlId: `A${i.toString().padStart(3, '0')}` }));
    }
    // 8 verified + 1 partial + 1 high-sev fail
    controls.push(ctrl({ verdict: 'partial', controlId: 'B001', severity: 'medium' }));
    controls.push(ctrl({ verdict: 'fail', controlId: 'B002', severity: 'high' }));
    const report = makeReport({ frameworkMapping: makeMapping(controls) });
    const r = computeComplianceScore(report);
    // 10 verified + 0.5 * 1 partial = 10.5 / 12 = 87.5
    expect(r.score).toBeGreaterThan(70);
    // 0 critical, 1 high fail → not PASSED (requires 0 high too), should be PARTIAL
    expect(r.verdict).toBe('PARTIAL');
  });

  it('returns FAILED when any critical fail exists', () => {
    const report = makeReport({
      frameworkMapping: makeMapping([
        ctrl({ verdict: 'verified', controlId: 'A001' }),
        ctrl({ verdict: 'verified', controlId: 'A002' }),
        ctrl({ verdict: 'fail', controlId: 'A003', severity: 'critical' }),
      ]),
    });
    const r = computeComplianceScore(report);
    expect(r.verdict).toBe('FAILED');
  });

  it('returns FAILED when more than 3 high-sev fails', () => {
    const controls: FrameworkControl[] = [];
    for (let i = 0; i < 10; i++) {
      controls.push(ctrl({ verdict: 'verified', controlId: `V${i}` }));
    }
    controls.push(ctrl({ verdict: 'fail', controlId: 'H1', severity: 'high' }));
    controls.push(ctrl({ verdict: 'fail', controlId: 'H2', severity: 'high' }));
    controls.push(ctrl({ verdict: 'fail', controlId: 'H3', severity: 'high' }));
    controls.push(ctrl({ verdict: 'fail', controlId: 'H4', severity: 'high' }));
    const report = makeReport({ frameworkMapping: makeMapping(controls) });
    const r = computeComplianceScore(report);
    expect(r.verdict).toBe('FAILED');
  });

  it('rounds score to two decimals', () => {
    const controls: FrameworkControl[] = [];
    for (let i = 0; i < 7; i++) {
      controls.push(ctrl({ verdict: 'verified', controlId: `V${i}` }));
    }
    // 7 verified / 7 total = 100; we need a non-round number
    controls.push(ctrl({ verdict: 'partial', controlId: 'P1' })); // 7 + 0.5 / 8 = 93.75
    const report = makeReport({ frameworkMapping: makeMapping(controls) });
    const r = computeComplianceScore(report);
    expect(r.score).toBe(93.75);
  });
});

describe('severityPillClass', () => {
  it('maps each severity to its class', () => {
    expect(severityPillClass('critical')).toContain('sev-critical');
    expect(severityPillClass('high')).toContain('sev-high');
    expect(severityPillClass('medium')).toContain('sev-medium');
    expect(severityPillClass('low')).toContain('sev-low');
    expect(severityPillClass('info')).toContain('sev-info');
  });

  it('falls back to sev-neutral for unknown', () => {
    expect(severityPillClass('whatever')).toContain('sev-neutral');
  });
});

describe('renderVerificationReportHtml — escaping', () => {
  it('escapes agent label, owner, purpose', () => {
    const report = makeReport({
      agentLabel: '<script>alert(1)</script>',
      declared: [
        {
          source: 'interview',
          capturedAt: '2026-05-17T11:00:00Z',
          agent: {
            name: 'Hostile<Agent>',
            owner: 'evil"owner',
            purpose: 'Do `bad` & worse',
          },
        },
      ],
    });
    const html = renderVerificationReportHtml(report, {
      agentLabel: '<script>alert(1)</script>',
      evaluationId: 'eval-001',
      generatedAt: '2026-05-17T12:00:00Z',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Hostile&lt;Agent&gt;');
    expect(html).toContain('evil&quot;owner');
    expect(html).toContain('Do `bad` &amp; worse');
  });

  it('escapes tool names and scope strings in appendix', () => {
    const report = makeReport({
      sources: [
        {
          sourceId: 'mcp-tools',
          verdict: 'verified',
          diffs: [],
          inventory: {
            source: 'mcp-tools',
            capturedAt: '2026-05-17T12:00:00Z',
            tools: [{ name: '<img src=x>', description: 'a&b' }],
          },
        },
      ],
    });
    const html = renderVerificationReportHtml(report, {
      agentLabel: 'X',
      evaluationId: 'eval-002',
      generatedAt: '2026-05-17T12:00:00Z',
    });
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain('a&amp;b');
  });
});

describe('renderVerificationReportHtml — cover + TOC', () => {
  it('cover shows evaluation id + timestamp + verdict + score', () => {
    const report = makeReport({
      frameworkMapping: makeMapping([
        ctrl({ verdict: 'verified', controlId: 'A001' }),
        ctrl({ verdict: 'verified', controlId: 'A002' }),
      ]),
    });
    const html = renderVerificationReportHtml(report, {
      agentLabel: 'My Agent',
      evaluationId: 'scan-20260517-120000-abc123',
      generatedAt: '2026-05-17T12:00:00Z',
    });
    expect(html).toContain('scan-20260517-120000-abc123');
    expect(html).toContain('2026-05-17T12:00:00Z');
    expect(html).toContain('PASSED');
    expect(html).toContain('100');
    expect(html).toContain('70.00'); // threshold
  });

  it('TOC includes HR section ONLY if hrPackResult.isHRAgent', () => {
    // Non-HR agent
    const reportNoHr = makeReport();
    const htmlNoHr = renderVerificationReportHtml(reportNoHr, {
      agentLabel: 'X',
      evaluationId: 'eval',
      generatedAt: '2026-05-17T12:00:00Z',
    });
    expect(htmlNoHr).not.toContain('HR Vertical Signals');

    // With HR pack — passed via opts
    const reportHr = makeReport();
    const htmlHr = renderVerificationReportHtml(reportHr, {
      agentLabel: 'X',
      evaluationId: 'eval',
      generatedAt: '2026-05-17T12:00:00Z',
      hrPack: {
        isHRAgent: true,
        signals: [
          {
            signalId: 'auto-rejection-without-disclosure',
            name: 'Auto-rejection without disclosure',
            verdict: 'detected',
            severity: 'high',
            rationale: 'agent purpose mentions rejection without human review',
            evidenceRefs: [{ kind: 'absence', ref: 'no human-review mention' }],
            recommendation: 'Document human-review step in purpose',
          },
        ],
        summary: {
          detectedCount: 1,
          notDetectedCount: 0,
          unverifiedCount: 0,
          criticalDetected: 0,
          highDetected: 1,
        },
      },
    });
    expect(htmlHr).toContain('HR Vertical Signals');
    expect(htmlHr).toContain('Auto-rejection without disclosure');
  });

  it('TOC includes Approval Audit Trail ONLY if approvalChain present', () => {
    // No chain
    const reportNo = makeReport();
    const htmlNo = renderVerificationReportHtml(reportNo, {
      agentLabel: 'X',
      evaluationId: 'eval',
      generatedAt: '2026-05-17T12:00:00Z',
    });
    expect(htmlNo).not.toContain('Approval Audit Trail');

    // With chain
    const reportWith = makeReport({
      approvalChain: {
        chain: {
          agentId: 'agent-1',
          agentLabel: 'agent label',
          createdAt: '2026-05-17T10:00:00Z',
          entries: [
            {
              action: 'declared',
              actor: { name: 'Alice', role: 'Owner', email: 'a@example.com' },
              timestamp: '2026-05-17T10:00:00Z',
              evidenceRefs: ['interview-2026-05-17'],
              comment: 'Initial declaration',
            },
            {
              action: 'approved',
              actor: { name: 'Bob', role: 'DPO' },
              timestamp: '2026-05-17T11:00:00Z',
              prevHash: 'abcdef1234',
            },
          ],
        },
        integrity: { ok: true },
      },
    });
    const htmlWith = renderVerificationReportHtml(reportWith, {
      agentLabel: 'X',
      evaluationId: 'eval',
      generatedAt: '2026-05-17T12:00:00Z',
    });
    expect(htmlWith).toContain('Approval Audit Trail');
    expect(htmlWith).toContain('Alice');
    expect(htmlWith).toContain('Bob');
  });
});

describe('renderVerificationReportHtml — integration', () => {
  it('produces well-formed HTML with full structure', () => {
    const report = makeReport({
      frameworkMapping: makeMapping([
        ctrl({
          framework: 'aiuc-1',
          controlId: 'A003',
          controlName: 'Limit Data Access',
          verdict: 'verified',
          severity: 'high',
          rationale: 'Declared scopes match actual scopes.',
        }),
        ctrl({
          framework: 'eu-ai-act',
          controlId: 'Article 14',
          controlName: 'Human Oversight',
          verdict: 'partial',
          severity: 'medium',
          rationale: 'Human-review checkpoint partially documented.',
        }),
      ]),
      approvalChain: {
        chain: {
          agentId: 'agent-1',
          createdAt: '2026-05-17T10:00:00Z',
          entries: [
            {
              action: 'declared',
              actor: { name: 'Alice', role: 'Owner' },
              timestamp: '2026-05-17T10:00:00Z',
            },
          ],
        },
        integrity: { ok: true },
      },
    });
    const html = renderVerificationReportHtml(report, {
      agentLabel: 'Full Agent',
      evaluationId: 'eval-001',
      generatedAt: '2026-05-17T12:00:00Z',
    });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html.endsWith('</html>')).toBe(true);
    expect(html).toContain('<html');
    expect(html).toContain('Heron');
    expect(html).toContain('Executive Summary');
    expect(html).toContain('Agent Specification');
    expect(html).toContain('Verification Results');
    expect(html).toContain('Compliance Framework Mapping');
    expect(html).toContain('Approval Audit Trail');
    expect(html).toContain('Conclusion');
    expect(html).toContain('Appendix');
    expect(html).toContain('AIUC-1');
    expect(html).toContain('Limit Data Access');
  });

  it('FAILED verdict + fallback text when frameworkMapping missing', () => {
    const report = makeReport();
    const html = renderVerificationReportHtml(report, {
      agentLabel: 'X',
      evaluationId: 'eval',
      generatedAt: '2026-05-17T12:00:00Z',
    });
    expect(html).toContain('FAILED');
    // Exec summary fallback when no framework mapping
    expect(html).toMatch(/no framework mapping|not evaluated|verification sources/i);
  });

  it('emits one Google Fonts link and inline CSS', () => {
    const report = makeReport();
    const html = renderVerificationReportHtml(report, {
      agentLabel: 'X',
      evaluationId: 'eval',
      generatedAt: '2026-05-17T12:00:00Z',
    });
    // Exactly one fonts.googleapis.com stylesheet link
    const cssLinkCount = (html.match(/fonts\.googleapis\.com\/css2/g) || []).length;
    expect(cssLinkCount).toBe(1);
    // Inline <style> block with our CSS
    expect(html).toContain('.heron-report');
  });
});
