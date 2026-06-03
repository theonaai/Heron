/**
 * AAP-119 (S4 of AAP-117) — ISO 42001 + NIST AI RMF verifiability tiering,
 * plus a skeptical re-validation of S3's (AAP-118) ISO/NIST bucket calls.
 *
 * ISO 42001 and NIST AI RMF came from the OLDER AAP-30 crosswalk, which never
 * assigned AAP-42 verifiability tiers. S3 bucketed them quickly. S4 does the
 * proper tiering AND treats every S3 ISO/NIST `verifiable` call as a hypothesis
 * to be falsified against the LIVE detectors.
 *
 * The AAP-42 tier vocabulary (the method this subtask applies):
 *   INTERROGATION  — agent self-attests, Heron probes the transcript.
 *   PROBE          — adversarial test (injection / extraction / cross-tenant).
 *   ARTIFACT       — operator uploads a policy / doc / register; Heron reviews.
 *   CODE           — needs source / config / deployment-env access.
 *   RUNTIME        — needs production telemetry.
 *   NOT_VERIFIABLE — purely organizational / legal / authority-side.
 *
 * Grounding decision (parity with EU / GDPR / AIUC-1): those three frameworks
 * carry NO `tier` field — they are grounded purely through the `bucket` field
 * plus prose comments in `control-buckets.ts` naming the detector mechanism.
 * Adding a `tier` field for ISO/NIST only would BREAK that parity (and ripple
 * into ~25 ControlResult construction sites + the S5 renderer, both explicitly
 * out of scope). So S4 documents the ISO/NIST tiers in `control-buckets.ts`
 * comments, exactly as the EU/GDPR/AIUC-1 sections do, and encodes the
 * tier→bucket invariant HERE as the executable source of truth.
 *
 * The invariant that ties tier to bucket (and is the bug-hunt's teeth):
 *   - bucket `verifiable`  ⟺ a deterministic detector is wired for the control
 *     AND the detector produces a declared-vs-actual (or
 *     deterministic-evidence) verdict. The honest reading of the `verifiable`
 *     bucket contract in types.ts.
 *   - bucket `oos-operator-artifact` ⟺ tier ARTIFACT with no deterministic
 *     verdict path (a management-system document/process the agent can't see).
 *   - bucket `oos-not-verifiable`    ⟺ tier PROBE / RUNTIME / CODE /
 *     NOT_VERIFIABLE.
 *   - ISO/NIST have ZERO `self-attested` controls — a management-system
 *     process is never agent-self-attestable (contrast AIUC-1 A005, which asks
 *     the agent about its OWN architecture).
 */

import { describe, expect, it } from 'vitest';

import { CONTROL_CATALOG } from '../../src/compliance/control-catalog.js';
import { BUCKET_BY_CONTROL } from '../../src/compliance/control-buckets.js';
import type { ComplianceBucket, FrameworkId } from '../../src/compliance/types.js';

// ─── AAP-42 tier vocabulary (test-local; not stored in the model) ───────────

type Tier =
  | 'INTERROGATION'
  | 'PROBE'
  | 'ARTIFACT'
  | 'CODE'
  | 'RUNTIME'
  | 'NOT_VERIFIABLE';

/**
 * One row of the S4 tiering decision.
 *
 *   controlId          — the catalog control id.
 *   tier               — the AAP-42 verifiability tier.
 *   qualifyingDetector — TRUE iff a wired deterministic detector produces a
 *                        genuine declared-vs-actual (or
 *                        deterministic-evidence) verdict for this control.
 *                        This is the exact property the `verifiable` bucket
 *                        contract turns on. MEASURE 1.1 is the one
 *                        detector-backed control where this is FALSE:
 *                        `detectNIST_Measure` returns `verified` merely
 *                        because sources ran, which is not a real verdict.
 *   expectedBucket     — the bucket the tier + qualifyingDetector imply.
 *   mechanism          — human-readable note for the test name.
 */
type TierRow = [
  controlId: string,
  tier: Tier,
  qualifyingDetector: boolean,
  expectedBucket: ComplianceBucket,
  mechanism: string,
];

/**
 * The S4 tiering decision for every WIRED ISO 42001 + NIST AI RMF control,
 * grounded in the actual frameworks + the live Heron detectors.
 *
 * Tier rationale, the verifiable rows:
 *   - A.4.4 / MAP 2.1 — AI-tooling inventory. The control's REQUIREMENT is a
 *     documented register (ARTIFACT), but `makeMcpInventoryDetector` produces a
 *     deterministic PARTIAL from the live MCP-server discovery surface today.
 *     Deterministic verdict ⇒ `verifiable` (caps at partial per AAP-105 A3
 *     until the operator supplies the register).
 *   - A.10.3 / GOVERN 6.2 / MANAGE 3.1 — supplier / third-party-component
 *     accountability. ARTIFACT in the abstract, but `makeProcessorDetector`
 *     produces a deterministic PARTIAL from third-party-SaaS credential names.
 *     Same mechanism that backs GDPR Art. 28 + AIUC-1 A001 (both blessed
 *     `verifiable` by the spec) ⇒ consistent `verifiable`.
 * The approval-chain-only downgrades (AAP-134):
 *   - MANAGE 1.2 — risk treatment. ARTIFACT (approval-chain record).
 *     `detectNIST_Manage` derives its verdict SOLELY from `sig.approvalChain` —
 *     an operator sign-off log the agent never supplies — and observes no
 *     agent-side evidence; with no chain it degrades to PARTIAL. Same
 *     approval-chain-only family as AIUC-1 E004 / E015.2 + EU Art. 14(4)(d),
 *     all of which AAP-134 / AAP-133 moved to `oos-operator-artifact` so the
 *     lens renders them as out-of-scope counts, not partial/fail rows. The
 *     detector is left untouched; only the METADATA bucket is corrected.
 *
 * The bug-hunt row:
 *   - MEASURE 1.1 — risk-measurement-method SELECTION. `detectNIST_Measure`
 *     returns `verified` merely because ≥1 source ran and produced any
 *     inventory/diff. That is NOT a declared-vs-actual verdict — there is no
 *     baseline and no substantive metric-selection check. The control's real
 *     requirement (documented, applied risk-measurement methods) is a
 *     management-system ARTIFACT the agent can't see. S3 called it
 *     `verifiable`; S4 downgrades it to `oos-operator-artifact`.
 */
const ISO_TIERS: ReadonlyArray<TierRow> = [
  ['A.4.4', 'ARTIFACT', true, 'verifiable', 'MCP-inventory detector → PARTIAL (deterministic)'],
  ['A.10.3', 'ARTIFACT', true, 'verifiable', 'processor detector → PARTIAL (deterministic)'],
  ['A.5.2', 'ARTIFACT', false, 'oos-operator-artifact', 'AI policy / purpose-limitation doc'],
  ['A.5.3', 'ARTIFACT', false, 'oos-operator-artifact', 'documented impact assessments'],
  ['A.5.4', 'ARTIFACT', false, 'oos-operator-artifact', 'privacy-impact records'],
  ['A.6.2.4', 'ARTIFACT', false, 'oos-operator-artifact', 'operational-change records'],
  ['A.6.2.5', 'ARTIFACT', false, 'oos-operator-artifact', 'resource-interaction restriction records'],
  ['A.6.2.6', 'ARTIFACT', false, 'oos-operator-artifact', 'access-control records'],
  ['A.6.2.8', 'ARTIFACT', false, 'oos-operator-artifact', 'event-log system'],
  ['A.7.4', 'ARTIFACT', false, 'oos-operator-artifact', 'data-quality documentation'],
  ['A.7.5', 'ARTIFACT', false, 'oos-operator-artifact', 'data-provenance records'],
  ['A.9.2', 'ARTIFACT', false, 'oos-operator-artifact', 'internal-audit records'],
  ['A.9.3', 'ARTIFACT', false, 'oos-operator-artifact', 'management-review records'],
  ['Clause 6.1', 'ARTIFACT', false, 'oos-operator-artifact', 'risk-treatment plan'],
];

const NIST_TIERS: ReadonlyArray<TierRow> = [
  ['MAP 2.1', 'ARTIFACT', true, 'verifiable', 'MCP-inventory detector → PARTIAL (deterministic)'],
  ['GOVERN 6.2', 'ARTIFACT', true, 'verifiable', 'processor detector → PARTIAL (deterministic)'],
  ['MANAGE 3.1', 'ARTIFACT', true, 'verifiable', 'processor detector → PARTIAL (deterministic)'],
  // ── the bug-hunt downgrades: detector is WIRED but NOT qualifying ──
  ['MEASURE 1.1', 'ARTIFACT', false, 'oos-operator-artifact', 'detectNIST_Measure overclaims verified on "sources ran"; no declared-vs-actual verdict'],
  // AAP-134: detectNIST_Manage derives its verdict SOLELY from sig.approvalChain
  // (an operator sign-off log the agent never supplies) with no agent-observable
  // evidence; with no chain it degrades to PARTIAL. Same approval-chain-only
  // family as AIUC E004 / E015.2 + EU Art 14(4)(d) → oos-operator-artifact.
  ['MANAGE 1.2', 'ARTIFACT', false, 'oos-operator-artifact', 'approval-chain-only: detectNIST_Manage reads only sig.approvalChain, no agent-observable evidence'],
  ['GOVERN 1.1', 'ARTIFACT', false, 'oos-operator-artifact', 'legal-requirements register'],
  ['GOVERN 1.7', 'ARTIFACT', false, 'oos-operator-artifact', 'decommissioning policy'],
  ['GOVERN 3.2', 'ARTIFACT', false, 'oos-operator-artifact', 'human-AI-roles policy'],
  ['GOVERN 6.1', 'ARTIFACT', false, 'oos-operator-artifact', 'third-party-risk policy'],
  ['MAP 1.6', 'ARTIFACT', false, 'oos-operator-artifact', 'requirements-elicitation record'],
  ['MAP 3.2', 'ARTIFACT', false, 'oos-operator-artifact', 'error-cost analysis'],
  ['MAP 3.5', 'ARTIFACT', false, 'oos-operator-artifact', 'oversight-process documentation'],
  ['MAP 4.1', 'ARTIFACT', false, 'oos-operator-artifact', 'legal-risk mapping'],
  ['MAP 5.1', 'ARTIFACT', false, 'oos-operator-artifact', 'impact likelihood/magnitude doc'],
  ['MEASURE 2.10', 'ARTIFACT', false, 'oos-operator-artifact', 'privacy-risk examination doc'],
  ['MEASURE 3.1', 'ARTIFACT', false, 'oos-operator-artifact', 'emergent-risk identification process'],
  ['MANAGE 2.4', 'ARTIFACT', false, 'oos-operator-artifact', 'deactivation-mechanism documentation'],
  ['MEASURE 2.4', 'RUNTIME', false, 'oos-not-verifiable', 'functionality/behaviour monitoring — production telemetry'],
  ['MEASURE 2.7', 'PROBE', false, 'oos-not-verifiable', 'security & resilience evaluation — adversarial'],
];

// ─── Helpers over the built catalog ─────────────────────────────────────────

function wiredControlIds(frameworkId: FrameworkId): Set<string> {
  return new Set(
    CONTROL_CATALOG.filter((e) => e.frameworkId === frameworkId).map(
      (e) => e.controlId,
    ),
  );
}

function hasWiredDetector(frameworkId: FrameworkId, controlId: string): boolean {
  return CONTROL_CATALOG.some(
    (e) =>
      e.frameworkId === frameworkId &&
      e.controlId === controlId &&
      typeof e.deterministicDetector === 'function',
  );
}

function bucketOf(
  frameworkId: FrameworkId,
  controlId: string,
): ComplianceBucket | undefined {
  return BUCKET_BY_CONTROL[frameworkId]?.[controlId];
}

/**
 * The tier→bucket invariant. Encodes the honest rule the bug-hunt enforces.
 *
 * The decision turns on `qualifyingDetector` — whether a deterministic detector
 * produces a genuine declared-vs-actual verdict — NOT on the bare presence of a
 * wired detector. That distinction is the entire MEASURE 1.1 lesson: it HAS a
 * wired detector, but the detector does not produce a real verdict, so it is
 * not honestly `verifiable`.
 */
function bucketForTier(tier: Tier, qualifyingDetector: boolean): ComplianceBucket {
  if (tier === 'PROBE' || tier === 'RUNTIME' || tier === 'CODE' || tier === 'NOT_VERIFIABLE') {
    return 'oos-not-verifiable';
  }
  // ARTIFACT (or INTERROGATION, though ISO/NIST has none) with a qualifying
  // deterministic verdict ⇒ verifiable; otherwise ⇒ operator-artifact.
  return qualifyingDetector ? 'verifiable' : 'oos-operator-artifact';
}

// ─── Tiering coverage: every wired ISO/NIST control is tiered ───────────────

describe('AAP-119: every wired ISO/NIST control carries an S4 tier', () => {
  const cases: Array<[FrameworkId, ReadonlyArray<TierRow>]> = [
    ['iso-42001', ISO_TIERS],
    ['nist-ai-rmf', NIST_TIERS],
  ];

  for (const [frameworkId, table] of cases) {
    it(`${frameworkId}: the tier table covers exactly the wired control set (no untiered defaults, no phantom rows)`, () => {
      const wired = wiredControlIds(frameworkId);
      const tiered = new Set(table.map(([id]) => id));
      // No wired control left untiered.
      for (const id of wired) {
        expect(tiered.has(id), `${frameworkId} ${id} is wired but has no S4 tier`).toBe(true);
      }
      // No tier row that does not correspond to a wired control.
      for (const id of tiered) {
        expect(wired.has(id), `${frameworkId} ${id} is tiered but not wired`).toBe(true);
      }
      expect(tiered.size).toBe(wired.size);
    });
  }
});

// ─── The tier→bucket invariant (the bug-hunt's executable teeth) ────────────

describe('AAP-119: bucket is consistent with the assigned tier + the live detector', () => {
  const cases: Array<[FrameworkId, ReadonlyArray<TierRow>]> = [
    ['iso-42001', ISO_TIERS],
    ['nist-ai-rmf', NIST_TIERS],
  ];

  for (const [frameworkId, table] of cases) {
    for (const [controlId, tier, qualifyingDetector, expectedBucket, mechanism] of table) {
      it(`${frameworkId} ${controlId} — tier ${tier} → bucket ${expectedBucket} (${mechanism})`, () => {
        // 1. The bucket the S4 table asserts matches the tier→bucket rule.
        expect(bucketForTier(tier, qualifyingDetector)).toBe(expectedBucket);
        // 2. The bucket actually encoded in control-buckets.ts matches.
        expect(bucketOf(frameworkId, controlId)).toBe(expectedBucket);
        // 3. The `qualifyingDetector` claim is honest about the live catalog:
        //    a qualifying detector must actually BE a wired detector, and a
        //    non-qualifying claim must NOT silently hide a control that has no
        //    detector issue (it either has no detector, or it is the
        //    documented MEASURE 1.1 exception whose detector overclaims).
        if (qualifyingDetector) {
          expect(
            hasWiredDetector(frameworkId, controlId),
            `${frameworkId} ${controlId} is marked qualifyingDetector but has NO wired detector`,
          ).toBe(true);
        }
      });
    }
  }
});

// ─── Honest invariant: verifiable ⟺ a real wired detector ───────────────────

describe('AAP-119 honest invariant: an ISO/NIST verifiable bucket requires a wired deterministic detector', () => {
  for (const frameworkId of ['iso-42001', 'nist-ai-rmf'] as const) {
    it(`${frameworkId}: no control is verifiable without a deterministic detector behind it`, () => {
      const verifiable = CONTROL_CATALOG.filter(
        (e) => e.frameworkId === frameworkId && e.bucket === 'verifiable',
      );
      for (const e of verifiable) {
        expect(
          hasWiredDetector(frameworkId, e.controlId),
          `${frameworkId} ${e.controlId} is bucketed verifiable but has NO wired detector — phantom verifiable`,
        ).toBe(true);
      }
    });

    it(`${frameworkId}: every wired control with a deterministic detector is bucketed verifiable`, () => {
      // The converse: a detector-backed ISO/NIST control must not hide in an
      // oos bucket (that would be an under-claim). Two NIST controls are the
      // INTENTIONAL exceptions, both detector-backed but honestly
      // oos-operator-artifact:
      //   - MEASURE 1.1 (AAP-119): detectNIST_Measure does not produce a
      //     declared-vs-actual verdict (verified merely because sources ran).
      //   - MANAGE 1.2 (AAP-134): detectNIST_Manage reads ONLY sig.approvalChain
      //     (operator artifact), with no agent-observable evidence.
      const oosExceptions = new Set(['MEASURE 1.1', 'MANAGE 1.2']);
      const detectorBacked = new Set(
        CONTROL_CATALOG.filter(
          (e) =>
            e.frameworkId === frameworkId &&
            typeof e.deterministicDetector === 'function',
        ).map((e) => e.controlId),
      );
      for (const controlId of detectorBacked) {
        const bucket = bucketOf(frameworkId, controlId);
        if (frameworkId === 'nist-ai-rmf' && oosExceptions.has(controlId)) {
          expect(bucket).toBe('oos-operator-artifact');
        } else {
          expect(
            bucket,
            `${frameworkId} ${controlId} has a detector but is not verifiable`,
          ).toBe('verifiable');
        }
      }
    });
  }

  it('only the two documented exceptions (MEASURE 1.1, MANAGE 1.2) are detector-backed ISO/NIST controls not bucketed verifiable (no other overclaim slipped through)', () => {
    const detectorBackedButNotVerifiable = CONTROL_CATALOG.filter(
      (e) =>
        (e.frameworkId === 'iso-42001' || e.frameworkId === 'nist-ai-rmf') &&
        typeof e.deterministicDetector === 'function' &&
        e.bucket !== 'verifiable',
    ).map((e) => `${e.frameworkId} :: ${e.controlId}`);
    // MEASURE 1.1 (AAP-119: no declared-vs-actual verdict) and MANAGE 1.2
    // (AAP-134: approval-chain-only, no agent-observable evidence) are the two
    // INTENTIONAL detector-backed → oos-operator-artifact controls.
    expect([...new Set(detectorBackedButNotVerifiable)].sort()).toEqual([
      'nist-ai-rmf :: MANAGE 1.2',
      'nist-ai-rmf :: MEASURE 1.1',
    ]);
  });
});

// ─── The MEASURE 1.1 resolution (the named bug-hunt deliverable) ────────────

describe('AAP-119: NIST MEASURE 1.1 overclaim is resolved', () => {
  it('MEASURE 1.1 is downgraded from verifiable to oos-operator-artifact', () => {
    // S3 bucketed it verifiable on the strength of detectNIST_Measure reaching
    // `verified`. But that verdict fires merely because Heron ran any source —
    // no declared baseline, no substantive risk-metric-selection check. The
    // verifiable bucket contract requires a declared-vs-actual verdict, which
    // this detector does not produce. The control's real requirement
    // (documented, applied risk-measurement methods) is a management-system
    // artifact the agent can't self-attest ⇒ oos-operator-artifact.
    expect(bucketOf('nist-ai-rmf', 'MEASURE 1.1')).toBe('oos-operator-artifact');
    expect(bucketOf('nist-ai-rmf', 'MEASURE 1.1')).not.toBe('verifiable');
  });

  it('MEASURE 1.1 is still wired (the detector stays; only the honest bucket changes)', () => {
    // S4 does not touch the detector (that is S2's lane). The control keeps its
    // wired detector; only its METADATA bucket is corrected.
    expect(hasWiredDetector('nist-ai-rmf', 'MEASURE 1.1')).toBe(true);
  });
});

// ─── ISO/NIST have zero self-attested controls ──────────────────────────────

describe('AAP-119: ISO/NIST carry zero self-attested controls', () => {
  for (const frameworkId of ['iso-42001', 'nist-ai-rmf'] as const) {
    it(`${frameworkId}: no wired control is self-attested (management-system processes are not agent-observable)`, () => {
      const selfAttested = CONTROL_CATALOG.filter(
        (e) => e.frameworkId === frameworkId && e.bucket === 'self-attested',
      );
      expect(selfAttested.map((e) => `${e.controlId} (${e.findingType})`)).toEqual([]);
    });
  }
});

// ─── Corrected per-framework wired bucket counts (post-MEASURE-1.1 fix) ──────

describe('AAP-119: corrected ISO/NIST wired bucket counts', () => {
  function distinctBucketCounts(
    frameworkId: FrameworkId,
  ): Record<ComplianceBucket, number> {
    const out: Record<ComplianceBucket, number> = {
      verifiable: 0,
      'self-attested': 0,
      'oos-operator-artifact': 0,
      'oos-not-verifiable': 0,
    };
    const seen = new Set<string>();
    for (const e of CONTROL_CATALOG) {
      if (e.frameworkId !== frameworkId) continue;
      if (seen.has(e.controlId)) continue;
      seen.add(e.controlId);
      out[e.bucket] += 1;
    }
    return out;
  }

  it('iso-42001 wired counts (unchanged by S4: A.4.4 + A.10.3 verifiable; 12 operator-artifact)', () => {
    expect(distinctBucketCounts('iso-42001')).toEqual({
      verifiable: 2,
      'self-attested': 0,
      'oos-operator-artifact': 12,
      'oos-not-verifiable': 0,
    });
  });

  it('nist-ai-rmf wired counts (S4 MEASURE 1.1 + AAP-134 MANAGE 1.2 downgrades: verifiable 5→3, operator-artifact 12→14)', () => {
    expect(distinctBucketCounts('nist-ai-rmf')).toEqual({
      verifiable: 3,
      'self-attested': 0,
      'oos-operator-artifact': 14,
      'oos-not-verifiable': 2,
    });
  });
});
