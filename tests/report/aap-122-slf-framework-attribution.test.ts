/**
 * AAP-122 (S6 of AAP-117) — attribute self-attested FINDINGS to frameworks.
 *
 * Lane B of the two "self-attested" lanes. The global "Self-Attested Findings"
 * stream (`VerdictFinding` with `evidenceSource: 'SLF'`) carries no framework
 * identity. AAP-122 adds a bounded `findingType` classification to each risk,
 * then DETERMINISTICALLY derives the framework card(s) the finding renders
 * under from `CONTROL_MAPPINGS` (keyed by `findingType`). The SAME finding
 * appears in BOTH the global stream AND under every framework its type maps to.
 *
 * This is ADDITIVE: the global stream is never emptied or relocated, and Lane A
 * (self-attested CONTROLS from prose flags — `selfAttestedControlsForFramework`)
 * is untouched.
 *
 * Coverage:
 *   1. `frameworkIdsForFindingType` is deterministic + fans out to every
 *      framework a finding type maps to (and only those).
 *   2. `slfFindingsForFramework` attributes an SLF finding to each mapped
 *      framework; ignores non-SLF findings, findings with no findingType, and
 *      findings whose type maps to no controls.
 *   3. Markdown lens render: a finding's title shows under each mapped framework
 *      card, after the control rows; a multi-framework finding shows under each;
 *      a no-findingType finding produces no card sub-list.
 *   4. End-to-end markdown (`renderMarkdownReport`): the SAME finding appears in
 *      BOTH the global "Self-Attested Findings" section AND under a framework
 *      card — the global list is not emptied.
 *   5. Dashboard `FrameworkCard` render: the SLF sub-list renders for a mapped
 *      framework and is absent for none.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  frameworkIdsForFindingType,
  slfFindingsForFramework,
  frameworkLens,
  type SlfLensFinding,
  type FrameworkLens,
} from '../../src/report/compliance-lens.js';
import { renderStructuredCompliance, renderMarkdownReport } from '../../src/report/templates.js';
import type { CodedVerdictFinding } from '../../src/report/finding-display.js';
import { CONTROL_MAPPINGS } from '../../src/compliance/control-mappings.js';
import { FrameworkCard } from '@/components/heron-v1/dashboard/MinimalReportView';
import type { FindingType, FrameworkId } from '../../src/compliance/types.js';
import type { AuditReport, StructuredCompliance, Risk } from '../../src/report/types.js';
import type { Verdict, VerdictFinding } from '../../src/verification/verdict.js';

// ─── Fixture builders ────────────────────────────────────────────────────────

/**
 * A bare SLF finding shaped like the ATTRIBUTION helper consumes it — id /
 * title / evidenceSource / findingType only. Used for the pure
 * `slfFindingsForFramework` / `frameworkIdsForFindingType` tests (which read
 * just those fields). For the RENDER tests use `codedSlf` (a full finding the
 * card needs: severity / components / description / code).
 */
function slf(args: { id: string; title: string; findingType?: FindingType }): SlfLensFinding {
  return {
    id: args.id,
    title: args.title,
    evidenceSource: 'SLF',
    ...(args.findingType !== undefined ? { findingType: args.findingType } : {}),
  };
}

/**
 * AAP-123 (S7) — a FULL coded SLF finding, as the framework-card sub-list now
 * consumes it (it renders a real finding card, not a stripped title). Carries
 * severity / components / description / a Vijil-style `code` so the card
 * renderer has everything it needs.
 */
function codedSlf(args: {
  id: string;
  title: string;
  findingType?: FindingType;
  code?: string;
  description?: string;
}): CodedVerdictFinding {
  return {
    id: args.id,
    band: 'medium',
    severityScore: 4,
    severityComponents: { br: 2, ds: 2, dm: 1 },
    evidenceSource: 'SLF',
    title: args.title,
    description: args.description ?? `${args.title} — self-reported in the interview.`,
    code: args.code ?? `SLF-${args.id}`,
    ...(args.findingType !== undefined ? { findingType: args.findingType } : {}),
    kind: 'risk',
  };
}

/** The distinct frameworks a finding type maps to, derived straight from the
 *  table — the expected value `frameworkIdsForFindingType` must reproduce. */
function expectedFrameworks(ft: FindingType): FrameworkId[] {
  const seen = new Set<FrameworkId>();
  const out: FrameworkId[] = [];
  for (const c of CONTROL_MAPPINGS[ft].controls) {
    if (seen.has(c.frameworkId)) continue;
    seen.add(c.frameworkId);
    out.push(c.frameworkId);
  }
  return out;
}

// ─── 1. Deterministic framework derivation from CONTROL_MAPPINGS ─────────────

describe('AAP-122 — frameworkIdsForFindingType (deterministic, table-driven)', () => {
  it('reproduces the distinct frameworks from the mapping table for every finding type', () => {
    for (const ft of Object.keys(CONTROL_MAPPINGS) as FindingType[]) {
      expect(frameworkIdsForFindingType(ft)).toEqual(expectedFrameworks(ft));
    }
  });

  it('fans a finding type out to MULTIPLE frameworks (decisions-about-people → all five)', () => {
    // decisions-about-people maps to controls across all five registered
    // frameworks in the table.
    expect(frameworkIdsForFindingType('decisions-about-people')).toEqual([
      'iso-42001',
      'eu-ai-act',
      'gdpr',
      'aiuc-1',
      'nist-ai-rmf',
    ]);
  });

  it('maps risk-score to ONLY iso-42001 / eu-ai-act / nist-ai-rmf (not gdpr, not aiuc-1)', () => {
    const fws = frameworkIdsForFindingType('risk-score');
    expect(fws).toContain('iso-42001');
    expect(fws).toContain('eu-ai-act');
    expect(fws).toContain('nist-ai-rmf');
    expect(fws).not.toContain('gdpr');
    expect(fws).not.toContain('aiuc-1');
  });

  it('returns each framework at most once even though a type maps to several controls per framework', () => {
    const fws = frameworkIdsForFindingType('excessive-access');
    expect(new Set(fws).size).toBe(fws.length);
  });
});

// ─── 2. slfFindingsForFramework attribution ──────────────────────────────────

describe('AAP-122 — slfFindingsForFramework', () => {
  it('attributes an SLF finding to EVERY framework its findingType maps to', () => {
    const finding = slf({ id: 'f1', title: 'Automated hiring decision', findingType: 'decisions-about-people' });
    for (const fw of frameworkIdsForFindingType('decisions-about-people')) {
      expect(slfFindingsForFramework(fw, [finding]).map((f) => f.id)).toEqual(['f1']);
    }
  });

  it('does NOT attribute an SLF finding to a framework its findingType does not map to', () => {
    // risk-score does not map to gdpr or aiuc-1.
    const finding = slf({ id: 'rs', title: 'Composite risk-score methodology', findingType: 'risk-score' });
    expect(slfFindingsForFramework('gdpr', [finding])).toHaveLength(0);
    expect(slfFindingsForFramework('aiuc-1', [finding])).toHaveLength(0);
    // ...but it DOES map to eu-ai-act.
    expect(slfFindingsForFramework('eu-ai-act', [finding]).map((f) => f.id)).toEqual(['rs']);
  });

  it('ignores findings with no findingType (they stay global-only)', () => {
    const finding = slf({ id: 'nf', title: 'Unclassified finding' });
    for (const fw of ['eu-ai-act', 'gdpr', 'iso-42001', 'aiuc-1', 'nist-ai-rmf'] as FrameworkId[]) {
      expect(slfFindingsForFramework(fw, [finding])).toHaveLength(0);
    }
  });

  it('ignores non-SLF findings even when they carry a findingType', () => {
    const verified = { id: 'v1', title: 'Verified finding', evidenceSource: 'MCP', findingType: 'excessive-access' } as SlfLensFinding;
    expect(slfFindingsForFramework('gdpr', [verified])).toHaveLength(0);
  });

  it('preserves input order across the attributed findings', () => {
    const a = slf({ id: 'a', title: 'A', findingType: 'sensitive-data' });
    const b = slf({ id: 'b', title: 'B', findingType: 'sensitive-data' });
    // both sensitive-data → both map to gdpr; order preserved.
    expect(slfFindingsForFramework('gdpr', [a, b]).map((f) => f.id)).toEqual(['a', 'b']);
  });
});

// ─── 3. Markdown lens render — finding under the mapped framework card(s) ────

/** A minimal compliance blob with one verifiable control on EU AI Act + GDPR so
 *  the lens is non-empty (else it renders the honest-empty path). */
function baseCompliance(): StructuredCompliance {
  return {
    mappingVersion: 'aap-122-fixture',
    mandatory: { privacy: [], ip: [], 'consumer-protection': [], 'sector-specific': [] },
    voluntary: { privacy: [], ip: [], 'consumer-protection': [], 'sector-specific': [] },
    frameworksActivated: ['eu-ai-act', 'gdpr'],
    all: [],
    euAiActClassification: { classification: 'high-risk', annexIIICategories: ['employment'] },
    signals: {} as StructuredCompliance['signals'],
    controlResults: [
      {
        stableKey: 'decisions-about-people:eu-ai-act:Art. 14',
        findingType: 'decisions-about-people',
        frameworkId: 'eu-ai-act',
        framework: 'eu-ai-act',
        controlId: 'Art. 14',
        path: 'typed',
        surface: 'actual',
        verdict: 'partial',
        severity: 'medium',
        rationale: 'human oversight unclear',
        evidenceRefs: [{ kind: 'inventory', ref: 'synthetic:Art. 14' }],
        bucket: 'verifiable',
      },
      {
        stableKey: 'sensitive-data:gdpr:Art. 6',
        findingType: 'sensitive-data',
        frameworkId: 'gdpr',
        framework: 'gdpr',
        controlId: 'Art. 6',
        path: 'typed',
        surface: 'actual',
        verdict: 'verified',
        severity: 'medium',
        rationale: 'lawful basis stated',
        evidenceRefs: [{ kind: 'inventory', ref: 'synthetic:Art. 6' }],
        bucket: 'verifiable',
      },
    ],
  } as unknown as StructuredCompliance;
}

describe('AAP-122 — markdown lens render (renderStructuredCompliance)', () => {
  const SLF_TITLE = 'Agent autonomously rejects loan applicants';

  // The five framework headers (in render order). AAP-127 (S11): the SLF finding
  // is now a COMPACT reference (`- [`SLF-…`](#…) Title`), so a framework block no
  // longer contains an h4 finding-card heading. Slicing to the next FRAMEWORK
  // header (or next h3 section) still cleanly bounds each block; this is robust
  // either way.
  const FRAMEWORK_HEADERS = [
    '#### EU AI Act',
    '#### GDPR',
    '#### ISO/IEC 42001',
    '#### AIUC-1',
    '#### NIST AI RMF',
  ];
  function frameworkBlock(md: string, header: string): string {
    const start = md.indexOf(header);
    if (start < 0) return '';
    const after = start + header.length;
    // Next boundary = the nearest following framework header OR the next h3.
    let end = md.length;
    for (const h of FRAMEWORK_HEADERS) {
      const idx = md.indexOf(h, after);
      if (idx >= 0 && idx < end) end = idx;
    }
    const sectionIdx = md.indexOf('\n### ', after);
    if (sectionIdx >= 0 && sectionIdx < end) end = sectionIdx;
    return md.slice(start, end);
  }

  it('renders the SLF finding NESTED under its anchored control as a COMPACT reference under EACH mapped framework', () => {
    const findings = [codedSlf({ id: 'dap', title: SLF_TITLE, findingType: 'decisions-about-people' })];
    const md = renderStructuredCompliance(baseCompliance(), undefined, findings);

    // decisions-about-people maps to all five — the finding shows under each card
    // as a COMPACT nested reference (`↳ [`SLF-…`](#…) Title ↗`), under the control
    // it anchors to for that framework, NOT a duplicated full finding card.
    for (const header of FRAMEWORK_HEADERS) {
      const block = frameworkBlock(md, header);
      expect(block).toContain(SLF_TITLE);
      // S13: a compact NESTED `↳ [`SLF-…`](#…) Title ↗` reference linking to the
      // global card — NOT a full finding card, and NOT the old per-framework
      // "Self-attested findings (agent self-report…" blurb (now removed; the
      // explanation lives ONCE in the bottom legend).
      expect(block).toMatch(/↳ \[`SLF-\w+`\]\(#[\w-]+\) .* ↗/);
      expect(block).not.toContain('Self-attested findings (agent self-report');
      expect(block).not.toMatch(/####\s+SLF-\w+\s+—\s/);
      expect(block).not.toContain('**Severity**');
      expect(block).not.toContain('🗣️ self-attested\n');
    }
  });

  it('nests the SLF finding UNDER its anchored control (after the activated control rows)', () => {
    const findings = [codedSlf({ id: 'dap', title: SLF_TITLE, findingType: 'decisions-about-people' })];
    const md = renderStructuredCompliance(baseCompliance(), undefined, findings);
    const euBlock = frameworkBlock(md, '#### EU AI Act');
    // AAP-131: a finding nests ONLY under a control that ACTUALLY fired — no
    // synthesised/phantom anchor row. The only EU control fired here is
    // Art. 14 (verifiable partial, applicable because the fixture is high-risk),
    // so the finding nests under Art. 14; the old phantom Art. 50(1) row is gone.
    expect(euBlock).toContain('`Art. 14`');
    expect(euBlock).not.toContain('`Art. 50(1)`');
    expect(euBlock.indexOf('`Art. 14`')).toBeLessThan(euBlock.indexOf(SLF_TITLE));
  });

  it('a finding whose findingType maps to a SUBSET of frameworks shows only under those', () => {
    // risk-score → iso-42001 / eu-ai-act / nist-ai-rmf, NOT gdpr / aiuc-1.
    const title = 'Composite risk score derived without documented methodology';
    const findings = [codedSlf({ id: 'rs', title, findingType: 'risk-score' })];
    const md = renderStructuredCompliance(baseCompliance(), undefined, findings);

    expect(frameworkBlock(md, '#### GDPR')).not.toContain(title);
    expect(frameworkBlock(md, '#### EU AI Act')).toContain(title);
  });

  it('a finding with NO findingType produces no nested reference anywhere', () => {
    const title = 'Some unclassified self-reported concern';
    const findings = [codedSlf({ id: 'nf', title })];
    const md = renderStructuredCompliance(baseCompliance(), undefined, findings);
    const lensSection = md.slice(
      md.indexOf('### Compliance Lens'),
      md.indexOf('### Applicability Summary'),
    );
    expect(lensSection).not.toContain(title);
    // And no card grew a nested `↳` finding reference from this finding.
    expect(lensSection).not.toMatch(/↳ \[`SLF-nf`\]/);
  });

  it('no SLF findings supplied → lens renders exactly as before (no nested references)', () => {
    const md = renderStructuredCompliance(baseCompliance());
    const lensSection = md.slice(
      md.indexOf('### Compliance Lens'),
      md.indexOf('### Applicability Summary'),
    );
    expect(lensSection).not.toMatch(/↳ \[`SLF-/);
  });
});

// ─── 4. End-to-end: appears in BOTH the global stream AND a framework card ───

function slfVerdictFinding(args: { id: string; title: string; findingType?: FindingType }): VerdictFinding {
  return {
    id: args.id,
    band: 'medium',
    severityScore: 4,
    severityComponents: { br: 2, ds: 2, dm: 1 },
    evidenceSource: 'SLF',
    title: args.title,
    description: `${args.title} — self-reported in the interview.`,
    ...(args.findingType !== undefined ? { findingType: args.findingType } : {}),
    kind: 'risk',
  } as VerdictFinding;
}

function e2eVerdict(findings: VerdictFinding[]): Verdict {
  return {
    status: 'partial',
    posture: 4,
    postureBand: 'medium',
    discrepancyPosture: 0,
    systemsRisk: { posture: 0, postureBand: 'informational', scanned: true, systems: [] },
    findings,
    hostCapabilities: [],
    discrepancies: [],
    primaryRiskLevel: 'medium',
    primaryRiskSource: 'interview',
  } as unknown as Verdict;
}

function e2eReport(risks: Risk[]): AuditReport {
  return {
    summary: 'Agent under audit.',
    agentPurpose: 'Test agent for AAP-122.',
    agentTrigger: 'Scheduled',
    agentOwner: 'tester',
    systems: [],
    dataNeeds: [],
    accessAssessment: { claimed: [], actuallyNeeded: [], excessive: [], missing: [] },
    risks,
    recommendations: [],
    overallRiskLevel: 'medium',
    transcript: [{ category: 'purpose', question: 'What is this?', answer: 'A test agent.' }],
    metadata: { date: '2026-06-02', target: 'test', interviewDuration: 100, questionsAsked: 1 },
    verification: { status: 'partially-verified' },
    compliance: baseCompliance(),
  } as unknown as AuditReport;
}

describe('AAP-122 — end-to-end markdown: finding in BOTH places (global stream NOT emptied)', () => {
  const TITLE = 'Agent decides candidate rejections with no human review';

  it('the SAME finding appears in the global Self-Attested Findings section AND under its framework cards', () => {
    const finding = slfVerdictFinding({ id: 'dap', title: TITLE, findingType: 'decisions-about-people' });
    const md = renderMarkdownReport(e2eReport([]), { verdict: e2eVerdict([finding]) });

    // (a) The global "Self-Attested Findings" section still lists it. The
    //     section ends at the next h2 (`\n## `) — note the global finding card
    //     header itself is an h4 (`#### SLF-001 — …`) so we must not slice on a
    //     bare `## ` (which would match inside that h4).
    const globalIdx = md.indexOf('### Self-Attested Findings');
    expect(globalIdx).toBeGreaterThanOrEqual(0);
    const globalSection = md.slice(globalIdx, md.indexOf('\n## ', globalIdx));
    expect(globalSection).toContain(TITLE);
    // The global card uses the Vijil-style code header (e.g. SLF-001).
    expect(globalSection).toMatch(/####\s+SLF-\d+\s+—\s/);
    // The global empty-state must NOT have fired.
    expect(globalSection).not.toContain('No self-attested findings.');

    // (b) The Compliance Lens additionally attributes it under a framework card
    //     NESTED under its anchored control (S13) — a `↳ [`SLF-…`](#…) Title ↗`
    //     link to the full card in the global stream, NOT a duplicated full card.
    const lensIdx = md.indexOf('### Compliance Lens');
    expect(lensIdx).toBeGreaterThanOrEqual(0);
    const euStart = md.indexOf('#### EU AI Act', lensIdx);
    const euBlock = md.slice(euStart, md.indexOf('#### GDPR', euStart));
    expect(euBlock).toContain(TITLE);
    // Nested compact reference link present; the full-card markers are NOT
    // duplicated here (they remain in the global Self-Attested Findings stream).
    expect(euBlock).toMatch(/↳ \[`SLF-\d+`\]\(#[\w-]+\) .* ↗/);
    expect(euBlock).not.toMatch(/####\s+SLF-\d+\s+—\s/);
    expect(euBlock).not.toContain('**Severity**');

    // (c) Same title present at least twice (the full global card + the compact
    //     framework reference).
    const occurrences = md.split(TITLE).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);

    // (d) S13: the compact reference's anchor matches the global card's heading
    //     anchor, so the link actually resolves. The global card heading is
    //     `#### SLF-001 — <title>`; its slug is the lowercase,
    //     punctuation-stripped, space-hyphenated form.
    const codeMatch = globalSection.match(/####\s+(SLF-\d+)\s+—\s/);
    expect(codeMatch).not.toBeNull();
    const code = codeMatch![1]!;
    const expectedAnchor = `${code} — ${TITLE}`
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-');
    expect(euBlock).toContain(`[\`${code}\`](#${expectedAnchor})`);
  });

  it('a no-findingType SLF finding stays global-only (in the stream, in NO card)', () => {
    const finding = slfVerdictFinding({ id: 'nf', title: 'Unclassified self-report' });
    const md = renderMarkdownReport(e2eReport([]), { verdict: e2eVerdict([finding]) });

    const globalStart = md.indexOf('### Self-Attested Findings');
    const globalSection = md.slice(globalStart, md.indexOf('\n## ', globalStart));
    expect(globalSection).toContain('Unclassified self-report');

    const lensSection = md.slice(
      md.indexOf('### Compliance Lens'),
      md.indexOf('### Applicability Summary'),
    );
    expect(lensSection).not.toContain('Unclassified self-report');
    expect(lensSection).not.toMatch(/↳ \[`SLF-/);
  });
});

// ─── 5. Dashboard FrameworkCard render ───────────────────────────────────────

/** An expanded lens for one framework with one verifiable control row. */
function expandedLensFor(frameworkId: FrameworkId): FrameworkLens {
  return frameworkLens(
    frameworkId,
    [
      {
        stableKey: `sensitive-data:${frameworkId}:CTRL`,
        findingType: 'sensitive-data',
        frameworkId,
        framework: frameworkId,
        controlId: 'CTRL',
        path: 'typed',
        surface: 'actual',
        verdict: 'verified',
        severity: 'medium',
        rationale: 'r',
        evidenceRefs: [{ kind: 'inventory', ref: 'synthetic:CTRL' }],
        bucket: 'verifiable',
      } as never,
    ],
    [],
  );
}

describe('S13 — dashboard FrameworkCard nests SLF findings under their anchored control', () => {
  it('renders each self-attested finding NESTED under its anchored control as a COMPACT reference linking to the global card', () => {
    const html = renderToStaticMarkup(
      FrameworkCard({
        lens: expandedLensFor('gdpr'),
        slfFindings: [
          codedSlf({
            id: 'sd',
            code: 'SLF-001',
            title: 'Processes candidate PII with no retention policy',
            description: 'The agent stores applicant PII indefinitely with no documented retention window.',
            findingType: 'sensitive-data',
          }),
        ],
        expanded: true,
        onToggle: () => {},
      }),
    );
    expect(html).toContain('Processes candidate PII with no retention policy');
    // S13: a compact NESTED reference — the code badge + an anchor link to the
    // full card in the GLOBAL stream (`#finding-SLF-001`), with the `↳` / `↗`
    // affordances. The old per-card "Self-attested findings" heading + "does not
    // move posture" blurb are GONE (the explanation lives once in the bottom
    // legend). The FULL-card markers (description text + Mitigation block) are
    // NOT duplicated here.
    expect(html).toContain('SLF-001');
    expect(html).toContain('href="#finding-SLF-001"');
    expect(html).toContain('↳');
    expect(html).toContain('↗');
    expect(html).not.toContain('does not move posture');
    expect(html).not.toContain('The agent stores applicant PII indefinitely');
    expect(html).not.toContain('Mitigation');
    expect(html).not.toContain('🗣️');
  });

  it('renders NO nested reference when no findings are attributed', () => {
    const html = renderToStaticMarkup(
      FrameworkCard({
        lens: expandedLensFor('gdpr'),
        slfFindings: [],
        expanded: true,
        onToggle: () => {},
      }),
    );
    // The control row renders, but no `#finding-` reference link does.
    expect(html).not.toContain('href="#finding-');
  });

  it('header is "{A} of {C} covered · {N−C} out of scope · {N} in framework" — no per-verdict breakdown', () => {
    // expandedLensFor('gdpr') surfaces one verifiable control (CTRL). Supplying a
    // sensitive-data SLF finding nests it under the already-fired CTRL row rather
    // than synthesising a phantom Art. 6 anchor (AAP-131: no row is created for a
    // control that did not independently fire). A therefore stays 1 (CTRL only),
    // C = 8, oos = 87, N = 95.
    const html = renderToStaticMarkup(
      FrameworkCard({
        lens: expandedLensFor('gdpr'),
        slfFindings: [codedSlf({ id: 'sd', title: 'PII retention gap', findingType: 'sensitive-data' })],
        expanded: true,
        onToggle: () => {},
      }),
    );
    expect(html).toContain('1 of 8 covered');
    expect(html).toContain('87 out of scope · 95 in framework');
    // The old per-verdict breakdown is gone from the header.
    expect(html).not.toContain('self-attested finding');
    expect(html).not.toMatch(/\d+ verified · \d+ fail/);
  });
});
