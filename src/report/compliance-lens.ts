/**
 * AAP-121 (S5 of AAP-117) — the honest compliance-lens projection.
 *
 * SINGLE SOURCE OF TRUTH for the per-framework lens, consumed by BOTH the
 * markdown renderer (`src/report/templates.ts`) and the dashboard React
 * component (`components/heron-v1/dashboard/MinimalReportView.tsx`). Render
 * drift between those two surfaces has bitten Heron before (AAP-108); keeping
 * the counting + grouping + ordering math in one pure module is how we prevent
 * the lens from drifting again. Both renderers must derive their counts and
 * their ordered control lists from `frameworkLens()` — never recompute inline.
 *
 * The agreed layout (per Ilya 2026-06-02):
 *
 *   1. Per-framework header counts by ACTUAL state: verified / fail / partial /
 *      self-attested, plus an out-of-scope COUNT.
 *   2. Show ONLY active controls (the `verifiable` + `self-attested` buckets).
 *      Out-of-scope (`oos-operator-artifact` + `oos-not-verifiable`) is a COUNT
 *      only — no list. All five frameworks use this one typed path; there is no
 *      "prose only" special case for the EU AI Act.
 *   3. Order on expand: verified -> partial -> self-attested.
 *   4. The out-of-scope figure is honest about the PUBLISHED universe, not just
 *      the handful of wired oos controls: it is
 *      `framework.publishedControlCount - (active controls shown)`, so the
 *      header reads "Heron addresses N of ~104, the rest out of scope".
 *
 * Where the data comes from:
 *
 *   - `verifiable` controls have a deterministic detector, so they flow through
 *     `controlResults` (S3 stamps `bucket` on each). Their header tallies
 *     (verified / fail / partial) read the runtime `verdict`.
 *   - `self-attested` controls have NO detector — the agent answers from its
 *     own operation via an interview question. They never appear in
 *     `controlResults`; they surface only as prose `TypedRegulatoryFlag`s in
 *     `compliance.all`, each carrying `selfAttested: true` (S2) and the
 *     `controlIds` it activated. We also tolerate a `self-attested`-bucketed
 *     `controlResult` for robustness, but in practice the prose flags own them.
 *   - the deterministic-first precedence (S2, `applyDeterministicPrecedence`)
 *     already strips any control a detector covered out of the prose flags
 *     before they reach a renderer, so a control is never double-counted across
 *     the verifiable and self-attested lanes.
 */

import { FRAMEWORKS } from '../compliance/frameworks.js';
import { findCatalogEntry, type ControlResult } from '../compliance/control-catalog.js';
import { FINDING_TYPES } from '../compliance/types.js';
import type { ComplianceBucket, FrameworkId } from '../compliance/types.js';
import type { TypedRegulatoryFlag } from '../compliance/mapper.js';
import { dedupeControlResults } from './control-results-projection.js';

// ─── Buckets that count as "active" (surfaced) vs "out of scope" (count only) ─

/**
 * Active = what Heron can actually say something about in OSS-v1: a control
 * with a deterministic verdict (`verifiable`) or a genuine agent self-report
 * (`self-attested`). These are the only buckets the lens LISTS.
 */
export const ACTIVE_BUCKETS: ReadonlySet<ComplianceBucket> = new Set<ComplianceBucket>([
  'verifiable',
  'self-attested',
]);

/**
 * Out of scope = needs a corporate artifact the agent can't see
 * (`oos-operator-artifact`) or an adversarial probe / runtime / infra signal
 * (`oos-not-verifiable`). The lens shows these as a COUNT only, never a list.
 */
export const OUT_OF_SCOPE_BUCKETS: ReadonlySet<ComplianceBucket> = new Set<ComplianceBucket>([
  'oos-operator-artifact',
  'oos-not-verifiable',
]);

// ─── Lens row shapes ─────────────────────────────────────────────────────────

/**
 * One active control as the lens renders it. Mirrors the load-bearing fields of
 * `ControlResult` so the dashboard's existing `ControlRow` can render a row
 * straight from this shape, and the markdown can list `controlId` + verdict.
 */
export interface LensControl {
  frameworkId: FrameworkId;
  controlId: string;
  controlName?: string;
  bucket: ComplianceBucket;
  /**
   * Runtime state. Verifiable controls carry their real detector verdict.
   * Self-attested controls are synthesised with the sentinel `self-attested`
   * verdict — they are agent claims, not deterministic verdicts, so the lens
   * renders them in their own state rather than mislabelling them verified.
   */
  verdict: ControlResult['verdict'] | 'self-attested';
  severity: ControlResult['severity'];
  rationale?: string;
  evidenceRefs?: ControlResult['evidenceRefs'];
}

/** Per-framework header tallies, all by ACTUAL state. */
export interface FrameworkLensCounts {
  verified: number;
  fail: number;
  partial: number;
  /** `unverified` verifiable controls — surfaced in the list, folded into the
   *  header's partial-ish "needs evidence" bucket is avoided; we keep them
   *  countable for callers that want them but the header copy groups them with
   *  partial. Kept distinct so neither renderer has to re-derive it. */
  unverified: number;
  selfAttested: number;
  /** Active controls the lens LISTS = verified + fail + partial + unverified +
   *  selfAttested. */
  activeShown: number;
  /** Honest out-of-scope figure against the published universe:
   *  `publishedControlCount - activeShown`, floored at 0. */
  outOfScope: number;
  /** The framework's published-universe size (the "~104" denominator). */
  publishedControlCount: number;
}

export interface FrameworkLens {
  frameworkId: FrameworkId;
  counts: FrameworkLensCounts;
  /**
   * Active controls in render order: verified -> partial -> unverified ->
   * self-attested -> fail. (Fail sinks below the clean/clarification states so
   * the reader scans the "what's proven" controls first; within a verdict
   * group, original order is preserved.) Out-of-scope controls are NOT here —
   * they are a count only.
   */
  controls: LensControl[];
}

// ─── Ordering ────────────────────────────────────────────────────────────────

/**
 * Render order on expand. The ticket pins "verified -> partial ->
 * self-attested"; we slot the two remaining active states around that spine:
 * `unverified` (a verifiable control with no evidence yet) sits with
 * `partial`, and `fail` sinks last so the proven/needs-clarification controls
 * read first. Lower number = earlier.
 */
const VERDICT_ORDER: Record<LensControl['verdict'], number> = {
  verified: 0,
  partial: 1,
  unverified: 2,
  'self-attested': 3,
  fail: 4,
  'not-applicable': 5,
};

function verdictRank(v: LensControl['verdict']): number {
  return VERDICT_ORDER[v] ?? 99;
}

// ─── Self-attested control extraction from prose flags ───────────────────────

/**
 * Distinct (frameworkId, controlId) pairs the prose flags self-attest for a
 * framework. A control counts as self-attested for the lens when:
 *   - a prose `TypedRegulatoryFlag` for this framework lists it in `controlIds`
 *     (every prose flag is `selfAttested: true` by construction — S2 — but we
 *     read the field defensively rather than assuming), AND
 *   - the control's catalog bucket is `self-attested` (so a verifiable control
 *     that only ever appeared on a prose flag — e.g. before its detector fired
 *     — is NOT miscounted as self-attested).
 *
 * Returns one `LensControl` per distinct control, looking up the control name
 * from the catalog so the row reads like the verifiable rows.
 */
export function selfAttestedControlsForFramework(
  frameworkId: FrameworkId,
  flags: readonly TypedRegulatoryFlag[],
): LensControl[] {
  const seen = new Set<string>();
  const out: LensControl[] = [];
  for (const flag of flags) {
    if (flag.frameworkId !== frameworkId) continue;
    // Defensive: only prose/self-report flags. Flags are self-attested by
    // construction post-S2; treat an explicit `false` as a non-self-report.
    if (flag.selfAttested === false) continue;
    for (const controlId of flag.controlIds ?? []) {
      if (seen.has(controlId)) continue;
      // Confirm the control is genuinely self-attested per the bucket map —
      // look it up via any catalog entry for this (framework, control).
      const entry = findControlAcrossFindings(frameworkId, controlId);
      if (entry?.bucket !== 'self-attested') continue;
      seen.add(controlId);
      out.push({
        frameworkId,
        controlId,
        controlName: entry.controlName,
        bucket: 'self-attested',
        verdict: 'self-attested',
        severity: 'info',
      });
    }
  }
  return out;
}

// ─── Verifiable control extraction from controlResults ───────────────────────

/**
 * The verifiable + any `self-attested`-bucketed control results for a
 * framework, deduped by stableKey, projected into `LensControl`. Out-of-scope
 * buckets are dropped here (they are a count only). A `self-attested`-bucketed
 * controlResult (rare — self-attested controls usually have no detector) is
 * relabelled to the `self-attested` verdict so it renders in the right group.
 */
export function activeControlResultsForFramework(
  frameworkId: FrameworkId,
  controlResults: readonly ControlResult[],
): LensControl[] {
  const out: LensControl[] = [];
  for (const r of dedupeControlResults(controlResults)) {
    if (r.frameworkId !== frameworkId) continue;
    const bucket = r.bucket;
    if (bucket === undefined || !ACTIVE_BUCKETS.has(bucket)) continue;
    out.push({
      frameworkId,
      controlId: r.controlId,
      controlName: r.controlName,
      bucket,
      verdict: bucket === 'self-attested' ? 'self-attested' : r.verdict,
      severity: r.severity,
      rationale: r.rationale,
      evidenceRefs: r.evidenceRefs,
    });
  }
  return out;
}

// ─── The lens ─────────────────────────────────────────────────────────────────

/**
 * Build the honest lens for one framework from the two evidence lanes.
 *
 * @param frameworkId   the framework to project.
 * @param controlResults the typed per-control verdicts (carry `bucket`).
 * @param flags         the prose `compliance.all` flags (carry `selfAttested` +
 *                      `controlIds`).
 */
export function frameworkLens(
  frameworkId: FrameworkId,
  controlResults: readonly ControlResult[],
  flags: readonly TypedRegulatoryFlag[],
): FrameworkLens {
  // Verifiable lane (+ any self-attested-bucketed result), from controlResults.
  const fromResults = activeControlResultsForFramework(frameworkId, controlResults);
  // Self-attested lane, from prose flags — dedup against any control already
  // surfaced from the results lane so a control can't appear twice.
  const resultControlIds = new Set(fromResults.map((c) => c.controlId));
  const fromFlags = selfAttestedControlsForFramework(frameworkId, flags).filter(
    (c) => !resultControlIds.has(c.controlId),
  );

  const controls = [...fromResults, ...fromFlags].sort(
    (a, b) => verdictRank(a.verdict) - verdictRank(b.verdict),
  );

  let verified = 0;
  let fail = 0;
  let partial = 0;
  let unverified = 0;
  let selfAttested = 0;
  for (const c of controls) {
    switch (c.verdict) {
      case 'verified':
        verified += 1;
        break;
      case 'fail':
        fail += 1;
        break;
      case 'partial':
        partial += 1;
        break;
      case 'unverified':
        unverified += 1;
        break;
      case 'self-attested':
        selfAttested += 1;
        break;
      default:
        break;
    }
  }

  const activeShown = controls.length;
  const publishedControlCount = FRAMEWORKS[frameworkId]?.publishedControlCount ?? 0;
  const outOfScope = Math.max(0, publishedControlCount - activeShown);

  return {
    frameworkId,
    counts: {
      verified,
      fail,
      partial,
      unverified,
      selfAttested,
      activeShown,
      outOfScope,
      publishedControlCount,
    },
    controls,
  };
}

/**
 * Frameworks that have at least one active control in EITHER lane (a verifiable
 * verdict or a self-attested prose flag), in registry order (mandatory first:
 * EU AI Act, GDPR; then voluntary) so the lens reads law-first.
 *
 * This is the honest "how many frameworks did we actually say something about"
 * count — it backs the collapsed-header "N frameworks addressed" figure. It is
 * NOT the render enumeration: every framework gets a card regardless (see
 * `allLensFrameworks` / FIX 1 of AAP-121 S5), because a 0-active framework still
 * carries an honest "0 of ~N, the rest out of scope" summary that a reader needs
 * to see (e.g. ISO 42001 / NIST AI RMF have 0 self-attested by design, so they
 * would vanish from a real audit otherwise).
 */
export function lensFrameworks(
  controlResults: readonly ControlResult[],
  flags: readonly TypedRegulatoryFlag[],
): FrameworkId[] {
  const out: FrameworkId[] = [];
  for (const frameworkId of Object.keys(FRAMEWORKS) as FrameworkId[]) {
    const lens = frameworkLens(frameworkId, controlResults, flags);
    if (lens.counts.activeShown > 0) out.push(frameworkId);
  }
  return out;
}

/**
 * Every framework the lens renders a card for — ALL of them, in registry order
 * (mandatory first: EU AI Act, GDPR; then voluntary). FIX 1 of AAP-121 S5: we
 * no longer hide 0-active frameworks. A framework with zero active controls
 * still renders its card with the same summary structure as the active ones
 * (active count = 0 plus the out-of-scope / published-count line), just with no
 * active-control rows. The "addressed" count stays honest via `lensFrameworks`.
 */
export function allLensFrameworks(): FrameworkId[] {
  return Object.keys(FRAMEWORKS) as FrameworkId[];
}

// ─── Finding-type-agnostic catalog lookup ─────────────────────────────────────

/**
 * Scan the catalog for any entry matching (frameworkId, controlId), ignoring
 * finding type. The bucket + name are control properties, so the first match
 * is authoritative. Lives here (not in control-catalog.ts) because it is a
 * lens-specific convenience over the exported `findCatalogEntry` finder.
 */
function findControlAcrossFindings(
  frameworkId: FrameworkId,
  controlId: string,
): { bucket: ComplianceBucket; controlName?: string } | undefined {
  // The finding types a control can hang under are unknown here, so reuse the
  // exported per-finding finder across the canonical finding-type set. Cheap:
  // the catalog is tiny and this runs once per self-attested control.
  for (const findingType of FINDING_TYPES_FOR_LOOKUP) {
    const entry = findCatalogEntry({ findingType, frameworkId, controlId });
    if (entry) {
      const out: { bucket: ComplianceBucket; controlName?: string } = { bucket: entry.bucket };
      if (entry.title !== undefined) out.controlName = entry.title;
      else if (entry.note !== undefined) out.controlName = entry.note;
      return out;
    }
  }
  return undefined;
}

// The finding-type set the agnostic lookup scans. Reusing the runtime
// FINDING_TYPES array keeps it in sync if a finding type is ever added.
const FINDING_TYPES_FOR_LOOKUP = FINDING_TYPES;
