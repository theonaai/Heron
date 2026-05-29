/**
 * Regression guard for AAP-105 A7 — the compliance lens must surface each
 * control's `rationale` (and a compact evidence summary) inside the expanded
 * framework accordion, not just the verdict/severity badges.
 *
 * WHY: a prior fix made controls honestly report `partial` with a rationale
 * like "Heron observed a live inventory of N MCP servers; ISO 42001 A.4.4
 * also expects a documented categorised inventory artefact — supply that to
 * upgrade to verified." That text is persisted in report.json
 * (controlResults[].rationale) but was rendered NOWHERE in the dashboard, so
 * a reviewer saw "A.4.4 — PARTIAL / INFO" with no reasoning. The whole point
 * of an honest-partial verdict is lost if the reviewer can't read why.
 *
 * TEST INFRA NOTE: this project's vitest setup has no DOM
 * (renderToStaticMarkup only, no jsdom). The framework accordion sits behind
 * two collapsed `useState` toggles (the lens "Detail" toggle and the
 * per-framework expand), so a top-level MinimalReportView static render never
 * reaches a control row. We therefore mount the exported `ControlRow`
 * directly — that is the unit that owns the rationale/evidence rendering. The
 * live accordion → row path is verified in the browser via Claude Preview.
 *
 * The footer-wording assertion is a source-content guard: the footer is
 * static JSX behind the same collapsed toggle, so we assert against the
 * component source that the inaccurate "no typed detector" clause is gone and
 * the corrected clause is present.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { ControlRow, type ControlResult } from '@/components/heron-v1/dashboard/MinimalReportView';

function render(control: ControlResult): string {
  return renderToStaticMarkup(<ControlRow control={control} />);
}

// The real ISO 42001 A.4.4 row from the demo session report.json.
const a44: ControlResult = {
  frameworkId: 'iso-42001',
  controlId: 'A.4.4',
  controlName: 'Tooling resources — AI tools and components inventory.',
  verdict: 'partial',
  severity: 'info',
  rationale:
    "Heron observed a live inventory of 5 MCP servers in the agent's configuration. " +
    'ISO 42001 A.4.4 also expects a documented, categorised AI-system inventory artefact. ' +
    'Supply that to upgrade this control to verified.',
  evidenceRefs: [
    { kind: 'inventory', ref: 'mcp:heron (http)' },
    { kind: 'inventory', ref: 'mcp:linear (http)' },
    { kind: 'inventory', ref: 'mcp:supabase (http)' },
    { kind: 'inventory', ref: 'mcp:chrome-devtools (stdio)' },
    { kind: 'inventory', ref: 'mcp:github (stdio)' },
  ],
};

describe('MinimalReportView compliance ControlRow rationale (AAP-105 A7)', () => {
  it('renders the controlId, name, verdict and severity (existing contract)', () => {
    const html = render(a44);
    expect(html).toContain('A.4.4');
    expect(html).toContain('Tooling resources');
    expect(html).toContain('partial');
    expect(html).toContain('info');
  });

  it('surfaces the rationale text inline under the control', () => {
    const html = render(a44);
    // The reasoning a reviewer needs — the whole point of A7.
    expect(html).toContain('documented, categorised AI-system inventory artefact');
    expect(html).toContain('Supply that to upgrade this control to verified');
  });

  it('surfaces a compact evidence summary capped at four refs with an overflow count', () => {
    const html = render(a44);
    expect(html).toContain('Evidence:');
    expect(html).toContain('mcp:heron (http)');
    expect(html).toContain('mcp:chrome-devtools (stdio)');
    // 5 refs → 4 shown + "+1 more"; the 5th must not be inlined.
    expect(html).toContain('+1 more');
    expect(html).not.toContain('mcp:github (stdio)');
  });

  it('renders no rationale/evidence elements when both are absent', () => {
    const bare: ControlResult = {
      frameworkId: 'iso-42001',
      controlId: 'A.2.2',
      controlName: 'AI policy.',
      verdict: 'verified',
      severity: 'info',
    };
    const html = render(bare);
    expect(html).toContain('A.2.2');
    // No empty rationale paragraph, no dangling "Evidence:" label.
    expect(html).not.toContain('Evidence:');
    // Verdict still renders.
    expect(html).toContain('verified');
  });

  it('ignores blank/whitespace evidence refs', () => {
    const withBlanks: ControlResult = {
      ...a44,
      evidenceRefs: [{ ref: '   ' }, { ref: '' }, { kind: 'inventory', ref: 'mcp:only (http)' }],
    };
    const html = render(withBlanks);
    expect(html).toContain('mcp:only (http)');
    // One usable ref → no overflow count.
    expect(html).not.toContain('more');
  });
});

describe('MinimalReportView compliance footer wording (AAP-105 A7)', () => {
  // The footer is static JSX behind the lens "Detail" toggle (collapsed by
  // default), so it is not reachable via renderToStaticMarkup. Guard the
  // wording against the component source instead.
  const source = readFileSync(
    fileURLToPath(new URL('../../components/heron-v1/dashboard/MinimalReportView.tsx', import.meta.url)),
    'utf8',
  );

  it('drops the inaccurate "no typed detector" clause', () => {
    // Partial verdicts ARE produced by typed detectors — the old wording was wrong.
    expect(source).not.toContain('signal present but no typed detector');
  });

  it('describes partial as a typed-detector signal that cannot yet be proven', () => {
    expect(source).toContain('typed detector found a relevant signal or applicable obligation');
    expect(source).toContain('Heron cannot');
  });
});
