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
import { runtimeEntry, type DiscoveredRuntime } from '../discovery/registry.js';
import type { EvidenceSource, Risk } from '../report/types.js';
import type { FindingType } from '../compliance/types.js';
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
import {
  computeSystemsRisk,
  type RiskScorableSystem,
  type SystemsRiskSummary,
} from './systems-risk.js';
import { readableScopeLabel } from './scope-labels.js';
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
  /**
   * AAP-122 — the bounded finding-type classification carried from the
   * originating interview `Risk` (SLF findings only). The analyzer assigns it;
   * the renderers fan it out to framework card(s) DETERMINISTICALLY via
   * `CONTROL_MAPPINGS` (`frameworkIdsForFindingType`). Undefined on Verified
   * findings and on SLF findings the analyzer could not classify — those stay
   * global-only with no framework card. Never moves posture.
   */
  findingType?: FindingType;
  /** Optional kind tag for legacy renderers (discovery / oauth / risk). */
  kind?: string;
  /**
   * T1 / D1 — explicit "could not verify" marker. Set to `'unverified'` when
   * this finding represents a DETERMINISTIC source Heron TRIED but could not
   * read (e.g. a failed OAuth introspection: expired/rejected token; later, a
   * skipped MCP enumeration). Such a finding is NOT a confirmed discrepancy —
   * the source-level verdict was `unverified` — so the renderer routes it to a
   * separate "Could not verify" bucket instead of "Verified discrepancies",
   * and excludes it from the "N verified" header counter. Severity stays 0, so
   * it never moves posture either way.
   *
   * Absent on confirmed Verified discrepancies (MCP/OAU/ENV/PLG) and on SLF
   * findings. The discriminator is THIS field, not the finding id or title —
   * any future "tried but could not read" finding sets it and routes the same.
   */
  verificationOutcome?: 'unverified';
}

/**
 * AAP-105 (G8b) — a discovered MCP server reclassified OUT of the
 * Verified findings list because the audited runtime's `scopeRule` is
 * `'global'`.
 *
 * The whole point of G8b: Heron audits a SPECIFIC AGENT WITH A TASK, not
 * the IDE. For a `global`-scope runtime (codex) the MCP config has NO
 * project binding — `~/.codex/config.toml` is shared by every project on
 * the box. So a discovered-but-undeclared (EXTRA-direction) global server
 * is the IDE's HOST CAPABILITY SURFACE, not a deviation by the audited
 * agent. It must NOT be a Verified `EXTRA` finding and must NOT move
 * posture (`computePosture` never sees these — they live here, not in
 * `findings`). The dashboard renders them as an informational note.
 *
 * Only EXTRA-direction findings reclassify. MISSING-direction findings
 * (the interview declared something absent on disk) stay Verified
 * regardless of scopeRule — that is a declared-vs-actual gap about a
 * thing the agent named, not a host-wide extra.
 *
 * `project-local` runtimes (claude-code) are unaffected: their per-
 * workspace MCP IS attributable to the audited agent, so EXTRA findings
 * there remain real Verified findings.
 */
export interface HostCapability {
  /** MCP server name as discovered (e.g. `supabase`). */
  serverName: string;
  /** Runtime whose host-wide config declared it (e.g. `codex`). */
  runtime: string;
  /** Transport, looked up from the discovered server. `unknown` when not resolvable. */
  transport: string;
  /** Human-readable note that this is IDE-global, not agent-bound. */
  note: string;
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
  /**
   * G9 (AAP-106) — declared SYSTEMS from the analyzer (`report.json
   * .systems[]`). Each row is scored on the BR × DS × DM scale
   * (`systems-risk.ts`) and the high-water-mark feeds posture, so an honest
   * agent (0 discrepancies) with irreversible writes to sensitive data still
   * reads as a real risk band instead of "No findings". Structurally
   * compatible with `SystemAssessment` / `ReportJsonSystem` — only the
   * risk-bearing fields (dataSensitivity / blastRadius / writeOperations)
   * are read.
   */
  systemAssessments?: RiskScorableSystem[];
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
   * G9 (AAP-106) — DEPLOYMENT RISK posture: the FIPS-199 high-water-mark of
   *   max( per-system risk over `systems[]` , verified-discrepancy HWM ).
   *
   * Pre-G9 this was the verified-discrepancy HWM ONLY, so an honest agent
   * (declared == actual, 0 discrepancies) scored 0 → "No Verified findings",
   * ignoring its risk surface. Now an honest-but-risky agent (irreversible
   * writes to sensitive data) carries the system risk into posture.
   *
   * SLF findings still NEVER move posture (wedge invariant). System risk is
   * deterministic blast-radius/sensitivity of the DECLARED systems — it is
   * not the agent's self-report about discrepancies, so it legitimately
   * drives the gradient. 0 only when there are no systems AND no verified
   * discrepancies (true "no scan").
   */
  posture: number;
  /** Coarse band for `posture` — informational / low / medium / high / critical. */
  postureBand: SeverityBand;
  /**
   * G9 (AAP-106) — verified-discrepancy-only HWM (the pre-G9 posture). Kept
   * separate so the renderer can show "N discrepancies" alongside the
   * risk-based headline. 0 when no verified discrepancy findings.
   */
  discrepancyPosture: number;
  /**
   * G9 (AAP-106) — per-system deployment-risk breakdown. `posture` /
   * `postureBand` here are the systems-only HWM; `scanned` says whether any
   * system was available to score (drives the clean-low-risk vs no-scan
   * label split). Empty + unscanned when the report carried no `systems[]`.
   */
  systemsRisk: SystemsRiskSummary;
  /** Every finding (Verified + SLF), with severity and provenance attached. */
  findings: VerdictFinding[];
  /**
   * AAP-105 (G8b) — global-scope MCP servers reclassified out of
   * `findings`. Informational only: no severity, NOT in `computePosture`,
   * rendered as a "host capability" note (not a finding card). Empty when
   * the audited runtime is `project-local` or had no global EXTRA servers.
   */
  hostCapabilities: HostCapability[];

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
  // Raw `service:scope` (or tool name) token — kept stable for the finding id
  // and carried into the description so the machine token stays discoverable
  // even though the title now shows a human-readable capability name.
  const service = (side as { service?: string }).service ?? sourceId;
  const scope = (side as { scope?: string }).scope ?? 'scope';
  const target =
    diff.dimension === 'tool'
      ? (side as { name?: string }).name ?? 'tool'
      : `${service}:${scope}`;
  // T2 / D6 — title reads as a clear capability, not a raw token, and uses no
  // em-dash (house style). Scope diffs render the curated/​prettified label
  // (e.g. "Gmail: send email"); tool diffs keep the tool name. `diff.kind`
  // ('extra' / 'missing' / 'mismatch') stays visible as "Extra/Missing scope".
  const kindLabel = `${diff.kind.charAt(0).toUpperCase()}${diff.kind.slice(1)}`;
  const dimensionWord = diff.dimension === 'tool' ? 'tool' : 'scope';
  const human =
    diff.dimension === 'tool'
      ? (side as { name?: string }).name ?? 'tool'
      : readableScopeLabel(service, scope);
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
    title: `${kindLabel} ${dimensionWord}: ${human}`,
    description: `OAuth ${dimensionWord} ${diff.kind} from ${sourceId} (${target})`,
    kind: 'oauth',
  };
}

/**
 * AAP-115 — build an informational VerdictFinding that SURFACES a failed OAuth
 * introspection (verdict `unverified`: auth / transport / parse error). The
 * canonical case is an expired/revoked Google token: the introspection call
 * returns nothing usable, so without this finding the failure would be buried
 * in a status-table row and `actualScopes` would read as a silent empty list.
 *
 * severityScore is 0 (`informational`) so the finding NEVER moves posture —
 * a failed read is honest "we could not verify", not a risk signal. The error
 * message (already scrubbed of any token value at the source boundary) is
 * carried into the description so a reviewer sees WHY it failed.
 */
function oauthIntrospectionFailureFinding(
  v: SourceVerification,
  idx: number,
): VerdictFinding {
  const reason = v.error?.message ?? 'introspection failed (no usable response)';
  return {
    id: `oau-${idx}-introspection-failed-${v.sourceId}`,
    band: 'informational',
    severityScore: 0,
    severityComponents: { br: 1, ds: 1, dm: 1 },
    evidenceSource: 'OAU',
    title: `OAuth introspection failed: ${v.sourceId}`,
    description: `Could not verify granted scopes for ${v.sourceId}: ${reason}. No declared-vs-actual comparison was possible for this source.`,
    kind: 'oauth',
    // T1 / D1 — a deterministic source we tried but could not read. Route to
    // the "Could not verify" bucket, not "Verified discrepancies".
    verificationOutcome: 'unverified',
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
    // AAP-122 — carry the analyzer's bounded finding-type classification onto
    // the SLF finding so the renderers can attribute it to framework card(s)
    // via `CONTROL_MAPPINGS`. The riskSchema already constrains the value to
    // the closed `FINDING_TYPES` enum; absent on risks the analyzer could not
    // classify (those stay global-only). Spread so the field is omitted, not
    // set to undefined, when absent — matches the `analyzerNotes` pattern.
    ...(risk.findingType !== undefined && { findingType: risk.findingType }),
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

// ── AAP-105 (G8b) — per-runtime scope gate ────────────────────────────

/**
 * Look up the transport of a discovered MCP server by name + runtime.
 * Used when reclassifying a global EXTRA finding into a `HostCapability`
 * so the note can say `(stdio)` / `(http)`. Falls back to `'unknown'`
 * when the server is not found in the agents array (e.g. plugin EXTRA
 * rows have no `DiscoveredMcpServer`).
 */
function transportForDiscoveredServer(
  serverName: string,
  runtime: string,
  agents: ReadonlyArray<DiscoveredAgent>,
): string {
  const lowered = serverName.toLowerCase();
  for (const agent of agents) {
    if (agent.runtime !== runtime) continue;
    for (const s of agent.mcpServers) {
      if (s.name.toLowerCase() === lowered) return s.transport;
    }
  }
  return 'unknown';
}

/**
 * AAP-105 (G8b) — decide whether a discovery finding is an EXTRA-direction
 * row on a `global`-scope runtime and therefore must be reclassified out
 * of the Verified findings list (see `HostCapability`).
 *
 * Gate is BOTH conditions:
 *   1. `kind === 'EXTRA'` — discovered-but-undeclared. MISSING /
 *      HIDDEN-CREDENTIALS are about declared things and stay Verified.
 *   2. the finding's `runtime` resolves to a registry entry whose
 *      `scopeRule === 'global'` (codex). Unknown runtimes and
 *      `project-local` runtimes (claude-code) are NOT reclassified.
 *
 * MISSING findings carry `runtime: '—'` which never resolves to a
 * registry entry, so they always fall through to the Verified path —
 * belt-and-suspenders on top of the `kind` check.
 */
function isGlobalScopeExtra(finding: DiscoveryFinding): boolean {
  if (finding.kind !== 'EXTRA') return false;
  const entry = runtimeEntry(finding.runtime as DiscoveredRuntime);
  return entry?.scopeRule === 'global';
}

/** A discovered runtime is global-scope when its registry `scopeRule` is
 *  `'global'` (codex). Unknown runtimes are treated as NOT global. */
function isGlobalScopeRuntime(runtime: string): boolean {
  const entry = runtimeEntry(runtime as DiscoveredRuntime);
  return entry?.scopeRule === 'global';
}

/**
 * G8 host-capability completeness fix — build the host-capability note
 * from the FULL discovered inventory of every global-scope runtime, NOT
 * from the mention-gated EXTRA findings.
 *
 * FINAL DECISION 2026-05-29 (heron-per-task-scope-design-2026-05-28.md
 * §3-5): for a `global`-scope runtime (codex) there is NO project binding
 * — `~/.codex/config.toml` is shared host-wide — so EVERY discovered MCP
 * server (AND every enabled global plugin) is an IDE host capability,
 * independent of whether the audited agent named it in the interview.
 *
 * Pre-fix the note was sourced from EXTRA findings, which only exist for
 * UNMENTIONED servers (the `isMentioned` gate in src/discovery/diff.ts).
 * A thorough agent that named every server it has (esp. under the Q39 /
 * AAP-82 `report_mcp_tools_list` directive) produced zero EXTRA findings,
 * collapsing the note to empty (sess-20260530-041854-a3e95b). Sourcing
 * from `discoveredAgents` makes the note complete regardless of mention.
 *
 * Product-owner decision (2026-05-30): EXCLUDE the `heron` audit server
 * itself from the note. Heron injects its own MCP server (named `heron` in
 * `[mcp_servers.heron]` of `~/.codex/config.toml`) so it can run the audit;
 * it is the audit endpoint we inject, NOT part of the audited agent's host
 * environment, so it should not appear as a host capability. Only MCP
 * servers are filtered — enabled plugins (capabilities of kind 'plugin')
 * are still included, so the note's shape does not regress versus the old
 * EXTRA-reclassification path (which surfaced plugins like
 * `github@openai-curated`). Deduped by (serverName, runtime). Returns []
 * when no global-scope agent is present.
 */
/**
 * Config name of Heron's own injected audit MCP server, as it appears in the
 * audited host config (`[mcp_servers.heron]` in `~/.codex/config.toml`).
 * Matched case-insensitively. Excluded from the host-capability note because
 * it is the audit endpoint Heron injects, not a capability of the host.
 */
const HERON_AUDIT_SERVER_NAME = 'heron';

function hostCapabilitiesFromDiscoveredAgents(
  agents: ReadonlyArray<DiscoveredAgent>,
): HostCapability[] {
  const out: HostCapability[] = [];
  const seen = new Set<string>();
  const push = (serverName: string, runtime: string, transport: string) => {
    const key = `${serverName.toLowerCase()}|${runtime}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      serverName,
      runtime,
      transport,
      note: `Configured in the ${runtime} IDE on this host, not specific to this audited agent/task.`,
    });
  };
  for (const agent of agents) {
    if (!isGlobalScopeRuntime(agent.runtime)) continue;
    // All discovered MCP servers EXCEPT heron. Heron is Heron's own injected
    // audit endpoint (the [mcp_servers.heron] we add to run the audit), not
    // part of the audited agent's host environment, so it must not appear in
    // the host-capability note. Transport comes straight from the discovered
    // server.
    for (const server of agent.mcpServers) {
      if (server.name.toLowerCase() === HERON_AUDIT_SERVER_NAME) continue;
      push(server.name, agent.runtime, server.transport);
    }
    // Enabled global host plugins. These have no DiscoveredMcpServer, so
    // transport resolution falls back to 'unknown' (same as the old
    // EXTRA-reclassification path produced for plugin rows).
    for (const cap of agent.capabilities ?? []) {
      if (cap.kind !== 'plugin') continue;
      if (!cap.enabled) continue;
      push(
        cap.name,
        agent.runtime,
        transportForDiscoveredServer(cap.name, agent.runtime, agents),
      );
    }
  }
  return out;
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

  // AAP-105 (G8b) — global-scope EXTRA servers are reclassified out of
  // the Verified findings list. They never become VerdictFindings, so they
  // never reach `computePosture`. Everything else (EXTRA on project-local
  // runtimes, all MISSING, all HIDDEN-CREDENTIALS) flows through the normal
  // Verified path unchanged.
  const verifiedDiscoveryFindings: DiscoveryFinding[] = [];
  const reclassifiedHostCapabilities: HostCapability[] = [];
  for (const f of discoveryFindings) {
    if (isGlobalScopeExtra(f)) {
      reclassifiedHostCapabilities.push({
        serverName: f.serverName,
        runtime: f.runtime,
        transport: transportForDiscoveredServer(f.serverName, f.runtime, discoveredAgents),
        note: `Configured in the ${f.runtime} IDE on this host, not specific to this audited agent/task.`,
      });
    } else {
      verifiedDiscoveryFindings.push(f);
    }
  }

  // G8 host-capability completeness fix — the host-capability NOTE is
  // sourced from the FULL discovered inventory of every global-scope
  // runtime, not from the mention-gated EXTRA findings. For a global
  // runtime there is no project binding, so every discovered MCP server
  // and enabled plugin is a host capability regardless of interview
  // mention (see `hostCapabilitiesFromDiscoveredAgents` JSDoc + the
  // sess-20260530-041854-a3e95b empty-note bug). When `discoveredAgents`
  // carries no global-scope agent (legacy callers / tests that pass only
  // `discoveryFindings`), fall back to the EXTRA-reclassification set so
  // the existing behaviour is preserved byte-for-byte.
  const fromAgents = hostCapabilitiesFromDiscoveredAgents(discoveredAgents);
  const hostCapabilities: HostCapability[] =
    fromAgents.length > 0 ? fromAgents : reclassifiedHostCapabilities;

  verifiedDiscoveryFindings.forEach((f, idx) => {
    findings.push(
      discoveryFindingToVerdictFinding(f, idx, discoveredAgents, oauthVerifications),
    );
  });

  oauthVerifications.forEach((v, vIdx) => {
    // AAP-115 — SURFACE introspection failures. An `unverified` OAuth source
    // (auth/transport/parse error — e.g. an expired Google token) carries an
    // empty diff array, so the diff loop below would emit NOTHING and the
    // failure would only ever show up as a status-table row. Emit an explicit
    // informational finding so the failed introspection is VISIBLE in the
    // findings list, never silently empty. severityScore 0 → it cannot move
    // posture (the read failed; we make no risk claim either way).
    if (v.verdict === 'unverified') {
      findings.push(oauthIntrospectionFailureFinding(v, vIdx));
      return;
    }
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

  // ── Posture (G9: max of verified-discrepancy HWM and per-system risk) ──
  //
  // discrepancyPosture is the pre-G9 posture: max severity over Verified
  // discrepancy findings (SLF excluded — wedge invariant intact). systemsRisk
  // scores the DECLARED systems on the same BR × DS × DM scale, so an honest
  // agent with irreversible writes to sensitive data still surfaces a real
  // risk band instead of "No findings". Final posture is the FIPS HWM of both.
  const discrepancyPosture = computePosture(findings);
  // AAP-115 — pass the verified OAuth scope inventory so per-system DS tiers
  // can be floored deterministically from what the granted scope actually
  // grants (catching a system that under-reports its sensitivity). The floor
  // only raises a tier; broad blast-radius scopes never floor DS.
  const systemsRisk = computeSystemsRisk(inputs.systemAssessments, oauthVerifications);
  const posture = Math.max(discrepancyPosture, systemsRisk.posture);
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
    discrepancyPosture,
    systemsRisk,
    findings,
    hostCapabilities,
    discrepancies: [],
    primaryRiskLevel: legacyRisk,
    primaryRiskSource:
      status === 'unverified' ? 'no-evidence' : 'deterministic',
  };
  if (legacyRisk !== 'unverified') verdict.deterministicRiskLevel = legacyRisk;
  return verdict;
}
