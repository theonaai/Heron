/**
 * PR #25 round 2 — defensive polish for the SOC-style HTML renderer.
 *
 * Five findings closed here:
 *
 *   MEDIUM — computeComplianceScore: when `frameworkMapping.controls`
 *   is undefined (corrupt / partial-mock report), `controls.length`
 *   threw `TypeError`. Round 2 contract: 3-way guard on
 *   `frameworkMapping` → `controls` → `controls.length`.
 *
 *   LOW — negative count clamp: summary counts coming back from a
 *   corrupted state as negative numbers produce nonsense scores
 *   (e.g. -1 / -1 * 100 → 100 → PASSED). Clamp each count at zero
 *   before arithmetic.
 *
 *   LOW — defensive `?? []` on `report.sources` and `report.declared`.
 *   The type contract guarantees them, but partial mocks and future
 *   callers should not crash if they pass `undefined`.
 *
 *   LOW — dead ternary on the score-class span (both branches `'mono'`).
 *   Verified by inspecting the rendered output; the cover should not
 *   carry an empty-string class attribute.
 *
 *   LOW — write-side size cap is exercised in the scans-round2 sibling
 *   test (see tests/server/scans-write-size-cap.test.ts).
 */

import { describe, it, expect } from 'vitest';
import {
  computeComplianceScore,
  renderVerificationReportHtml,
} from '../../src/report/html-renderer.js';
import type { VerificationReport } from '../../src/verification/types.js';
import type { FrameworkMapping } from '../../src/verification/frameworks/types.js';

describe('computeComplianceScore — round 2 defensive guards', () => {
  it('returns FAILED without crashing when controls is undefined', () => {
    // Build a mapping shape with controls undefined. Cast through unknown
    // because the type contract forbids it; the audit verified the
    // runtime crash, so the runtime guard must hold even against the
    // off-contract input.
    const fm = {
      generatedAt: '2026-05-17T12:00:00Z',
      controls: undefined,
      summary: {
        verifiedCount: 0,
        partialCount: 0,
        unverifiedCount: 0,
        failCount: 0,
        notApplicableCount: 0,
      },
    } as unknown as FrameworkMapping;

    const report: VerificationReport = {
      capturedAt: '2026-05-17T12:00:00Z',
      agentLabel: 'X',
      declared: [],
      sources: [],
      frameworkMapping: fm,
    };

    const r = computeComplianceScore(report);
    expect(r).toEqual({ score: 0, verdict: 'FAILED', threshold: 70 });
  });

  it('returns FAILED without crashing when controls is null', () => {
    const fm = {
      generatedAt: '2026-05-17T12:00:00Z',
      controls: null,
      summary: {
        verifiedCount: 0,
        partialCount: 0,
        unverifiedCount: 0,
        failCount: 0,
        notApplicableCount: 0,
      },
    } as unknown as FrameworkMapping;

    const report: VerificationReport = {
      capturedAt: '2026-05-17T12:00:00Z',
      agentLabel: 'X',
      declared: [],
      sources: [],
      frameworkMapping: fm,
    };

    const r = computeComplianceScore(report);
    expect(r).toEqual({ score: 0, verdict: 'FAILED', threshold: 70 });
  });

  it('clamps negative summary counts at zero (does not return 100 / PASSED)', () => {
    // Negative inputs from a corrupted state must not produce a
    // nonsensical 100% score. With the clamp, total → 0 and the
    // function returns FAILED via the total-zero short-circuit.
    const fm: FrameworkMapping = {
      generatedAt: '2026-05-17T12:00:00Z',
      controls: [],
      summary: {
        verifiedCount: -1,
        partialCount: -1,
        failCount: -1,
        unverifiedCount: -1,
        notApplicableCount: 0,
      },
    };

    // Sanity: empty controls already triggers the early-return, but
    // we also assert with a single dummy control to exercise the
    // arithmetic path with clamped negatives.
    const r1 = computeComplianceScore({
      capturedAt: '2026-05-17T12:00:00Z',
      agentLabel: 'X',
      declared: [],
      sources: [],
      frameworkMapping: fm,
    });
    expect(r1.score).toBeLessThanOrEqual(100);
    expect(r1.verdict).not.toBe('PASSED');

    // Now with one verified control + negative summary fields. After
    // clamping, total = 0 from summary, the function falls through.
    const fm2: FrameworkMapping = {
      generatedAt: '2026-05-17T12:00:00Z',
      controls: [
        {
          framework: 'aiuc-1',
          controlId: 'A001',
          controlName: 'X',
          verdict: 'verified',
          severity: 'low',
          rationale: 'ok',
          evidenceRefs: [],
        },
      ],
      summary: {
        verifiedCount: -5,
        partialCount: -5,
        failCount: -5,
        unverifiedCount: -5,
        notApplicableCount: 0,
      },
    };
    const r2 = computeComplianceScore({
      capturedAt: '2026-05-17T12:00:00Z',
      agentLabel: 'X',
      declared: [],
      sources: [],
      frameworkMapping: fm2,
    });
    expect(r2.score).toBeLessThanOrEqual(100);
    expect(r2.verdict).not.toBe('PASSED');
  });
});

describe('renderVerificationReportHtml — round 2 defensive guards', () => {
  it('renders without crashing when sources and declared are undefined', () => {
    // Partial mock — type contract guarantees these, but we want
    // belt-and-braces. Cast through unknown.
    const report = {
      capturedAt: '2026-05-17T12:00:00Z',
      agentLabel: 'PartialAgent',
      // declared + sources deliberately omitted
    } as unknown as VerificationReport;

    expect(() =>
      renderVerificationReportHtml(report, {
        agentLabel: 'PartialAgent',
        evaluationId: 'eval-partial',
        generatedAt: '2026-05-17T12:00:00Z',
      }),
    ).not.toThrow();

    const html = renderVerificationReportHtml(report, {
      agentLabel: 'PartialAgent',
      evaluationId: 'eval-partial',
      generatedAt: '2026-05-17T12:00:00Z',
    });
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html.endsWith('</html>')).toBe(true);
  });

  it('cover score span does not emit an empty class attribute', () => {
    // The dead ternary `${scoreClass ? 'mono' : 'mono'}` would always
    // render `class="mono"`, but if the broken form ever flipped to
    // emit `class=""` (empty), output would carry a quirky empty
    // attribute. Guard against either accidental regression.
    const report: VerificationReport = {
      capturedAt: '2026-05-17T12:00:00Z',
      agentLabel: 'X',
      declared: [],
      sources: [],
    };
    const html = renderVerificationReportHtml(report, {
      agentLabel: 'X',
      evaluationId: 'eval',
      generatedAt: '2026-05-17T12:00:00Z',
    });
    // No empty class="" on any span.
    expect(html).not.toMatch(/<span class=""/);
    // The score-threshold block still carries the FAILED label.
    expect(html).toContain('FAILED');
  });
});
