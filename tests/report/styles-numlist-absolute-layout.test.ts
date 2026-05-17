/**
 * PR #28 / AAP-57 — Replace flex/grid counter layout with
 * absolute-positioned counter for findings-list, recommended-actions,
 * and numlist.
 *
 * PR #27 introduced `display: flex; flex-wrap: wrap` on
 * `.findings-list > li` + `.recommended-actions > li`. That fixed the
 * grid-distribution bug for the *short* Headline Findings rows, but it
 * silently regressed the *long* Recommended Actions rows: the counter
 * "01" is a flex child with `flex: 0 0 28px`, and when the action
 * sentence is too long to fit on the first wrapped row, `flex-wrap`
 * pushes the entire text node onto the next flex row — leaving the
 * counter alone on row 1 and the text full-width on row 2.
 *
 * The same shape of bug exists for `.numlist` in Section 05 Conclusion,
 * which uses a 36px/1fr grid; the grid handles wrap correctly only
 * because each li wraps `${a}` in a `<div>`, but the indent is brittle
 * and looks misaligned next to the other lists.
 *
 * Fix: use absolute positioning for the counter. `<li>` becomes
 * `position: relative` with `padding-left: 36px`; the `::before`
 * counter is `position: absolute; left: 0` and floats outside the
 * content flow. Long sentences now wrap naturally inside the
 * content box, with every wrapped line aligned to the 36px indent.
 *
 * Visual evidence of the bug:
 *   /Users/ilaivanov/Claude/Claude1/reference-screenshots/
 *     heron-html-renders-2026-05-17/09-pr27-full-doc-2x.png
 * Section 01 Recommended Actions + Section 05 Conclusion: counter on
 * row 1, text on row 2.
 */
import { describe, it, expect } from 'vitest';
import { REPORT_CSS } from '../../src/report/styles.js';

describe('PR #28 — absolute-positioned counter for numbered lists', () => {
  it('findings-list / recommended-actions <li> uses absolute counter (no flex on li)', () => {
    // The PR #27 rule grouped both selectors. After the fix, the
    // grouped selector body must NOT contain `display: flex` and MUST
    // declare `position: relative` so the absolute counter anchors
    // inside the li.
    const liRuleMatch = REPORT_CSS.match(
      /\.heron-report \.findings-list > li,\s*\.heron-report \.recommended-actions > li\s*\{([^}]+)\}/,
    );
    expect(liRuleMatch).toBeTruthy();
    const body = liRuleMatch![1];
    expect(body).not.toMatch(/display:\s*flex/);
    expect(body).not.toMatch(/flex-wrap:\s*wrap/);
    expect(body).toMatch(/position:\s*relative/);
    // Content indent matches the absolute counter's reserved width.
    expect(body).toMatch(/padding[-\s:]+.*36px/);
  });

  it('findings-list / recommended-actions ::before uses absolute positioning', () => {
    const beforeRuleMatch = REPORT_CSS.match(
      /\.heron-report \.findings-list > li::before,\s*\.heron-report \.recommended-actions > li::before\s*\{([^}]+)\}/,
    );
    expect(beforeRuleMatch).toBeTruthy();
    const body = beforeRuleMatch![1];
    expect(body).toMatch(/content:\s*counter\(ef,\s*decimal-leading-zero\)/);
    expect(body).toMatch(/counter-increment:\s*ef/);
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/left:\s*0/);
    // ::before should NOT be a flex item anymore.
    expect(body).not.toMatch(/flex:\s*0\s+0\s+28px/);
  });

  it('numlist <li> uses absolute counter (no grid template)', () => {
    const liRuleMatch = REPORT_CSS.match(
      /\.heron-report \.numlist > li\s*\{([^}]+)\}/,
    );
    expect(liRuleMatch).toBeTruthy();
    const body = liRuleMatch![1];
    // No grid template: numlist used to use 36px 1fr.
    expect(body).not.toMatch(/display:\s*grid/);
    expect(body).not.toMatch(/grid-template-columns/);
    expect(body).toMatch(/position:\s*relative/);
    expect(body).toMatch(/padding[-\s:]+.*36px/);
  });

  it('numlist ::before uses absolute positioning', () => {
    const beforeRuleMatch = REPORT_CSS.match(
      /\.heron-report \.numlist > li::before\s*\{([^}]+)\}/,
    );
    expect(beforeRuleMatch).toBeTruthy();
    const body = beforeRuleMatch![1];
    expect(body).toMatch(/content:\s*counter\(nl,\s*decimal-leading-zero\)/);
    expect(body).toMatch(/counter-increment:\s*nl/);
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/left:\s*0/);
  });
});
