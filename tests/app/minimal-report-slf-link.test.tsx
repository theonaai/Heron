/**
 * AAP-130 (B1) — the lens SLF reference (`↗`) must always land on its full
 * card in the global Self-Attested Findings stream, even when that section is
 * collapsed.
 *
 * THE BUG: the compact `↳ CODE Title ↗` reference under a control is a plain
 * `<a href="#finding-NNN">`. The global Self-Attested section is React-
 * controlled and COLLAPSED by default, so the target card is not mounted. A
 * bare anchor jump then has no target and does nothing.
 *
 * THE FIX: `FindingRef`'s click handler calls `navigateToFinding`, which (1)
 * clicks the section toggle (keyed by the stable `SLF_TOGGLE_ID`) to expand it
 * when collapsed, then (2) scrolls the card into view once it mounts.
 *
 * TEST INFRA NOTE: this project's vitest setup has no jsdom (renderToStaticMarkup
 * only). The expand-then-scroll DOM choreography is exercised live in the
 * browser via Claude Preview. Here we assert:
 *   - the static `href` fallback is intact (no-JS / static-markup path),
 *   - `navigateToFinding` no-ops safely off the DOM (SSR guard),
 *   - the source wiring is present: `FindingRef` calls `navigateToFinding`,
 *     and the toggle button carries the id + `data-slf-open` state flag the
 *     navigator reads.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  FindingRef,
  findingAnchorId,
  navigateToFinding,
  SLF_TOGGLE_ID,
} from '@/components/heron-v1/dashboard/MinimalReportView';

const SOURCE = readFileSync(
  fileURLToPath(new URL('../../components/heron-v1/dashboard/MinimalReportView.tsx', import.meta.url)),
  'utf8',
);

describe('AAP-130 (B1) — SLF reference always lands on its card', () => {
  it('keeps the #finding-<code> href as a no-JS fallback', () => {
    const html = renderToStaticMarkup(
      <FindingRef finding={{ id: 'f1', code: 'SLF-001', title: 'Broad OAuth access' }} />,
    );
    expect(html).toContain(`href="#${findingAnchorId('SLF-001')}"`);
  });

  it('navigateToFinding no-ops safely when there is no document (SSR guard)', () => {
    // vitest runs in node with no jsdom, so `document` is undefined here.
    expect(() => navigateToFinding('SLF-001')).not.toThrow();
  });

  it('FindingRef wires its onClick to navigateToFinding (expand-then-scroll)', () => {
    expect(SOURCE).toMatch(/onClick=\{\(e\)\s*=>\s*\{[\s\S]*navigateToFinding\(finding\.code\)/);
  });

  it('the global Self-Attested toggle carries the stable id + data-slf-open flag', () => {
    expect(SLF_TOGGLE_ID).toBe('self-attested-findings-toggle');
    expect(SOURCE).toContain('id={SLF_TOGGLE_ID}');
    expect(SOURCE).toContain("data-slf-open={slfOpen ? 'true' : 'false'}");
  });

  it('navigateToFinding reads data-slf-open and only clicks the toggle when collapsed', () => {
    expect(SOURCE).toContain("getAttribute('data-slf-open') !== 'true'");
    expect(SOURCE).toContain('toggle.click()');
  });
});
