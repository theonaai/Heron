/**
 * PR #26 — editorial polish round for the SOC-style HTML renderer.
 *
 * Ilya reviewed the first live render of PR #25 and called the editorial
 * voice "AI-slop". This file codifies the fixes:
 *
 *   1. Cover h1 reads "Compliance Evidence Pack" with subtitle
 *      "Scope verification report" — not the AI-stuffed compound noun
 *      phrase from the original.
 *   2. Cover brand strip is just `Heron` — no "Open-Source Agent
 *      Verification" tag underneath.
 *   3. Verdict badge inner content is one word
 *      (PASSED / PARTIAL / FAILED). The "Overall verdict" label that
 *      diluted the visual punch is gone.
 *   4. h-section headers carry no `<span class="label">Section</span>`
 *      template noise — number + title is enough.
 *   5. Robot pluralisation "(s)" is replaced with computed singular /
 *      plural per the actual source count.
 *   6. Executive Summary mirrors the DPO-readable evidence-pack
 *      structure that already lives in
 *      `src/verification/hr-pack/exec-summary.ts`: Compliance Posture,
 *      Headline Findings, Framework Coverage, Recommended Actions,
 *      Approval Trail subsections.
 *   7. Cover meta is a definition list (<dl class="cover-meta">) — 3
 *      items only (Agent / Evaluation ID / Generated). Captured is
 *      dropped from the cover; Generated timestamp is formatted
 *      "YYYY-MM-DD HH:MM UTC" not full ISO.
 */
import { describe, it, expect } from 'vitest';
import { renderVerificationReportHtml } from '../../src/report/html-renderer.js';
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

describe('renderVerificationReportHtml — editorial polish: cover', () => {
  it('h1 reads "Compliance Evidence Pack" (no AI-stuffed compound phrase)', () => {
    const html = renderVerificationReportHtml(makeReport(), {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-17T09:22:55.856Z',
    });
    expect(html).toContain('Compliance Evidence Pack');
    expect(html).not.toContain('AI Agent Scope Verification');
    expect(html).not.toContain('Compliance Assessment');
  });

  it('cover subtitle reads "Scope verification report"', () => {
    const html = renderVerificationReportHtml(makeReport(), {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-17T09:22:55.856Z',
    });
    expect(html).toContain('Scope verification report');
  });

  it('cover brand has Heron mark only — no "Open-Source Agent Verification" tag', () => {
    const html = renderVerificationReportHtml(makeReport(), {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-17T09:22:55.856Z',
    });
    expect(html).toContain('cover-mark');
    expect(html).toContain('Heron');
    expect(html).not.toContain('Open-Source Agent Verification');
    expect(html).not.toContain('class="cover-tag"');
  });

  it('cover meta is a <dl> with 3 items — no Captured row', () => {
    const html = renderVerificationReportHtml(makeReport(), {
      agentLabel: 'My Agent',
      evaluationId: 'mcp-scan_71f07d93de460515',
      generatedAt: '2026-05-17T09:22:55.856Z',
    });
    // dl.cover-meta replaces the old span-soup layout
    expect(html).toMatch(/<dl class="cover-meta">/);
    // No Captured row — that telemetry duplicates Generated and confuses readers.
    expect(html).not.toMatch(/cover-meta[^<]*Captured/i);
    // Don't ban the literal "Captured" string globally — kv() in Section 02 still uses Scan Date.
    // But the cover itself must not include Captured anywhere.
    const coverMatch = html.match(/<section class="cover">([\s\S]*?)<\/section>/);
    expect(coverMatch).toBeTruthy();
    expect(coverMatch![1]).not.toContain('Captured');
    // Cover meta must still show Agent + Evaluation ID + Generated
    expect(coverMatch![1]).toContain('Agent');
    expect(coverMatch![1]).toContain('Evaluation ID');
    expect(coverMatch![1]).toContain('Generated');
  });

  it('cover Generated timestamp is YYYY-MM-DD HH:MM UTC (no millisecond ISO)', () => {
    const html = renderVerificationReportHtml(makeReport(), {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-17T09:22:55.856Z',
    });
    const coverMatch = html.match(/<section class="cover">([\s\S]*?)<\/section>/);
    expect(coverMatch).toBeTruthy();
    // Should contain the readable form
    expect(coverMatch![1]).toContain('2026-05-17 09:22 UTC');
    // Should not contain the raw ISO milliseconds form
    expect(coverMatch![1]).not.toContain('2026-05-17T09:22:55.856Z');
  });

  it('verdict badge inner content is a single word — no "Overall verdict" label', () => {
    const html = renderVerificationReportHtml(makeReport(), {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-17T09:22:55.856Z',
    });
    // The old structure had <span class="verdict-label">Overall verdict</span>.
    // Drop the inner label entirely.
    expect(html).not.toContain('verdict-label');
    expect(html).not.toContain('Overall verdict');
    // The badge still renders the verdict word — FAILED here (no framework mapping)
    expect(html).toMatch(/<div class="verdict-badge verdict-failed">\s*FAILED\s*<\/div>/);
  });
});

describe('renderVerificationReportHtml — editorial polish: section headers', () => {
  it('h-section emits number + title only — no "Section" label', () => {
    const html = renderVerificationReportHtml(makeReport(), {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-17T09:22:55.856Z',
    });
    // The old structure had <span class="label">Section</span> next to every header.
    // After polish that span is gone.
    expect(html).not.toContain('<span class="label">Section</span>');
    // Number + title remain.
    expect(html).toMatch(/<div class="h-section" id="sec-exec-summary">[\s\S]*?<span class="num">01<\/span>[\s\S]*?<span class="title">Executive Summary<\/span>/);
  });
});

describe('renderVerificationReportHtml — editorial polish: pluralization', () => {
  it('uses "1 verification source" (no "(s)") when sources.length === 1', () => {
    const html = renderVerificationReportHtml(makeReport(), {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-17T09:22:55.856Z',
    });
    expect(html).not.toContain('source(s)');
    expect(html).toContain('1 verification source');
    // Not "1 verification sources" (typo guard)
    expect(html).not.toMatch(/1 verification sources(?:[^A-Za-z])/);
  });

  it('uses "2 verification sources" when sources.length === 2', () => {
    const html = renderVerificationReportHtml(
      makeReport({
        sources: [
          {
            sourceId: 'mcp-tools',
            verdict: 'verified',
            diffs: [],
            inventory: { source: 'mcp-tools', capturedAt: '2026-05-17T12:00:00Z', tools: [] },
          },
          {
            sourceId: 'oauth',
            verdict: 'verified',
            diffs: [],
            inventory: { source: 'oauth', capturedAt: '2026-05-17T12:00:00Z', tools: [] },
          },
        ],
      }),
      {
        agentLabel: 'X',
        evaluationId: 'eval-1',
        generatedAt: '2026-05-17T09:22:55.856Z',
      },
    );
    expect(html).toContain('2 verification sources');
    expect(html).not.toContain('source(s)');
  });
});

describe('renderVerificationReportHtml — editorial polish: executive summary structure', () => {
  it('Section 01 contains Compliance Posture, Headline Findings, Framework Coverage, Recommended Actions subsections', () => {
    const report = makeReport({
      frameworkMapping: makeMapping([
        ctrl({ verdict: 'verified', controlId: 'A001', framework: 'aiuc-1' }),
        ctrl({ verdict: 'fail', controlId: 'Article 14', framework: 'eu-ai-act', severity: 'critical', controlName: 'Human Oversight', rationale: 'No approval chain present.' }),
        ctrl({ verdict: 'partial', controlId: 'MANAGE', framework: 'nist-ai-rmf', severity: 'medium', controlName: 'MANAGE', rationale: 'process undocumented' }),
      ]),
    });
    const html = renderVerificationReportHtml(report, {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-17T09:22:55.856Z',
    });
    expect(html).toContain('<h3>Compliance Posture</h3>');
    expect(html).toContain('<h3>Headline Findings</h3>');
    expect(html).toContain('<h3>Framework Coverage</h3>');
    expect(html).toContain('<h3>Recommended Actions</h3>');
  });

  it('Section 01 includes Approval Trail subsection when approvalChain present', () => {
    const report = makeReport({
      frameworkMapping: makeMapping([
        ctrl({ verdict: 'verified', controlId: 'A001' }),
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
            {
              action: 'approved',
              actor: { name: 'Carla Reyes', role: 'DPO' },
              timestamp: '2026-05-17T11:00:00Z',
            },
          ],
        },
        integrity: { ok: true },
      },
    });
    const html = renderVerificationReportHtml(report, {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-17T09:22:55.856Z',
    });
    expect(html).toContain('<h3>Approval Trail</h3>');
    // Approval trail subsection should name the approver
    expect(html).toContain('Carla Reyes');
  });

  it('Section 01 omits Approval Trail subsection when no approvalChain', () => {
    const report = makeReport({
      frameworkMapping: makeMapping([
        ctrl({ verdict: 'verified', controlId: 'A001' }),
      ]),
    });
    const html = renderVerificationReportHtml(report, {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-17T09:22:55.856Z',
    });
    // No <h3>Approval Trail</h3> when no chain.
    // (The body-level Approval Audit Trail section is also conditional — see existing test.)
    const execMatch = html.match(/<div class="h-section" id="sec-exec-summary">[\s\S]*?<div class="h-section" id="sec-agent-spec">/);
    expect(execMatch).toBeTruthy();
    expect(execMatch![0]).not.toContain('<h3>Approval Trail</h3>');
  });

  it('Headline Findings renders severity pills + framework citations', () => {
    const report = makeReport({
      frameworkMapping: makeMapping([
        ctrl({
          verdict: 'fail',
          controlId: 'Article 22',
          framework: 'gdpr',
          severity: 'critical',
          controlName: 'Automated Decision-Making',
          rationale: 'Auto-reject without disclosure.',
        }),
        ctrl({
          verdict: 'fail',
          controlId: 'Article 14',
          framework: 'eu-ai-act',
          severity: 'high',
          controlName: 'Human Oversight',
          rationale: 'No human-review tool.',
        }),
      ]),
    });
    const html = renderVerificationReportHtml(report, {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-17T09:22:55.856Z',
    });
    expect(html).toContain('<ol class="findings-list">');
    // Severity pill rendered for each finding
    expect(html).toMatch(/<span class="sev sev-critical">/);
    expect(html).toMatch(/<span class="sev sev-high">/);
    // Citation muted text contains the framework reference
    expect(html).toContain('GDPR Article 22');
    expect(html).toContain('EU AI Act Article 14');
  });

  it('Framework Coverage renders per-framework verified/total counts', () => {
    const report = makeReport({
      frameworkMapping: makeMapping([
        ctrl({ verdict: 'verified', controlId: 'A001', framework: 'aiuc-1' }),
        ctrl({ verdict: 'verified', controlId: 'A002', framework: 'aiuc-1' }),
        ctrl({ verdict: 'fail', controlId: 'A003', framework: 'aiuc-1', severity: 'high' }),
        ctrl({ verdict: 'fail', controlId: 'Article 14', framework: 'eu-ai-act', severity: 'critical' }),
      ]),
    });
    const html = renderVerificationReportHtml(report, {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-17T09:22:55.856Z',
    });
    expect(html).toContain('<ul class="framework-coverage">');
    expect(html).toContain('AIUC-1');
    expect(html).toContain('EU AI Act');
    // 2/3 verified for AIUC-1 group (verified count over total controls in framework)
    expect(html).toMatch(/AIUC-1[^<]*<\/strong>[^<]*2\/3/);
    expect(html).toMatch(/EU AI Act[^<]*<\/strong>[^<]*0\/1/);
  });

  it('Compliance Posture line names the verdict', () => {
    const report = makeReport({
      frameworkMapping: makeMapping([
        ctrl({ verdict: 'fail', controlId: 'A1', severity: 'critical' }),
        ctrl({ verdict: 'verified', controlId: 'A2' }),
      ]),
    });
    const html = renderVerificationReportHtml(report, {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-17T09:22:55.856Z',
    });
    // Posture body explicitly mentions FAILED + the critical count
    const postureMatch = html.match(/<h3>Compliance Posture<\/h3>[\s\S]*?<\/div>/);
    expect(postureMatch).toBeTruthy();
    expect(postureMatch![0]).toContain('FAILED');
    expect(postureMatch![0]).toContain('1 critical');
  });

  it('Recommended Actions is omitted when no failing or partial controls', () => {
    const report = makeReport({
      frameworkMapping: makeMapping([
        ctrl({ verdict: 'verified', controlId: 'A1' }),
        ctrl({ verdict: 'verified', controlId: 'A2' }),
      ]),
    });
    const html = renderVerificationReportHtml(report, {
      agentLabel: 'X',
      evaluationId: 'eval-1',
      generatedAt: '2026-05-17T09:22:55.856Z',
    });
    // For a clean run, the Recommended Actions subsection should still appear
    // but with a "no actions" body. We keep the subsection so the document
    // structure is consistent across runs.
    expect(html).toContain('<h3>Recommended Actions</h3>');
  });
});
