/**
 * AAP-83 Phase 2 — absorb the 12 framework detectors into the
 * compliance catalog.
 *
 * Strategy: the detector function bodies in
 * `src/verification/frameworks/detectors.ts` (AAP-86 location; lifted
 * out of the standalone driver module) are well-tested
 * (router.test.ts, golden.test.ts, round-2-fixes.test.ts,
 * section-placement.test.ts, orchestrator-integration.test.ts — ~6
 * test files, 60+ test cases). Rewriting them in-place under
 * `src/compliance/detectors/*` risks regressions. Instead this adapter
 * wraps each detector so it speaks the new `TypedDetector` signature
 * (envelope-in, ControlResult-out) while delegating to the existing
 * FrameworkControl-producing function.
 *
 * AAP-86 deleted the standalone framework-mapping driver (its registry
 * was only ever consumed by the CLI). The CLI now reaches the same
 * detectors through this adapter via `mapFindings`.
 *
 * Mapping (router.ts identity → catalog (findingType, frameworkId, controlId)):
 *   aiuc-1:A003        → excessive-access: aiuc-1 / A003.3 + A003.4
 *   aiuc-1:B006        → write-risk:        aiuc-1 / B006
 *   aiuc-1:D003        → write-risk:        aiuc-1 / D003
 *   aiuc-1:E004        → decisions-about-people: aiuc-1 / E004
 *   aiuc-1:E015        → write-risk:        aiuc-1 / E015.2
 *   eu-ai-act:Annex-III-4 → decisions-about-people: eu-ai-act / Art. 6(2) + Annex III
 *   eu-ai-act:Article-14  → write-risk: eu-ai-act / Art. 14(4)(d)
 *   eu-ai-act:Article-12  → regulatory-flags: eu-ai-act / Art. 12
 *   gdpr:Article-22       → decisions-about-people: gdpr / Art. 22
 *   gdpr:Article-5        → excessive-access: gdpr / Art. 25 (data minimisation analogue)
 *   nist-ai-rmf:MEASURE   → risk-score: nist-ai-rmf / MEASURE 1.1
 *   nist-ai-rmf:MANAGE    → risk-score: nist-ai-rmf / MANAGE 1.2
 *
 * The mapping is intentionally not 1-to-1 with router controlIds because
 * the catalog uses Heron_v1 citation strings (Art. 9(2)(a), A.6.2.6,
 * MANAGE 1.2) while the router used short labels (Article-14, MANAGE).
 * The adapter records both: `stableKey` uses the catalog citation,
 * `controlName` carries the router's human-readable name.
 */

import {
  detectAIUC1_A003,
  detectAIUC1_B006,
  detectAIUC1_D003,
  detectAIUC1_E004,
  detectAIUC1_E015,
  detectEUAIAct_AnnexIII4,
  detectEUAIAct_Article14,
  detectEUAIAct_Article12,
  detectGDPR_Article22,
  detectGDPR_Article5,
  detectNIST_Measure,
  detectNIST_Manage,
} from '../../verification/frameworks/detectors.js';
import type { VerificationSignals } from '../../verification/frameworks/envelope.js';
import type {
  FrameworkControl as RouterFrameworkControl,
  ControlVerdict as RouterVerdict,
  ControlSeverity as RouterSeverity,
} from '../../verification/frameworks/types.js';
import { stableKeyFor } from '../control-key.js';
import type {
  ControlResultSeverity,
  ControlResultSurface,
  ControlResultVerdict,
} from '../control-catalog.js';
import type {
  ControlResult,
  TypedDetector,
  TypedEvidenceEnvelope,
} from './types.js';
import type { FindingType, FrameworkId } from '../types.js';

// ─── Verdict / severity passthrough ────────────────────────────────────────

/**
 * Router and catalog use the same vocabularies (`verified` | `partial` |
 * `unverified` | `fail` | `not-applicable` and `critical` | `high` |
 * `medium` | `low` | `info`). Functions exist solely to make a future
 * divergence explicit at the boundary rather than allowing a silent
 * structural mismatch.
 */
function mapVerdict(v: RouterVerdict): ControlResultVerdict {
  return v;
}

function mapSeverity(s: RouterSeverity): ControlResultSeverity {
  return s;
}

// ─── Envelope → VerificationSignals adapter ────────────────────────────────

/**
 * Build the router-shaped `VerificationSignals` from the catalog-shaped
 * `TypedEvidenceEnvelope`. Returns null when no verificationReport is
 * available — every router detector needs at least the inventories /
 * approval chain that live on the report.
 */
function envelopeToSignals(
  evidence: TypedEvidenceEnvelope,
): VerificationSignals | null {
  const report = evidence.verificationReport;
  if (!report) return null;

  const signals: VerificationSignals = {
    diffs: report.sources.flatMap((s) => s.diffs),
    actualInventories: report.sources
      .map((s) => s.inventory)
      .filter((i): i is NonNullable<typeof i> => i !== undefined),
  };
  if (report.declared[0]) signals.declaredInventory = report.declared[0];
  if (report.approvalChain) {
    signals.approvalChain = report.approvalChain.chain;
    signals.approvalIntegrity = report.approvalChain.integrity;
  }
  return signals;
}

/**
 * One adapter row. Builds a TypedDetector that:
 *   1. Constructs router signals from the envelope (null short-circuits).
 *   2. Calls the router-shaped detector.
 *   3. Reshapes its `FrameworkControl` output into a `ControlResult`.
 */
function makeAdapter(args: {
  findingType: FindingType;
  frameworkId: FrameworkId;
  controlId: string;
  surface: ControlResultSurface;
  detector: (sig: VerificationSignals) => RouterFrameworkControl;
}): TypedDetector {
  return (evidence: TypedEvidenceEnvelope) => {
    const signals = envelopeToSignals(evidence);
    if (!signals) return null;
    const out = args.detector(signals);
    const result: ControlResult = {
      stableKey: stableKeyFor({
        findingType: args.findingType,
        frameworkId: args.frameworkId,
        controlId: args.controlId,
      }),
      findingType: args.findingType,
      frameworkId: args.frameworkId,
      // AAP-111: denormalised owning-framework join field (== frameworkId).
      framework: args.frameworkId,
      controlId: args.controlId,
      controlName: out.controlName,
      path: 'typed',
      surface: args.surface,
      verdict: mapVerdict(out.verdict),
      severity: mapSeverity(out.severity),
      rationale: out.rationale,
      evidenceRefs: out.evidenceRefs.map((r) => ({ kind: r.kind, ref: r.ref })),
    };
    return result;
  };
}

// ─── Adapter registry ──────────────────────────────────────────────────────

/**
 * The 12 framework detectors lifted into typed-evidence shape. Each row
 * names the catalog entry the detector lights up and the surface it
 * reads from. Order mirrors the original detector-table order so any
 * downstream snapshot that depended on order survives.
 *
 * Some framework detectors light multiple catalog entries (A003 fires
 * for both excessive-access:aiuc-1:A003.3 and excessive-access:aiuc-1:A003.4
 * — they're paired least-privilege controls). We register one adapter
 * per (framework detector, catalog entry) pair so the verdict
 * propagates to every applicable entry.
 */
export const ROUTER_DETECTOR_ADAPTERS: ReadonlyArray<{
  findingType: FindingType;
  frameworkId: FrameworkId;
  controlId: string;
  detector: TypedDetector;
}> = [
  // ── AIUC-1 ──
  {
    findingType: 'excessive-access',
    frameworkId: 'aiuc-1',
    controlId: 'A003.3',
    detector: makeAdapter({
      findingType: 'excessive-access',
      frameworkId: 'aiuc-1',
      controlId: 'A003.3',
      surface: 'actual',
      detector: detectAIUC1_A003,
    }),
  },
  {
    findingType: 'excessive-access',
    frameworkId: 'aiuc-1',
    controlId: 'A003.4',
    detector: makeAdapter({
      findingType: 'excessive-access',
      frameworkId: 'aiuc-1',
      controlId: 'A003.4',
      surface: 'actual',
      detector: detectAIUC1_A003,
    }),
  },
  {
    findingType: 'write-risk',
    frameworkId: 'aiuc-1',
    controlId: 'B006',
    detector: makeAdapter({
      findingType: 'write-risk',
      frameworkId: 'aiuc-1',
      controlId: 'B006',
      surface: 'actual',
      detector: detectAIUC1_B006,
    }),
  },
  {
    findingType: 'write-risk',
    frameworkId: 'aiuc-1',
    controlId: 'D003',
    detector: makeAdapter({
      findingType: 'write-risk',
      frameworkId: 'aiuc-1',
      controlId: 'D003',
      surface: 'actual',
      detector: detectAIUC1_D003,
    }),
  },
  {
    findingType: 'decisions-about-people',
    frameworkId: 'aiuc-1',
    controlId: 'E004',
    detector: makeAdapter({
      findingType: 'decisions-about-people',
      frameworkId: 'aiuc-1',
      controlId: 'E004',
      surface: 'approval',
      detector: detectAIUC1_E004,
    }),
  },
  {
    findingType: 'write-risk',
    frameworkId: 'aiuc-1',
    controlId: 'E015.2',
    detector: makeAdapter({
      findingType: 'write-risk',
      frameworkId: 'aiuc-1',
      controlId: 'E015.2',
      surface: 'approval',
      detector: detectAIUC1_E015,
    }),
  },
  // ── EU AI Act ──
  {
    findingType: 'decisions-about-people',
    frameworkId: 'eu-ai-act',
    controlId: 'Art. 6(2) + Annex III',
    detector: makeAdapter({
      findingType: 'decisions-about-people',
      frameworkId: 'eu-ai-act',
      controlId: 'Art. 6(2) + Annex III',
      surface: 'actual',
      detector: detectEUAIAct_AnnexIII4,
    }),
  },
  {
    findingType: 'write-risk',
    frameworkId: 'eu-ai-act',
    controlId: 'Art. 14(4)(d)',
    detector: makeAdapter({
      findingType: 'write-risk',
      frameworkId: 'eu-ai-act',
      controlId: 'Art. 14(4)(d)',
      surface: 'approval',
      detector: detectEUAIAct_Article14,
    }),
  },
  {
    findingType: 'regulatory-flags',
    frameworkId: 'eu-ai-act',
    controlId: 'Art. 12',
    detector: makeAdapter({
      findingType: 'regulatory-flags',
      frameworkId: 'eu-ai-act',
      controlId: 'Art. 12',
      surface: 'approval',
      detector: detectEUAIAct_Article12,
    }),
  },
  // ── GDPR ──
  {
    findingType: 'decisions-about-people',
    frameworkId: 'gdpr',
    controlId: 'Art. 22',
    detector: makeAdapter({
      findingType: 'decisions-about-people',
      frameworkId: 'gdpr',
      controlId: 'Art. 22',
      surface: 'actual',
      detector: detectGDPR_Article22,
    }),
  },
  {
    findingType: 'excessive-access',
    frameworkId: 'gdpr',
    controlId: 'Art. 25',
    detector: makeAdapter({
      findingType: 'excessive-access',
      frameworkId: 'gdpr',
      controlId: 'Art. 25',
      surface: 'actual',
      detector: detectGDPR_Article5,
    }),
  },
  // ── NIST AI RMF ──
  {
    findingType: 'risk-score',
    frameworkId: 'nist-ai-rmf',
    controlId: 'MEASURE 1.1',
    detector: makeAdapter({
      findingType: 'risk-score',
      frameworkId: 'nist-ai-rmf',
      controlId: 'MEASURE 1.1',
      surface: 'actual',
      detector: detectNIST_Measure,
    }),
  },
  {
    findingType: 'risk-score',
    frameworkId: 'nist-ai-rmf',
    controlId: 'MANAGE 1.2',
    detector: makeAdapter({
      findingType: 'risk-score',
      frameworkId: 'nist-ai-rmf',
      controlId: 'MANAGE 1.2',
      surface: 'approval',
      detector: detectNIST_Manage,
    }),
  },
];

// ─── Lookup by stableKey ───────────────────────────────────────────────────

/**
 * Map a stable catalog key to the detector that lights up that entry.
 * `Map` (not Record) guards against prototype-pollution if a hostile
 * controlId ever flowed through here.
 */
const DETECTORS_BY_KEY: ReadonlyMap<string, TypedDetector> = new Map(
  ROUTER_DETECTOR_ADAPTERS.map((row) => [
    stableKeyFor({
      findingType: row.findingType,
      frameworkId: row.frameworkId,
      controlId: row.controlId,
    }),
    row.detector,
  ]),
);

export function getDetectorForStableKey(
  stableKey: string,
): TypedDetector | undefined {
  return DETECTORS_BY_KEY.get(stableKey);
}

export function listAdaptedDetectorKeys(): string[] {
  return [...DETECTORS_BY_KEY.keys()];
}
