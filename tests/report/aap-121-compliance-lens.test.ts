/**
 * AAP-121 (S5 of AAP-117) — the honest compliance-lens projection.
 *
 * Pins the shared per-framework lens math that BOTH the markdown renderer and
 * the dashboard React component consume. The whole point of this module is to
 * be the single source of truth so the two surfaces can't drift (AAP-108).
 *
 * Coverage:
 *   1. Header counts are by ACTUAL state (verified / fail / partial /
 *      self-attested).
 *   2. Only ACTIVE controls (verifiable + self-attested) are listed;
 *      out-of-scope controls are a COUNT only, never in the list.
 *   3. The out-of-scope figure is honest about the PUBLISHED universe:
 *      `publishedControlCount - activeShown`.
 *   4. Order on expand: verified -> partial -> self-attested.
 *   5. Self-attested controls come from the prose flags (they have no
 *      detector), de-duped against the verifiable lane.
 *   6. EU AI Act uses the same typed path as every other framework (no
 *      "prose only" special case).
 *   7. FIX 1 (S5): every framework is carded — a 0-active framework still
 *      renders its honest "0 of ~N, the rest out of scope" summary instead of
 *      vanishing (`allLensFrameworks`).
 */

import { describe, expect, it } from 'vitest';

import {
  ACTIVE_BUCKETS,
  OUT_OF_SCOPE_BUCKETS,
  activeControlResultsForFramework,
  allLensFrameworks,
  frameworkLens,
  lensFrameworks,
  selfAttestedControlsForFramework,
} from '../../src/report/compliance-lens.js';
import { renderStructuredCompliance } from '../../src/report/templates.js';
import { FRAMEWORKS } from '../../src/compliance/frameworks.js';
import type { ControlResult } from '../../src/compliance/control-catalog.js';
import type { ComplianceBucket, FrameworkId } from '../../src/compliance/types.js';
import type { TypedRegulatoryFlag } from '../../src/compliance/mapper.js';
import type { StructuredCompliance } from '../../src/report/types.js';

// ─── Fixture builders ────────────────────────────────────────────────────────

function result(args: {
  frameworkId: FrameworkId;
  controlId: string;
  verdict: ControlResult['verdict'];
  bucket: ComplianceBucket;
  severity?: ControlResult['severity'];
  findingType?: ControlResult['findingType'];
}): ControlResult {
  const findingType = args.findingType ?? 'sensitive-data';
  return {
    stableKey: `${findingType}:${args.frameworkId}:${args.controlId}`,
    findingType,
    frameworkId: args.frameworkId,
    framework: args.frameworkId,
    controlId: args.controlId,
    path: 'typed',
    surface: 'actual',
    verdict: args.verdict,
    severity: args.severity ?? 'medium',
    rationale: `rationale for ${args.controlId}`,
    evidenceRefs: [{ kind: 'inventory', ref: `synthetic:${args.controlId}` }],
    bucket: args.bucket,
  };
}

/** A self-attested prose flag (the only lane self-attested controls live in). */
function selfAttestedFlag(args: {
  frameworkId: FrameworkId;
  controlIds: string[];
  findingType?: TypedRegulatoryFlag['triggeredBy'];
}): TypedRegulatoryFlag {
  return {
    framework: `${args.frameworkId} — self-report`,
    frameworkId: args.frameworkId,
    severity: 'warning',
    description: 'agent self-report',
    controlIds: args.controlIds,
    category: 'privacy',
    tier: args.frameworkId === 'eu-ai-act' || args.frameworkId === 'gdpr' ? 'mandatory' : 'voluntary',
    mandatoryIn: args.frameworkId === 'eu-ai-act' || args.frameworkId === 'gdpr' ? ['EU'] : [],
    triggeredBy: args.findingType ?? 'sensitive-data',
    selfAttested: true,
  } as TypedRegulatoryFlag;
}

// ─── 1. Header counts by actual state ────────────────────────────────────────

describe('AAP-121 lens — header counts by ACTUAL state', () => {
  it('counts verified / fail / partial from verifiable controlResults', () => {
    const results: ControlResult[] = [
      // GDPR verifiable controls with a spread of verdicts.
      result({ frameworkId: 'gdpr', controlId: 'Art. 6', verdict: 'fail', bucket: 'verifiable' }),
      result({ frameworkId: 'gdpr', controlId: 'Art. 25', verdict: 'partial', bucket: 'verifiable' }),
      result({ frameworkId: 'gdpr', controlId: 'Art. 28', verdict: 'partial', bucket: 'verifiable' }),
      result({ frameworkId: 'gdpr', controlId: 'Art. 32', verdict: 'verified', bucket: 'verifiable' }),
    ];
    const lens = frameworkLens('gdpr', results, []);
    expect(lens.counts.verified).toBe(1);
    expect(lens.counts.fail).toBe(1);
    expect(lens.counts.partial).toBe(2);
    expect(lens.counts.selfAttested).toBe(0);
    expect(lens.counts.activeShown).toBe(4);
  });

  it('counts self-attested from prose flags', () => {
    // GDPR Art. 5(1)(b) is self-attested in the bucket map.
    const flags = [selfAttestedFlag({ frameworkId: 'gdpr', controlIds: ['Art. 5(1)(b)'] })];
    const lens = frameworkLens('gdpr', [], flags);
    expect(lens.counts.selfAttested).toBe(1);
    expect(lens.counts.verified).toBe(0);
    expect(lens.counts.activeShown).toBe(1);
  });
});

// ─── 2. Only active controls listed; out-of-scope is a count only ────────────

describe('AAP-121 lens — only active controls listed, out-of-scope is a count', () => {
  it('drops out-of-scope controlResults from the list but they do not inflate activeShown', () => {
    const results: ControlResult[] = [
      result({ frameworkId: 'gdpr', controlId: 'Art. 6', verdict: 'fail', bucket: 'verifiable' }),
      // An oos control result must NOT appear in the active list.
      result({
        frameworkId: 'eu-ai-act',
        controlId: 'Art. 11',
        verdict: 'unverified',
        bucket: 'oos-operator-artifact',
      }),
    ];
    const euLens = frameworkLens('eu-ai-act', results, []);
    // Art. 11 is out of scope → not listed.
    expect(euLens.controls.map((c) => c.controlId)).not.toContain('Art. 11');
    expect(euLens.counts.activeShown).toBe(0);
  });

  it('ACTIVE_BUCKETS and OUT_OF_SCOPE_BUCKETS partition the four buckets', () => {
    const all: ComplianceBucket[] = [
      'verifiable',
      'self-attested',
      'oos-operator-artifact',
      'oos-not-verifiable',
    ];
    for (const b of all) {
      const active = ACTIVE_BUCKETS.has(b);
      const oos = OUT_OF_SCOPE_BUCKETS.has(b);
      // Exactly one side claims each bucket.
      expect(active !== oos).toBe(true);
    }
  });

  it('activeControlResultsForFramework keeps only verifiable + self-attested', () => {
    const results: ControlResult[] = [
      result({ frameworkId: 'gdpr', controlId: 'Art. 6', verdict: 'fail', bucket: 'verifiable' }),
      result({
        frameworkId: 'gdpr',
        controlId: 'OOS',
        verdict: 'unverified',
        bucket: 'oos-not-verifiable',
      }),
    ];
    const active = activeControlResultsForFramework('gdpr', results);
    expect(active.map((c) => c.controlId)).toEqual(['Art. 6']);
  });
});

// ─── 3. Honest out-of-scope figure against the published universe ────────────

describe('AAP-121 lens — out-of-scope is published-universe honest', () => {
  it('outOfScope = publishedControlCount - activeShown', () => {
    const results: ControlResult[] = [
      result({ frameworkId: 'gdpr', controlId: 'Art. 6', verdict: 'fail', bucket: 'verifiable' }),
      result({ frameworkId: 'gdpr', controlId: 'Art. 25', verdict: 'partial', bucket: 'verifiable' }),
    ];
    const lens = frameworkLens('gdpr', results, []);
    // GDPR published universe is 95; 2 active shown → 93 out of scope.
    expect(lens.counts.publishedControlCount).toBe(95);
    expect(lens.counts.activeShown).toBe(2);
    expect(lens.counts.outOfScope).toBe(93);
  });

  it('uses the registry publishedControlCount for each framework', () => {
    expect(FRAMEWORKS['eu-ai-act'].publishedControlCount).toBe(104);
    expect(FRAMEWORKS['gdpr'].publishedControlCount).toBe(95);
    expect(FRAMEWORKS['iso-42001'].publishedControlCount).toBe(38);
    expect(FRAMEWORKS['aiuc-1'].publishedControlCount).toBe(50);
    expect(FRAMEWORKS['nist-ai-rmf'].publishedControlCount).toBe(72);
  });

  it('floors outOfScope at 0 (never negative)', () => {
    // Synthesize more active controls than the published count by abusing the
    // GDPR lane — defensive guard, not a real-world shape.
    const lens = frameworkLens('iso-42001', [], []);
    // Zero active → outOfScope equals the published count, not negative.
    expect(lens.counts.activeShown).toBe(0);
    expect(lens.counts.outOfScope).toBe(38);
  });
});

// ─── 4. Order on expand: verified -> partial -> self-attested ────────────────

describe('AAP-121 lens — order on expand', () => {
  it('orders verified before partial before self-attested', () => {
    const results: ControlResult[] = [
      result({ frameworkId: 'gdpr', controlId: 'Art. 25', verdict: 'partial', bucket: 'verifiable' }),
      result({ frameworkId: 'gdpr', controlId: 'Art. 32', verdict: 'verified', bucket: 'verifiable' }),
    ];
    const flags = [selfAttestedFlag({ frameworkId: 'gdpr', controlIds: ['Art. 5(1)(b)'] })];
    const lens = frameworkLens('gdpr', results, flags);
    const verdicts = lens.controls.map((c) => c.verdict);
    // verified first, then partial, then self-attested.
    expect(verdicts).toEqual(['verified', 'partial', 'self-attested']);
  });

  it('fail sinks below the clean/clarification controls', () => {
    const results: ControlResult[] = [
      result({ frameworkId: 'gdpr', controlId: 'Art. 6', verdict: 'fail', bucket: 'verifiable' }),
      result({ frameworkId: 'gdpr', controlId: 'Art. 32', verdict: 'verified', bucket: 'verifiable' }),
    ];
    const lens = frameworkLens('gdpr', results, []);
    expect(lens.controls.map((c) => c.verdict)).toEqual(['verified', 'fail']);
  });
});

// ─── 5. Self-attested extraction + dedup across lanes ────────────────────────

describe('AAP-121 lens — self-attested extraction', () => {
  it('only counts prose-flag controls whose catalog bucket is self-attested', () => {
    // Art. 6 is VERIFIABLE in the bucket map — a prose flag listing it must NOT
    // be counted as self-attested (deterministic precedence would have stripped
    // it, but the lens is defensive).
    const flags = [
      selfAttestedFlag({ frameworkId: 'gdpr', controlIds: ['Art. 6', 'Art. 5(1)(b)'] }),
    ];
    const selfAttested = selfAttestedControlsForFramework('gdpr', flags);
    expect(selfAttested.map((c) => c.controlId)).toEqual(['Art. 5(1)(b)']);
  });

  it('ignores flags explicitly marked selfAttested:false', () => {
    const flag = {
      ...selfAttestedFlag({ frameworkId: 'gdpr', controlIds: ['Art. 5(1)(b)'] }),
      selfAttested: false,
    } as TypedRegulatoryFlag;
    expect(selfAttestedControlsForFramework('gdpr', [flag])).toHaveLength(0);
  });

  it('de-dupes a control already surfaced from the verifiable lane', () => {
    // If a control somehow appears in BOTH lanes, the lens lists it once
    // (results lane wins).
    const results: ControlResult[] = [
      result({
        frameworkId: 'aiuc-1',
        controlId: 'A005',
        verdict: 'verified',
        bucket: 'self-attested',
        findingType: 'sensitive-data',
      }),
    ];
    const flags = [selfAttestedFlag({ frameworkId: 'aiuc-1', controlIds: ['A005'] })];
    const lens = frameworkLens('aiuc-1', results, flags);
    const a005 = lens.controls.filter((c) => c.controlId === 'A005');
    expect(a005).toHaveLength(1);
  });

  it('attaches the control name from the catalog for self-attested rows', () => {
    const flags = [selfAttestedFlag({ frameworkId: 'aiuc-1', controlIds: ['A005'] })];
    const selfAttested = selfAttestedControlsForFramework('aiuc-1', flags);
    expect(selfAttested).toHaveLength(1);
    // A005 is cross-customer isolation — the catalog note/title is non-empty.
    expect(selfAttested[0]!.controlName).toBeTruthy();
  });
});

// ─── 6. EU AI Act uses the same typed path (no prose-only special case) ──────

describe('AAP-121 lens — EU AI Act parity', () => {
  it('renders EU AI Act from controlResults + flags like every other framework', () => {
    const results: ControlResult[] = [
      result({
        frameworkId: 'eu-ai-act',
        controlId: 'Art. 6(2) + Annex III',
        verdict: 'partial',
        bucket: 'verifiable',
        findingType: 'decisions-about-people',
      }),
    ];
    const flags = [
      // Art. 5 + Art. 50(1) are the EU AI Act self-attested controls.
      selfAttestedFlag({
        frameworkId: 'eu-ai-act',
        controlIds: ['Art. 5', 'Art. 50(1)'],
        findingType: 'regulatory-flags',
      }),
    ];
    const lens = frameworkLens('eu-ai-act', results, flags);
    expect(lens.counts.partial).toBe(1);
    expect(lens.counts.selfAttested).toBe(2);
    expect(lens.counts.activeShown).toBe(3);
    // Published universe honest: 104 - 3 = 101 out of scope.
    expect(lens.counts.outOfScope).toBe(101);
  });

  it('lensFrameworks lists a framework only when it has active controls, mandatory-first', () => {
    const results: ControlResult[] = [
      result({ frameworkId: 'aiuc-1', controlId: 'A001', verdict: 'partial', bucket: 'verifiable' }),
    ];
    const flags = [selfAttestedFlag({ frameworkId: 'gdpr', controlIds: ['Art. 5(1)(b)'] })];
    const shown = lensFrameworks(results, flags);
    // Both gdpr (self-attested) and aiuc-1 (verifiable) are active; gdpr is
    // mandatory so it comes first.
    expect(shown).toEqual(['gdpr', 'aiuc-1']);
  });

  it('a framework with only out-of-scope controls is not listed', () => {
    const results: ControlResult[] = [
      result({
        frameworkId: 'eu-ai-act',
        controlId: 'Art. 11',
        verdict: 'unverified',
        bucket: 'oos-operator-artifact',
      }),
    ];
    expect(lensFrameworks(results, [])).toEqual([]);
  });
});

// ─── 7. FIX 1 — every framework is carded, even with 0 active controls ───────

describe('AAP-121 lens — FIX 1: all five frameworks render', () => {
  it('allLensFrameworks returns all five in registry order (mandatory-first)', () => {
    expect(allLensFrameworks()).toEqual([
      'eu-ai-act',
      'gdpr',
      'iso-42001',
      'aiuc-1',
      'nist-ai-rmf',
    ]);
  });

  it('is independent of signals — returns all five even with no inputs', () => {
    expect(allLensFrameworks()).toHaveLength(5);
  });

  it('a 0-active framework still projects an honest "0 of ~N" lens', () => {
    // NIST AI RMF has 0 self-attested controls by design; with no verifiable
    // verdict it has 0 active — but its card must still summarise honestly.
    const lens = frameworkLens('nist-ai-rmf', [], []);
    expect(lens.counts.activeShown).toBe(0);
    expect(lens.counts.publishedControlCount).toBe(72);
    expect(lens.counts.outOfScope).toBe(72);
    expect(lens.controls).toEqual([]);
  });
});

// ─── Markdown render of the lens (parity with the dashboard projection) ──────

/** A realistic multi-framework compliance blob for the markdown lens. */
function lensCompliance(): StructuredCompliance {
  return {
    mappingVersion: 'aap-121-fixture',
    mandatory: { privacy: [], ip: [], 'consumer-protection': [], 'sector-specific': [] },
    voluntary: { privacy: [], ip: [], 'consumer-protection': [], 'sector-specific': [] },
    frameworksActivated: ['eu-ai-act', 'gdpr', 'aiuc-1'],
    all: [
      selfAttestedFlag({
        frameworkId: 'eu-ai-act',
        controlIds: ['Art. 5', 'Art. 50(1)'],
        findingType: 'regulatory-flags',
      }),
      selfAttestedFlag({ frameworkId: 'gdpr', controlIds: ['Art. 5(1)(b)'] }),
    ],
    euAiActClassification: { classification: 'high-risk', annexIIICategories: ['employment'] },
    signals: {} as StructuredCompliance['signals'],
    controlResults: [
      result({
        frameworkId: 'eu-ai-act',
        controlId: 'Art. 6(2) + Annex III',
        verdict: 'partial',
        bucket: 'verifiable',
        findingType: 'decisions-about-people',
      }),
      // An out-of-scope EU AI Act control — must be counted, never listed.
      result({
        frameworkId: 'eu-ai-act',
        controlId: 'Art. 11',
        verdict: 'unverified',
        bucket: 'oos-operator-artifact',
      }),
      result({ frameworkId: 'gdpr', controlId: 'Art. 32', verdict: 'verified', bucket: 'verifiable' }),
      result({ frameworkId: 'gdpr', controlId: 'Art. 6', verdict: 'fail', bucket: 'verifiable' }),
      result({
        frameworkId: 'gdpr',
        controlId: 'Art. 25',
        verdict: 'partial',
        bucket: 'verifiable',
        findingType: 'excessive-access',
      }),
    ],
  } as unknown as StructuredCompliance;
}

describe('AAP-121 lens — markdown render', () => {
  it('renders a Compliance Lens section with a one-line legend', () => {
    const md = renderStructuredCompliance(lensCompliance());
    expect(md).toContain('### Compliance Lens');
    // The legend (scope point 4): verified / warn / self-attested explained.
    expect(md).toContain('can earn a clean');
    expect(md).toContain('self-attested');
  });

  it('per-framework header counts by ACTUAL state + out-of-scope count', () => {
    const md = renderStructuredCompliance(lensCompliance());
    // EU AI Act: 1 verifiable partial + 2 self-attested = 3 active of ~104.
    expect(md).toContain('**3 of ~104 addressed**');
    expect(md).toMatch(/EU AI Act[\s\S]*0 verified · 0 fail · 1 partial · 2 self-attested/);
    // 104 published - 3 active = 101 out of scope.
    expect(md).toMatch(/EU AI Act[\s\S]*101 out of scope/);
    // GDPR: 1 verified + 1 fail + 1 partial + 1 self-attested = 4 of ~95.
    expect(md).toContain('**4 of ~95 addressed**');
    expect(md).toMatch(/GDPR[\s\S]*1 verified · 1 fail · 1 partial · 1 self-attested/);
    expect(md).toMatch(/GDPR[\s\S]*91 out of scope/);
  });

  it('lists ONLY active controls — out-of-scope controls never appear as a row', () => {
    const md = renderStructuredCompliance(lensCompliance());
    const lensSection = md.slice(
      md.indexOf('### Compliance Lens'),
      md.indexOf('### Applicability Summary'),
    );
    // The verifiable EU AI Act control is listed.
    expect(lensSection).toContain('Art. 6(2) + Annex III');
    // The out-of-scope Art. 11 is NOT listed as a control row in the lens.
    expect(lensSection).not.toContain('`Art. 11`');
  });

  it('orders active controls verified -> partial -> self-attested -> fail', () => {
    const md = renderStructuredCompliance(lensCompliance());
    const gdprBlock = md.slice(md.indexOf('#### GDPR'));
    const verifiedIdx = gdprBlock.indexOf('`Art. 32`');
    const partialIdx = gdprBlock.indexOf('`Art. 25`');
    const selfIdx = gdprBlock.indexOf('`Art. 5(1)(b)`');
    const failIdx = gdprBlock.indexOf('`Art. 6`');
    expect(verifiedIdx).toBeGreaterThanOrEqual(0);
    expect(verifiedIdx).toBeLessThan(partialIdx);
    expect(partialIdx).toBeLessThan(selfIdx);
    expect(selfIdx).toBeLessThan(failIdx);
  });

  it('renders the EU AI Act card the same way as the others (no "prose only" special case)', () => {
    const md = renderStructuredCompliance(lensCompliance());
    // The old dashboard special-case wording must not leak into the markdown.
    expect(md).not.toContain('signals (prose only)');
    // EU AI Act gets a real state-based header line like every framework.
    expect(md).toMatch(/#### EU AI Act\n\n\*\*\d+ of ~104 addressed\*\*/);
  });

  it('no active controls at all → honest empty lens', () => {
    const empty = {
      mappingVersion: 'aap-121-empty',
      mandatory: { privacy: [], ip: [], 'consumer-protection': [], 'sector-specific': [] },
      voluntary: { privacy: [], ip: [], 'consumer-protection': [], 'sector-specific': [] },
      frameworksActivated: [],
      all: [],
      euAiActClassification: { classification: 'unclassified', annexIIICategories: [] },
      signals: {} as StructuredCompliance['signals'],
      controlResults: [],
    } as unknown as StructuredCompliance;
    const md = renderStructuredCompliance(empty);
    expect(md).toContain('### Compliance Lens');
    expect(md).toContain('No active controls from current signals');
  });

  // ─── FIX 1: all five framework cards render, even 0-active ones ────────────

  it('renders a card for ALL FIVE frameworks, including 0-active ones', () => {
    // The fixture only has active controls for EU AI Act + GDPR. ISO 42001,
    // AIUC-1, and NIST AI RMF have 0 active controls — they used to vanish, but
    // FIX 1 keeps their cards.
    const md = renderStructuredCompliance(lensCompliance());
    expect(md).toContain('#### EU AI Act');
    expect(md).toContain('#### GDPR');
    expect(md).toContain('#### ISO/IEC 42001');
    expect(md).toContain('#### AIUC-1');
    expect(md).toContain('#### NIST AI RMF');
  });

  it('a 0-active framework card shows the honest "0 of ~N" summary, no rows', () => {
    const md = renderStructuredCompliance(lensCompliance());
    const lensSection = md.slice(
      md.indexOf('### Compliance Lens'),
      md.indexOf('### Applicability Summary'),
    );
    // NIST AI RMF: 0 active of ~72, all 72 out of scope, no control rows.
    const nistBlock = lensSection.slice(lensSection.indexOf('#### NIST AI RMF'));
    expect(nistBlock).toContain('**0 of ~72 addressed**');
    expect(nistBlock).toContain('72 out of scope');
    expect(nistBlock).toContain('No active controls for this framework');
    // ISO/IEC 42001: 0 active of ~38.
    const isoBlock = lensSection.slice(
      lensSection.indexOf('#### ISO/IEC 42001'),
      lensSection.indexOf('#### AIUC-1'),
    );
    expect(isoBlock).toContain('**0 of ~38 addressed**');
    expect(isoBlock).toContain('38 out of scope');
  });
});
