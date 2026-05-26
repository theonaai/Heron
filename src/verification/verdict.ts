/**
 * Verdict computation — AAP-63.
 *
 * Heron strategy v3.0 §3: "Every claim about an AI agent should be
 * verifiable from a deterministic source of truth, not from the agent's
 * own self-report." Until AAP-63 the dashboard's risk badge was driven
 * 100% by Surface 1 (LLM analysis of the interview transcript), which
 * is non-deterministic — two consecutive runs of the same agent
 * produced different verdicts.
 *
 * This module reconciles Surface 1 (LLM-derived interview findings)
 * with Surface 2 (deterministic filesystem discovery + OAuth scope
 * introspection) into a single `Verdict`. The verdict's
 * `primaryRiskLevel` is what the dashboard pill shows; it comes from
 * Surface 2 when ANY Surface 2 source has run, falling back to
 * `'unverified'` when only Surface 1 evidence exists. Interview risk
 * is preserved as a SECONDARY signal so the dashboard can render the
 * LLM's separate take alongside the deterministic verdict.
 *
 * The discrepancy heuristic in this file is intentionally v1:
 * substring matching against the (lowercased) interview transcript
 * looking for explicit denials ("never", "do not", "doesn't") near a
 * service name that Surface 2 then surfaced as an EXTRA / unrecorded
 * capability. False positives here are tolerable — the renderer shows
 * the discrepancy as a side note, not as a hard verdict driver — but
 * we keep the matcher conservative so it doesn't flood the report.
 */

import type { DiscoveredAgent, DiscoveryFinding } from '../discovery/types.js';
import type { Risk } from '../report/types.js';
import type { SourceVerification, DiffEntry, DiffSeverity } from './types.js';

/** Per-session verification status. Mirrors the field on `AuditSession`. */
export type VerificationStatus = 'unverified' | 'partial' | 'verified';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type PrimaryRiskLevel = 'unverified' | RiskLevel;

export interface Discrepancy {
  /** What the interview text claimed. */
  claim: string;
  /** What Surface 2 evidence revealed. */
  evidence: string;
  severity: RiskLevel;
}

export interface VerdictInputs {
  /** Surface 2 — filesystem discovery findings from src/discovery/diff.ts. */
  discoveryFindings?: DiscoveryFinding[];
  /** Surface 2 — OAuth introspection per-source results. */
  oauthVerifications?: SourceVerification[];
  /** Surface 1 — analyzer LLM findings. */
  interviewFindings?: Risk[];
  /** Optional raw transcript text (lowercased internally) used for
   *  best-effort discrepancy heuristics. */
  interviewTranscriptText?: string;
  /**
   * AAP-75 — discovered agents (post-enumeration). The verdict counts
   * write-classified MCP tools across all servers and uses that count as
   * a side-input to the deterministic risk ramp: 1+ write tool nudges
   * an otherwise-clean discovery to `medium`, 5+ to `high`. Without
   * enumeration this signal is absent and the legacy ramp applies.
   */
  discoveredAgents?: DiscoveredAgent[];
}

export interface Verdict {
  status: VerificationStatus;
  deterministicRiskLevel?: RiskLevel;
  interviewRiskLevel?: RiskLevel;
  /** What the dashboard badge should display. */
  primaryRiskLevel: PrimaryRiskLevel;
  /** Why the primary risk was chosen. */
  primaryRiskSource: 'deterministic' | 'self-reported' | 'no-evidence';
  discrepancies: Discrepancy[];
}

// ── Severity mapping ─────────────────────────────────────────────────

/**
 * Severity ramp from discovery findings to a deterministic risk level.
 *
 * Discovery uses HIGH/MEDIUM/LOW/INFO buckets; the dashboard pill uses
 * low/medium/high/critical. Per the AAP-63 brief: "CRITICAL → high,
 * HIGH → medium, MEDIUM → medium". One HIGH on its own is a
 * deterministic medium; three or more HIGH findings escalate to
 * deterministic high.
 */
function discoveryRiskLevel(findings: DiscoveryFinding[]): RiskLevel {
  if (findings.length === 0) return 'low';
  const highCount = findings.filter((f) => f.severity === 'HIGH').length;
  const mediumCount = findings.filter((f) => f.severity === 'MEDIUM').length;
  // AAP-88: thresholds documented in src/verification/threshold-manifest.ts.
  //   - verdict_discoveryRisk_highEscalate (3 HIGH → high)
  //   - verdict_discoveryRisk_highToMedium (1 HIGH → medium)
  //   - verdict_discoveryRisk_mediumEscalate (3 MEDIUM → medium)
  if (highCount >= 3) return 'high';
  if (highCount >= 1) return 'medium';
  if (mediumCount >= 3) return 'medium';
  return 'low';
}

/**
 * AAP-75 — count `write`-classified tools across all enumerated MCP
 * servers on all discovered agents. `unknown`-classified tools are NOT
 * counted; they're surfaced in the report so an operator can manually
 * resolve, but the verdict ramp stays conservative.
 */
function countWriteTools(agents: DiscoveredAgent[]): number {
  // AAP-88: categorical threshold `verdict_writeTools_excludeUnknown` —
  // `unknown`-classified tools are NOT counted toward the write-tool ramp.
  // See src/verification/threshold-manifest.ts.
  let n = 0;
  for (const agent of agents) {
    for (const server of agent.mcpServers) {
      const tools = server.toolEnumeration?.tools ?? [];
      for (const t of tools) {
        if (t.classification === 'write') n++;
      }
    }
  }
  return n;
}

/**
 * AAP-75 — lift the deterministic discovery risk level based on the
 * number of write-classified MCP tools the agent actually has access to.
 *
 * Heron ships strategy v3.0 §3 — "tell the operator exactly what writes
 * are available". The verdict pill is the highest-leverage place to
 * surface that count: 1+ writes pushes a baseline-clean discovery to
 * `medium`, 5+ to `high`, regardless of LLM analysis. The thresholds
 * are intentionally low because the SAME agent that claims "read-only"
 * in the interview but ships 1 write tool is precisely the misclaim
 * AAP-75 exists to expose.
 *
 * Note: we never DOWNGRADE — if the discovery findings already say
 * `high`, the write-tool ramp doesn't drop it back to `medium`.
 */
function liftForWriteTools(baseline: RiskLevel, writeToolCount: number): RiskLevel {
  // AAP-88: thresholds documented in src/verification/threshold-manifest.ts.
  //   - verdict_writeTools_noLift (0 tools → no-op)
  //   - verdict_writeTools_highLift (>=5 tools → lift to high)
  //   - verdict_writeTools_mediumLift (>=1 tool → lift to medium)
  //   - verdict_writeTools_noDowngrade (never downgrade — implemented via maxRisk)
  if (writeToolCount === 0) return baseline;
  if (writeToolCount >= 5) return maxRisk(baseline, 'high');
  return maxRisk(baseline, 'medium');
}

/**
 * Severity ramp from OAuth diff entries to a deterministic risk level.
 * Mirrors the discovery ramp at the diff-severity level.
 */
function oauthRiskLevel(verifications: SourceVerification[]): RiskLevel {
  const diffs: DiffEntry[] = [];
  for (const v of verifications) {
    for (const d of v.diffs) diffs.push(d);
  }
  if (diffs.length === 0) return 'low';
  // AAP-88: thresholds documented in src/verification/threshold-manifest.ts.
  //   - verdict_oauthRisk_criticalToHigh (1 critical → high)
  //   - verdict_oauthRisk_highEscalate (3 high → high)
  //   - verdict_oauthRisk_highToMedium (1 high → medium)
  //   - verdict_oauthRisk_mediumEscalate (3 medium → medium)
  const critical = diffs.filter((d) => d.severity === 'critical').length;
  if (critical >= 1) return 'high';
  const high = diffs.filter((d) => d.severity === 'high').length;
  if (high >= 3) return 'high';
  if (high >= 1) return 'medium';
  const medium = diffs.filter((d) => d.severity === 'medium').length;
  if (medium >= 3) return 'medium';
  return 'low';
}

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

function interviewRiskFromFindings(findings: Risk[]): RiskLevel | undefined {
  if (findings.length === 0) return undefined;
  let max: RiskLevel = 'low';
  for (const r of findings) {
    const sev = r.severity as RiskLevel;
    if (sev === 'low' || sev === 'medium' || sev === 'high' || sev === 'critical') {
      max = maxRisk(max, sev);
    }
  }
  return max;
}

// ── Discrepancy heuristics ───────────────────────────────────────────

const DENIAL_PATTERNS = [
  /\bnever\b/i,
  /\bdoes\s*not\b/i,
  /\bdoesn't\b/i,
  /\bdo\s*not\b/i,
  /\bdon't\b/i,
  /\bno\s+access\b/i,
  /\bno\s+(?:slack|github|gmail|drive|jira|linear|notion|salesforce|hubspot|sentry|postgres|calendar)\b/i,
];

function discoveryFindingSeverityToRiskLevel(sev: DiscoveryFinding['severity']): RiskLevel {
  switch (sev) {
    case 'HIGH':
      return 'high';
    case 'MEDIUM':
      return 'medium';
    case 'LOW':
      return 'low';
    case 'INFO':
      return 'low';
    default:
      return 'low';
  }
}

function diffSeverityToRiskLevel(sev: DiffSeverity): RiskLevel {
  switch (sev) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
      return 'low';
    case 'info':
      return 'low';
    default:
      return 'low';
  }
}

/**
 * Best-effort v1 discrepancy detector.
 *
 * For each EXTRA discovery finding, scan the transcript text for an
 * explicit denial near the server's name or canonical keyword. If we
 * find one, emit a Discrepancy entry that the report renderer can
 * surface in a dedicated section.
 *
 * Conservative on purpose: false positives in this list would erode
 * trust in the broader verdict, so we require both a denial token AND
 * a service-name token within ~80 chars of each other.
 */
function detectDiscrepancies(
  discoveryFindings: DiscoveryFinding[],
  oauthVerifications: SourceVerification[],
  transcriptText: string,
): Discrepancy[] {
  const out: Discrepancy[] = [];
  if (transcriptText.length === 0) return out;

  const text = transcriptText.toLowerCase();

  const checkOne = (
    serviceName: string,
    description: string,
    severity: RiskLevel,
  ): void => {
    const lowered = serviceName.toLowerCase();
    if (lowered.length === 0) return;
    const idx = text.indexOf(lowered);
    if (idx < 0) return;
    // AAP-88: window-chars threshold `verdict_discrepancy_windowChars` = 80.
    // See src/verification/threshold-manifest.ts.
    const start = Math.max(0, idx - 80);
    const end = Math.min(text.length, idx + lowered.length + 80);
    const window = text.slice(start, end);
    for (const p of DENIAL_PATTERNS) {
      if (p.test(window)) {
        out.push({
          claim: `Interview text near "${serviceName}" contains a denial (matched pattern "${p.source}")`,
          evidence: `${serviceName}: ${description}`,
          severity,
        });
        return;
      }
    }
  };

  for (const f of discoveryFindings) {
    if (f.kind !== 'EXTRA') continue;
    checkOne(
      f.serverName,
      f.description,
      discoveryFindingSeverityToRiskLevel(f.severity),
    );
  }

  for (const v of oauthVerifications) {
    for (const d of v.diffs) {
      if (d.kind !== 'extra') continue;
      const sev = diffSeverityToRiskLevel(d.severity);
      if (d.dimension === 'tool') {
        const a = d.actual as { name?: string; description?: string };
        if (a.name) checkOne(a.name, a.description ?? `OAuth EXTRA tool: ${a.name}`, sev);
      } else {
        const a = d.actual as { service?: string; scope?: string };
        const label = `${a.service ?? ''}:${a.scope ?? ''}`;
        if (a.service) checkOne(a.service, `OAuth EXTRA scope: ${label}`, sev);
      }
    }
  }

  return out;
}

// ── Public entry point ──────────────────────────────────────────────

export function computeVerdict(inputs: VerdictInputs): Verdict {
  const interviewRiskLevel = interviewRiskFromFindings(inputs.interviewFindings ?? []);

  const hasDiscovery = inputs.discoveryFindings !== undefined;
  const hasOauth = (inputs.oauthVerifications?.length ?? 0) > 0;

  // No Surface 2 at all → unverified.
  if (!hasDiscovery && !hasOauth) {
    const base: Verdict = {
      status: 'unverified',
      primaryRiskLevel: 'unverified',
      primaryRiskSource: 'no-evidence',
      discrepancies: [],
    };
    if (interviewRiskLevel !== undefined) {
      base.interviewRiskLevel = interviewRiskLevel;
    }
    return base;
  }

  // At least one Surface 2 source ran.
  const discoveryFindings = inputs.discoveryFindings ?? [];
  const oauthVerifications = inputs.oauthVerifications ?? [];

  // Status semantics — AAP-88 categorical thresholds documented in
  // src/verification/threshold-manifest.ts:
  //   - verdict_status_verifiedRequiresBoth: 'verified' iff BOTH Surface 2
  //     sources ran (discovery AND oauth) AND both produced clean evidence.
  //     Missing OAuth introspection is by design today (token-capture UX is
  //     AAP-64) — sessions therefore land on 'partial' for the foreseeable
  //     future even when discovery returns zero findings.
  //   - verdict_status_partialWhenAny: 'partial' otherwise (at least one
  //     Surface 2 source ran).
  //   - verdict_status_unverifiedNoSurface2: 'unverified' when neither
  //     Surface 2 source ran (handled by the early-return above).
  const discoveryClean = hasDiscovery && discoveryFindings.length === 0;
  const oauthClean =
    hasOauth &&
    oauthVerifications.every(
      (v) => v.verdict === 'verified' && v.diffs.length === 0,
    );
  const status: VerificationStatus =
    hasDiscovery && hasOauth && discoveryClean && oauthClean
      ? 'verified'
      : 'partial';

  // AAP-75 — lift baseline discovery risk based on write-tool count.
  const fromDiscoveryBase = hasDiscovery ? discoveryRiskLevel(discoveryFindings) : 'low';
  const writeToolCount = inputs.discoveredAgents
    ? countWriteTools(inputs.discoveredAgents)
    : 0;
  const fromDiscovery: RiskLevel = liftForWriteTools(fromDiscoveryBase, writeToolCount);
  const fromOauth = hasOauth ? oauthRiskLevel(oauthVerifications) : 'low';
  const deterministicRiskLevel: RiskLevel = maxRisk(fromDiscovery, fromOauth);

  const discrepancies = detectDiscrepancies(
    discoveryFindings,
    oauthVerifications,
    inputs.interviewTranscriptText ?? '',
  );

  const verdict: Verdict = {
    status,
    deterministicRiskLevel,
    primaryRiskLevel: deterministicRiskLevel,
    primaryRiskSource: 'deterministic',
    discrepancies,
  };
  if (interviewRiskLevel !== undefined) {
    verdict.interviewRiskLevel = interviewRiskLevel;
  }
  return verdict;
}
