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
  anchorControlForFinding,
  composeFrameworkLensRows,
  frameworkLens,
  lensFrameworks,
  selfAttestedControlsForFramework,
  staticCoverageForFramework,
  verdictDisplayLabel,
} from '../../src/report/compliance-lens.js';
import { FINDING_TYPES } from '../../src/compliance/types.js';
import type { FindingType } from '../../src/compliance/types.js';
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
//
// AAP-128 (S12): out-of-scope is now `publishedControlCount - covered` (= N − C,
// STATIC capability) — it no longer depends on the per-audit `activeShown`.

describe('AAP-121/128 lens — out-of-scope is published-universe honest (static)', () => {
  it('outOfScope = publishedControlCount - covered (NOT activeShown)', () => {
    const results: ControlResult[] = [
      result({ frameworkId: 'gdpr', controlId: 'Art. 6', verdict: 'fail', bucket: 'verifiable' }),
      result({ frameworkId: 'gdpr', controlId: 'Art. 25', verdict: 'partial', bucket: 'verifiable' }),
    ];
    const lens = frameworkLens('gdpr', results, []);
    // GDPR published universe is 95; static capability C = 8 → 87 out of scope,
    // regardless of the 2 controls that fired this audit.
    expect(lens.counts.publishedControlCount).toBe(95);
    expect(lens.counts.activeShown).toBe(2);
    expect(lens.counts.covered).toBe(8);
    expect(lens.counts.outOfScope).toBe(87);
  });

  it('uses the registry publishedControlCount for each framework', () => {
    expect(FRAMEWORKS['eu-ai-act'].publishedControlCount).toBe(104);
    expect(FRAMEWORKS['gdpr'].publishedControlCount).toBe(95);
    expect(FRAMEWORKS['iso-42001'].publishedControlCount).toBe(38);
    expect(FRAMEWORKS['aiuc-1'].publishedControlCount).toBe(50);
    expect(FRAMEWORKS['nist-ai-rmf'].publishedControlCount).toBe(72);
  });

  it('floors outOfScope at 0 (never negative) and is C-based even with 0 active', () => {
    const lens = frameworkLens('iso-42001', [], []);
    // Zero active this audit, but static C = 2 → outOfScope = 38 - 2 = 36.
    expect(lens.counts.activeShown).toBe(0);
    expect(lens.counts.covered).toBe(2);
    expect(lens.counts.outOfScope).toBe(36);
  });
});

// ─── 4. Order on expand: severity-primary, verdict tiebreak (AAP-130 / B3) ────

describe('AAP-130 lens — order on expand (severity-primary)', () => {
  it('within one severity, tiebreaks fail -> partial -> ... -> verified', () => {
    // All three default to `medium` severity, so the verdict TIEBREAK decides:
    // partial (1) before verified (4). Self-attested rows carry `info` severity
    // (sentinel), so they sink below the medium rows regardless of verdict.
    const results: ControlResult[] = [
      result({ frameworkId: 'gdpr', controlId: 'Art. 25', verdict: 'partial', bucket: 'verifiable' }),
      result({ frameworkId: 'gdpr', controlId: 'Art. 32', verdict: 'verified', bucket: 'verifiable' }),
    ];
    const flags = [selfAttestedFlag({ frameworkId: 'gdpr', controlIds: ['Art. 5(1)(b)'] })];
    const lens = frameworkLens('gdpr', results, flags);
    const verdicts = lens.controls.map((c) => c.verdict);
    // medium partial, then medium verified, then info self-attested.
    expect(verdicts).toEqual(['partial', 'verified', 'self-attested']);
  });

  it('fail rises above verified at the same severity (worst-first)', () => {
    const results: ControlResult[] = [
      result({ frameworkId: 'gdpr', controlId: 'Art. 6', verdict: 'fail', bucket: 'verifiable' }),
      result({ frameworkId: 'gdpr', controlId: 'Art. 32', verdict: 'verified', bucket: 'verifiable' }),
    ];
    const lens = frameworkLens('gdpr', results, []);
    expect(lens.controls.map((c) => c.verdict)).toEqual(['fail', 'verified']);
  });

  it('severity is the PRIMARY key: a HIGH row outranks a MEDIUM row of any verdict', () => {
    // A high-severity partial must render ABOVE a medium-severity fail — severity
    // dominates the verdict tiebreak. This is the B3 inversion: urgent first.
    const results: ControlResult[] = [
      result({ frameworkId: 'gdpr', controlId: 'Art. 6', verdict: 'fail', bucket: 'verifiable', severity: 'medium' }),
      result({ frameworkId: 'gdpr', controlId: 'Art. 25', verdict: 'partial', bucket: 'verifiable', severity: 'high' }),
    ];
    const lens = frameworkLens('gdpr', results, []);
    expect(lens.controls.map((c) => c.controlId)).toEqual(['Art. 25', 'Art. 6']);
  });

  it('a HIGH-severity partial and a FAIL both rise above an INFO verified/self-attested row', () => {
    const results: ControlResult[] = [
      result({ frameworkId: 'gdpr', controlId: 'Art. 32', verdict: 'verified', bucket: 'verifiable', severity: 'info' }),
      result({ frameworkId: 'gdpr', controlId: 'Art. 6', verdict: 'fail', bucket: 'verifiable', severity: 'high' }),
      result({ frameworkId: 'gdpr', controlId: 'Art. 25', verdict: 'partial', bucket: 'verifiable', severity: 'high' }),
    ];
    const flags = [selfAttestedFlag({ frameworkId: 'gdpr', controlIds: ['Art. 5(1)(b)'] })];
    const lens = frameworkLens('gdpr', results, flags);
    // High fail, then high partial (verdict tiebreak at HIGH). Then the two INFO
    // rows: within info, self-attested (tiebreak 3) sorts above verified (4).
    expect(lens.controls.map((c) => c.controlId)).toEqual([
      'Art. 6',
      'Art. 25',
      'Art. 5(1)(b)',
      'Art. 32',
    ]);
  });
});

// ─── 4b. Verdict display label (AAP-130 / B2) ────────────────────────────────

describe('AAP-130 verdictDisplayLabel — "partial" reads "Needs review"', () => {
  it('relabels only `partial` to "Needs review"; the value stays `partial`', () => {
    expect(verdictDisplayLabel('partial')).toBe('Needs review');
  });

  it('every other verdict displays its own word unchanged', () => {
    expect(verdictDisplayLabel('verified')).toBe('verified');
    expect(verdictDisplayLabel('fail')).toBe('fail');
    expect(verdictDisplayLabel('unverified')).toBe('unverified');
    expect(verdictDisplayLabel('self-attested')).toBe('self-attested');
    expect(verdictDisplayLabel('not-applicable')).toBe('not-applicable');
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
    // AAP-128 (S12): coverage is static C (not the 3 active this audit).
    // AAP-133: Art 14(4)(d) moved verifiable → oos-operator-artifact, so the
    // EU AI Act active-bucket capability C drops 5 → 4; out-of-scope is the
    // static 104 - 4 = 100.
    expect(lens.counts.covered).toBe(4);
    expect(lens.counts.outOfScope).toBe(100);
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

  it('a 0-active framework still projects an honest "C of ~N" lens', () => {
    // NIST AI RMF has 0 self-attested controls by design; with no verifiable
    // verdict it has 0 active THIS audit — but its card must still summarise
    // honestly. AAP-128 (S12): coverage is the STATIC capability C = 4 (it does
    // not collapse to 0 just because nothing fired); out-of-scope = 72 - 4 = 68.
    const lens = frameworkLens('nist-ai-rmf', [], []);
    expect(lens.counts.activeShown).toBe(0);
    expect(lens.counts.covered).toBe(4);
    expect(lens.counts.publishedControlCount).toBe(72);
    expect(lens.counts.outOfScope).toBe(68);
    expect(lens.controls).toEqual([]);
  });
});

// ─── 7b. AAP-128 (S12) — static capability coverage C ────────────────────────

describe('AAP-128 (S12) — coverage C is STATIC (same regardless of what fired)', () => {
  it('staticCoverageForFramework matches the catalog active-bucket count per framework', () => {
    // The capability set: catalog controls bucketed verifiable OR self-attested.
    // Sanity values verified against control-buckets.ts.
    // AAP-133: EU AI Act active-bucket C is 4 (Art 14(4)(d) moved to
    // oos-operator-artifact): Art 6(2)+Annex III verifiable + Art 12 verifiable
    // + Art 5 + Art 50(1) self-attested.
    expect(staticCoverageForFramework('eu-ai-act')).toBe(4);
    expect(staticCoverageForFramework('gdpr')).toBe(8);
    expect(staticCoverageForFramework('aiuc-1')).toBe(13);
    expect(staticCoverageForFramework('iso-42001')).toBe(2);
    expect(staticCoverageForFramework('nist-ai-rmf')).toBe(4);
  });

  it('counts.covered equals the static C no matter which controls actually fired', () => {
    // Audit A: GDPR with two controls firing.
    const auditA = frameworkLens(
      'gdpr',
      [
        result({ frameworkId: 'gdpr', controlId: 'Art. 6', verdict: 'fail', bucket: 'verifiable' }),
        result({ frameworkId: 'gdpr', controlId: 'Art. 32', verdict: 'verified', bucket: 'verifiable' }),
      ],
      [],
    );
    // Audit B: GDPR with a DIFFERENT single control firing.
    const auditB = frameworkLens(
      'gdpr',
      [result({ frameworkId: 'gdpr', controlId: 'Art. 25', verdict: 'partial', bucket: 'verifiable' })],
      [],
    );
    // Audit C: GDPR with NOTHING firing.
    const auditC = frameworkLens('gdpr', [], []);
    // activeShown differs (2 / 1 / 0) but coverage is identical and static.
    expect(auditA.counts.activeShown).toBe(2);
    expect(auditB.counts.activeShown).toBe(1);
    expect(auditC.counts.activeShown).toBe(0);
    expect(auditA.counts.covered).toBe(8);
    expect(auditB.counts.covered).toBe(8);
    expect(auditC.counts.covered).toBe(8);
    // And out-of-scope (N − C) is therefore identical too.
    expect(auditA.counts.outOfScope).toBe(87);
    expect(auditB.counts.outOfScope).toBe(87);
    expect(auditC.counts.outOfScope).toBe(87);
  });
});

// ─── 7c. composeFrameworkLensRows — `surfaced` (A) never exceeds C ───────────
//
// AAP-131 (Option B, strict): a finding attaches to a framework control ONLY IF
// that control INDEPENDENTLY FIRED this audit (it is already a row in
// `lens.controls` from a detector verdict or an independent self-attestation).
// A phantom control row is NEVER synthesised — a finding whose anchor control
// did not fire drops to `orphanFindings`. So every row is an
// independently-fired ACTIVE-bucket control, `surfaced` equals the full visible
// row count, and A ≤ C ≤ N holds by construction.

/** One coded SLF finding for the composer, carrying a findingType. */
function composableFinding(args: { id: string; code: string; findingType: FindingType }) {
  return {
    id: args.id,
    code: args.code,
    title: `finding ${args.findingType}`,
    evidenceSource: 'SLF',
    findingType: args.findingType,
  };
}

/** Every findingType as an SLF finding — fans the worst case across the card. */
function allFindingTypeFindings() {
  return FINDING_TYPES.map((ft, i) =>
    composableFinding({ id: `f${i}`, code: `SLF-${String(i).padStart(3, '0')}`, findingType: ft }),
  );
}

describe('AAP-121 lens — composeFrameworkLensRows surfaced (A) ≤ covered (C)', () => {
  it('drops findings whose anchor control did not fire to orphanFindings — never a synthetic row', () => {
    // ISO 42001 has C = 2 active controls, but with NO controlResults and NO
    // flags, NOTHING fired this audit (`lens.controls` is empty). Every
    // findingType therefore has no fired control to nest under → all findings
    // orphan, NO row is synthesised. (Pre-AAP-131 this synthesised oos rows.)
    const lens = frameworkLens('iso-42001', [], []);
    const findings = allFindingTypeFindings();
    const composed = composeFrameworkLensRows(lens, findings);
    // No control fired → no rows at all; every finding is an orphan.
    expect(composed.rows).toHaveLength(0);
    expect(composed.surfaced).toBe(0);
    // Every finding that maps into this framework lands in the orphan list
    // rather than vanishing or synthesising a phantom row.
    expect(composed.orphanFindings.length).toBeGreaterThan(0);
    expect(composed.surfaced).toBeLessThanOrEqual(staticCoverageForFramework('iso-42001'));
  });

  it('an oos-only mapped finding orphans even when other controls fired', () => {
    // EU AI Act: Art. 6(2) + Annex III fires as a verifiable controlResult (its
    // active row). A finding whose type maps ONLY to out-of-scope EU controls (
    // excessive-access → Art. 9(2)(a) oos-operator-artifact + Art. 15(4-5)
    // oos-not-verifiable) must NOT anchor to anything — anchorControlForFinding
    // returns undefined (no active fallback) — so it orphans and never
    // synthesises an Art. 9(2)(a) ghost row.
    const lens = frameworkLens(
      'eu-ai-act',
      [
        result({
          frameworkId: 'eu-ai-act',
          controlId: 'Art. 6(2) + Annex III',
          verdict: 'partial',
          bucket: 'verifiable',
          findingType: 'decisions-about-people',
        }),
      ],
      [],
    );
    const composed = composeFrameworkLensRows(lens, [
      composableFinding({ id: 'f1', code: 'SLF-001', findingType: 'excessive-access' }),
    ]);
    // Art. 9(2)(a) must NOT appear as a row.
    expect(composed.rows.map((r) => r.control.controlId)).not.toContain('Art. 9(2)(a)');
    // The finding orphaned instead.
    expect(composed.orphanFindings.map((o) => o.code)).toContain('SLF-001');
  });

  it('holds A ≤ C ≤ N and surfaced == visible row count on all five frameworks', () => {
    const findings = allFindingTypeFindings();
    for (const frameworkId of allLensFrameworks()) {
      const lens = frameworkLens(frameworkId, [], []);
      const composed = composeFrameworkLensRows(lens, findings);
      const C = lens.counts.covered;
      const N = lens.counts.publishedControlCount;
      expect(composed.surfaced).toBeLessThanOrEqual(C);
      expect(C).toBeLessThanOrEqual(N);
      // AAP-131: every row is an independently-fired ACTIVE-bucket control, so
      // `surfaced` equals the full visible row count — no uncounted phantoms.
      expect(composed.surfaced).toBe(composed.rows.length);
      const activeRows = composed.rows.filter((r) => ACTIVE_BUCKETS.has(r.control.bucket));
      expect(composed.surfaced).toBe(activeRows.length);
    }
  });

  it('a finding whose anchor control DID fire still nests under it (SLF-001 under GDPR Art. 25)', () => {
    // GDPR Art. 25 fires as a verifiable controlResult AND a finding anchors to
    // it (excessive-access → Art. 25). The finding nests under the fired row;
    // it is a single active row counted once. (AAP-131 acceptance: correct
    // nesting is PRESERVED where the control did fire.)
    const anchor = anchorControlForFinding('gdpr', 'excessive-access');
    expect(anchor?.controlId).toBe('Art. 25');
    expect(ACTIVE_BUCKETS.has(anchor!.bucket)).toBe(true);
    const lens = frameworkLens(
      'gdpr',
      [result({ frameworkId: 'gdpr', controlId: 'Art. 25', verdict: 'partial', bucket: 'verifiable' })],
      [],
    );
    const composed = composeFrameworkLensRows(lens, [
      composableFinding({ id: 'f1', code: 'SLF-001', findingType: 'excessive-access' }),
    ]);
    const art25Rows = composed.rows.filter((r) => r.control.controlId === 'Art. 25');
    expect(art25Rows).toHaveLength(1);
    // The finding nested under the fired row, not orphaned.
    expect(art25Rows[0]!.findings.map((f) => f.code)).toContain('SLF-001');
    expect(composed.orphanFindings).toHaveLength(0);
    expect(composed.surfaced).toBe(1);
  });

  it('the SAME finding nests when its control fired but orphans when it did not', () => {
    // excessive-access → GDPR Art. 25 (active/verifiable). When Art. 25 fired,
    // the finding nests. When NOTHING fired, the identical finding orphans —
    // proving attachment is gated strictly on the control having fired.
    const finding = composableFinding({ id: 'f1', code: 'SLF-001', findingType: 'excessive-access' });

    const firedLens = frameworkLens(
      'gdpr',
      [result({ frameworkId: 'gdpr', controlId: 'Art. 25', verdict: 'verified', bucket: 'verifiable' })],
      [],
    );
    const nested = composeFrameworkLensRows(firedLens, [finding]);
    expect(nested.rows.find((r) => r.control.controlId === 'Art. 25')?.findings.map((f) => f.code)).toContain(
      'SLF-001',
    );
    expect(nested.orphanFindings).toHaveLength(0);

    const emptyLens = frameworkLens('gdpr', [], []);
    const orphaned = composeFrameworkLensRows(emptyLens, [finding]);
    expect(orphaned.rows).toHaveLength(0);
    expect(orphaned.orphanFindings.map((o) => o.code)).toContain('SLF-001');
  });

  it('anchorControlForFinding returns undefined when only out-of-scope controls map (no fallback)', () => {
    // AAP-131 removed the `if (!chosen) chosen = inFramework[0]` out-of-scope
    // fallback. excessive-access maps to EU Art. 9(2)(a) (oos-operator-artifact)
    // with no active EU control, so the anchor must be undefined rather than the
    // out-of-scope Art. 9(2)(a).
    const anchor = anchorControlForFinding('eu-ai-act', 'excessive-access');
    expect(anchor).toBeUndefined();
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

  it('per-framework headline is "{A} of {C} covered · {N−C} out of scope · {N} in framework"', () => {
    const md = renderStructuredCompliance(lensCompliance());
    // S13: the headline is "{A} of {C} covered · {N−C} out of scope · {N} in
    // framework". A = distinct controls surfaced this audit; C = static
    // capability; no `~` prefix; no per-verdict breakdown.
    // EU AI Act: A = 3 (Art. 6(2)+Annex III verifiable + Art. 5 + Art. 50(1)
    // self-attested controls). AAP-133: Art 14(4)(d) moved out of verifiable,
    // so C = 4, oos = 100, N = 104.
    expect(md).toContain('**3 of 4 covered** · 100 out of scope · 104 in framework');
    // GDPR: A = 4 (Art. 32 verified + Art. 6 fail + Art. 25 partial + Art.
    // 5(1)(b) self-attested), C = 8, oos = 87, N = 95.
    expect(md).toContain('**4 of 8 covered** · 87 out of scope · 95 in framework');
    // The verbose per-verdict breakdown and the `~` prefix are GONE.
    expect(md).not.toMatch(/\d+ verified · \d+ fail · \d+ partial · \d+ self-attested/);
    expect(md).not.toContain('of ~');
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

  it('AAP-130 (B3): orders by severity, tiebroken by verdict — fail -> partial -> verified -> self-attested', () => {
    // All four GDPR rows default to `medium` severity except the self-attested
    // Art. 5(1)(b), which carries the `info` sentinel. So the three medium rows
    // sort by the verdict tiebreak (fail -> partial -> verified) and the info
    // self-attested row sinks last.
    const md = renderStructuredCompliance(lensCompliance());
    const gdprBlock = md.slice(md.indexOf('#### GDPR'));
    const failIdx = gdprBlock.indexOf('`Art. 6`');
    const partialIdx = gdprBlock.indexOf('`Art. 25`');
    const verifiedIdx = gdprBlock.indexOf('`Art. 32`');
    const selfIdx = gdprBlock.indexOf('`Art. 5(1)(b)`');
    expect(failIdx).toBeGreaterThanOrEqual(0);
    expect(failIdx).toBeLessThan(partialIdx);
    expect(partialIdx).toBeLessThan(verifiedIdx);
    expect(verifiedIdx).toBeLessThan(selfIdx);
  });

  it('AAP-130 (B2): the partial control badge reads "Needs review", not "partial"', () => {
    const md = renderStructuredCompliance(lensCompliance());
    const gdprBlock = md.slice(md.indexOf('#### GDPR'));
    // Art. 25 is the `partial` control; its badge must say "Needs review".
    const art25Line = gdprBlock.split('\n').find((l) => l.includes('`Art. 25`')) ?? '';
    expect(art25Line).toContain('Needs review');
    expect(art25Line).not.toContain('⚠️ partial');
  });

  it('renders the EU AI Act card the same way as the others (no "prose only" special case)', () => {
    const md = renderStructuredCompliance(lensCompliance());
    // The old dashboard special-case wording must not leak into the markdown.
    expect(md).not.toContain('signals (prose only)');
    // EU AI Act gets the same "{A} of {C} covered · … · {N} in framework"
    // header line as every framework.
    expect(md).toMatch(/#### EU AI Act\n\n\*\*\d+ of 4 covered\*\* · \d+ out of scope · 104 in framework/);
  });

  it('no active controls at all → still renders all five cards with static C-of-N coverage', () => {
    // AAP-127 (S11) FIX 2: the all-or-nothing early-return ("No active controls
    // from current signals") is GONE. Even with zero signals, every framework
    // card renders its honest STATIC capability coverage (AAP-128 / S12), since
    // C is catalog-derived and meaningful regardless of what fired.
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
    // No empty-state escape hatch anymore.
    expect(md).not.toContain('No active controls from current signals');
    // All five cards present. With nothing firing, A = 0 (no controls
    // surfaced); the headline is "0 of {C} covered · {N−C} out of scope · {N}
    // in framework".
    expect(md).toContain('#### EU AI Act');
    // AAP-133: Art 14(4)(d) moved out of verifiable → EU AI Act C = 4, oos = 100.
    expect(md).toContain('**0 of 4 covered** · 100 out of scope · 104 in framework');
    expect(md).toContain('#### GDPR');
    expect(md).toContain('**0 of 8 covered** · 87 out of scope · 95 in framework');
    expect(md).toContain('#### ISO/IEC 42001');
    expect(md).toContain('**0 of 2 covered** · 36 out of scope · 38 in framework');
    expect(md).toContain('#### AIUC-1');
    expect(md).toContain('**0 of 13 covered** · 37 out of scope · 50 in framework');
    expect(md).toContain('#### NIST AI RMF');
    expect(md).toContain('**0 of 4 covered** · 68 out of scope · 72 in framework');
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

  it('a 0-active framework card shows the static "C of ~N covered" summary, no rows', () => {
    const md = renderStructuredCompliance(lensCompliance());
    const lensSection = md.slice(
      md.indexOf('### Compliance Lens'),
      md.indexOf('### Applicability Summary'),
    );
    // S13: NIST AI RMF has 0 active controls THIS audit (A = 0), but its static
    // capability is C = 4 of ~72 (68 out of scope); no rows.
    const nistBlock = lensSection.slice(lensSection.indexOf('#### NIST AI RMF'));
    expect(nistBlock).toContain('**0 of 4 covered** · 68 out of scope · 72 in framework');
    expect(nistBlock).toContain('No active controls for this framework');
    // ISO/IEC 42001: A = 0, C = 2, 36 out of scope, N = 38.
    const isoBlock = lensSection.slice(
      lensSection.indexOf('#### ISO/IEC 42001'),
      lensSection.indexOf('#### AIUC-1'),
    );
    expect(isoBlock).toContain('**0 of 2 covered** · 36 out of scope · 38 in framework');
  });
});
