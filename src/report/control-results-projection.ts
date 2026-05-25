/**
 * AAP-84 Phase 4 — derive renderer-facing projections from
 * `controlResults: ControlResult[]`.
 *
 * Why this lives here (not in `src/compliance/`):
 *
 * The renderers (`src/report/templates.ts`, `components/heron-v1/dashboard/
 * ReportView.tsx`) want a compact "what changed for the reader" shape:
 * per-framework gap counters, overall severity label, gap-type labels
 * for the applicability summary. The compliance module ships a flat
 * `ControlResult[]` because each detector is independent and the renderer
 * is not the only consumer (Phase 6 will ship classifyEUAIAct off the
 * same typed envelope).
 *
 * Phase 4 of AAP-83's mapper unification migrates renderers from
 * `compliance.all: TypedRegulatoryFlag[]` to `controlResults`. The two
 * shapes carry different semantics:
 *
 *   - `TypedRegulatoryFlag` collapses each (framework × finding) into
 *     ONE flag with a single severity. The legacy gap counter on
 *     templates.ts:44 reads `severity !== 'info'`.
 *
 *   - `ControlResult` keeps each control distinct with a per-control
 *     verdict ladder: `verified | partial | unverified | fail |
 *     not-applicable`. There is no `info` severity that doubles as
 *     "not a gap" — that semantic was implicit in the flag projection.
 *
 * Gap-count mapping (canonical for Phase 4):
 *
 *   - `fail`            → counts as a gap. The control is actively
 *                         violated. Default the severity to the
 *                         detector-emitted severity (usually high /
 *                         critical for fail verdicts).
 *   - `partial`         → counts as a gap. Some evidence supports the
 *                         control but not enough to verify.
 *   - `unverified`      → counts as a gap. The reader has no evidence
 *                         either way — the gap IS the absence of
 *                         evidence. Phase 6+ will route around this once
 *                         classifyEUAIAct stops emitting `unverified`
 *                         for legitimately-not-applicable controls.
 *   - `verified`        → not a gap. Evidence supports the control.
 *   - `not-applicable`  → not a gap. The control was correctly excluded.
 *
 * Severity → status label mapping (mirrors the legacy
 * `summarizeOverallStatus` ladder):
 *
 *   - any `fail` + severity `critical|high`        → "Action Required"
 *   - any `fail` + severity `medium`                → "Action Required"
 *   - any `fail` + severity `low|info`              → "Review"
 *   - any `partial` (no fails)                      → "Needs Clarification"
 *   - any `unverified` (no fails, no partials)      → "Review"
 *   - only `verified` / `not-applicable`            → "Not Triggered"
 *
 * Codex flagged "risk of double/undercount" — this module dedupes by
 * `stableKey` so a detector that fires twice for the same control (the
 * router adapter pairs A003.3 and A003.4 onto one detector function)
 * does not inflate the gap counter.
 */

import type {
  ControlResult,
  ControlResultSeverity,
  ControlResultVerdict,
} from '../compliance/control-catalog.js';
import type { FrameworkId } from '../compliance/types.js';

/** Verdicts that count toward the gap counter. */
export const GAP_VERDICTS: ReadonlySet<ControlResultVerdict> = new Set<ControlResultVerdict>([
  'fail',
  'partial',
  'unverified',
]);

export function isGapVerdict(v: ControlResultVerdict): boolean {
  return GAP_VERDICTS.has(v);
}

/**
 * Dedup controlResults by `stableKey`. Catalog adapters can register the
 * same detector under multiple (findingType, frameworkId, controlId)
 * triples (e.g. AIUC-1 A003.3 + A003.4 share `detectAIUC1_A003`). Two
 * detectors lighting the same stable key would double-count gaps;
 * filtering here keeps the renderer honest.
 */
export function dedupeControlResults(results: readonly ControlResult[]): ControlResult[] {
  const seen = new Set<string>();
  const out: ControlResult[] = [];
  for (const r of results) {
    if (seen.has(r.stableKey)) continue;
    seen.add(r.stableKey);
    out.push(r);
  }
  return out;
}

/**
 * Filter helpers — clearer at the call site than inline predicates.
 */
export function gapResults(results: readonly ControlResult[]): ControlResult[] {
  return dedupeControlResults(results).filter((r) => isGapVerdict(r.verdict));
}

export function resultsForFramework(
  results: readonly ControlResult[],
  frameworkId: FrameworkId,
): ControlResult[] {
  return dedupeControlResults(results).filter((r) => r.frameworkId === frameworkId);
}

/**
 * Severity ladder used to pick "highest severity in the set". Mirrors
 * `severityOrder` in templates.ts but operates on ControlResultSeverity
 * instead of the legacy flag-severity vocabulary.
 */
const CR_SEVERITY_RANK: Record<ControlResultSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

export function worstSeverity(
  results: readonly ControlResult[],
): ControlResultSeverity | null {
  let worst: ControlResultSeverity | null = null;
  for (const r of results) {
    if (worst === null || CR_SEVERITY_RANK[r.severity] > CR_SEVERITY_RANK[worst]) {
      worst = r.severity;
    }
  }
  return worst;
}

/**
 * Overall status label derived from `controlResults`. Mirrors
 * `summarizeOverallStatus`'s legacy contract:
 *
 *   - "Action Required"      — at least one `fail` verdict, regardless of severity
 *   - "Needs Clarification"  — at least one `partial`, no fails
 *   - "Review"               — at least one `unverified`, no fails / partials
 *   - "Not Triggered"        — only `verified` / `not-applicable` (or empty)
 *
 * This loses the legacy "warning"/"action-required" flag-severity
 * gradient — the verdict ladder is the new ground truth, severity is
 * for sorting / pill colour rather than the top-level label.
 */
export function statusLabelFromControlResults(
  results: readonly ControlResult[],
): string {
  const deduped = dedupeControlResults(results);
  if (deduped.length === 0) return 'Not Triggered';
  if (deduped.some((r) => r.verdict === 'fail')) return 'Action Required';
  if (deduped.some((r) => r.verdict === 'partial')) return 'Needs Clarification';
  if (deduped.some((r) => r.verdict === 'unverified')) return 'Review';
  return 'Not Triggered';
}

/**
 * Per-tier gap counts. Output mirrors the legacy
 * `summarizeOverallStatus` suffix that reads
 * `(N mandatory-framework gaps, M voluntary-framework gaps)`.
 *
 * `mandatoryFrameworks` lets the caller inject which framework IDs are
 * mandatory in the OSS scope (currently `eu-ai-act`, `gdpr`). Other
 * frameworks tally toward `voluntary`. Decoupling from
 * `FRAMEWORKS[id].tier` keeps this module free of framework registry
 * imports and lets tests pin behaviour without spinning the registry.
 */
export function gapCountsByTier(
  results: readonly ControlResult[],
  mandatoryFrameworks: ReadonlySet<FrameworkId>,
  excludedFindingTypes: ReadonlySet<string> = new Set(),
): { mandatory: number; voluntary: number } {
  const gaps = gapResults(results).filter(
    (g) => !excludedFindingTypes.has(g.findingType),
  );
  let mandatory = 0;
  let voluntary = 0;
  for (const g of gaps) {
    if (mandatoryFrameworks.has(g.frameworkId)) mandatory += 1;
    else voluntary += 1;
  }
  return { mandatory, voluntary };
}

/**
 * Per-framework gap projection — used by the applicability summary table.
 * Returns the dedup'd ControlResult set for the framework AND a short
 * `gapLabels` list derived from `findingType` for the "Gaps Found" cell.
 *
 * The legacy projection on `compliance.all` grouped by `triggeredBy`
 * (the findingType) and rendered one label per type. Keeping that
 * grouping here preserves the existing reader's "Excessive permissions,
 * Data handling" UX so the migration is purely about source-of-truth,
 * not display shape.
 *
 * `excludedFindingTypes` mirrors the legacy `GAP_EXCLUDED` set on
 * templates.ts — `risk-score` always fires as a methodology anchor, not
 * a real gap. Passing the set here keeps the renderer's existing
 * exclusion contract intact under the new source.
 */
export function gapLabelsForFramework(
  results: readonly ControlResult[],
  frameworkId: FrameworkId,
  labelMap: Readonly<Record<string, string>>,
  excludedFindingTypes: ReadonlySet<string> = new Set(),
): string[] {
  const gaps = gapResults(results).filter(
    (r) => r.frameworkId === frameworkId && !excludedFindingTypes.has(r.findingType),
  );
  const uniqueFindingTypes = [...new Set(gaps.map((g) => g.findingType))];
  return uniqueFindingTypes.map((t) => labelMap[t] ?? t);
}

/**
 * The set of frameworks that fired at least one ControlResult. Used to
 * derive the applicability summary's "activated" column when the caller
 * is migrating to controlResults-as-source-of-truth.
 *
 * NOTE: this is a SUPERSET of "actually triggered" — a control can fire
 * with `verified` (which is not a gap) and still mean the framework is
 * activated. The renderer treats activation and gaps independently.
 */
export function activatedFrameworksFromControlResults(
  results: readonly ControlResult[],
): FrameworkId[] {
  const set = new Set<FrameworkId>();
  for (const r of dedupeControlResults(results)) {
    set.add(r.frameworkId);
  }
  return [...set];
}
