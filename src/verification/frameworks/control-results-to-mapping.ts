/**
 * AAP-86 — CLI adapter: ControlResult[] → FrameworkMapping.
 *
 * Phase 9 deleted the standalone framework-mapping driver but
 * `report.frameworkMapping` is still consumed by:
 *   - `renderVerificationSection` (markdown / HTML compliance section)
 *   - `src/report/html-renderer.ts` (`--format html` path)
 *   - HR exec summary (vertical-pack `renderExecutiveSummary`)
 *
 * Those renderers expect the `FrameworkMapping` shape (per-control rows
 * with `framework / controlId / controlName / verdict / rationale /
 * evidenceRefs / severity` plus a `summary` counter rollup), not the
 * unified `ControlResult` shape that `mapFindings` produces.
 *
 * This adapter is the one-liner CLI wrapper: run `mapFindings` with the
 * verification report on the `actual` side, take the resulting
 * `controlResults`, and reshape them into `FrameworkMapping`. The
 * detector logic itself is unchanged — the compliance-side router
 * adapter already wraps each of the 12 original framework detectors
 * into the typed-evidence envelope contract that `mapFindings` consumes
 * per catalog entry.
 *
 * Field mapping notes (Codex pass 3):
 *   - `controlName` is optional on `ControlResult` but required on
 *     `FrameworkControl`. Default to `result.controlName ?? result.controlId`.
 *   - Verdict / severity vocabularies are identical between the two
 *     shapes — straight passthrough.
 *   - Evidence ref kinds match — straight passthrough.
 *
 * Ordering: `mapFindings` walks `CONTROL_CATALOG`; the old driver
 * walked its own per-detector table. Output order may differ, but no
 * snapshot test pins framework-mapping shape in the CLI markdown
 * (verified during AAP-86 implementation). Sorted by
 * `(frameworkId, controlId)` here so the CLI output is stable across
 * runs.
 */

import type { ControlResult } from '../../compliance/control-catalog.js';
import type {
  FrameworkControl,
  FrameworkId,
  FrameworkMapping,
  FrameworkMappingSummary,
} from './types.js';

/**
 * The compliance-side `FrameworkId` union includes `iso-42001`; the
 * verification-side union does not (the legacy framework-mapping driver
 * only ever produced the 4 frameworks AIUC-1 / EU AI Act / GDPR / NIST
 * AI RMF). In practice the typed detectors never emit `iso-42001`
 * results either — the ISO 42001 entries in the catalog are prose-only.
 * This guard keeps the type system honest at the boundary and drops any
 * future `iso-42001` typed result from the legacy-shape adapter output.
 */
const VERIFICATION_FRAMEWORK_IDS: ReadonlySet<FrameworkId> = new Set([
  'aiuc-1',
  'eu-ai-act',
  'gdpr',
  'nist-ai-rmf',
]);

function isVerificationFrameworkId(id: string): id is FrameworkId {
  return (VERIFICATION_FRAMEWORK_IDS as ReadonlySet<string>).has(id);
}

function summarizeFrameworkControls(
  controls: readonly FrameworkControl[],
): FrameworkMappingSummary {
  const summary: FrameworkMappingSummary = {
    verifiedCount: 0,
    partialCount: 0,
    unverifiedCount: 0,
    failCount: 0,
    notApplicableCount: 0,
  };
  for (const c of controls) {
    switch (c.verdict) {
      case 'verified': summary.verifiedCount++; break;
      case 'partial': summary.partialCount++; break;
      case 'unverified': summary.unverifiedCount++; break;
      case 'fail': summary.failCount++; break;
      case 'not-applicable': summary.notApplicableCount++; break;
      default: {
        const _exhaustive: never = c.verdict;
        void _exhaustive;
      }
    }
  }
  return summary;
}

function toFrameworkControl(result: ControlResult): FrameworkControl | null {
  if (!isVerificationFrameworkId(result.frameworkId)) return null;
  return {
    framework: result.frameworkId,
    controlId: result.controlId,
    // `ControlResult.controlName` is optional; `FrameworkControl.controlName`
    // is required. Fall back to the control id so the renderer always has
    // a non-empty label.
    controlName: result.controlName ?? result.controlId,
    verdict: result.verdict,
    rationale: result.rationale,
    evidenceRefs: result.evidenceRefs.map((r) => ({ kind: r.kind, ref: r.ref })),
    severity: result.severity,
  };
}

/**
 * Reshape `ControlResult[]` into the legacy `FrameworkMapping` envelope
 * that `report.frameworkMapping` consumers still rely on (markdown /
 * HTML compliance section, HR exec summary).
 *
 * Sorted by `frameworkId` then `controlId` for stable CLI output.
 */
export function controlResultsToFrameworkMapping(
  controlResults: readonly ControlResult[],
  opts: { now?: () => Date } = {},
): FrameworkMapping {
  const now = opts.now ?? (() => new Date());
  const controls = controlResults
    .map(toFrameworkControl)
    .filter((c): c is FrameworkControl => c !== null)
    .sort((a, b) => {
      const fw = a.framework.localeCompare(b.framework);
      if (fw !== 0) return fw;
      return a.controlId.localeCompare(b.controlId);
    });
  return {
    generatedAt: now().toISOString(),
    controls,
    summary: summarizeFrameworkControls(controls),
  };
}
