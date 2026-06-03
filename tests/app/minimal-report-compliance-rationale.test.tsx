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

import {
  ControlRow,
  shortEvidenceLabel,
  type ControlResult,
} from '@/components/heron-v1/dashboard/MinimalReportView';

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
    // AAP-130 (B2): the `partial` verdict badge now reads "Needs review" (the
    // shared display label). The verdict VALUE stays `partial`.
    expect(html).toContain('Needs review');
    expect(html).not.toContain('>partial<');
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
    // AAP-105 F4: refs are shortened to bare tokens — the "mcp:<server>"
    // handle keeps its prefix but drops the " (transport)" tail.
    expect(html).toContain('mcp:heron');
    expect(html).toContain('mcp:chrome-devtools');
    // The verbose transport-suffixed form must NOT survive.
    expect(html).not.toContain('mcp:heron (http)');
    expect(html).not.toContain('(stdio)');
    // 5 refs → 4 shown + "+1 more"; the 5th must not be inlined.
    expect(html).toContain('+1 more');
    expect(html).not.toContain('mcp:github');
  });

  it('AAP-121: renders the self-attested verdict state (agent self-report, not a verdict)', () => {
    // The lens passes self-attested controls through ControlRow with the
    // `self-attested` sentinel verdict. The row must render that state rather
    // than falling through to a misleading default.
    const selfAttested = {
      frameworkId: 'gdpr',
      controlId: 'Art. 5(1)(b)',
      controlName: 'Purpose limitation.',
      verdict: 'self-attested' as const,
      severity: 'info' as const,
    };
    const html = renderToStaticMarkup(<ControlRow control={selfAttested} />);
    expect(html).toContain('Art. 5(1)(b)');
    expect(html).toContain('self-attested');
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
    // AAP-105 F4: shortened to the bare "mcp:only" handle (transport dropped).
    expect(html).toContain('mcp:only');
    expect(html).not.toContain('mcp:only (http)');
    // One usable ref → no overflow count.
    expect(html).not.toContain('more');
  });
});

// AAP-105 F4 — the evidence-line shortener is the load-bearing bit: raw refs
// carry absolute paths, a "→ AI provider (international transfer)" tail, a
// "(plaintext secret-pattern key)" annotation, and the capability: form
// duplicates the key. All of that must collapse to a bare token.
describe('shortEvidenceLabel (AAP-105 F4)', () => {
  it('extracts the bare key from an env:<path>: KEY → tail ref', () => {
    expect(
      shortEvidenceLabel(
        'env:/Users/me/Codex3/.env: GOOGLE_API_KEY → cloud provider (international transfer)',
      ),
    ).toBe('GOOGLE_API_KEY');
  });

  it('strips the "(plaintext secret-pattern key)" annotation', () => {
    expect(
      shortEvidenceLabel('env:/Users/me/Codex3/.env.example: GAMMA_API_KEY (plaintext secret-pattern key)'),
    ).toBe('GAMMA_API_KEY');
  });

  it('collapses the duplicated key in the capability: form', () => {
    expect(
      shortEvidenceLabel('capability:OPENAI_API_KEY: OPENAI_API_KEY → AI provider (international transfer)'),
    ).toBe('OPENAI_API_KEY');
  });

  it('keeps the mcp:<server> handle but drops the transport tail', () => {
    expect(shortEvidenceLabel('mcp:linear (http)')).toBe('mcp:linear');
    expect(shortEvidenceLabel('mcp:chrome-devtools (stdio)')).toBe('mcp:chrome-devtools');
  });

  it('returns empty string for empty/blank input', () => {
    expect(shortEvidenceLabel('')).toBe('');
    expect(shortEvidenceLabel('   ')).toBe('');
  });
});

describe('ControlRow evidence dedup + path stripping (AAP-105 F4)', () => {
  // The same key shows up as both a capability: and an env: ref, and across
  // .env / .env.example — the rendered line must show it once, with no path.
  const dupes: ControlResult = {
    frameworkId: 'aiuc-1',
    controlId: 'A001',
    controlName: 'Input data policy.',
    verdict: 'partial',
    severity: 'medium',
    evidenceRefs: [
      { kind: 'inventory', ref: 'capability:OPENAI_API_KEY: OPENAI_API_KEY → AI provider (international transfer)' },
      { kind: 'inventory', ref: 'env:/Users/me/Codex3/.env: OPENAI_API_KEY → AI provider (international transfer)' },
      { kind: 'inventory', ref: 'env:/Users/me/Codex3/.env.example: OPENAI_API_KEY → AI provider (international transfer)' },
      { kind: 'inventory', ref: 'env:/Users/me/Codex3/.env: GOOGLE_API_KEY → cloud provider (international transfer)' },
    ],
  };

  it('deduplicates a key seen under multiple prefixes and drops paths + tails', () => {
    const html = render(dupes);
    expect(html).toContain('Evidence:');
    expect(html).toContain('OPENAI_API_KEY');
    expect(html).toContain('GOOGLE_API_KEY');
    // No absolute path, no classification tail, no source prefix leaks.
    expect(html).not.toContain('/Users/');
    expect(html).not.toContain('.env');
    expect(html).not.toContain('AI provider');
    expect(html).not.toContain('international transfer');
    expect(html).not.toContain('capability:');
    // 4 raw refs collapse to 2 distinct keys → no overflow.
    expect(html).not.toContain('more');
  });
});

describe('MinimalReportView compliance lens legend (AAP-105 A7 + AAP-121 S5)', () => {
  // The lens legend is static JSX behind the lens "Detail" toggle (collapsed by
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

  it('AAP-121: the legend is the one-liner — verified / warn / self-attested', () => {
    // Scope point 4: some controls can earn a clean verified, others only ever
    // warn (the deterministic-flag set); self-attested controls are agent
    // answers, not verdicts.
    expect(source).toContain('can earn a clean');
    expect(source).toContain('the deterministic-flag set');
    expect(source).toContain('own answers, not');
  });

  it('AAP-121: drops the per-card out-of-scope toggle copy (oos is a count only)', () => {
    // The old "toggle in each card to include them" hid out-of-scope behind a
    // per-card toggle. S5 makes out-of-scope a count, never a list.
    expect(source).not.toContain('toggle in each card to include them');
    expect(source).not.toContain('Show ${fwOos} out-of-scope');
  });
});
