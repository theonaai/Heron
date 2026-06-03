/**
 * Pipeline glue for AAP-63 — turns the bag of artifacts the audit
 * pipeline produces into a `Verdict`, then persists the verdict onto
 * the session meta.
 *
 * Two entry points:
 *   - `computeVerdictFromArtifacts(...)`: pure, side-effect-free
 *     translator. Takes the analyzer JSON blob + the discovery section
 *     of report.json (when present) + the raw transcript and produces
 *     a `Verdict`. Used by mcp-server.ts at session completion AND by
 *     the dashboard discovery scan route after a Surface 2 read lands.
 *   - `persistVerdict(...)`: writes the verdict fields back onto the
 *     session meta via `updateSessionMeta`. Also mirrors the
 *     `primaryRiskLevel` onto the legacy `riskLevel` field so existing
 *     callers (markdown report download, comparison exports) continue
 *     to read the same value they always have.
 */

import type { DiscoveryFinding, DiscoveryResult } from '../discovery/types.js';
import type { ReportVerificationStatus, Risk } from '../report/types.js';
import { updateSessionMeta } from '../storage/sessions.js';
import type { TranscriptEntry } from '../storage/sessions.js';
import type { SourceVerification } from './types.js';
import { computeVerdict, type Verdict } from './verdict.js';
import type { RiskScorableSystem, SystemRiskResult } from './systems-risk.js';

/**
 * Loose shape of the analyzer JSON we care about for verdict computation.
 * We type narrowly so a malformed / partial blob doesn't crash the
 * pipeline — anything missing falls back to undefined and the verdict
 * gracefully degrades.
 */
interface AnalyzerJsonSubset {
  risks?: Risk[];
  overallRiskLevel?: string;
  localAgentDiscovery?: { findings?: DiscoveryFinding[] };
  systems?: RiskScorableSystem[];
}

function extractInterviewFindings(reportJson: unknown): Risk[] | undefined {
  if (!reportJson || typeof reportJson !== 'object') return undefined;
  const j = reportJson as AnalyzerJsonSubset;
  if (!Array.isArray(j.risks)) return undefined;
  return j.risks;
}

/**
 * G9 (AAP-106) — pull the declared `systems[]` so the verdict can score
 * per-system deployment risk into posture. Loosely typed: a malformed /
 * partial blob degrades to undefined and the systems-risk dimension is
 * simply absent (posture falls back to the discrepancy HWM).
 */
function extractSystemAssessments(
  reportJson: unknown,
): RiskScorableSystem[] | undefined {
  if (!reportJson || typeof reportJson !== 'object') return undefined;
  const j = reportJson as AnalyzerJsonSubset;
  if (!Array.isArray(j.systems)) return undefined;
  return j.systems;
}

function extractDiscoveryFindings(reportJson: unknown): DiscoveryFinding[] | undefined {
  if (!reportJson || typeof reportJson !== 'object') return undefined;
  const j = reportJson as AnalyzerJsonSubset;
  if (!j.localAgentDiscovery) return undefined;
  if (!Array.isArray(j.localAgentDiscovery.findings)) return [];
  return j.localAgentDiscovery.findings;
}

// AAP-102 — `transcriptToText` removed. The verdict no longer consumes
// raw transcript text (the discrepancy detector was the only caller).

/**
 * Build a `Verdict` from a session's analyzer report.json blob,
 * the freshest discovery scan (when present), and the raw transcript.
 *
 * `discoveryOverride` lets the discovery scan route bypass the
 * `reportJson.localAgentDiscovery` lookup and pass the fresh scan
 * result directly — avoiding a race between patchReportJson and
 * verdict computation.
 *
 * `oauthVerificationsOverride` (AAP-74) does the same for the L6 OAuth
 * introspection results: the scan route runs `runVerification` after
 * `runDiscovery`, so the freshest source-verification array is in
 * memory before `patchReportJson` has fsync'd. Passing it as an
 * override means the verdict reflects Surface 2 OAuth evidence on
 * the SAME tick the scan completes, not on the next read of
 * report.json.
 */
export function computeVerdictFromArtifacts(args: {
  reportJson?: unknown;
  transcript?: TranscriptEntry[];
  discoveryOverride?: DiscoveryResult;
  oauthVerificationsOverride?: SourceVerification[];
}): Verdict {
  const interviewFindings = extractInterviewFindings(args.reportJson);
  let discoveryFindings: DiscoveryFinding[] | undefined;
  if (args.discoveryOverride) {
    discoveryFindings = args.discoveryOverride.findings ?? [];
  } else {
    discoveryFindings = extractDiscoveryFindings(args.reportJson);
  }

  // AAP-75 — surface enumerated MCP servers so the verdict can factor
  // write-tool count into the BR-W axis. Pull from the fresh-scan
  // override when present (avoids a race with patchReportJson);
  // otherwise dig into the persisted reportJson shape.
  const discoveredAgents = args.discoveryOverride
    ? args.discoveryOverride.agents
    : extractDiscoveredAgents(args.reportJson);

  // G9 — declared systems for per-system deployment-risk scoring. Always
  // sourced from the persisted reportJson (systems don't change with a fresh
  // discovery scan; they come from the interview analyzer).
  const systemAssessments = extractSystemAssessments(args.reportJson);

  const inputs: Parameters<typeof computeVerdict>[0] = {};
  if (interviewFindings !== undefined) inputs.interviewFindings = interviewFindings;
  if (discoveryFindings !== undefined) inputs.discoveryFindings = discoveryFindings;
  if (systemAssessments !== undefined) inputs.systemAssessments = systemAssessments;
  if (args.oauthVerificationsOverride !== undefined) {
    inputs.oauthVerifications = args.oauthVerificationsOverride;
  }
  // AAP-102 — `interviewTranscriptText` removed (discrepancy detector
  // was the only consumer). Transcript no longer participates in
  // verdict computation; SLF findings carry the agent's claims as
  // structured data instead.
  if (discoveredAgents !== undefined) inputs.discoveredAgents = discoveredAgents;
  return computeVerdict(inputs);
}

/**
 * AAP-75 — extract the `agents[]` array from a persisted reportJson's
 * `localAgentDiscovery` section. Loosely typed because the persisted
 * shape uses the dashboard mirror types from `lib/report-json` rather
 * than the canonical reader types; for verdict purposes the only fields
 * we touch are `mcpServers[].toolEnumeration?.tools[].classification`.
 */
function extractDiscoveredAgents(
  reportJson: unknown,
): DiscoveryResult['agents'] | undefined {
  if (!reportJson || typeof reportJson !== 'object') return undefined;
  const j = reportJson as { localAgentDiscovery?: { agents?: unknown } };
  if (!j.localAgentDiscovery) return undefined;
  const agents = j.localAgentDiscovery.agents;
  if (!Array.isArray(agents)) return undefined;
  // The shape we read from disk happens to be structurally compatible
  // with DiscoveryResult['agents'] for the fields the verdict needs.
  // We cast through `unknown` to avoid asserting on every nested field —
  // `countWriteTools` is defensive about missing toolEnumeration / tools.
  return agents as unknown as DiscoveryResult['agents'];
}

/**
 * Persist a verdict onto session meta. Sets:
 *   - verificationStatus
 *   - riskLevel — legacy alias. AAP-102 maps the posture band onto the
 *     legacy `low/medium/high/critical` enum so existing dashboard /
 *     report download paths keep working without a code change.
 *     `'unverified'` flows through when no Surface 2 evidence exists so
 *     the dashboard still renders the "VERIFICATION REQUIRED" pill.
 */
export async function persistVerdict(sessionId: string, verdict: Verdict): Promise<void> {
  const patch: Parameters<typeof updateSessionMeta>[1] = buildVerdictMetaPatch(verdict);
  await updateSessionMeta(sessionId, patch);
}

/**
 * AAP-105 A2 — verdict → SessionMetaPatch projection. Pulled out so the
 * atomic `patchReportAndMeta(...)` writer path can apply the same
 * fields as `persistVerdict` without round-tripping through
 * updateSessionMeta. Keeps both paths byte-identical at the meta
 * layer.
 */
export function buildVerdictMetaPatch(
  verdict: Verdict,
): Parameters<typeof updateSessionMeta>[1] {
  return {
    verificationStatus: verdict.status,
    riskLevel: postureToLegacyRiskLevel(verdict),
  };
}

/**
 * AAP-103 — distil the full Verdict into the snapshot shape the
 * dashboard's `report.json` reader needs. The verdict carries some
 * fields the dashboard does not care about (legacy compile-time
 * aliases, internal `kind` tags); the snapshot is a stable subset.
 */
export function buildVerdictSnapshot(verdict: Verdict): {
  status: 'verified' | 'partial' | 'unverified';
  posture: number;
  postureBand: import('./severity-scoring.js').SeverityBand;
  discrepancyPosture: number;
  systemsRisk: {
    posture: number;
    postureBand: import('./severity-scoring.js').SeverityBand;
    scanned: boolean;
    systems: SystemRiskResult[];
  };
  findings: Array<{
    id: string;
    band: import('./severity-scoring.js').SeverityBand;
    severityScore: number;
    severityComponents: {
      br: number;
      ds: number;
      dm: number;
      brW?: number;
      brR?: number;
      brA?: number;
    };
    evidenceSource: 'MCP' | 'OAU' | 'ENV' | 'PLG' | 'SLF';
    title: string;
    description: string;
    // AAP-122 — SLF finding's bounded finding-type, threaded into the snapshot
    // so the dashboard can attribute it to framework card(s).
    findingType?: import('../compliance/types.js').FindingType;
    kind?: string;
  }>;
  // AAP-105 (G8b) — global-scope MCP servers reclassified out of
  // `findings`. Informational, no severity, never moves posture.
  hostCapabilities: Array<{
    serverName: string;
    runtime: string;
    transport: string;
    note: string;
  }>;
} {
  return {
    status: verdict.status,
    posture: verdict.posture ?? 0,
    postureBand: verdict.postureBand ?? 'informational',
    discrepancyPosture: verdict.discrepancyPosture ?? 0,
    systemsRisk: {
      posture: verdict.systemsRisk?.posture ?? 0,
      postureBand: verdict.systemsRisk?.postureBand ?? 'informational',
      scanned: verdict.systemsRisk?.scanned ?? false,
      systems: verdict.systemsRisk?.systems ?? [],
    },
    findings: (verdict.findings ?? []).map((f) => ({
      id: f.id,
      band: f.band,
      severityScore: f.severityScore,
      severityComponents: f.severityComponents,
      evidenceSource: f.evidenceSource,
      title: f.title,
      description: f.description,
      ...(f.findingType !== undefined ? { findingType: f.findingType } : {}),
      ...(f.kind !== undefined ? { kind: f.kind } : {}),
    })),
    hostCapabilities: (verdict.hostCapabilities ?? []).map((h) => ({
      serverName: h.serverName,
      runtime: h.runtime,
      transport: h.transport,
      note: h.note,
    })),
  };
}

/**
 * AAP-102 — map the new posture model back onto the legacy free-form
 * `riskLevel` string for storage-side back-compat. The field on
 * `AuditSession.riskLevel` is `string | undefined` (not the strict
 * RiskLevel enum) so 'unverified' flows through cleanly. G4 will remove
 * this once dashboard reads `posture` directly.
 */
function postureToLegacyRiskLevel(verdict: Verdict): string {
  if (verdict.status === 'unverified') return 'unverified';
  switch (verdict.postureBand) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
    case 'informational':
    default:
      return 'low';
  }
}

/**
 * AAP-80 — derive the report-level `verification.status` from a
 * computed `Verdict`. The mapping is intentionally narrow so the two
 * code paths that persist this field (`start_verification` MCP handler
 * and `POST /api/discovery/scan`) cannot drift.
 *
 * Mapping rules:
 *   - `verdict.status === 'verified'` → `'verified'`. All Surface 2
 *     sources ran and produced clean evidence.
 *   - `verdict.status === 'partial'` → `'partially-verified'`. At least
 *     one Surface 2 source ran but the verdict came back partial —
 *     either a source did not run, or one returned findings. This is
 *     the most common steady-state for AAP-79-era audits: discovery
 *     runs but OAuth introspection (AAP-64) is still wired manually,
 *     so the verdict can almost never reach `'verified'`.
 *   - `verdict.status === 'unverified'` AND no Surface 2 source was
 *     attempted → `'interrogation-only'`. Pre-scan baseline.
 *   - `verdict.status === 'unverified'` AND a Surface 2 source was
 *     attempted but failed → `'verification-failed'`. (In practice the
 *     persist paths short-circuit on errors and call this helper with
 *     the no-Surface-2 verdict only when nothing ran; this branch
 *     exists so the helper is total over the verdict surface.)
 *
 * The optional second arg lets the caller record which Surface 2
 * sources were attempted. The helper uses it to disambiguate the two
 * `'unverified'` outcomes. When omitted, we conservatively assume
 * "no source attempted" → `'interrogation-only'`; callers that want
 * the `'verification-failed'` path must opt in explicitly.
 */
export function reportVerificationStatusFromVerdict(
  verdict: Verdict,
  options: { surface2Attempted?: boolean } = {},
): ReportVerificationStatus {
  // AAP-88: categorical thresholds documented in
  // src/verification/threshold-manifest.ts:
  //   - verdict_pipeline_verifiedMapping
  //   - verdict_pipeline_partialMapping
  //   - verdict_pipeline_interrogationOnlyMapping
  //   - verdict_pipeline_verificationFailedMapping
  if (verdict.status === 'verified') return 'verified';
  if (verdict.status === 'partial') return 'partially-verified';
  // verdict.status === 'unverified'
  return options.surface2Attempted === true
    ? 'verification-failed'
    : 'interrogation-only';
}
