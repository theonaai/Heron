/**
 * G9 (DS-tier rework) — per-system DEPLOYMENT RISK scoring.
 *
 * The core insight (Ilya, 2026-05-29): Heron's job is not just catching
 * declared-vs-actual DISCREPANCIES, it is surfacing RISK. Before G9,
 * `computePosture` (verdict.ts) was max severity over verified discrepancy
 * findings ONLY. So an HONEST agent — declared == actual, zero discrepancies
 * — got posture 0 and the dashboard read "No Verified findings", which is
 * empty/confusing and, worse, ignored the real risk surface: the agent had
 * Google Drive with full write scope on T2 PII and Wellkid / Gamma / Telegram
 * with irreversible writes. Those are real risks (blast radius, irreversible
 * ops on sensitive data) regardless of honesty.
 *
 * This module scores each declared SYSTEM (the `systems[]` rows the analyzer
 * emits onto report.json) on the SAME BR × DS × DM scale as findings
 * (`severity-scoring.ts`, `severityFromInputs`). The verdict then takes the
 * FIPS-199 high-water-mark of (system risk, verified discrepancy risk) so a
 * clean-but-risky agent reads as e.g. "Medium risk", not "No findings".
 *
 * MAPPING (Systems data → BR × DS × DM):
 *
 *   BR (Blast Radius) = max( blastAxis , writeAxis ) — FIPS HWM, not sum.
 *     - blastAxis from the system's `blastRadius` enum:
 *         single-record / single-user → 1
 *         team-scope                  → 2
 *         org-wide / cross-tenant     → 3
 *       + lifted one band (capped at 3) when the system has IRREVERSIBLE
 *         writes: an irreversible op cannot be rolled back, so its blast
 *         radius is structurally larger than a reversible one at the same
 *         org reach (a single irreversible write to a shared surface is
 *         worse than a reversible one). team-scope + irreversible → 3.
 *     - writeAxis from the write-operation count via `bandForWriteCount`
 *       (0-1 → 1, 2-4 → 2, 5+ → 3) — same cut points as BR-W for findings.
 *     BR-A (autonomy) is intentionally NOT folded in here: the systems rows
 *     carry no per-system autonomy signal, and the agent-level autonomy
 *     already flows through the SLF / discovery findings. Folding a blanket
 *     "autonomous" default into every system would flatten every row to BR=3
 *     and destroy the per-system spread the demo needs (Gemini read-only vs
 *     Wellkid irreversible-write must diverge).
 *
 *   DS (Data Sensitivity) = T1/T2/T3 supplied DIRECTLY by the analyzer (LLM)
 *     as `system.dataSensitivityTier`, grounded in the W3C DPV (Data Privacy
 *     Vocabulary) taxonomy (see the per-system spec in src/llm/prompts.ts).
 *     This module CONSUMES that tier — it no longer derives it. The old regex
 *     classifier (`classifySystemDS`) was deleted: it was negation-blind
 *     ("agent stated NO student names were found" matched `names` → T2) and
 *     over-matched ("folder names" → T2). The LLM understands negation and
 *     context, so the tier is sourced where that judgement lives. T1→1 / T2→2 /
 *     T3→3. If the analyzer omits the tier, we default CONSERVATIVELY to T2 (a
 *     security tool must not under-rate on uncertainty). The free-text
 *     `dataSensitivity` prose is kept as the human-readable basis.
 *
 *   DM (Domain Multiplier) = 1.0 default. We deliberately do NOT infer 1.5
 *     from the prose here. DM=1.5 is an Annex III / Art. 35(3) regulatory
 *     amplifier; the typed Annex III detection runs against discovery
 *     capabilities (`computeDM` in severity-scoring.ts), not system prose.
 *     Inferring it from free text would be a guess that inflates posture —
 *     out of scope for G9 (which is "what posture MEASURES", not re-tuning
 *     domain detection). The domain amplifier still reaches posture via the
 *     discovery/SLF findings that DO carry typed capabilities.
 *
 * severity per system = BR × DS × DM, rounded to the same 9-value 1..13.5
 * scale as every other finding (via `severityFromInputs`).
 *
 * This module is PURE — no I/O, no verdict assembly. `verdict.ts` consumes it.
 */

import {
  bandForWriteCount,
  severityBand,
  severityFromInputs,
  type AxisBand,
  type DomainMultiplier,
  type SeverityBand,
} from './severity-scoring.js';

/** Minimal write-operation shape (mirror of `WriteOperation` / `ReportJsonWriteOperation`). */
export interface SystemWriteOp {
  reversible?: boolean;
  approvalRequired?: boolean;
}

/**
 * Minimal system shape the risk scorer needs. Structurally compatible with
 * both `SystemAssessment` (src/report/types.ts) and `ReportJsonSystem`
 * (lib/report-json.ts) — we only read the four risk-bearing fields so a
 * partial / legacy blob degrades gracefully.
 */
export interface RiskScorableSystem {
  systemId: string;
  /** Human-readable sensitivity prose (basis sentence for the tier). */
  dataSensitivity?: string;
  /**
   * DS-tier rework — analyzer-supplied DATA SENSITIVITY TIER (DPV-grounded). The DS
   * axis keys off this. Optional: when absent, {@link scoreSystemRisk} defaults
   * conservatively to T2.
   */
  dataSensitivityTier?: 'T1' | 'T2' | 'T3';
  blastRadius?: string;
  writeOperations?: SystemWriteOp[];
}

export interface SystemRiskResult {
  systemId: string;
  /** BR × DS × DM, one of {1, 1.5, 2, 3, 4, 4.5, 6, 9, 13.5}. */
  severity: number;
  band: SeverityBand;
  br: AxisBand;
  ds: AxisBand;
  dm: DomainMultiplier;
  /** T1 / T2 / T3 — the analyzer-supplied tier this row scored on (or the
   *  conservative T2 default when the analyzer omitted it). */
  dsTier: 'T1' | 'T2' | 'T3';
  /** Short "why this tier" basis (≤120 chars): the first clause of the
   *  sensitivity prose when a tier was provided, else the default-T2 note. */
  dsBasis: string;
  /** True when this system declares at least one irreversible write op. */
  hasIrreversibleWrite: boolean;
}

// ─── Data-sensitivity tier (T1 / T2 / T3) ─────────────────────────────────
//
// The tier is supplied by the analyzer (LLM) as `system.dataSensitivityTier`,
// DPV-grounded — see the module JSDoc and src/llm/prompts.ts. This module no
// longer derives it from prose (the old regex `classifySystemDS` was deleted:
// negation-blind + over-matching). The only helper retained here is the basis
// extractor: a short human-readable "why" sentence lifted from the prose for
// the PII-basis-inline transparency surface.

/** Map a tier label to its DS axis band. T1→1 / T2→2 / T3→3. */
function dsBandForTier(tier: 'T1' | 'T2' | 'T3'): AxisBand {
  return tier === 'T3' ? 3 : tier === 'T2' ? 2 : 1;
}

/**
 * Pull a short human-readable basis from the sensitivity prose: the first
 * clause, truncated. Lets a reviewer see the phrase the analyzer wrote (e.g.
 * "responsible fields may contain names") next to the tier it assigned.
 */
function firstClause(prose: string): string {
  const clauses = prose
    .split(/[;.]|,(?=\s)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return truncate((clauses[0] ?? prose).trim(), 120);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const window = s.slice(0, max);
  const ws = window.lastIndexOf(' ');
  return s.slice(0, ws > 0 ? ws : max).trimEnd() + '…';
}

// ─── Blast radius axis ────────────────────────────────────────────────────

/**
 * Map the system's `blastRadius` enum to a 1-3 band.
 *   single-record / single-user → 1
 *   team-scope                  → 2
 *   org-wide / cross-tenant     → 3
 * Anything else (unset / unknown prose) → 1 (conservative-low; we do not
 * inflate when the analyzer gave us nothing).
 */
export function blastRadiusAxis(blastRadius: string | undefined): AxisBand {
  const p = (blastRadius || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (p.includes('cross') && p.includes('tenant')) return 3;
  if (p.includes('org')) return 3;
  if (p.includes('team')) return 2;
  // single-record / single-user / single / self / record → 1
  return 1;
}

// ─── Per-system severity ────────────────────────────────────────────────

/**
 * Score ONE system on the BR × DS × DM scale. See module JSDoc for the full
 * mapping rationale.
 */
export function scoreSystemRisk(system: RiskScorableSystem): SystemRiskResult {
  const writeOps = system.writeOperations ?? [];
  const hasIrreversibleWrite = writeOps.some((w) => w.reversible === false);

  // BR — max(blastAxis lifted for irreversibility, writeCountAxis).
  let blastAxis = blastRadiusAxis(system.blastRadius);
  if (hasIrreversibleWrite && blastAxis < 3) {
    blastAxis = (blastAxis + 1) as AxisBand;
  }
  const writeAxis = bandForWriteCount(writeOps.length);
  const br = Math.max(blastAxis, writeAxis) as AxisBand;

  // DS from the analyzer-supplied tier. When the analyzer provided a tier, the
  // basis is the first clause of its prose (the human-readable "why"). When it
  // omitted the tier, default CONSERVATIVELY to T2 — a security tool must not
  // under-rate on uncertainty — and record that in the basis.
  const prose = (system.dataSensitivity ?? '').trim();
  let dsTier: 'T1' | 'T2' | 'T3';
  let dsBasis: string;
  if (system.dataSensitivityTier) {
    dsTier = system.dataSensitivityTier;
    dsBasis = prose ? firstClause(prose) : `analyzer-supplied tier ${dsTier}`;
  } else {
    dsTier = 'T2';
    dsBasis = 'tier not provided by analyzer; defaulted conservatively to T2';
  }
  const ds = dsBandForTier(dsTier);

  // DM — 1.0 fixed for systems (see module JSDoc; domain amplifier reaches
  // posture via typed discovery/SLF findings, not prose inference here).
  const dm: DomainMultiplier = 1.0;

  // Feed through the shared math helper so rounding + the 9-value scale match
  // every other finding exactly. brR/brA are set to 1 so BR = max collapses to
  // our computed `br` (blast/write), the only axes the systems rows inform.
  const result = severityFromInputs({
    brW: br,
    brR: 1,
    brA: 1,
    ds,
    dm,
  });

  return {
    systemId: system.systemId,
    severity: result.severity,
    band: severityBand(result.severity),
    br,
    ds,
    dm,
    dsTier,
    dsBasis,
    hasIrreversibleWrite,
  };
}

export interface SystemsRiskSummary {
  /** FIPS-199 HWM (max severity) across all scored systems. 0 when none. */
  posture: number;
  postureBand: SeverityBand;
  /** True when at least one system was available to score (a scan happened). */
  scanned: boolean;
  /** Per-system risk rows, for the renderer (basis inline + table). */
  systems: SystemRiskResult[];
}

/**
 * Score every system and return the high-water-mark posture + the per-system
 * breakdown. `posture` is 0 when there are no systems (the caller treats that
 * as "no scan" and renders the gray Not-yet-verified state).
 */
export function computeSystemsRisk(
  systems: ReadonlyArray<RiskScorableSystem> | undefined,
): SystemsRiskSummary {
  const rows = (systems ?? []).map(scoreSystemRisk);
  let max = 0;
  for (const r of rows) {
    if (r.severity > max) max = r.severity;
  }
  return {
    posture: max,
    postureBand: severityBand(max),
    scanned: rows.length > 0,
    systems: rows,
  };
}
