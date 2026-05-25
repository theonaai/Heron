/**
 * Top-level HR-vertical pack aggregator (AAP-51).
 *
 * Composes the 7 HR detectors (`detectors.ts`) behind a single
 * `runHRPack` entry point. The router is responsible for:
 *
 *  1. Building the `VerificationSignals` envelope from the
 *     `VerificationReport`, mirroring the framework-detector wiring so
 *     the two pipelines see the same view of the world.
 *  2. Gating detector execution on `isHRAgent(signals)` — non-HR agents
 *     return an empty result. Detectors are NOT called at all when the
 *     gate is closed, so no false positives can fire on a non-HR agent.
 *  3. Respecting the `HERON_HR_PACK_DISABLED=true` env toggle for
 *     operators who want to skip the HR pack entirely.
 *  4. Summarising detector results into `HRPackSummary` for the
 *     executive summary renderer.
 *
 * Detector lookup uses a `Map<string, HRDetector>` rather than a
 * `Record<string, HRDetector>` to short-circuit any prototype-pollution
 * path through a hostile signal identifier. The map is built once,
 * frozen by closure scope, and never accepts new entries at runtime.
 *
 * Tracking: https://linear.app/theona/issue/AAP-51
 */

import { isHRAgent } from '../frameworks/classify.js';
import type { VerificationSignals } from '../frameworks/envelope.js';
import type { VerificationReport } from '../types.js';
import {
  detectAutoRejectionWithoutDisclosure,
  detectATSWriteScopeSprawl,
  detectCandidatePIIInLogs,
  detectScoringWithoutCriteria,
  detectDoNotContactBypass,
  detectOfferLetterOutOfRange,
  detectSubAgentScopeExpansion,
} from './detectors.js';
import type { HRPackResult, HRPackSummary, HRSignal } from './types.js';

type HRDetector = (sig: VerificationSignals) => HRSignal;

/**
 * Ordered detector entries. Order is stable for golden snapshots and
 * for the executive-summary "headline findings" sort.
 *
 *  1. auto-rejection-without-disclosure  (critical when detected)
 *  2. ats-write-scope-sprawl             (high)
 *  3. candidate-pii-in-logs              (medium)
 *  4. scoring-without-criteria           (high)
 *  5. do-not-contact-bypass              (high)
 *  6. offer-letter-out-of-range          (critical)
 *  7. sub-agent-scope-expansion          (high)
 */
const HR_DETECTOR_TABLE: ReadonlyArray<[string, HRDetector]> = [
  ['auto-rejection-without-disclosure', detectAutoRejectionWithoutDisclosure],
  ['ats-write-scope-sprawl', detectATSWriteScopeSprawl],
  ['candidate-pii-in-logs', detectCandidatePIIInLogs],
  ['scoring-without-criteria', detectScoringWithoutCriteria],
  ['do-not-contact-bypass', detectDoNotContactBypass],
  ['offer-letter-out-of-range', detectOfferLetterOutOfRange],
  ['sub-agent-scope-expansion', detectSubAgentScopeExpansion],
];

const HR_DETECTORS: ReadonlyMap<string, HRDetector> = new Map(HR_DETECTOR_TABLE);

/**
 * Single source of truth for the HR-pack env-disable flag. Used by the
 * CLI and the orchestrator-integration tests.
 */
export function isHRPackDisabled(): boolean {
  return process.env.HERON_HR_PACK_DISABLED === 'true';
}

export function listHRDetectorIds(): string[] {
  return HR_DETECTOR_TABLE.map(([id]) => id);
}

function emptyResult(): HRPackResult {
  return {
    isHRAgent: false,
    signals: [],
    summary: {
      detectedCount: 0,
      notDetectedCount: 0,
      unverifiedCount: 0,
      criticalDetected: 0,
      highDetected: 0,
    },
  };
}

/**
 * Run all 7 HR detectors against the given verification report.
 *
 * Returns an HR pack result. When the env toggle is set or the agent
 * is not HR-class, returns an empty result with `isHRAgent: false`. The
 * detectors are NOT called in that case — no false positives possible.
 */
export function runHRPack(report: VerificationReport): HRPackResult {
  if (isHRPackDisabled()) return emptyResult();

  const signals: VerificationSignals = {
    diffs: report.sources.flatMap((s) => s.diffs),
    declaredInventory: report.declared[0],
    actualInventories: report.sources
      .map((s) => s.inventory)
      .filter((i): i is NonNullable<typeof i> => i !== undefined),
    ...(report.approvalChain
      ? {
          approvalChain: report.approvalChain.chain,
          approvalIntegrity: report.approvalChain.integrity,
        }
      : {}),
  };

  if (!isHRAgent(signals)) return emptyResult();

  const out: HRSignal[] = [];
  for (const [, detector] of HR_DETECTOR_TABLE) {
    out.push(detector(signals));
  }
  return {
    isHRAgent: true,
    signals: out,
    summary: summarise(out),
  };
}

function summarise(signals: readonly HRSignal[]): HRPackSummary {
  const s: HRPackSummary = {
    detectedCount: 0,
    notDetectedCount: 0,
    unverifiedCount: 0,
    criticalDetected: 0,
    highDetected: 0,
  };
  for (const sig of signals) {
    switch (sig.verdict) {
      case 'detected':
        s.detectedCount++;
        if (sig.severity === 'critical') s.criticalDetected++;
        if (sig.severity === 'high') s.highDetected++;
        break;
      case 'not-detected':
        s.notDetectedCount++;
        break;
      case 'unverified':
        s.unverifiedCount++;
        break;
      default: {
        const _exhaustive: never = sig.verdict;
        void _exhaustive;
      }
    }
  }
  return s;
}

/**
 * Lookup a single HR detector by id. Used by tests and any future
 * tooling that needs to invoke a single detector directly.
 */
export function getHRDetector(id: string): HRDetector | undefined {
  return HR_DETECTORS.get(id);
}
