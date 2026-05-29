/**
 * G9 (AAP-106) — per-system DEPLOYMENT RISK scoring.
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
 *   DS (Data Sensitivity) = T1/T2/T3 derived from the free-text
 *     `dataSensitivity` prose via {@link classifySystemDS}. The analyzer does
 *     NOT emit a structured tier per system (only prose), so we classify the
 *     prose with the same GDPR-Art.9 / PHI / financial / PII vocabulary the
 *     `severity-scoring.ts` DS axis uses. T1=1 / T2=2 / T3=3.
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
  dataSensitivity?: string;
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
  /** T1 / T2 / T3 label + the short basis sentence lifted from the prose. */
  dsTier: 'T1' | 'T2' | 'T3';
  /** Short "why this tier" basis (≤120 chars) derived from the sensitivity prose. */
  dsBasis: string;
  /** True when this system declares at least one irreversible write op. */
  hasIrreversibleWrite: boolean;
}

// ─── DS classification (T1 / T2 / T3) from free-text sensitivity prose ────

/**
 * T3 — GDPR Art. 9 special categories, PHI, financial credentials, gov IDs.
 * Anchored on the same vocabulary as `severity-scoring.ts` T3_PATTERNS.
 */
const SYS_T3_RE =
  /\b(health|medical|phi\b|patient|biometric|race|religion|sexual|political opinion|trade union|article\s*9|art\.?\s*9|hipaa|ssn|social security|passport|national id|tax id|credit card|cardholder|pci|cvv|bank account|iban|swift|payment card|financial credential)\b/i;

/**
 * T2 — sensitive PII (names, contact, employment, education, communication
 * content, location, customer data). Anchored on the same categories as
 * `severity-scoring.ts` T2_PATTERNS but matched against prose.
 */
const SYS_T2_RE =
  /\b(pii|personal data|personal information|personal name|names?\b|e-?mail|phone|date of birth|\bdob\b|location|address|contact|employee|employment|education|student|lesson|course|message|messaging|credential|token|login|password)\b/i;

/**
 * Classify the free-text `dataSensitivity` prose into a tier + a short basis.
 * Mirrors the renderer's `classifyDS` vocabulary (kept aligned on purpose so
 * the badge tier and the risk DS axis never disagree) but also returns a
 * compact "why" sentence for the G9 PII-basis-inline transparency fix.
 */
export function classifySystemDS(prose: string): {
  tier: 'T1' | 'T2' | 'T3';
  ds: AxisBand;
  basis: string;
} {
  const p = (prose || '').trim();
  if (SYS_T3_RE.test(p)) {
    return { tier: 'T3', ds: 3, basis: deriveBasis(p, SYS_T3_RE) };
  }
  if (SYS_T2_RE.test(p)) {
    return { tier: 'T2', ds: 2, basis: deriveBasis(p, SYS_T2_RE) };
  }
  return { tier: 'T1', ds: 1, basis: p ? firstClause(p) : 'standard operational data' };
}

/**
 * Pull a short human-readable basis from the sensitivity prose: the clause
 * that contains the tier-deciding keyword. So "T2 because ..." reads as the
 * actual phrase the analyzer wrote (e.g. "responsible fields may contain
 * names"), letting a reviewer judge whether the classification is sound
 * rather than over-conservative. Falls back to the first clause.
 */
function deriveBasis(prose: string, re: RegExp): string {
  const m = re.exec(prose);
  if (!m) return firstClause(prose);
  // Find the clause (split on ; or . or ,) that contains the match index.
  const idx = m.index;
  const clauses = splitClauses(prose);
  let cursor = 0;
  for (const c of clauses) {
    const start = prose.indexOf(c, cursor);
    const end = start + c.length;
    cursor = end;
    if (idx >= start && idx < end) {
      return truncate(c.trim(), 120);
    }
  }
  return firstClause(prose);
}

function splitClauses(prose: string): string[] {
  return prose
    .split(/[;.]|,(?=\s)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function firstClause(prose: string): string {
  const clauses = splitClauses(prose);
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

  // DS from prose.
  const dsClass = classifySystemDS(system.dataSensitivity ?? '');

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
    ds: dsClass.ds,
    dm,
  });

  return {
    systemId: system.systemId,
    severity: result.severity,
    band: severityBand(result.severity),
    br,
    ds: dsClass.ds,
    dm,
    dsTier: dsClass.tier,
    dsBasis: dsClass.basis,
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
