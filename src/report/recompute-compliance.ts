/**
 * AAP-79 / AAP-83 / AAP-86 — recompute the Stage 3 framework mapping
 * with discovery evidence.
 *
 * Original AAP-79 problem: the analyzer pipeline runs
 * `mapFindingsToRiskCategories` exactly once, on the LLM-extracted
 * systems + the raw interview transcript. Surface 2 evidence
 * (`runDiscovery` filesystem reads — L1-L3) lands later, after the
 * report is already on disk. Pre-AAP-79 the mapping was never
 * re-computed, so a transcript that never mentioned PII could still
 * leave the report missing GDPR Art 5(1)(c) controls even when
 * discovery found an AWS credentials file or a `.env` with
 * `STRIPE_SECRET_KEY` in it.
 *
 * Pre-AAP-83 this module synthesised a virtual transcript fragment
 * from the discovery payload (names only, never values) and fed the
 * augmented transcript back into the prose mapper so its
 * `hasSensitivePII` / `hasInternationalTransfer` regexes would fire.
 * Typed → fake prose → regex on fake prose worked but routed
 * deterministic evidence through a prose path that was designed for
 * self-report.
 *
 * AAP-83 introduced the typed envelope. AAP-84 migrated the renderer
 * to consume `controlResults`. AAP-85 added typed Annex III signals.
 * AAP-86 (this revision) deletes the synthesis bridge entirely —
 * `mapFindings({declared, actual: {discovery}})` is the canonical
 * call. The typed-evidence detectors in
 * `src/compliance/detectors/discovery-detectors.ts` light up
 * `ControlResult`s with proper provenance, and the merged projection
 * in `mapFindings` keeps `compliance.all` populated for renderers
 * that still consume the legacy projection.
 *
 * Privacy contract: unchanged. The module never reads credential
 * values. The already-redacted `DiscoveryResult` (output of the
 * discovery readers + secretlint pass) flows in; KEY NAMES, FILE
 * PATHS, PROFILE NAMES, and SERVICE NAMES are the only fields the
 * detectors ever inspect.
 */

import type { DiscoveryResult } from '../discovery/types.js';
import {
  mapFindings,
  type CategorizedCompliance,
} from '../compliance/mapper.js';
import type { VerificationReport } from '../verification/types.js';
import type {
  AnalysisResult,
  QAPair,
  SystemAssessment,
} from './types.js';

/**
 * Minimum subset of the analyzer output the recompute path needs. We keep
 * this narrow on purpose — the discovery scan route patches a partial
 * report.json before this runs, and we tolerate older sessions that
 * predate AAP-79.
 */
export interface RecomputeAnalyzerSubset {
  systems: SystemAssessment[];
  makesDecisionsAboutPeople?: AnalysisResult['makesDecisionsAboutPeople'];
  decisionMakingDetails?: AnalysisResult['decisionMakingDetails'];
}

/**
 * Recompute `compliance` (CategorizedCompliance) from the analyzer
 * output, the original interview transcript, and the typed discovery
 * payload. Pure function — returns the fresh CategorizedCompliance for
 * the caller to write back onto the report.
 *
 * `discovery` is the structurally-typed payload that lives at
 * `reportJson.localAgentDiscovery` after `runDiscovery` completes. The
 * function tolerates partial / undefined fields — anything missing
 * falls through as "no extra signal" and the mapper output matches the
 * Stage 3 original.
 *
 * `verificationReport` is the Surface 2 verification output (diff +
 * inventory + approval chain). The forwarded-OAuth path (G10) threads
 * the orchestrator's report in so the router-adapter wedge detectors
 * (AIUC-1 A003/A003.3/A003.4/B006, GDPR Art 25/Art 22) fire — those
 * detectors read `evidence.verificationReport` and short-circuit to null
 * without it, so a clean forwarded OAuth grant never reached `verified`
 * before. When both `discovery` and `verificationReport` are absent the
 * caller passes neither and the mapper runs the prose-only path unchanged.
 */
export function recomputeComplianceWithDiscovery(args: {
  analyzer: RecomputeAnalyzerSubset;
  transcript: QAPair[];
  discovery?: DiscoveryResult | null;
  verificationReport?: VerificationReport | null;
}): CategorizedCompliance {
  // Build the `actual` envelope only when at least one Surface 2 signal is
  // present; an empty envelope would flip the mapper out of the prose-only
  // path and run the typed detectors against nothing.
  const actual: { discovery?: DiscoveryResult; verificationReport?: VerificationReport } = {};
  if (args.discovery) actual.discovery = args.discovery;
  if (args.verificationReport) actual.verificationReport = args.verificationReport;
  const hasActual = actual.discovery !== undefined || actual.verificationReport !== undefined;
  return mapFindings({
    declared: {
      systems: args.analyzer.systems,
      transcript: args.transcript,
      ...(args.analyzer.makesDecisionsAboutPeople !== undefined
        ? { makesDecisionsAboutPeople: args.analyzer.makesDecisionsAboutPeople }
        : {}),
      ...(args.analyzer.decisionMakingDetails !== undefined
        ? { decisionMakingDetails: args.analyzer.decisionMakingDetails }
        : {}),
    },
    ...(hasActual ? { actual } : {}),
  });
}
