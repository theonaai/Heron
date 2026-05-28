/**
 * AAP-103 — Display primitives for the Vijil-style Failure Pattern card
 * and gradient indicator.
 *
 * Shared helpers consumed from three surfaces:
 *
 *   - `src/report/templates.ts`           — markdown body
 *   - `src/report/html-renderer.ts`       — production HTML report
 *   - `components/heron-v1/dashboard/...` — dashboard React (mirrors)
 *
 * The single source of truth for finding-code formatting, gradient
 * stops, severity-band labels, and hover-hint formula lives here so the
 * three render paths cannot drift again (pattern learned from AAP-93 /
 * AAP-96 / AAP-97 / AAP-98: content fixes must land in BOTH markdown
 * and dashboard — same applies to the new finding-card primitives).
 *
 * Numeric anchors:
 *   - 9 distinct severity values (1, 1.5, 2, 3, 4, 4.5, 6, 9, 13.5)
 *     come from `computeSeverity` (BR × DS × DM, AAP-101).
 *   - Bands (informational / low / medium / high / critical) come from
 *     `severityBand` in `src/verification/severity-scoring.ts`.
 *   - Color stops anchored on Vijil reference (Frame 09 of the visual
 *     reference index, 2026-05-17 recording).
 */

import type { EvidenceSource } from './types.js';
import type {
  SeverityBand,
} from '../verification/severity-scoring.js';
import type { VerdictFinding } from '../verification/verdict.js';

// ─── 9 distinct severity stops ──────────────────────────────────────────

/**
 * Every possible value `computeSeverity` returns (BR × DS × DM).
 *
 *   BR ∈ {1, 2, 3}, DS ∈ {1, 2, 3}, DM ∈ {1.0, 1.5}
 *   ⇒ 9 distinct products: 1, 1.5, 2, 3, 4, 4.5, 6, 9, 13.5
 *
 * Ordered ascending — index 0 = lowest risk, index 8 = highest.
 */
export const SEVERITY_STOPS = [1, 1.5, 2, 3, 4, 4.5, 6, 9, 13.5] as const;
export type SeverityStop = (typeof SEVERITY_STOPS)[number];

/**
 * Per-stop hex color. Anchored on the Vijil reference + heron-session-
 * context-2026-05-28 §"Решение 5: Report display":
 *
 *   1     → saturated green   (deep, calm)
 *   1.5   → green             (matches `--r-low` deep green)
 *   2-3   → light green → yellow-green transition
 *   4-4.5 → yellow → light orange (warm warning band)
 *   6     → orange            (escalation)
 *   9     → red-orange        (high)
 *   13.5  → saturated red     (critical, matches `--r-crit`)
 *
 * Stop colors form a smooth visual gradient when rendered as a CSS
 * `linear-gradient` (`renderGradientCSSValue` below).
 */
export const SEVERITY_STOP_COLORS: Readonly<Record<SeverityStop, string>> = {
  1: '#15803d',     // saturated green (Vijil-low text, also `--r-low`)
  1.5: '#22c55e',   // green
  2: '#65a30d',     // light green
  3: '#a3a200',     // yellow-green
  4: '#ca8a04',     // yellow
  4.5: '#d97706',   // light orange
  6: '#ea580c',     // orange
  9: '#dc2626',     // red-orange
  13.5: '#991b1b',  // saturated red (`--r-crit`)
};

/**
 * Map ANY severity number to its closest registered stop. The
 * `computeSeverity` output is always one of the 9 canonical values
 * already, but a hand-built test fake or persisted legacy row may
 * carry an intermediate number — pick the nearest stop and stay safe.
 */
export function nearestStop(severity: number): SeverityStop {
  if (!Number.isFinite(severity) || severity <= SEVERITY_STOPS[0]) {
    return SEVERITY_STOPS[0];
  }
  if (severity >= SEVERITY_STOPS[SEVERITY_STOPS.length - 1]) {
    return SEVERITY_STOPS[SEVERITY_STOPS.length - 1];
  }
  // Linear scan over 9 stops — micro-cheap.
  let best: SeverityStop = SEVERITY_STOPS[0];
  let bestDelta = Math.abs(severity - best);
  for (const s of SEVERITY_STOPS) {
    const delta = Math.abs(severity - s);
    if (delta < bestDelta) {
      best = s;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * Hex color for a severity number. Snaps to the nearest registered
 * stop and returns its color.
 */
export function colorForSeverity(severity: number): string {
  return SEVERITY_STOP_COLORS[nearestStop(severity)];
}

/**
 * CSS `linear-gradient` value with all 9 stops, evenly spaced from
 * 0% (lowest) to 100% (highest). Caller wraps with `background:
 * <value>` (markdown / HTML / React all accept this).
 */
export function renderGradientCSSValue(): string {
  const parts: string[] = ['to right'];
  const n = SEVERITY_STOPS.length;
  for (let i = 0; i < n; i++) {
    const pct = Math.round((i / (n - 1)) * 100);
    parts.push(`${SEVERITY_STOP_COLORS[SEVERITY_STOPS[i]]} ${pct}%`);
  }
  return `linear-gradient(${parts.join(', ')})`;
}

/**
 * Map a severity value to a percentage along the gradient bar.
 * Used to position the "you are here" marker. Returns a number in
 * [0, 100] (inclusive).
 */
export function gradientPercentForSeverity(severity: number): number {
  const stop = nearestStop(severity);
  const idx = SEVERITY_STOPS.indexOf(stop);
  return Math.round((idx / (SEVERITY_STOPS.length - 1)) * 100);
}

// ─── Severity band labels (display copy) ───────────────────────────────

/**
 * Display label per severity band. The dashboard / markdown both
 * surface this as the lead label on the gradient and on every finding
 * row.
 */
export const SEVERITY_BAND_LABEL: Readonly<Record<SeverityBand, string>> = {
  informational: 'Informational',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

/**
 * 4-tier breakdown for the gradient counts line. Maps verdict bands
 * onto the 4 customer-facing buckets the spec calls out.
 *
 *   - critical band       → 'critical'
 *   - high band           → 'high'
 *   - medium band         → 'medium'
 *   - low band            → 'low'
 *   - informational band  → 'low'  (collapsed; the OSS report does not
 *                                    surface a separate informational
 *                                    chip — it folds into low for the
 *                                    counts line)
 */
export type GradientBucket = 'critical' | 'high' | 'medium' | 'low';

export function bucketForBand(band: SeverityBand): GradientBucket {
  if (band === 'critical') return 'critical';
  if (band === 'high') return 'high';
  if (band === 'medium') return 'medium';
  return 'low';
}

// ─── Finding code formatting (MCP-001 / OAU-001 / ENV-001 / PLG-001 / SLF-001) ─

/**
 * Format a Vijil-style finding code: `<EVIDENCE_SOURCE>-<NNN>`.
 *
 * Serial numbers are 1-indexed, zero-padded to 3 digits initially.
 * The caller maintains a per-prefix counter inside the audit so
 * serials reset to 001 within each prefix for each audit (not
 * monotonic across audits — that would require a persistent
 * counter, out of scope for MVP).
 */
export function formatFindingCode(
  evidenceSource: EvidenceSource,
  serial: number,
): string {
  const n = Math.max(1, Math.floor(serial));
  return `${evidenceSource}-${String(n).padStart(3, '0')}`;
}

/**
 * Walk a `VerdictFinding[]` and assign each finding a stable code
 * based on `evidenceSource`. Serial numbers restart at 001 within
 * each prefix; iteration order is preserved (so the order findings
 * appear in the report drives the serial assignment).
 *
 * Returns a NEW array — the input is not mutated. Each element is
 * the original finding plus a `code` field.
 */
export interface CodedVerdictFinding extends VerdictFinding {
  /** Vijil-style code, e.g. `MCP-001`. */
  code: string;
}

export function assignFindingCodes(
  findings: ReadonlyArray<VerdictFinding>,
): CodedVerdictFinding[] {
  const counters: Record<EvidenceSource, number> = {
    MCP: 0,
    OAU: 0,
    ENV: 0,
    PLG: 0,
    SLF: 0,
  };
  return findings.map((f) => {
    counters[f.evidenceSource] += 1;
    return {
      ...f,
      code: formatFindingCode(f.evidenceSource, counters[f.evidenceSource]),
    };
  });
}

// ─── Hover-hint formula breakdown ───────────────────────────────────────

/**
 * Per-axis text snippets for the BR × DS × DM hover-hint.
 *
 *   BR ∈ {1, 2, 3}  — short label per band (write/read/autonomy)
 *   DS ∈ {1, 2, 3}  — short label per tier (standard / sensitive / critical)
 *   DM ∈ {1.0, 1.5} — default / elevated
 *
 * The snippets are intentionally short — they reproduce in a tooltip
 * (HTML `title` attribute, markdown footnote, or React tooltip) and
 * should read at-a-glance.
 */
const BR_LABEL: Readonly<Record<1 | 2 | 3, string>> = {
  1: 'narrow blast radius',
  2: 'multi-system blast radius',
  3: 'broad blast radius',
};
const DS_LABEL: Readonly<Record<1 | 2 | 3, string>> = {
  1: 'T1 standard data',
  2: 'T2 sensitive PII',
  3: 'T3 critical data (Art. 9 / PHI / financial / gov ID)',
};
const DM_LABEL: Readonly<Record<string, string>> = {
  '1': 'default domain',
  '1.5': 'Annex III / DPIA-trigger domain',
};

export interface SeverityFormulaArgs {
  /** BR × DS × DM result (one of 9 stops). */
  severity: number;
  /** BR composite band (1-3) — max(BR-W, BR-R, BR-A). */
  br: number;
  /** DS band (1-3). */
  ds: number;
  /** DM multiplier (1.0 or 1.5). */
  dm: number;
  /** Optional per-axis BR sub-bands for richer hint copy. */
  brW?: number;
  brR?: number;
  brA?: number;
}

/**
 * Render a 1-line formula breakdown for the severity hover hint.
 *
 *   "BR 2 (multi-system blast radius) × DS 3 (T3 critical data) × DM 1.5 (Annex III) = 9.0"
 *
 * Suitable for an HTML `title` attribute, a markdown footnote, and a
 * React `title` / tooltip. The function never returns NaN — every
 * branch produces a complete sentence.
 */
export function renderSeverityFormula(args: SeverityFormulaArgs): string {
  const brLabel = BR_LABEL[(clamp123(args.br) as 1 | 2 | 3)];
  const dsLabel = DS_LABEL[(clamp123(args.ds) as 1 | 2 | 3)];
  const dmKey = args.dm >= 1.5 ? '1.5' : '1';
  const dmLabel = DM_LABEL[dmKey];
  const sevDisplay = formatSeverityNumber(args.severity);
  return `BR ${args.br} (${brLabel}) × DS ${args.ds} (${dsLabel}) × DM ${args.dm} (${dmLabel}) = ${sevDisplay}`;
}

function clamp123(n: number): number {
  if (n <= 1) return 1;
  if (n >= 3) return 3;
  return 2;
}

/**
 * Format a severity number with one decimal place when needed
 * (matches the canonical printable form: 1, 1.5, 2, 3, 4, 4.5, 6, 9,
 * 13.5).
 */
export function formatSeverityNumber(severity: number): string {
  if (!Number.isFinite(severity)) return '0';
  const rounded = Math.round(severity * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// ─── Verified-only counts for the gradient breakdown line ─────────────

/**
 * Count Verified findings (evidenceSource !== 'SLF') by band, mapped
 * onto the 4 customer-facing buckets. Used by the gradient indicator's
 * "1 critical, 3 high, …" line.
 *
 * SLF findings are excluded by design — posture is Verified-only
 * (heron-session-context-2026-05-28 §"Уточнение по весам"). The
 * separate SLF block in the report has its own counts.
 */
export interface BucketCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export function countVerifiedByBucket(
  findings: ReadonlyArray<VerdictFinding>,
): BucketCounts {
  const out: BucketCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    if (f.evidenceSource === 'SLF') continue;
    out[bucketForBand(f.band)] += 1;
  }
  return out;
}

/**
 * Render the "1 critical, 3 high, 5 medium, 2 low" line — the
 * count breakdown shown below the gradient marker. Empty buckets are
 * omitted to keep the line readable. Returns `'No verified findings'`
 * when every bucket is zero (suitable for both markdown and HTML).
 */
export function renderBucketCountsLine(counts: BucketCounts): string {
  const parts: string[] = [];
  if (counts.critical > 0) parts.push(`${counts.critical} critical`);
  if (counts.high > 0) parts.push(`${counts.high} high`);
  if (counts.medium > 0) parts.push(`${counts.medium} medium`);
  if (counts.low > 0) parts.push(`${counts.low} low`);
  if (parts.length === 0) return 'No verified findings';
  return parts.join(', ');
}
