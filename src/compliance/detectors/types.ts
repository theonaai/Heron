/**
 * AAP-83 Phase 2 — typed-evidence detector contracts.
 *
 * These types live in `src/compliance/detectors/` because they belong
 * to the unified compliance engine, not to the verification source
 * adapters. The router types (`src/verification/frameworks/types.ts`)
 * still exist for back-compat with the CLI `mcp-scan` path, and this
 * module re-exports a subset so detector authors only need one import.
 *
 * The contract per ticket spec:
 *
 *   - A detector consumes a `TypedEvidenceEnvelope` (the `actual` half
 *     of the mapFindings input — discovery, verificationReport,
 *     oauthVerifications).
 *   - It returns a `ControlResult` carrying provenance (`path: 'typed'`,
 *     `surface`) and an evidence-refs list, or `null` when no signal is
 *     available (caller falls back to the prose path).
 *   - Detectors run INDEPENDENT of `isFindingActive()` gates (per ticket
 *     spec point 2). Typed evidence can light a control even when the
 *     prose path's gating signals do not fire.
 */

import type {
  VerificationReport,
  SourceVerification,
} from '../../verification/types.js';
import type { DiscoveryResult } from '../../discovery/types.js';
import type {
  ControlResult,
  ControlResultEvidenceRef,
  ControlResultSeverity,
  ControlResultSurface,
  ControlResultVerdict,
} from '../control-catalog.js';

// Re-export the existing router-side primitives so detector authors can
// import everything from one place. Once Phase 9 deletes the router
// registry these can move to live here permanently.
export type {
  ControlEvidenceRef,
  ControlSeverity,
  ControlVerdict,
  FrameworkControl as RouterFrameworkControl,
} from '../../verification/frameworks/types.js';
export type { VerificationSignals } from '../../verification/frameworks/router.js';

/**
 * Typed-evidence envelope.
 *
 * Mirrors the `actual` half of the mapFindings input. Detectors typically
 * read one or two fields — keep it loose so a future evidence source can
 * be appended without churning every detector signature.
 */
export interface TypedEvidenceEnvelope {
  /** Surface 2 deterministic — filesystem discovery (L1-L5). */
  discovery?: DiscoveryResult | undefined;
  /** Surface 2 deterministic — MCP / OAuth / agent-declaration verification. */
  verificationReport?: VerificationReport | undefined;
  /** Surface 2 cloud — L7 OAuth scope introspection per provider. */
  oauthVerifications?: SourceVerification[] | undefined;
}

/**
 * Detector function signature.
 *
 * Returns null when the detector has no opinion (no relevant evidence
 * surface present). Returns a `ControlResult` when typed evidence fires.
 *
 * The returned result's `path` is always `'typed'` — that's the
 * contract. The caller may post-process into `'combined'` if it also
 * runs the prose path for the same control.
 */
export type TypedDetector = (
  evidence: TypedEvidenceEnvelope,
) => ControlResult | null;

// Re-export ControlResult fields so detector implementations only need
// one import.
export type {
  ControlResult,
  ControlResultEvidenceRef,
  ControlResultSeverity,
  ControlResultSurface,
  ControlResultVerdict,
};

// ─── Helpers shared across detectors ───────────────────────────────────────

/**
 * Build a ControlResult with `path: 'typed'` pre-filled. Detector authors
 * use this to ensure the provenance contract is honoured uniformly.
 */
export function typedControlResult(args: {
  stableKey: string;
  findingType: ControlResult['findingType'];
  frameworkId: ControlResult['frameworkId'];
  controlId: string;
  controlName?: string;
  surface: ControlResultSurface;
  verdict: ControlResultVerdict;
  severity: ControlResultSeverity;
  rationale: string;
  evidenceRefs: ControlResultEvidenceRef[];
}): ControlResult {
  const out: ControlResult = {
    stableKey: args.stableKey,
    findingType: args.findingType,
    frameworkId: args.frameworkId,
    controlId: args.controlId,
    path: 'typed',
    surface: args.surface,
    verdict: args.verdict,
    severity: args.severity,
    rationale: args.rationale,
    evidenceRefs: args.evidenceRefs,
  };
  if (args.controlName !== undefined) out.controlName = args.controlName;
  return out;
}
