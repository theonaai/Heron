/**
 * AAP-83 — Unified control catalog.
 *
 * Single registry that consolidates the two parallel control inventories
 * that lived in the codebase prior to AAP-83:
 *
 *   - `CONTROL_MAPPINGS` (src/compliance/control-mappings.ts) — Heron_v1
 *     port. 5 frameworks, 30+ controls. Prose-driven detection: regexes
 *     fire over interview transcript text. Drives the LLM-grounded
 *     compliance section of every audit report.
 *
 *   - The 12 framework detectors (now in
 *     `src/verification/frameworks/detectors.ts`, originally the
 *     standalone driver lifted out in AAP-86) — AAP-49 deterministic
 *     router. 4 frameworks (no ISO 42001), 12 controls. Typed-evidence
 *     detection: pure functions consume `VerificationSignals` (diffs,
 *     inventories, approval chain) and return a `ControlVerdict`.
 *     Pre-AAP-83 CLI-only; AAP-83 wired them into the dashboard mapper
 *     via `router-adapter.ts`.
 *
 * The catalog gives each entry a stable identity (`stableKey`) plus an
 * optional `deterministicDetector` slot. Per-control, the mapper can pick
 * the typed path (when actual evidence is available AND a detector
 * exists) or fall back to the prose path. Both paths can run side-by-side
 * for the same control while we validate parity; the prose path stays
 * the default until typed evidence proves it does the right thing.
 *
 * Why a catalog rather than two tables: the architectural problem with
 * the two-tables-in-parallel arrangement was that the same control
 * (e.g. AIUC-1 A003 — Least Privilege) had different rule shapes,
 * different evidence vocabularies, and different output schemas
 * depending on which engine ran it. Mapping the same control through
 * the same key here forces the two engines to agree on identity before
 * they diverge on evidence.
 *
 * Migration plan (per AAP-83 ticket):
 *   - Phase 1 (this file)    — catalog scaffolded; CONTROL_MAPPINGS
 *                              entries adapted into catalog entries.
 *                              Detectors NOT wired yet.
 *   - Phase 2                — router detectors absorbed into
 *                              src/compliance/detectors/, catalog entries
 *                              wired up.
 *   - Phase 3                — mapper input refactored to {declared,
 *                              actual} envelope.
 *   - Phase 4                — per-control two-path execution lit up.
 *   - Phase 5                — recompute-compliance prose synthesis
 *                              deleted (typed path wins for discovery).
 *   - Phase 9                — router.ts registry deleted.
 *
 * Stable key contract: `${findingType}:${frameworkId}:${controlId}`.
 * Used for dedup, snapshot diffing, and per-control verdict lookup.
 * Never construct one ad-hoc; call `stableKeyFor()`.
 */

import { CONTROL_MAPPINGS } from './control-mappings.js';
import { DISCOVERY_DETECTOR_ADAPTERS } from './detectors/discovery-detectors.js';
import { ROUTER_DETECTOR_ADAPTERS } from './detectors/router-adapter.js';
import type {
  ComplianceBucket,
  ControlMapping,
  FindingType,
  FrameworkControl,
  FrameworkId,
  RiskCategory,
} from './types.js';
import { BUCKET_BY_CONTROL } from './control-buckets.js';

/**
 * Sentinel bucket stamped at entry-construction time and overwritten for every
 * wired control by `assignBuckets`. It exists only to satisfy the required
 * `bucket` field during the two-step build (construct → assign); `assignBuckets`
 * throws if any wired control still lacks a real bucket, so this value can
 * never reach a real report.
 */
const PROVISIONAL_BUCKET: ComplianceBucket = 'oos-not-verifiable';

// ─── Detector function signature ───────────────────────────────────────────

/**
 * Typed-evidence detector signature.
 *
 * Detectors are PURE functions. Given the typed evidence envelope, they
 * return either a `ControlResult` (covers verified / partial / fail /
 * unverified / not-applicable) or `null` when no signal is available.
 * Null means "no opinion" — the caller falls back to the prose path or
 * surfaces the legacy mapping unchanged.
 *
 * Kept loose here (`unknown` for the envelope) because the typed
 * envelope is defined in `./detectors/types.ts` (Phase 2) — importing
 * it here would create a circular dep. The detectors themselves
 * narrow at the call site.
 */
export type DetectorFn = (
  evidence: unknown,
) => ControlResult | null;

// ─── ControlResult — per-control output shape ──────────────────────────────

/**
 * Provenance fields per ticket spec point 4:
 *   - `path`    — which engine produced the verdict.
 *   - `surface` — which evidence surface the verdict was anchored to.
 */
export type ControlResultPath = 'typed' | 'prose' | 'combined';

/**
 * Surface vocabulary.
 *
 *   - `declared` — Surface 1: interview transcript / agent declaration.
 *   - `actual`   — Surface 2 deterministic: filesystem discovery
 *                  (L1-L3), MCP server enumeration, scope inventory.
 *   - `oauth`    — Surface 2 cloud: L4 OAuth introspection.
 *   - `approval` — approval-chain evidence (E004, E015, Article 14, 12).
 */
export type ControlResultSurface = 'declared' | 'actual' | 'oauth' | 'approval';

export type ControlResultVerdict =
  | 'verified'
  | 'partial'
  | 'unverified'
  | 'fail'
  | 'not-applicable';

export type ControlResultSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface ControlResultEvidenceRef {
  kind: 'diff' | 'inventory' | 'approval' | 'declared' | 'absence';
  ref: string;
}

export interface ControlResult {
  /** Stable identity — `${findingType}:${frameworkId}:${controlId}`. */
  stableKey: string;
  findingType: FindingType;
  frameworkId: FrameworkId;
  /**
   * AAP-111: owning framework id, denormalised join field for report.json
   * consumers. Always equals `frameworkId`; carried as its own key so the
   * serialised `controlResults[].framework` matches `frameworksActivated`
   * entries and the dashboard's `FRAMEWORK_LABELS` map without the reader
   * having to know the internal field is named `frameworkId`. Stamped from
   * the catalog entry (single source of truth) in `runTypedDetectors`, so a
   * detector that forgets to set it cannot leave the join field empty.
   */
  framework: FrameworkId;
  controlId: string;
  controlName?: string;
  path: ControlResultPath;
  surface: ControlResultSurface;
  verdict: ControlResultVerdict;
  severity: ControlResultSeverity;
  rationale: string;
  evidenceRefs: ControlResultEvidenceRef[];
  /**
   * AAP-118 (S3 of AAP-117): the honest 4-bucket classification of this
   * control, denormalised from the catalog entry. The `verdict` above is the
   * runtime STATE; `bucket` is the control METADATA that says what Heron can
   * honestly establish at all. Optional on the wire so the ~25 other
   * `ControlResult` construction sites (verdict engine, hr-pack, report
   * translators) stay untouched — only the compliance mapper stamps it, from
   * the catalog (single source of truth), mirroring how `framework` is stamped
   * in `runTypedDetectors`. Absent ⇒ producer predates the bucket model.
   */
  bucket?: ComplianceBucket;
}

// ─── Catalog entry shape ───────────────────────────────────────────────────

export interface ControlCatalogEntry {
  /** Identity */
  findingType: FindingType;
  frameworkId: FrameworkId;
  controlId: string;
  /** Human-readable name; used in markdown + dashboard renderers. */
  title?: string;
  /** Risk category — copied from the parent `ControlMapping`. */
  category: RiskCategory;
  /** Carries the same metadata that lived on `FrameworkControl`. */
  note?: string;
  annexIII?: boolean;
  gatedBy?: string[];
  /**
   * AAP-118 (S3 of AAP-117): the honest 4-bucket classification of this
   * control. Required control metadata — populated for every catalog entry at
   * build time from `BUCKET_BY_CONTROL` (keyed by `frameworkId` + `controlId`,
   * derived from `framework-buckets-honest-2026-06-02.md`). Distinct from the
   * runtime verdict: the bucket says what Heron CAN establish, the verdict
   * says what it DID establish for a given audit. The build throws if any
   * wired control is missing a bucket, so this can never be silently absent.
   */
  bucket: ComplianceBucket;
  /**
   * Optional deterministic detector. When present AND typed evidence is
   * available, the mapper runs the detector and prefers its verdict over
   * the prose path. When absent (or returns null), the prose path runs
   * unchanged.
   *
   * Phase 1: all entries land with `deterministicDetector: undefined` —
   * we only consolidate the registry here. Phase 2 absorbs the 12
   * router detectors and wires them up.
   */
  deterministicDetector?: DetectorFn;
  /**
   * Whether the prose path should ever run for this control. Default
   * `true` — keeps the existing Heron_v1 LLM-grounded behaviour. A
   * future control with a typed-only rule can set this to `false`.
   */
  prosePathEnabled: boolean;
}

// ─── Stable key re-export ──────────────────────────────────────────────────

// Re-export from `./control-key.js` so call sites that already import
// from this barrel keep working. The helper itself lives in its own
// module to break a circular dep between this file and the typed-
// evidence detectors.
export { stableKeyFor } from './control-key.js';
import { stableKeyFor } from './control-key.js';

// ─── Catalog construction from CONTROL_MAPPINGS ────────────────────────────

/**
 * Flatten `CONTROL_MAPPINGS` (one entry per finding-type, each with an
 * inner list of controls) into the catalog shape (one entry per
 * (findingType, control) pair). Detectors are not attached at this
 * stage — Phase 1 only consolidates identity.
 *
 * Same control id (e.g. `iso-42001 A.6.2.6`) can legitimately appear
 * under multiple finding types (excessive-access AND scope-creep, etc.)
 * — the catalog preserves both as distinct entries because the
 * downstream renderer keys per-finding.
 */
function buildCatalogFromMappings(): ControlCatalogEntry[] {
  const entries: ControlCatalogEntry[] = [];
  for (const mapping of Object.values(CONTROL_MAPPINGS) as ControlMapping[]) {
    for (const ctrl of mapping.controls) {
      const entry: ControlCatalogEntry = {
        findingType: mapping.findingType,
        frameworkId: ctrl.frameworkId,
        controlId: ctrl.controlId,
        category: mapping.category,
        prosePathEnabled: true,
        // Provisional — overwritten (and completeness-checked) by
        // `assignBuckets` after the catalog is fully assembled.
        bucket: PROVISIONAL_BUCKET,
      };
      if (ctrl.note !== undefined) entry.note = ctrl.note;
      if (ctrl.annexIII !== undefined) entry.annexIII = ctrl.annexIII;
      if (ctrl.gatedBy !== undefined) entry.gatedBy = ctrl.gatedBy;
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * Splice typed-evidence detectors into the catalog. Phase 2 absorbs the
 * router's 12 detectors via `router-adapter.ts` — each adapter row maps
 * to a catalog entry by `stableKey`. When an adapter row references a
 * controlId the catalog does not yet have, we append a new entry so the
 * router's coverage survives the migration.
 *
 * `control-key.ts` carries `stableKeyFor` to break a would-be circular
 * dependency: this module imports adapters → adapters import the key
 * helper → key helper imports nothing.
 */
function attachDetectors(
  base: ControlCatalogEntry[],
): ControlCatalogEntry[] {
  const byKey = new Map<string, ControlCatalogEntry>(
    base.map((e) => [
      stableKeyFor({
        findingType: e.findingType,
        frameworkId: e.frameworkId,
        controlId: e.controlId,
      }),
      e,
    ]),
  );

  const allRows = [...ROUTER_DETECTOR_ADAPTERS, ...DISCOVERY_DETECTOR_ADAPTERS];

  for (const row of allRows) {
    const key = stableKeyFor({
      findingType: row.findingType,
      frameworkId: row.frameworkId,
      controlId: row.controlId,
    });
    const existing = byKey.get(key);
    if (existing) {
      existing.deterministicDetector = row.detector as unknown as DetectorFn;
    } else {
      // Adapter covers a (findingType, frameworkId, controlId) triple
      // that the prose mapper does not. Append it so the unified
      // catalog covers everything both engines knew about. Category
      // mirrors the parent finding's category (best-effort — the
      // prose mapper's controlMapping is the authority on category
      // assignment; orphan entries get the most common category for
      // that finding type).
      const fallback = base.find((e) => e.findingType === row.findingType);
      byKey.set(key, {
        findingType: row.findingType,
        frameworkId: row.frameworkId,
        controlId: row.controlId,
        category: fallback?.category ?? 'consumer-protection',
        deterministicDetector: row.detector as unknown as DetectorFn,
        prosePathEnabled: false,
        // Provisional — overwritten (and completeness-checked) by
        // `assignBuckets` after the catalog is fully assembled.
        bucket: PROVISIONAL_BUCKET,
      });
    }
  }

  return [...byKey.values()];
}

/**
 * AAP-118 (S3 of AAP-117) — stamp the honest 4-bucket classification onto
 * every catalog entry from `BUCKET_BY_CONTROL` (the spec-derived source of
 * truth, keyed by frameworkId + controlId).
 *
 * Run as a single pass AFTER `attachDetectors`, so both prose-derived and
 * adapter-only entries are bucketed by the same lookup — neither construction
 * site needs to know about buckets. The bucket is a property of the control,
 * so all entries that share a (frameworkId, controlId) get the same bucket
 * regardless of which finding type they hang under.
 *
 * Hard fail on a wired control with no bucket: a control reaching a report
 * with an unknown honest-classification is exactly the silent gap this
 * subtask exists to close. The error names the offender so adding a new
 * wired control forces a deliberate bucket decision in `control-buckets.ts`.
 */
function assignBuckets(
  entries: ControlCatalogEntry[],
): ControlCatalogEntry[] {
  const missing: string[] = [];
  for (const entry of entries) {
    const bucket = BUCKET_BY_CONTROL[entry.frameworkId]?.[entry.controlId];
    if (bucket === undefined) {
      missing.push(`${entry.frameworkId} :: ${entry.controlId}`);
      continue;
    }
    entry.bucket = bucket;
  }
  if (missing.length > 0) {
    const unique = [...new Set(missing)].sort();
    throw new Error(
      `control-catalog: ${unique.length} wired control(s) have no bucket in ` +
        `BUCKET_BY_CONTROL (src/compliance/control-buckets.ts). Add a bucket ` +
        `per framework-buckets-honest-2026-06-02.md: ${unique.join(', ')}`,
    );
  }
  return entries;
}

/**
 * The unified control catalog. Built once at module load.
 *
 * Phase 1 read exclusively from `CONTROL_MAPPINGS`. Phase 2 (here) splices
 * in the router's 12 detector entries. Future phases may swap the
 * underlying detector implementations without touching this builder.
 */
export const CONTROL_CATALOG: readonly ControlCatalogEntry[] = Object.freeze(
  assignBuckets(attachDetectors(buildCatalogFromMappings())),
);

// ─── Lookup helpers ────────────────────────────────────────────────────────

export function listCatalogEntries(): readonly ControlCatalogEntry[] {
  return CONTROL_CATALOG;
}

export function findCatalogEntry(args: {
  findingType: FindingType;
  frameworkId: FrameworkId;
  controlId: string;
}): ControlCatalogEntry | undefined {
  return CONTROL_CATALOG.find(
    (e) =>
      e.findingType === args.findingType &&
      e.frameworkId === args.frameworkId &&
      e.controlId === args.controlId,
  );
}

export function catalogEntriesForFinding(
  findingType: FindingType,
): ControlCatalogEntry[] {
  return CONTROL_CATALOG.filter((e) => e.findingType === findingType);
}

// ─── Adapter to the legacy FrameworkControl shape ──────────────────────────

/**
 * Some legacy code paths (mapper.ts per-finding builder) still expect
 * the `FrameworkControl` shape from `./types.ts`. Provide a thin
 * adapter so a catalog entry can be projected back into the legacy
 * shape without losing fields.
 *
 * This is intentionally one-way — the catalog is the source of truth
 * post-AAP-83; the legacy shape lives on only to keep call sites stable
 * across the migration.
 */
export function entryToFrameworkControl(
  entry: ControlCatalogEntry,
): FrameworkControl {
  const out: FrameworkControl = {
    frameworkId: entry.frameworkId as FrameworkId,
    controlId: entry.controlId,
  };
  if (entry.note !== undefined) out.note = entry.note;
  if (entry.annexIII !== undefined) out.annexIII = entry.annexIII;
  if (entry.gatedBy !== undefined) out.gatedBy = entry.gatedBy;
  return out;
}
