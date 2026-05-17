/**
 * PR #27 / AAP-56 — Headline Findings + Recommended Actions layout fix.
 *
 * The PR #26 editorial pass left `.findings-list > li` styled as
 * `display: grid; grid-template-columns: 28px 1fr`. With the renderer
 * emitting three inline children inside each `<li>` (severity pill,
 * title text node, citation `<span class="muted">`), CSS Grid's
 * auto-placement distributed them across two rows:
 *
 *   [counter "01"][HIGH pill stretched full-width        ]
 *   [title text  ][(AIUC-1 E004) overlapping the title   ]
 *
 * Symptoms in the live render (08-pr27-fixed-2x.png baseline at
 * /Users/ilaivanov/Claude/Claude1/reference-screenshots/heron-html-renders-2026-05-17/06-pr26-exec-summary-2x.png):
 *   - severity pill renders as a full-width banner
 *   - title text wraps to one word per line
 *   - citation overlaps the title column
 *
 * Fix: replace the per-LI grid rule with a flex layout. The counter
 * is a fixed 28px flex child (via ::before), the pill keeps its
 * inline-flex natural width, and the title + citation flow inline
 * after the pill with normal text wrapping.
 *
 * These tests are CSS-text assertions (the suite has no headless DOM
 * for visual diff). They guard the structural shape of the layout
 * rule so a future editor can't silently regress to grid.
 */
import { describe, it, expect } from 'vitest';
import { REPORT_CSS } from '../../src/report/styles.js';
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
    notApplicableCount: controls.filter((c) => c.verdict === 'not-applicable')
      .length,
  };
  return {
    generatedAt: '2026-05-17T12:00:00Z',
    controls,
    summary,
  } as FrameworkMapping;
}

function ctrl(over: Partial<FrameworkControl>): FrameworkControl {
  return {
    framework: 'aiuc-1',
    controlId: 'E004',
    controlName: 'Assigned Accountability',
    verdict: 'fail',
    rationale: 'No accountable owner declared.',
    evidence: [],
    severity: 'high',
    ...over,
  } as FrameworkControl;
}

function makeReport(over: Partial<VerificationReport> = {}): VerificationReport {
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
    ...over,
  } as VerificationReport;
}

describe('PR #27 — findings-list + recommended-actions CSS layout', () => {
  // The PR #27 flex layout was superseded by PR #28's absolute-counter
  // layout — see styles-numlist-absolute-layout.test.ts for the
  // layout shape. The remaining test in this file is the structural
  // smoke test, which is still valid: the renderer must keep emitting
  // the pill + title + citation as inline children of <li>.

  it('rendered <li> still contains pill + title text + citation as inline children', () => {
    // Structural smoke test — the renderer HTML must not change.
    // If the renderer ever splits the pill into a separate row
    // wrapper, this test fails and we have to revisit the CSS.
    const report = makeReport({
      verdict: 'failed',
      frameworkMapping: makeMapping([
        ctrl({
          verdict: 'fail',
          controlId: 'E004',
          controlName: 'Assigned Accountability',
          severity: 'high',
        }),
        ctrl({
          verdict: 'fail',
          controlId: 'E007',
          controlName: 'Logging Captured',
          severity: 'critical',
        }),
      ]),
    });
    const html = renderVerificationReportHtml(report, {
      agentLabel: 'pr27-layout',
      evaluationId: 'eval-pr27',
      generatedAt: '2026-05-17T12:00:00Z',
    });
    // Find the findings-list ol and the first <li> inside it.
    const liMatch = html.match(
      /<ol class="findings-list">[\s\S]*?<li>([\s\S]*?)<\/li>/,
    );
    expect(liMatch).toBeTruthy();
    const liInner = liMatch![1];
    // Three load-bearing fragments inline:
    //   1) severity pill <span class="sev sev-…">…</span>
    //   2) human-readable title text (sentence-cased control name + period)
    //   3) muted citation <span class="muted">(…)</span>
    expect(liInner).toMatch(/<span class="sev sev-[a-z]+">[A-Z]+<\/span>/);
    expect(liInner).toMatch(/<span class="muted">\(/);
    // Title text exists between the pill close-tag and the muted span.
    const inlineBody = liInner.replace(/\s+/g, ' ').trim();
    expect(inlineBody).toMatch(
      /<\/span>\s*[A-Za-z][^<]*\.\s*<span class="muted">/,
    );
  });
});
