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
import type { Risk } from '../report/types.js';
import { updateSessionMeta, type RiskLevel as SessionRiskLevel } from '../storage/sessions.js';
import type { TranscriptEntry } from '../storage/sessions.js';
import { computeVerdict, type Verdict } from './verdict.js';

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
}

function extractInterviewFindings(reportJson: unknown): Risk[] | undefined {
  if (!reportJson || typeof reportJson !== 'object') return undefined;
  const j = reportJson as AnalyzerJsonSubset;
  if (!Array.isArray(j.risks)) return undefined;
  return j.risks;
}

function extractDiscoveryFindings(reportJson: unknown): DiscoveryFinding[] | undefined {
  if (!reportJson || typeof reportJson !== 'object') return undefined;
  const j = reportJson as AnalyzerJsonSubset;
  if (!j.localAgentDiscovery) return undefined;
  if (!Array.isArray(j.localAgentDiscovery.findings)) return [];
  return j.localAgentDiscovery.findings;
}

function transcriptToText(transcript: TranscriptEntry[]): string {
  return transcript.map((t) => `${t.question}\n${t.answer}`).join('\n');
}

/**
 * Build a `Verdict` from a session's analyzer report.json blob,
 * the freshest discovery scan (when present), and the raw transcript.
 *
 * `discoveryOverride` lets the discovery scan route bypass the
 * `reportJson.localAgentDiscovery` lookup and pass the fresh scan
 * result directly — avoiding a race between patchReportJson and
 * verdict computation.
 */
export function computeVerdictFromArtifacts(args: {
  reportJson?: unknown;
  transcript?: TranscriptEntry[];
  discoveryOverride?: DiscoveryResult;
}): Verdict {
  const interviewFindings = extractInterviewFindings(args.reportJson);
  let discoveryFindings: DiscoveryFinding[] | undefined;
  if (args.discoveryOverride) {
    discoveryFindings = args.discoveryOverride.findings ?? [];
  } else {
    discoveryFindings = extractDiscoveryFindings(args.reportJson);
  }
  const interviewTranscriptText = args.transcript
    ? transcriptToText(args.transcript)
    : '';

  const inputs: Parameters<typeof computeVerdict>[0] = {};
  if (interviewFindings !== undefined) inputs.interviewFindings = interviewFindings;
  if (discoveryFindings !== undefined) inputs.discoveryFindings = discoveryFindings;
  if (interviewTranscriptText.length > 0) {
    inputs.interviewTranscriptText = interviewTranscriptText;
  }
  return computeVerdict(inputs);
}

/**
 * Persist a verdict onto session meta. Sets:
 *   - verificationStatus
 *   - deterministicRiskLevel (when present)
 *   - interviewRiskLevel (when present)
 *   - riskLevel — legacy alias. Set to primaryRiskLevel so the existing
 *     dashboard / report download paths keep working without a code
 *     change. The string 'unverified' is a valid value here; the
 *     dashboard renders it as the new "VERIFICATION REQUIRED" badge.
 */
export async function persistVerdict(sessionId: string, verdict: Verdict): Promise<void> {
  const patch: Parameters<typeof updateSessionMeta>[1] = {
    verificationStatus: verdict.status,
    // The legacy field stays a free-form string; primaryRiskLevel widens
    // it to include 'unverified', which is exactly what we want for the
    // dashboard's red "verification required" pill on pre-AAP-63 sessions.
    riskLevel: verdict.primaryRiskLevel,
  };
  if (verdict.deterministicRiskLevel !== undefined) {
    patch.deterministicRiskLevel = verdict.deterministicRiskLevel as SessionRiskLevel;
  }
  if (verdict.interviewRiskLevel !== undefined) {
    patch.interviewRiskLevel = verdict.interviewRiskLevel as SessionRiskLevel;
  }
  await updateSessionMeta(sessionId, patch);
}
