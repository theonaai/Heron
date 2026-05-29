/**
 * Verdict computation — AAP-63 / AAP-102.
 *
 * Heron strategy v3.0 §3: "Every claim about an AI agent should be
 * verifiable from a deterministic source of truth, not from the agent's
 * own self-report." This module reconciles Surface 1 (LLM-derived
 * interview findings, stamped `evidenceSource: 'SLF'`) with Surface 2
 * (deterministic filesystem discovery + OAuth scope introspection,
 * stamped MCP / OAU / ENV / PLG by detector) into a single `Verdict`.
 *
 * AAP-102 — Posture replaces the prior 7-label / 3-risk-level verdict:
 *
 *   - Every finding carries `severityScore` (BR × DS × DM, see
 *     `severity-scoring.ts`) and `evidenceSource`.
 *   - Posture = FIPS 199 high-water-mark (max severityScore) across
 *     ONLY Verified findings — findings whose `evidenceSource ≠ 'SLF'`.
 *   - SLF findings ARE scored via `computeSeverity` (using self-reported
 *     inputs) so the renderer can show them in a separate column, but
 *     they do NOT drive posture aggregation. The agent's word does not
 *     move the gradient (heron-session-context-2026-05-28.md
 *     § "Уточнение по весам").
 *
 * Removed in AAP-102:
 *   - `discoveryRiskLevel` / `oauthRiskLevel` / `liftForWriteTools` /
 *     `maxRisk` threshold tables — replaced by `computeSeverity` per
 *     finding plus posture aggregation.
 *   - `detectDiscrepancies` ±80-char window heuristic — brittle, opaque
 *     to reviewers, false positives like "never had issues with GitHub".
 *     The new SLF column makes the agent's claims visible directly so
 *     a reviewer can spot mismatches by eye.
 *   - `interviewRiskLevel` / `deterministicRiskLevel` / `primaryRiskLevel`
 *     triple — replaced by single `posture` field.
 *   - `calibrateVerdictLabel` / `calibrateOverallRiskLevel` 7-label
 *     auto-decision — reviewer decides; Heron computes posture only.
 *   - `INTERNAL_HEURISTIC` threshold-manifest references — every number
 *     in the new model is anchored (FIPS 199, GDPR Art. 9, EU AI Act
 *     Annex III, AWS Security Pillar).
 */

import type { DiscoveredAgent, DiscoveryFinding } from '../discovery/types.js';
import type { EvidenceSource, Risk } from '../report/types.js';
import {
  computeSeverity,
  severityBand,
  severityFromInputs,
  type AxisBand,
  type DomainMultiplier,
  type SeverityBand,
  type SeverityEvidence,
  type SeverityResult,
} from './severity-scoring.js';
import type {
  SourceVerification,
  DiffEntry,
  DiffSeverity,
  ActualTool,
  ActualScope,
  DeclaredTool,
  DeclaredScope,
} from './types.js';

/** Per-session verification status. Mirrors the field on `AuditSession`. */
export type VerificationStatus = 'unverified' | 'partial' | 'verified';

/**
 * AAP-102 — deprecated legacy risk-level type, kept for compile-time
 * compatibility with the display layer (`src/report/templates.ts`,
 * dashboard React components). G4 (AAP-103) will remove every consumer
 * and this alias goes with it. Do NOT branch new logic on this — branch
 * on `posture` / `postureBand` instead.
 *
 * @deprecated Use `Verdict.postureBand` (a `SeverityBand`) for new code.
 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** @deprecated Use `Verdict.postureBand`. */
export type PrimaryRiskLevel = 'unverified' | RiskLevel;

/**
 * AAP-102 — deprecated. The discrepancy detector (±80-char window) was
 * removed; SLF findings render in their own column and the reviewer
 * spots mismatches by eye. The type alias remains so the display layer
 * still compiles; the array is always empty.
 *
 * @deprecated Removed in AAP-102. Always empty.
 */
export interface Discrepancy {
  claim: string;
  evidence: string;
  severity: RiskLevel;
}

/**
 * One row in the unified findings list the verdict assembles. The same
 * shape feeds the report renderer (G4) — every card it draws traces
 * back to one of these.
 *
 * `severityScore` is the BR × DS × DM number (one of 9 distinct values).
 * `evidenceSource` is the wedge: MCP/OAU/ENV/PLG findings drive posture,
 * SLF findings are shown but don't.
 */
export interface VerdictFinding {
  /** Stable identifier for de-dup and per-finding lookup. */
  id: string;
  /** Coarse severity band (informational / low / medium / high / critical). */
  band: SeverityBand;
  /** BR × DS × DM numeric severity. */
  severityScore: number;
  /** Per-axis bands for the renderer. */
  severityComponents: {
    br: number;
    ds: number;
    dm: number;
    brW?: number;
    brR?: number;
    brA?: number;
  };
  /** MCP / OAU / ENV / PLG (Verified) or SLF (Self-attested). */
  evidenceSource: EvidenceSource;
  /** Short, human-readable title. */
  title: string;
  /** Free-form description. */
  description: string;
  /**
   * AAP-104 B9 — analyzer-provided actionable notes. The LLM analyzer
   * generates a `mitigation` field on each Surface 1 risk (semicolon-
   * separated suggestion list). Pre-fix the verdict pipeline dropped
   * this on the SLF conversion, so the dashboard fell through to the
   * generic SLF mitigation hint ("self-reported, not verified"). Now
   * the field is preserved end-to-end and the renderer prefers it for
   * SLF findings when present.
   */
  analyzerNotes?: string;
  /** Optional kind tag for legacy renderers (discovery / oauth / risk). */
  kind?: string;
}

export interface VerdictInputs {
  /** Surface 2 — filesystem discovery findings from src/discovery/diff.ts. */
  discoveryFindings?: DiscoveryFinding[];
  /** Surface 2 — OAuth introspection per-source results. */
  oauthVerifications?: SourceVerification[];
  /** Surface 1 — analyzer LLM findings (stamped SLF by analyzer). */
  interviewFindings?: Risk[];
  /**
   * AAP-75 — discovered agents (post-enumeration). Surfaces MCP write-tool
   * inventory which `computeSeverity` reads as BR-W input.
   */
  discoveredAgents?: DiscoveredAgent[];
}

export interface Verdict {
  /**
   * Technical execution status — did Surface 2 actually run? NOT a verdict.
   *   - `verified`  — both discovery AND oauth ran, both clean.
   *   - `partial`   — at least one Surface 2 source ran.
   *   - `unverified`— no Surface 2 evidence at all.
   */
  status: VerificationStatus;
  /**
   * FIPS 199 high-water-mark across Verified findings only.
   * 0 when no Verified findings exist.
   */
  posture: number;
  /** Coarse band for `posture` — informational / low / medium / high / critical. */
  postureBand: SeverityBand;
  /** Every finding (Verified + SLF), with severity and provenance attached. */
  findings: VerdictFinding[];

  // ── Legacy / deprecated fields (compile-time back-compat for G4) ──────
  // These exist purely so the unmodified display layer
  // (`src/report/templates.ts`, dashboard React) still compiles. They are
  // derived trivially from `posture` and will render empty / stale
  // pills until G4 removes every reference.

  /** @deprecated Always `[]`. Removed in AAP-102; see module JSDoc. */
  discrepancies: Discrepancy[];
  /** @deprecated Derived from `postureBand`; equal to `'unverified'` when status === 'unverified'. */
  primaryRiskLevel: PrimaryRiskLevel;
  /** @deprecated Constant `'deterministic'` (or `'no-evidence'` when unverified). */
  primaryRiskSource: 'deterministic' | 'self-reported' | 'no-evidence';
  /** @deprecated Aliased to `primaryRiskLevel` band, or undefined when status === 'unverified'. */
  deterministicRiskLevel?: RiskLevel;
  /** @deprecated Always undefined post-AAP-102 (SLF findings no longer roll up to an interview level). */
  interviewRiskLevel?: RiskLevel;
}

// ── Discovery / OAuth finding → VerdictFinding (Verified) ──────────────

/**
 * Map a DiscoveryFinding into a VerdictFinding stamped with the
 * appropriate `evidenceSource`. Discovery surfaces:
 *   - MCP server detection → MCP
 *   - .env / credential / processor → ENV
 *   - plugin / auth credential → PLG
 *
 * We classify based on the finding's `kind` and `description` content
 * because the DiscoveryFinding shape doesn't carry an explicit surface
 * tag. The router/discovery detector adapter layer already encodes the
 * same split via `ROUTER_DETECTOR_ADAPTERS` / `DISCOVERY_DETECTOR_ADAPTERS`;
 * here we tag the raw finding rows for the renderer.
 */
function evidenceSourceForDiscoveryFinding(
  finding: DiscoveryFinding,
): Exclude<EvidenceSource, 'SLF'> {
  // Server-shaped findings (EXTRA / MISSING / HIDDEN-CREDENTIALS, etc.)
  // are MCP server discoveries by default — DiscoveryFinding always
  // carries a `serverName`.
  return 'MCP';
}

function discoveryFindingToVerdictFinding(
  finding: DiscoveryFinding,
  idx: number,
  discoveredAgents: DiscoveredAgent[],
  oauthVerifications: SourceVerification[],
): VerdictFinding {
  const evidence: SeverityEvidence = {
    discovery: {
      agents: discoveredAgents,
      // Conservative: no workspaceEnv unless the caller passes a full
      // DiscoveryResult. discoveryFindings alone is enough for BR-W via
      // the agents array.
    } as SeverityEvidence['discovery'],
    oauthVerifications,
  };
  const result = computeSeverity(evidence);
  return {
    id: `mcp-${idx}-${finding.kind.toLowerCase()}-${finding.serverName}`,
    band: severityBand(result.severity),
    severityScore: result.severity,
    severityComponents: {
      br: result.br,
      ds: result.ds,
      dm: result.dm,
      brW: result.components.brW,
      brR: result.components.brR,
      brA: result.components.brA,
    },
    evidenceSource: evidenceSourceForDiscoveryFinding(finding),
    title: `${finding.kind} ${finding.serverName}`,
    description: finding.description,
    kind: 'discovery',
  };
}

function diffSeverityFloor(_severity: DiffSeverity): void {
  // No-op stub kept for symmetry; severity now flows from computeSeverity,
  // not the raw DiffSeverity. Retained to document that OAuth diff
  // `severity` field is intentionally not consulted here — the BR × DS × DM
  // model derives severity from blast-radius axes, not heuristic labels.
  return;
}

function oauthDiffToVerdictFinding(
  diff: DiffEntry,
  sourceId: string,
  idx: number,
  discoveredAgents: DiscoveredAgent[],
  oauthVerifications: SourceVerification[],
): VerdictFinding {
  diffSeverityFloor(diff.severity);
  const evidence: SeverityEvidence = {
    discovery: { agents: discoveredAgents } as SeverityEvidence['discovery'],
    oauthVerifications,
  };
  const result = computeSeverity(evidence);
  // `actual` exists on 'extra' / 'mismatch'; `declared` exists on 'missing' / 'mismatch'.
  // Pick whichever side is present so we can produce a stable target label.
  const side: ActualTool | ActualScope | DeclaredTool | DeclaredScope =
    diff.kind === 'missing' ? diff.declared : diff.actual;
  const target =
    diff.dimension === 'tool'
      ? (side as { name?: string }).name ?? 'tool'
      : `${(side as { service?: string }).service ?? sourceId}:${
          (side as { scope?: string }).scope ?? 'scope'
        }`;
  return {
    id: `oau-${idx}-${diff.kind}-${target}`,
    band: severityBand(result.severity),
    severityScore: result.severity,
    severityComponents: {
      br: result.br,
      ds: result.ds,
      dm: result.dm,
      brW: result.components.brW,
      brR: result.components.brR,
      brA: result.components.brA,
    },
    evidenceSource: 'OAU',
    title: `OAuth ${diff.kind} — ${target}`,
    description: `OAuth scope ${diff.kind} from ${sourceId}`,
    kind: 'oauth',
  };
}

// ── Interview Risk → VerdictFinding (SLF) ──────────────────────────────

/**
 * Map an interview-derived Risk into a VerdictFinding.
 *
 * AAP-105 A6 — TWO scoring paths:
 *
 *   1. Per-finding (preferred). When the analyzer assessed THIS risk's own
 *      blast-radius / data-sensitivity / domain axes (`risk.severityInputs`),
 *      score from those via `severityFromInputs` — BR = max(brW, brR, brA),
 *      severity = BR × DS × DM, same math and same 9-value scale as
 *      deterministic findings. This is what stops every SLF card collapsing to
 *      the session-wide blast-radius number: "Telegram alerting fails open"
 *      (low BR) and "Broad Google OAuth permissions" (high reach) now diverge.
 *      Still self-attested — the inputs came from the agent's interview, not a
 *      verified scan — and the renderer labels it as such.
 *
 *   2. Session-wide fallback (legacy / no inputs). When `severityInputs` is
 *      absent (old report.json on disk, or an LLM extraction that omitted it),
 *      keep the prior behaviour: `computeSeverity` against the session-wide
 *      discovery + OAuth evidence, with the LLM's categorical `severity`
 *      honoured as a DS floor (high+ → DS=3, medium → DS=2). No regression for
 *      sessions produced before A6.
 *
 * Either way the finding is stamped SLF and NEVER moves the posture gradient —
 * `computePosture` skips SLF rows by `evidenceSource`, independent of the score
 * (Heron strategy v3.0 §3: the agent's self-report cannot move the gradient).
 */
function interviewRiskToVerdictFinding(
  risk: Risk,
  idx: number,
  discoveredAgents: DiscoveredAgent[],
  oauthVerifications: SourceVerification[],
): VerdictFinding {
  let result: SeverityResult;
  if (risk.severityInputs) {
    // Path 1 — per-finding. The schema already constrains each axis to a
    // valid band (1/2/3) and dm to 1.0/1.5; cast through the axis types so
    // the math helper sees the narrowed literals.
    const si = risk.severityInputs;
    result = severityFromInputs({
      brW: si.brW as AxisBand,
      brR: si.brR as AxisBand,
      brA: si.brA as AxisBand,
      ds: si.ds as AxisBand,
      dm: si.dm as DomainMultiplier,
    });
  } else {
    // Path 2 — session-wide fallback. Honour the LLM's categorical severity
    // as a DS floor: a HIGH/CRITICAL SLF risk carries DS ≥ 2 even when typed
    // evidence is silent.
    let dsFloor: 1 | 2 | 3 = 1;
    if (risk.severity === 'critical' || risk.severity === 'high') dsFloor = 3;
    else if (risk.severity === 'medium') dsFloor = 2;

    const evidence: SeverityEvidence = {
      discovery: { agents: discoveredAgents } as SeverityEvidence['discovery'],
      oauthVerifications,
      findingContext: { dataSensitivityFloor: dsFloor },
    };
    result = computeSeverity(evidence);
  }
  // Risks SHOULD carry a title (riskSchema requires it), but the verdict
  // pipeline can be called with hand-built JSON blobs from test fakes /
  // legacy report.json files that pre-date schema enforcement. Be defensive:
  // fall back to a synthetic id when title is missing.
  const titleStr = typeof risk.title === 'string' ? risk.title : `risk-${idx}`;
  const slug = titleStr.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  // AAP-104 B9 — preserve analyzer-supplied mitigation text. The shape
  // is intentionally permissive (the verdict pipeline accepts hand-
  // built JSON from old tests as well as analyzer.ts output) so we
  // string-check the field before lifting it.
  const analyzerNotes =
    typeof risk.mitigation === 'string' && risk.mitigation.trim().length > 0
      ? risk.mitigation.trim()
      : undefined;
  return {
    id: `slf-${idx}-${slug}`,
    band: severityBand(result.severity),
    severityScore: result.severity,
    severityComponents: {
      br: result.br,
      ds: result.ds,
      dm: result.dm,
      brW: result.components.brW,
      brR: result.components.brR,
      brA: result.components.brA,
    },
    evidenceSource: 'SLF',
    title: titleStr,
    description: typeof risk.description === 'string' ? risk.description : '',
    ...(analyzerNotes !== undefined && { analyzerNotes }),
    kind: 'risk',
  };
}

// ── Posture aggregation (FIPS 199 high-water-mark) ────────────────────

/**
 * Compute posture = max(severityScore) across findings where
 * `evidenceSource ≠ 'SLF'`. Returns 0 when no Verified findings exist
 * (caller can render "Insufficient evidence" rather than band 1).
 *
 * FIPS 199 rule: max, not sum / not average. Any single critical-band
 * Verified finding sets posture critical. SLF findings are excluded by
 * design — the agent's self-report cannot move the gradient (Heron
 * strategy v3.0 §3 + session-context 2026-05-28 § "Уточнение по весам").
 */
export function computePosture(findings: ReadonlyArray<VerdictFinding>): number {
  let max = 0;
  for (const f of findings) {
    if (f.evidenceSource === 'SLF') continue;
    if (f.severityScore > max) max = f.severityScore;
  }
  return max;
}

// ── Public entry point ──────────────────────────────────────────────

export function computeVerdict(inputs: VerdictInputs): Verdict {
  const interviewFindings = inputs.interviewFindings ?? [];
  const discoveryFindings = inputs.discoveryFindings ?? [];
  const oauthVerifications = inputs.oauthVerifications ?? [];
  const discoveredAgents = inputs.discoveredAgents ?? [];

  const hasDiscovery = inputs.discoveryFindings !== undefined;
  const hasOauth = (inputs.oauthVerifications?.length ?? 0) > 0;
  // AAP-91 — `discoveredAgents` is also deterministic Surface 2 evidence.
  const hasAgents = (inputs.discoveredAgents?.length ?? 0) > 0;

  // ── Status (technical execution state, NOT a verdict) ──
  //
  // Same gate as pre-AAP-102: `verified` requires BOTH discovery AND OAuth
  // ran with clean evidence. `partial` covers everything in between.
  // `unverified` only when no Surface 2 source ran. This is the
  // simplified 3-state ladder per AAP-102 acceptance.
  let status: VerificationStatus;
  if (!hasDiscovery && !hasOauth && !hasAgents) {
    status = 'unverified';
  } else {
    const discoveryClean = hasDiscovery && discoveryFindings.length === 0;
    const oauthClean =
      hasOauth &&
      oauthVerifications.every(
        (v) => v.verdict === 'verified' && v.diffs.length === 0,
      );
    status =
      hasDiscovery && hasOauth && discoveryClean && oauthClean
        ? 'verified'
        : 'partial';
  }

  // ── Findings ──
  const findings: VerdictFinding[] = [];

  discoveryFindings.forEach((f, idx) => {
    findings.push(
      discoveryFindingToVerdictFinding(f, idx, discoveredAgents, oauthVerifications),
    );
  });

  oauthVerifications.forEach((v) => {
    v.diffs.forEach((d, idx) => {
      findings.push(
        oauthDiffToVerdictFinding(d, v.sourceId, idx, discoveredAgents, oauthVerifications),
      );
    });
  });

  interviewFindings.forEach((r, idx) => {
    findings.push(
      interviewRiskToVerdictFinding(r, idx, discoveredAgents, oauthVerifications),
    );
  });

  // ── Posture (Verified-only FIPS HWM) ──
  const posture = computePosture(findings);
  const postureBand = severityBand(posture);

  // ── Legacy compile-time aliases (G4 will delete) ──
  const legacyRisk: RiskLevel | 'unverified' =
    status === 'unverified'
      ? 'unverified'
      : postureBand === 'critical'
        ? 'critical'
        : postureBand === 'high'
          ? 'high'
          : postureBand === 'medium'
            ? 'medium'
            : 'low';
  const verdict: Verdict = {
    status,
    posture,
    postureBand,
    findings,
    discrepancies: [],
    primaryRiskLevel: legacyRisk,
    primaryRiskSource:
      status === 'unverified' ? 'no-evidence' : 'deterministic',
  };
  if (legacyRisk !== 'unverified') verdict.deterministicRiskLevel = legacyRisk;
  return verdict;
}
