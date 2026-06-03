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
import {
  findCatalogEntry,
  listCatalogEntries,
  type ControlResult,
} from '../compliance/control-catalog.js';
import { CONTROL_MAPPINGS } from '../compliance/control-mappings.js';
import { FINDING_TYPES } from '../compliance/types.js';
import type { ComplianceBucket, FindingType, FrameworkId } from '../compliance/types.js';
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

// ─── Static capability coverage C (AAP-128 / S12) ─────────────────────────────

/**
 * AAP-128 (S12) — per-framework STATIC capability coverage `C`.
 *
 * `C` = the count of DISTINCT controls in `frameworkId`'s catalog whose honest
 * bucket is in `ACTIVE_BUCKETS` (`verifiable` OR `self-attested`). It is a
 * property of the catalog/bucket MODEL (`control-catalog.ts` stamps the bucket
 * from `control-buckets.ts`), NOT of any one audit — so it is identical on
 * every run regardless of which controls actually fired. This is what the
 * coverage headline ("C of ~N covered") must read, so the figure never moves
 * audit-to-audit (contrast `activeShown`, which is per-audit).
 *
 * Derived from `CONTROL_CATALOG` (not directly from `BUCKET_BY_CONTROL`) so a
 * bucket-map entry that is not actually WIRED into a catalog entry cannot
 * inflate C — only controls that can reach a report are counted, consistent
 * with the honest-lens principle. (In practice the two agree, because the
 * catalog's distinct control set per framework equals the bucket map's keys;
 * computing from the catalog keeps it that way by construction.)
 *
 * Computed once at module load and memoised: the catalog is frozen at load.
 */
const STATIC_COVERAGE_BY_FRAMEWORK: Record<FrameworkId, number> = (() => {
  const distinctActive = new Map<FrameworkId, Set<string>>();
  for (const entry of listCatalogEntries()) {
    if (!ACTIVE_BUCKETS.has(entry.bucket)) continue;
    let set = distinctActive.get(entry.frameworkId);
    if (!set) {
      set = new Set<string>();
      distinctActive.set(entry.frameworkId, set);
    }
    set.add(entry.controlId);
  }
  const out = {} as Record<FrameworkId, number>;
  for (const frameworkId of Object.keys(FRAMEWORKS) as FrameworkId[]) {
    out[frameworkId] = distinctActive.get(frameworkId)?.size ?? 0;
  }
  return out;
})();

/**
 * The static capability coverage `C` for one framework — the headline
 * numerator. Identical every audit (see `STATIC_COVERAGE_BY_FRAMEWORK`).
 */
export function staticCoverageForFramework(frameworkId: FrameworkId): number {
  return STATIC_COVERAGE_BY_FRAMEWORK[frameworkId] ?? 0;
}

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
  /** Active controls the lens LISTS this audit = verified + fail + partial +
   *  unverified + selfAttested. PER-AUDIT — fluctuates with which controls
   *  fired. NOT the coverage headline (that is `covered`, below). */
  activeShown: number;
  /**
   * AAP-128 (S12) — STATIC capability coverage `C`: the count of THIS
   * framework's catalog controls whose bucket is `verifiable` OR
   * `self-attested`. Computed from the catalog/bucket model
   * (`control-catalog.ts` + `control-buckets.ts`), NOT from the per-audit
   * `activeShown`, so it is identical on every audit regardless of which
   * controls fired. This is the coverage-headline numerator: "C of ~N covered".
   */
  covered: number;
  /** Honest out-of-scope figure against the published universe.
   *  AAP-128 (S12): now `publishedControlCount - covered` (= N − C, STATIC
   *  capability), floored at 0 — what Heron structurally cannot address for
   *  this framework, identical every audit. (Was `publishedControlCount -
   *  activeShown`, a per-audit figure.) */
  outOfScope: number;
  /** The framework's published-universe size (the "~104" denominator, `N`). */
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

// ─── Lane B — self-attested FINDINGS attributed to frameworks (AAP-122) ───────

/**
 * AAP-122 — the load-bearing fields of a self-attested (`evidenceSource: 'SLF'`)
 * finding the lens needs to attribute it to a framework card. Structural so
 * BOTH the verdict's live `VerdictFinding` (verdict.ts) and the persisted
 * `VerdictFindingSnapshot` (report/types.ts) — and the dashboard's wire shape —
 * satisfy it without a coupling import. The renderers pass their own finding
 * objects straight through.
 *
 * NOTE the two lanes are distinct. Lane A (`selfAttestedControlsForFramework`,
 * above) renders self-attested CONTROLS from prose `TypedRegulatoryFlag`s and
 * is UNTOUCHED. Lane B (here) renders the global "Self-Attested Findings"
 * stream's `VerdictFinding`s additionally under each framework card, AFTER the
 * control rows, without removing them from the global list.
 */
export interface SlfLensFinding {
  /** Stable finding id (for React keys / de-dup). */
  id: string;
  /** Human-readable finding title. */
  title: string;
  /** Provenance — only `'SLF'` findings are attributed; others are ignored. */
  evidenceSource: string;
  /**
   * The bounded finding-type classification, when the analyzer assigned one.
   * Absent → the finding gets no card and stays global-only.
   */
  findingType?: FindingType;
}

/**
 * AAP-122 — the DISTINCT frameworks a finding type maps to, derived
 * DETERMINISTICALLY from the `CONTROL_MAPPINGS` table (one finding type can
 * activate controls across several frameworks). The framework identity comes
 * entirely from the table; the LLM never names a framework. Returns frameworks
 * in `CONTROL_MAPPINGS` order, deduped. An unknown / unmapped finding type
 * yields an empty array.
 */
export function frameworkIdsForFindingType(findingType: FindingType): FrameworkId[] {
  const mapping = CONTROL_MAPPINGS[findingType];
  if (!mapping) return [];
  const out: FrameworkId[] = [];
  const seen = new Set<FrameworkId>();
  for (const control of mapping.controls) {
    if (seen.has(control.frameworkId)) continue;
    seen.add(control.frameworkId);
    out.push(control.frameworkId);
  }
  return out;
}

/**
 * AAP-122 — the self-attested findings that belong under one framework's card.
 *
 * A finding is attributed to `frameworkId` when it is an SLF finding, carries a
 * `findingType`, and that finding type maps (via `CONTROL_MAPPINGS`) to at
 * least one control in `frameworkId`. The SAME finding fans out to every
 * framework its type maps to — so a `decisions-about-people` finding appears
 * under EU AI Act, GDPR, ISO 42001, AIUC-1, and NIST AI RMF. A finding with no
 * `findingType`, or whose type maps to no controls, is attributed to NO card
 * (it stays in the global stream only).
 *
 * Pure and additive: it neither mutates nor consumes the global list — the
 * caller still renders that list in full. Order is preserved from the input.
 *
 * AAP-123 (S7) — generic over the concrete finding shape. The body reads ONLY
 * `evidenceSource` + `findingType` (both on the `SlfLensFinding` base), so the
 * caller can feed its own richer finding objects — e.g. a `CodedVerdictFinding`
 * carrying severity / description / code — and get the SAME concrete type back.
 * That is what lets each framework card render the finding as a full finding
 * card (not a stripped title bullet) without a second lookup or a cast.
 */
export function slfFindingsForFramework<T extends SlfLensFinding>(
  frameworkId: FrameworkId,
  findings: readonly T[],
): T[] {
  const out: T[] = [];
  for (const f of findings) {
    if (f.evidenceSource !== 'SLF') continue;
    if (f.findingType === undefined) continue;
    if (!frameworkIdsForFindingType(f.findingType).includes(frameworkId)) continue;
    out.push(f);
  }
  return out;
}

// ─── Finding → anchored control resolution (S13) ──────────────────────────────

/**
 * S13 — the control a self-attested FINDING is ANCHORED to for a given
 * framework. This is the SAME deterministic table the global finding card's
 * "Anchored to: <framework> <article>" line is built from (`getFrameworkBasis`
 * in templates.ts reads the prose flag's `controlIds[0]`, which is itself
 * seeded from `CONTROL_MAPPINGS`): the finding's `findingType` maps — via
 * `CONTROL_MAPPINGS` — to one or more controls per framework, and the anchor is
 * the FIRST of those, preferring a control whose catalog bucket is active
 * (`verifiable`/`self-attested`) so the finding nests under a control the lens
 * will actually render as a row.
 *
 * Returns `undefined` when the finding type maps to no control in this
 * framework (the caller then renders the finding as a standalone compact row —
 * the FALLBACK in the redesign spec).
 */
export function anchorControlForFinding(
  frameworkId: FrameworkId,
  findingType: FindingType,
): { controlId: string; controlName?: string; bucket: ComplianceBucket } | undefined {
  const mapping = CONTROL_MAPPINGS[findingType];
  if (!mapping) return undefined;
  const inFramework = mapping.controls.filter((c) => c.frameworkId === frameworkId);
  if (inFramework.length === 0) return undefined;

  // Prefer the first control whose catalog bucket is ACTIVE so the finding
  // nests under a renderable row; otherwise fall back to the first mapped
  // control (still anchored honestly, even if it is itself out of scope).
  const resolve = (controlId: string) => findControlAcrossFindings(frameworkId, controlId);
  let chosen = inFramework.find((c) => {
    const entry = resolve(c.controlId);
    return entry !== undefined && ACTIVE_BUCKETS.has(entry.bucket);
  });
  if (!chosen) chosen = inFramework[0];
  if (!chosen) return undefined;

  const entry = resolve(chosen.controlId);
  const out: { controlId: string; controlName?: string; bucket: ComplianceBucket } = {
    controlId: chosen.controlId,
    bucket: entry?.bucket ?? 'self-attested',
  };
  const name = entry?.controlName ?? chosen.note;
  if (name !== undefined) out.controlName = name;
  return out;
}

// ─── Composed framework rows: findings nested under their anchor control (S13) ─

/**
 * S13 — one compact reference to a self-attested FINDING, nested under the
 * control it anchors to (or standalone in the fallback path). Carries only the
 * fields a renderer needs to draw a one-line `CODE  Title  ↗` reference that
 * links to the FULL card in the global Self-Attested Findings stream.
 */
export interface LensFindingRef {
  /** Stable finding id (React key). */
  id: string;
  /** Vijil-style finding code, e.g. `SLF-001`. */
  code: string;
  /** Human-readable finding title. */
  title: string;
}

/**
 * S13 — a control row plus the self-attested findings nested under it. The
 * control is rendered with its verdict badge; each nested finding is a compact
 * reference into the global stream. `syntheticSelfAttested` is true when the
 * control did NOT independently activate this audit and exists ONLY because a
 * finding anchors to it — the renderer shows it with the `self-attested`
 * verdict in that case (spec point 1).
 */
export interface LensControlRow {
  control: LensControl;
  findings: LensFindingRef[];
}

/**
 * S13 — the fully composed render model for ONE framework card: the ordered
 * control rows (each with any nested findings) plus any findings whose anchor
 * could not be resolved to a renderable control (FALLBACK — rendered as
 * standalone compact rows at the end). `surfaced` is the redesign's `A`: the
 * count of DISTINCT ACTIVE-bucket controls actually shown as rows this audit
 * (activated + finding-anchored), which is the headline numerator `{A} of {C}
 * covered`. Synthetic rows whose anchor fell back to an out-of-scope bucket are
 * still rendered but excluded from `A`, so it never exceeds `C`.
 */
export interface FrameworkLensRows {
  rows: LensControlRow[];
  /** FALLBACK findings with no resolvable anchor control — standalone rows. */
  orphanFindings: LensFindingRef[];
  /** `A` — distinct ACTIVE-bucket controls surfaced as rows this audit
   *  (activated + finding-anchored). Excludes synthetic rows whose anchor fell
   *  back to an out-of-scope bucket, so the headline never reads A > C. */
  surfaced: number;
}

/** The finding shape `composeFrameworkLensRows` reads — code + title + the
 *  attribution fields. Both the dashboard's `CodedVerdictFinding` and the
 *  markdown path satisfy it structurally. */
export interface ComposableFinding extends SlfLensFinding {
  code: string;
}

/**
 * S13 — compose the per-framework render model: nest each self-attested finding
 * under the control it ANCHORS to for this framework, synthesising a
 * `self-attested` control row when the anchor control did not independently
 * activate this audit. Findings whose anchor cannot be resolved to a control
 * fall back to `orphanFindings`. Pure; shared by BOTH renderers so the two
 * surfaces stay identical.
 *
 * `findings` should already be the framework-scoped set
 * (`slfFindingsForFramework(frameworkId, …)`).
 */
export function composeFrameworkLensRows<T extends ComposableFinding>(
  lens: FrameworkLens,
  findings: readonly T[],
): FrameworkLensRows {
  const { frameworkId } = lens;
  // Start from the activated controls, preserving the projection's order.
  const rows: LensControlRow[] = lens.controls.map((control) => ({ control, findings: [] }));
  const rowByControlId = new Map<string, LensControlRow>();
  for (const row of rows) rowByControlId.set(row.control.controlId, row);

  const orphanFindings: LensFindingRef[] = [];

  for (const f of findings) {
    const ref: LensFindingRef = { id: f.id, code: f.code, title: f.title };
    const anchor =
      f.findingType !== undefined ? anchorControlForFinding(frameworkId, f.findingType) : undefined;
    if (!anchor) {
      orphanFindings.push(ref);
      continue;
    }
    let row = rowByControlId.get(anchor.controlId);
    if (!row) {
      // The anchor control did not independently activate this audit — it
      // exists ONLY because this finding anchors to it. Synthesise a row with
      // the `self-attested` verdict (spec point 1).
      const synthetic: LensControl = {
        frameworkId,
        controlId: anchor.controlId,
        bucket: anchor.bucket,
        verdict: 'self-attested',
        severity: 'info',
        ...(anchor.controlName !== undefined ? { controlName: anchor.controlName } : {}),
      };
      row = { control: synthetic, findings: [] };
      rowByControlId.set(anchor.controlId, row);
      rows.push(row);
    }
    row.findings.push(ref);
  }

  // `A` — distinct ACTIVE-bucket controls surfaced as rows (activated +
  // finding-anchored). A synthetic finding-anchored row whose control fell back
  // to an out-of-scope bucket (anchorControlForFinding prefers an ACTIVE-bucket
  // control but FALLS BACK to a non-active one) is still RENDERED, but it must
  // NOT inflate the numerator past the static coverage denominator `C`
  // (`staticCoverageForFramework`, which counts only ACTIVE_BUCKETS controls).
  // Counting only ACTIVE_BUCKETS rows keeps the headline honest: A ≤ C ≤ N.
  const surfaced = rows.filter((row) => ACTIVE_BUCKETS.has(row.control.bucket)).length;
  return { rows, orphanFindings, surfaced };
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
  // AAP-128 (S12): coverage is the STATIC capability C (catalog-derived),
  // identical every audit; out-of-scope is N − C (also static). The per-audit
  // `activeShown` is kept for the verdict breakdown but is no longer the
  // headline figure.
  const covered = staticCoverageForFramework(frameworkId);
  const outOfScope = Math.max(0, publishedControlCount - covered);

  return {
    frameworkId,
    counts: {
      verified,
      fail,
      partial,
      unverified,
      selfAttested,
      activeShown,
      covered,
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
