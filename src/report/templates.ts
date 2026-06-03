import type { AnalyzeFailureReason } from '../analysis/analyzer.js';
import { calibrateVerdictLabel } from '../analysis/risk-scorer.js';
import type { AuditReport, EvidenceSource, QAPair, DataQuality, Risk, SystemAssessment, WriteOperation, StructuredCompliance, RegulatoryFlag } from './types.js';
import type { TypedRegulatoryFlag } from '../compliance/mapper.js';
import type { ControlResult } from '../compliance/control-catalog.js';
import {
  activatedFrameworksFromControlResults,
  dedupeControlResults,
  gapCountsByTier,
  gapLabelsForFramework,
  gapResults,
  statusLabelFromControlResults,
  worstSeverity,
} from './control-results-projection.js';
import {
  allLensFrameworks,
  composeFrameworkLensRows,
  frameworkLens,
  slfFindingsForFramework,
  verdictDisplayLabel,
  type FrameworkLens,
  type LensControl,
  type LensFindingRef,
} from './compliance-lens.js';
import { isProvided, UNKNOWN_PLACEHOLDER } from '../util/provided.js';
import {
  isBusinessSystem,
  categorizeSystem,
  systemCategoryLabel,
  systemCategoryRationale,
  type SystemCategory,
} from '../util/systems.js';
import {
  escapeText,
  escapeInlineCode,
  escapeTableCell as escapeCell,
} from '../util/markdown-escape.js';
import type {
  DiffEntry,
  SourceVerification,
  VerificationReport,
  VerificationVerdict,
} from '../verification/types.js';
import { renderFrameworkMappingSection } from '../verification/frameworks/render.js';
import type { Verdict, VerdictFinding } from '../verification/verdict.js';
import type { SystemRiskResult } from '../verification/systems-risk.js';
import type { DiscoveryFinding } from '../discovery/types.js';
import {
  assignFindingCodes,
  bucketForBand,
  countVerifiedByBucket,
  formatSeverityNumber,
  nearestStop,
  renderBucketCountsLine,
  renderSeverityFormula,
  SEVERITY_BAND_LABEL,
  SEVERITY_STOPS,
  type CodedVerdictFinding,
} from './finding-display.js';
import {
  buildSlfMitigationState,
  getMitigationHint,
  getSlfMitigationHint,
  type SlfMitigationState,
} from './mitigation-catalog.js';
import { extractProjectName, type TranscriptEntryLike } from './agent-name.js';

// ─── AAP-43 P1 #5 / AAP-84 Phase 4 — overall regulatory status ────────────

/**
 * AAP-84 — set of FrameworkId values the OSS pipeline treats as
 * mandatory. Mirrors `FRAMEWORKS[id].tier === 'mandatory'` for the two
 * EU-wide statutes shipped in the OSS scope (post-AAP-42 scope cut). We
 * inline the set here so the templates file does not import the
 * framework registry just to count gaps.
 */
const MANDATORY_FRAMEWORK_IDS = new Set([
  'eu-ai-act',
  'gdpr',
] as const);

/**
 * Reduce all activated framework signals into a single status label +
 * gap counter. Replaces the prior EU/US/UK jurisdiction matrix which
 * couldn't vary without US/UK frameworks in the OSS registry.
 *
 * AAP-84 — when `controlResults` is populated (any audit that ran with
 * Surface 2 actual-evidence enabled) the function reads its gap
 * verdicts directly. When absent (legacy report on disk, or a Surface 1
 * only run), it falls back to the legacy `compliance.all` projection so
 * back-compat survives until Phase 9 deletes the prose synthesis.
 *
 * Labels (descending severity):
 *   - "Action Required"      — at least one `fail` verdict (typed) OR
 *                              action-required flag (legacy)
 *   - "Needs Clarification"  — at least one `partial` verdict (typed) OR
 *                              clarification-needed flag (legacy)
 *   - "Review"               — at least one `unverified` verdict (typed)
 *                              OR warning-level flag (legacy)
 *   - "Not Triggered"        — no gap-class signals
 */
function summarizeOverallStatus(c: StructuredCompliance): string {
  const controlResults = ((c as any).controlResults ?? []) as ControlResult[];
  if (controlResults.length > 0) {
    return summarizeOverallStatusFromControlResults(controlResults);
  }
  return summarizeOverallStatusFromLegacy(c);
}

/**
 * AAP-84 typed projection: reads `controlResults` directly. Gap-count
 * mapping is documented on
 * `src/report/control-results-projection.ts:GAP_VERDICTS`.
 *
 * Codex post-review fix (Blocker 3): risk-score detectors fire as a
 * methodology anchor, not a real gap (mirrors the legacy `GAP_EXCLUDED`
 * filter on `triggeredBy`). A risk-score-only partial or fail must not
 * produce "Needs Clarification" or "Action Required" when there are no
 * other gaps. Exclude `risk-score` BEFORE computing the status label so
 * the label and the gap-count suffix agree.
 */
function summarizeOverallStatusFromControlResults(results: ControlResult[]): string {
  // GAP_EXCLUDED (risk-score) is defined later in this file alongside
  // the markdown-renderer helpers; we reference it directly so the
  // exclusion set stays single-source-of-truth across both projections.
  const filtered = results.filter((r) => !GAP_EXCLUDED.has(r.findingType));
  const label = statusLabelFromControlResults(filtered);
  const counts = gapCountsByTier(filtered, MANDATORY_FRAMEWORK_IDS as ReadonlySet<any>, GAP_EXCLUDED);
  const parts: string[] = [];
  if (counts.mandatory > 0) parts.push(`${counts.mandatory} mandatory-framework gap${counts.mandatory === 1 ? '' : 's'}`);
  if (counts.voluntary > 0) parts.push(`${counts.voluntary} voluntary-framework gap${counts.voluntary === 1 ? '' : 's'}`);
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `${label}${suffix}`;
}

/**
 * Legacy projection — kept until Phase 9. Triggered for reports loaded
 * from disk that predate AAP-83 (`controlResults` absent), and for
 * Surface 1 only audits where the mapper never received an `actual`
 * envelope.
 */
function summarizeOverallStatusFromLegacy(c: StructuredCompliance): string {
  const all = (c.all ?? []) as RegulatoryFlag[];
  if (all.length === 0) return 'Not Triggered';

  let label: string;
  if (all.some(f => f.severity === 'action-required')) label = 'Action Required';
  else if (all.some(f => f.severity === 'clarification-needed')) label = 'Needs Clarification';
  else if (all.some(f => f.severity === 'warning')) label = 'Review';
  else label = 'Not Triggered';

  const mandatoryGaps = all.filter(f => f.tier === 'mandatory' && f.severity !== 'info').length;
  const voluntaryGaps = all.filter(f => f.tier === 'voluntary' && f.severity !== 'info').length;
  const parts: string[] = [];
  if (mandatoryGaps > 0) parts.push(`${mandatoryGaps} mandatory-framework gap${mandatoryGaps === 1 ? '' : 's'}`);
  if (voluntaryGaps > 0) parts.push(`${voluntaryGaps} voluntary-framework gap${voluntaryGaps === 1 ? '' : 's'}`);
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `${label}${suffix}`;
}

// isBusinessSystem lives in src/util/systems.ts (shared with analyzer + mapper).

/**
 * AAP-108 — resolve the agent DISPLAY NAME shown in the header and the
 * Agent Profile row.
 *
 * `report.metadata.target` is the raw RUNTIME label (e.g. "Codex desktop
 * agent in /Users/.../Codex3"), which is uninformative and drifts from
 * what the dashboard shows. The dashboard's `MinimalReportView` derives
 * the name via `extractProjectName(transcript, runtimeName, agentPurpose)`
 * — the Q1-extracted product name (e.g. "MVP Edu Content Agent") — and the
 * Node storage layer stamps that same value onto `meta.extractedAgentName`
 * (and onto report.json, via `deriveExtractedAgentName`). This helper
 * reads from the SAME source so the markdown header / Agent Profile match
 * the dashboard:
 *
 *   1. A pre-stamped `extractedAgentName` on the report blob (the field
 *      the storage layer / report.json already carries), when present.
 *   2. Otherwise derive it on the fly via the shared `extractProjectName`,
 *      passing `metadata.target` as the runtime fallback — identical to the
 *      dashboard call. `.name` is the extracted product name; it equals the
 *      runtime fallback only when extraction genuinely failed.
 *
 * `metadata.target` remains the last-resort fallback (when there is no
 * transcript / agentPurpose to extract from), so legacy reports still
 * render a name.
 */
function resolveAgentDisplayName(report: AuditReport): string {
  const stamped = (report as { extractedAgentName?: unknown }).extractedAgentName;
  if (typeof stamped === 'string' && stamped.trim().length > 0) {
    return stamped.trim();
  }
  const transcript = Array.isArray(report.transcript)
    ? (report.transcript as TranscriptEntryLike[])
    : undefined;
  const { name } = extractProjectName(
    transcript,
    report.metadata?.target,
    report.agentPurpose,
  );
  return name || report.metadata?.target || 'unknown-agent';
}

/**
 * AAP-63 — optional Surface 2 context for `renderMarkdownReport`.
 *
 * When the caller has a computed `Verdict` and the discovery scan
 * artefacts on hand, the renderer emits two extra sections — a
 * "Verification Status" block at the top and a "Discrepancies" block
 * after it — and splits the Findings section into
 * "Deterministic Findings (Surface 2)" + "Self-Reported Findings
 * (Surface 1)". When this context is absent (the initial markdown
 * write happens BEFORE the user-gated discovery scan), the renderer
 * keeps the legacy single-section layout for back-compat AND emits a
 * minimal "verification not yet run" callout so a downstream reader
 * still sees the Surface 2 gap.
 */
export interface RenderMarkdownReportContext {
  verdict?: Verdict;
  discoveryFindings?: DiscoveryFinding[];
  /**
   * Optional per-source verification status for the report header.
   *
   * AAP-93 M4 — accepts a discriminated `{status, reason?}` object so
   * the Verification Status table can render the reason alongside a
   * `skipped` / `failed` row. The bare-string form is preserved for
   * back-compat (legacy callers that don't have a reason to surface);
   * the renderer normalises both shapes internally.
   */
  discoveryStatus?:
    | 'ran'
    | 'skipped'
    | 'failed'
    | { status: 'ran' | 'skipped' | 'failed'; reason?: string };
  oauthIntrospectionStatus?: Array<{
    provider: string;
    /** `'ran' | 'skipped' | 'failed'` — same back-compat dual shape as discoveryStatus. */
    status:
      | 'ran'
      | 'skipped'
      | 'failed'
      | { status: 'ran' | 'skipped' | 'failed'; reason?: string };
    /** Free-text reason — only consumed when `status` is the bare string form. */
    reason?: string;
  }>;
  /**
   * AAP-67 — workspace .env evidence (renumbered to L3 in docs after
   * AAP-100). When absent, the section block is omitted entirely.
   * The shape mirrors `DiscoveryResult`'s `workspaceEnv` (kept loose —
   * `string[]` for keys — so the markdown template stays decoupled
   * from the reader types).
   */
  localDiscoveryExtras?: {
    workspaceEnv?: Array<{ path: string; workspace: string; keys: string[] }>;
    warnings?: string[];
  };
}

export function renderMarkdownReport(
  report: AuditReport,
  context: RenderMarkdownReportContext = {},
): string {
  const verdict = context.verdict;
  const discoveryFindings = context.discoveryFindings ?? [];

  // SLF parity: build the SLF mitigation state ONCE from the report's live
  // session data and hand it to the Findings renderer, so every self-attested
  // card's mitigation is state-aware and identical to the dashboard. Both
  // `oauthScopeVerification` and `localAgentDiscovery` live only on the
  // persisted report.json blob (not the `AuditReport` type), so they're read
  // via a narrow cast — the same pattern `oauthIntrospectionState` uses for
  // `oauthScopeVerification`. The shared builder is the single source of truth:
  // the dashboard's `FindingsBlock` calls the very same function.
  const reportBlob = report as {
    oauthScopeVerification?: { sources?: Array<{ connector?: string; verdict?: string; errorMessage?: string }> };
    localAgentDiscovery?: unknown;
  };
  const slfState = buildSlfMitigationState(
    reportBlob.oauthScopeVerification,
    reportBlob.localAgentDiscovery,
  );

  // AAP-123 (S7) — coded findings + the SLF-finding → legacy-Risk map, built
  // ONCE here so the compliance lens's per-framework SLF sub-lists render real
  // finding cards (code / severity / mitigation), identical to the global
  // Self-Attested stream. `assignFindingCodes` is the SAME pass the global
  // stream runs over the SAME `verdict.findings`, so an SLF-NNN code matches in
  // both places. Empty when no verdict is attached (pre-analyzer markdown
  // write) — the lens then renders controls with no SLF sub-list (no regression).
  const codedVerdictFindings = verdict ? assignFindingCodes(verdict.findings ?? []) : [];
  const slfRiskById = slfRiskByFindingId(verdict?.findings ?? [], report.risks);

  const sections = [
    renderHeader(report, verdict),
    // AAP-79 — interrogation-only banner sits ABOVE the existing
    // Verification Status section so a reader scanning the top of the
    // report cannot miss that the verdict is self-report only. The
    // banner is suppressed once `verification.status === 'verified'`.
    renderInterrogationOnlyBanner(report),
    // AAP-103 — gradient posture indicator. Sits between the
    // interrogation-only banner and the Verification Status section so
    // the reader sees the numeric BR × DS × DM posture immediately
    // after they learn whether deterministic evidence was even
    // collected.
    renderPostureSection(verdict),
    // AAP-63 — Verification Status sits near the top so an auditor sees
    // "deterministic or not?" before reading any findings.
    renderVerificationStatusSection(
      verdict,
      context,
      report.verification?.status,
    ),
    renderScopeAndMethodology(report, context),
    renderSummary(report, verdict, discoveryFindings),
    renderAgentProfile(report),
    // AAP-63 — discrepancies between Surface 1 claims and Surface 2
    // evidence appear above the findings tables so the reviewer is
    // primed to read findings critically.
    renderDiscrepanciesSection(verdict),
    renderLocalDiscoveryExtras(context),
    // AAP-103 — when a verdict is attached, render the new Vijil-style
    // Failure Pattern cards (code + severity + formula hover + implications
    // + mitigations callout). Pre-verdict callers (the initial markdown
    // write before the analyzer finishes) still hit the legacy flat-table
    // path so back-compat with golden tests is preserved.
    verdict
      ? renderFindingsCards(
          report.risks,
          report.compliance as StructuredCompliance | undefined,
          verdict,
          discoveryFindings,
          slfState,
        )
      : renderFindingsSplit(
          report.risks,
          report.compliance as StructuredCompliance | undefined,
          discoveryFindings,
        ),
    renderSystems(report.systems, verdict),
    renderPositiveFindings(report, discoveryFindings),
    renderVerdict(report, discoveryFindings, verdict),
    report.compliance
      ? renderRegulatoryCompliance(
          report.compliance as StructuredCompliance,
          report,
          // AAP-122 — the verdict's self-attested findings feed the per-
          // framework attribution under each lens card.
          // AAP-123 (S7) — pass the FULL coded findings (+ the legacy-Risk map +
          // session state) so each attributed finding renders as a real finding
          // card. Empty when no verdict is attached, so the lens just renders
          // controls with no SLF sub-list — no regression.
          codedVerdictFindings,
          slfRiskById,
          slfState,
        )
      : null,
    report.dataQuality ? renderDataQuality(report.dataQuality) : null,
    renderTranscript(report.transcript),
    renderDisclaimer(),
  ];

  return sections.filter(Boolean).join('\n\n---\n\n');
}

// ─── Header ──────────────────────────────────────────────────────────────────

function renderHeader(report: AuditReport, verdict?: Verdict): string {
  // AAP-103 — header simplified to identification + verification state.
  // The categorical "Risk Level" (low / medium / high / critical) is
  // replaced by the numeric posture indicator in `renderPostureSection`
  // below, anchored on BR × DS × DM (FIPS 199 high-water-mark) rather
  // than the prior heuristic ramp. The verification suffix stays here
  // because it answers a different question — "did Surface 2 actually
  // run?" — orthogonal to the posture number itself.
  const dqPart = report.dataQuality ? ` | **Data Quality**: ${report.dataQuality.score}/100` : '';

  const verificationStatus = report.verification?.status;
  let verificationLine: string;
  if (!verdict && !verificationStatus) {
    verificationLine = '**Verification**: Unverified — no verdict computed';
  } else if (verificationStatus === 'verified') {
    verificationLine = '**Verification**: Verified';
  } else if (verificationStatus === 'partially-verified') {
    verificationLine = '**Verification**: Partial — see Verification Status section';
  } else if (verificationStatus === 'verification-failed') {
    verificationLine = '**Verification**: Failed — see Verification Status section';
  } else {
    // 'interrogation-only' or absent (legacy session pre-AAP-79).
    verificationLine = '**Verification**: Unverified — run discovery to verify';
  }

  // AAP-43 P1 #5: single overall regulatory status label (replaces
  // EU/US/UK matrix). The matrix implied we'd analyzed each jurisdiction,
  // but we don't know the deployer's jurisdiction and only EU-mandatory
  // frameworks are in OSS scope (see AAP-42). A single label + gap counter
  // is honest: "here is the highest unresolved severity across activated
  // frameworks, and how many mandatory vs voluntary gaps there are."
  let regLine = '';
  if (report.compliance) {
    regLine = `\n**Regulatory Status**: ${summarizeOverallStatus(report.compliance as StructuredCompliance)}`;
  }

  // AAP-108 — `**Agent**:` shows the Q1-extracted PRODUCT name (mirrors the
  // dashboard header + the markdown's own Executive Summary prose), not the
  // raw runtime label from `metadata.target`.
  const agentDisplayName = resolveAgentDisplayName(report);

  return `# Agent Access Audit Report

**Generated**: ${report.metadata.date} | **Agent**: ${escapeText(agentDisplayName)} | ${verificationLine}${dqPart}${regLine}`;
}

// ─── Posture indicator (AAP-103) ───────────────────────────────────────────

/**
 * Render the BR × DS × DM posture indicator that sits near the top of
 * the report. Replaces the prior categorical "Risk Level: MEDIUM" with
 * a numeric posture (one of 9 stops) + a band label + per-band counts
 * across the verdict's Verified findings.
 *
 * Markdown surface caveat: a real CSS gradient bar lives in the HTML
 * renderer and the dashboard React. The markdown form renders an ASCII
 * stop ladder ("1 · 1.5 · 2 · 3 · ⟨4⟩ · 4.5 · 6 · 9 · 13.5") with the
 * marker stop wrapped in angle brackets, plus a "you are here at <pct>%
 * along the bar" annotation. That keeps the indicator legible even when
 * the markdown body is rendered in a plaintext viewer (one common
 * compliance-officer workflow).
 *
 * AAP-108 (mirrors AAP-106 G9 / AAP-107 on the dashboard): posture is
 * RISK-BASED. It is the FIPS-199 high-water-mark of the per-system
 * deployment risk and any verified-discrepancy severity. So an honest
 * agent (declared == actual, 0 verified discrepancies) with a real risk
 * surface still reads as a genuine band rather than "No Verified
 * findings". The counts half states the discrepancy status separately
 * ("no discrepancies" / "N discrepancies") and, when risk is sourced from
 * the systems surface, says "Risk from N systems" instead of the raw
 * "No verified findings" bucket line. Only a genuine no-scan, no-risk
 * verdict (posture 0, nothing scored) reads "No Verified findings".
 */
function renderPostureSection(verdict: Verdict | undefined): string {
  if (!verdict) return '';

  const posture = verdict.posture ?? 0;
  const band = verdict.postureBand ?? 'informational';
  const bandLabel = SEVERITY_BAND_LABEL[band];

  // Build the ASCII ladder. Wrap the active stop with brackets so the
  // marker is visible in plain text.
  const markerStop = nearestStop(posture);
  const ladder = SEVERITY_STOPS.map((s) => {
    const label = formatSeverityNumber(s);
    return s === markerStop ? `⟨${label}⟩` : label;
  }).join(' · ');

  // G9 — count VERIFIED DISCREPANCY findings (evidenceSource !== 'SLF'),
  // and whether the systems-risk pass scored any systems. Same signals the
  // dashboard's HeaderBlock reads.
  const verifiedDiscrepancyCount = (verdict.findings ?? []).filter(
    (f) => f.evidenceSource !== 'SLF',
  ).length;
  const systemsScored = verdict.systemsRisk?.systems?.length ?? 0;
  const scanned =
    (verdict.systemsRisk?.scanned ?? false) ||
    (verdict.status !== undefined && verdict.status !== 'unverified');

  const discrepancySubNote =
    verifiedDiscrepancyCount === 0
      ? 'no discrepancies'
      : `${verifiedDiscrepancyCount} discrepanc${verifiedDiscrepancyCount === 1 ? 'y' : 'ies'}`;

  // Counts half. When risk is sourced from the systems surface (posture
  // > 0 with zero verified discrepancies), name the systems instead of
  // the empty "No verified findings" bucket line — the latter reads as a
  // contradiction next to a Medium headline.
  const counts = countVerifiedByBucket(verdict.findings ?? []);
  const countsLine =
    verifiedDiscrepancyCount === 0 && posture > 0 && systemsScored > 0
      ? `Risk from ${systemsScored} system${systemsScored === 1 ? '' : 's'}  ·  ${discrepancySubNote}`
      : renderBucketCountsLine(counts);

  let postureText: string;
  if (posture > 0) {
    postureText = `${formatSeverityNumber(posture)} ${bandLabel} risk`;
  } else if (scanned) {
    // Scan ran, low/no blast radius, no discrepancies — honest clean state,
    // NOT "no findings" (which read as "discovery never ran").
    postureText = 'Low risk';
  } else {
    // Genuine no-evidence baseline: nothing scanned, nothing scored.
    postureText = 'No Verified findings';
  }

  // G9 anchor copy: posture reflects deployment risk (per-system blast
  // radius x sensitivity) aggregated with any verified discrepancy via the
  // FIPS 199 high-water-mark rule. Do NOT imply the agent is clean or that
  // discovery has not run. NO em-dashes.
  const anchorNote =
    'Posture reflects deployment risk across the declared systems (blast radius and data sensitivity), aggregated with any verified declared-vs-actual discrepancy via the FIPS 199 high-water-mark rule (max severity, not average). Self-attested findings render below but do not move the gradient.';

  const lines = [
    '## Posture',
    '',
    `**Posture**: ${postureText}  ·  ${countsLine}`,
    '',
    '```',
    `Severity gradient (1 = lowest, 13.5 = highest):`,
    `  ${ladder}`,
    `  ^---- Posture marker`,
    '```',
    '',
    `_${anchorNote}_`,
  ];
  return lines.join('\n');
}


// ─── AAP-79 — interrogation-only banner ────────────────────────────────────

/**
 * Render a prominent banner near the top of the markdown report when
 * `verification.status === 'interrogation-only'` (or the older format
 * that omits the field entirely). The banner uses a fenced ASCII frame
 * so it survives reader-side markdown stripping (e.g. plaintext export)
 * and stays visible on the dashboard's markdown fallback path.
 *
 * The 'verification-failed' state renders a separate failure banner so
 * the operator sees the reason the scan errored and can retry.
 *
 * When `verification.status === 'verified'`, the banner is suppressed
 * — the upstream `sections.filter(Boolean)` drops the empty string.
 */
function renderInterrogationOnlyBanner(report: AuditReport): string {
  const status = report.verification?.status;
  if (status === 'verified') return '';
  if (status === 'partially-verified') {
    // AAP-80 — amber banner copy. Used when at least one Surface 2
    // source ran (so we're past interrogation-only) but the verdict
    // came back `partial`. Distinguished from 'verification-failed' so
    // the reader knows the report carries SOME deterministic evidence;
    // they just shouldn't treat it as fully reconciled.
    return [
      '> **Partially verified.** One or more deterministic evidence sources did ' +
        'not run or did not complete cleanly. See the **Verification Status** ' +
        'section below for per-source detail.',
      '>',
      '> Resolve outstanding findings or rerun with any missing or failed ' +
        'sources available to flip this banner to **Verified**.',
    ].join('\n');
  }
  if (status === 'verification-failed') {
    const reason = report.verification?.reason ?? 'see dashboard for details';
    return [
      '> **Verification failed.** Discovery could not complete for this session.',
      `> Reason: ${escapeInlineCode(reason)}`,
      '>',
      '> The report below remains based on the interview only. Retry verification ' +
        'via the dashboard or by re-calling `start_verification` from the agent host.',
    ].join('\n');
  }
  // Default = 'interrogation-only' or undefined (legacy session pre-AAP-79).
  return [
    '> **This report is based on the interview only.** Run verification to ' +
      'confirm declared scope against deterministic evidence ' +
      '(MCP configs, plugin / skill / auth credential names, .env files: names only).',
    '>',
    '> Verified runs flip this banner off and re-compute the framework mapping ' +
      'with the discovery evidence merged in. Call `start_verification` from the ' +
      'agent host, or click **Run verification** in the dashboard.',
  ].join('\n');
}

// ─── Scope & Methodology ────────────────────────────────────────────────────

/**
 * AAP-93 H1 — `Limitations` text is conditional on
 * `report.verification.status`. Pre-fix the line always claimed "based
 * solely on self-reported information / no runtime analysis", which
 * contradicted itself once Surface 2 had run (the same report carried
 * 10 deterministic findings AND a Verification Status table showing
 * filesystem discovery ran). Each lifecycle state now picks the text
 * that is honest at that state.
 *
 * Codex post-review fix (P2 #1): partial verification can mean
 * either filesystem-only (OAuth skipped) OR OAuth-only (filesystem
 * skipped via the `skipFilesystem: true` dashboard path). The text
 * inspects the per-source status when partially-verified so the
 * methodology actually agrees with the Verification Status table.
 */
/**
 * AAP-108 — OAuth introspection state, derived off the SAME canonical
 * field the dashboard reads (`report.oauthScopeVerification.sources`) and
 * the markdown's own Verification Status table reads. Mirrors the
 * dashboard's `buildSlfMitigationState` OAuth derivation:
 *
 *   - `attempted` once at least one introspection source exists (the agent
 *     forwarded its tokeninfo via `report_oauth_scopes` this run).
 *   - `failed` when an attempted source did NOT come back `verified` —
 *     either it carries an `errorMessage` (e.g. an `introspection-error:
 *     ... invalid_token ...` provider rejection) or its `verdict` is
 *     anything other than 'verified'.
 *
 * The explicit per-provider `context.oauthIntrospectionStatus` rows are
 * also honoured (a `ran` row means attempted), so callers that thread
 * concrete statuses still drive the line. When neither signal is present
 * the source genuinely did not run -> `attempted` stays false and the
 * caller keeps the "skipped" copy.
 */
interface OAuthIntrospectionState {
  attempted: boolean;
  failed: boolean;
}

function oauthIntrospectionState(
  report: AuditReport,
  context: RenderMarkdownReportContext,
): OAuthIntrospectionState {
  const sources =
    (report as {
      oauthScopeVerification?: {
        sources?: Array<{ verdict?: string; errorMessage?: string }>;
      };
    }).oauthScopeVerification?.sources ?? [];
  const sourcesAttempted = sources.length > 0;
  const sourcesFailed = sources.some(
    (s) => !!s.errorMessage || (s.verdict !== undefined && s.verdict !== 'verified'),
  );

  const oauthRows = context.oauthIntrospectionStatus ?? [];
  const rowsAttempted = oauthRows.some(
    (r) => normalizeStatus(r.status, r.reason).status === 'ran',
  );
  const rowsFailed = oauthRows.some(
    (r) => normalizeStatus(r.status, r.reason).status === 'failed',
  );

  return {
    attempted: sourcesAttempted || rowsAttempted,
    failed: sourcesFailed || rowsFailed,
  };
}

function limitationsTextForVerification(
  report: AuditReport,
  context: RenderMarkdownReportContext = {},
): string {
  const status = report.verification?.status;
  switch (status) {
    case 'verified':
      return "Combines self-reported interview answers with filesystem discovery and OAuth scope introspection. Runtime behaviour, code review, and network traffic remain out of scope. Findings should be verified against actual system configurations.";
    case 'partially-verified': {
      // Inspect per-source state. `discoveryStatus` defaults to 'ran'
      // (legacy behaviour). OAuth state is driven off the canonical
      // `oauthScopeVerification` field (plus any explicit per-provider
      // rows) so the line agrees with the Verification Status table and
      // the dashboard — it only says "skipped" when introspection truly
      // did not run.
      const fsStatus = normalizeStatus(context.discoveryStatus ?? 'ran').status;
      const oauth = oauthIntrospectionState(report, context);
      const oauthRan = oauth.attempted;
      const fsRan = fsStatus === 'ran';
      // AAP-108 — attempted-but-failed clause (e.g. the provider rejected
      // an expired/invalid token). NO em-dashes.
      const oauthFailedClause =
        'OAuth introspection attempted, failed (see Verification Status section). Refresh the token and re-run so granted scopes can be diffed against declared usage.';
      if (fsRan && oauthRan && oauth.failed) {
        return `Combines self-reported interview answers with filesystem discovery. ${oauthFailedClause} Runtime behaviour, code review, and network traffic remain out of scope.`;
      }
      if (fsRan && oauthRan) {
        return 'Combines self-reported interview answers with filesystem discovery and OAuth scope introspection (partial coverage — see Verification Status section). Runtime behaviour, code review, and network traffic remain out of scope.';
      }
      if (oauthRan && !fsRan && oauth.failed) {
        return `Combines self-reported interview answers with filesystem discovery skipped. ${oauthFailedClause} Runtime behaviour, code review, and network traffic remain out of scope.`;
      }
      if (oauthRan && !fsRan) {
        return 'Combines self-reported interview answers with OAuth scope introspection. Filesystem discovery skipped — runtime behaviour, code review, and network traffic remain out of scope. Findings should be verified against actual system configurations.';
      }
      if (fsRan && !oauthRan) {
        return 'Combines self-reported interview answers with filesystem discovery. OAuth introspection skipped — runtime behaviour, code review, and network traffic remain out of scope. Findings should be verified against actual system configurations.';
      }
      // Neither source actually ran but report flipped to partial —
      // honest fallback.
      return 'Verification was attempted but no deterministic source completed cleanly. See Verification Status section.';
    }
    case 'verification-failed':
      return 'Verification attempted but did not complete cleanly. See the Verification Status section below. The report below remains based on the interview only and should be re-verified once the underlying source is reachable.';
    case 'interrogation-only':
    default:
      return "This assessment is based solely on the agent's self-reported information. No runtime analysis, code review, or network traffic inspection was performed. Findings should be verified against actual system configurations.";
  }
}

function renderScopeAndMethodology(
  report: AuditReport,
  context: RenderMarkdownReportContext = {},
): string {
  return `## Scope & Methodology

**Assessment type**: Automated structured interview

**Method**: Heron conducted a ${report.metadata.questionsAsked}-question interview covering agent purpose, data access, permissions, write operations, and operational frequency. **Duration**: ${Math.round(report.metadata.interviewDuration / 1000)}s.

**Limitations**: ${limitationsTextForVerification(report, context)}`;
}

// ─── Data Quality Badge ──────────────────────────────────────────────────────

function renderDataQuality(dq: DataQuality): string {
  const provided = dq.fieldsProvided.length;
  const total = provided + dq.fieldsMissing.length;
  // AAP-88: thresholds `templates_dataQuality_goodBoundary` = 70 and
  // `templates_dataQuality_partialBoundary` = 40 documented in
  // src/verification/threshold-manifest.ts.
  const qualityLabel = dq.score >= 70 ? 'Good' : dq.score >= 40 ? 'Partial' : 'Poor';

  const fieldDescriptions: Record<string, string> = {
    systemId: 'External systems connected (name, API type, auth)',
    scopesRequested: 'Permissions/scopes granted to the agent',
    dataSensitivity: 'Data classification (PII, financial, etc.)',
    blastRadius: 'Scope of impact if something goes wrong',
    frequencyAndVolume: 'How often it runs, API calls per run',
    writeOperations: 'What the agent creates, modifies, or deletes',
    reversibility: 'Whether write operations can be undone',
  };

  const rows = [
    ...dq.fieldsProvided.map(f => `| ${f} | ${fieldDescriptions[f] ?? ''} | Provided |`),
    ...dq.fieldsMissing.map(f => `| ${f} | ${fieldDescriptions[f] ?? ''} | **NOT PROVIDED** |`),
  ];

  let warning = '';
  if (dq.repeatedAnswers > 0) {
    warning = `\n\n> **Warning**: ${dq.repeatedAnswers} of ${dq.totalQuestions} answers were repeated/canned responses. Data in this report may be incomplete.`;
  }

  return `## Data Quality: ${qualityLabel} (${provided}/${total} fields) ${warning}

| Field | What it measures | Status |
|-------|-----------------|--------|
${rows.join('\n')}`;
}

// ─── Summary ─────────────────────────────────────────────────────────────────

/**
 * AAP-93 H3 — count Surface 2 findings by severity for the Executive
 * Summary's "Deterministic findings" stream. `DiscoveryFinding` uses
 * the upper-case ladder (HIGH / MEDIUM / LOW); the summary table
 * renders them in title case alongside the analyzer's stream.
 *
 * Codex round 7 P2 — on the OAuth-only path discoveryFindings is
 * empty but OAuth diffs (the verdict's `discrepancies` array — kept
 * loose-typed via DiscoveryFinding-shaped rows from
 * persist-verified-markdown.ts callers — OR a deterministicRiskLevel
 * lift on the verdict) still represent Surface 2 evidence. The
 * summary now respects a `verdict.deterministicRiskLevel` lift even
 * when discoveryFindings is empty: when the verdict says HIGH/CRITICAL
 * but the per-row stream is empty, we surface "see Verification
 * Status" instead of "None" so the cell doesn't lie.
 */
function countDeterministicFindings(
  discoveryFindings: ReadonlyArray<DiscoveryFinding>,
): { critical: number; high: number; medium: number; low: number } {
  const out = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of discoveryFindings) {
    switch (f.severity) {
      case 'HIGH':
        out.high++;
        break;
      case 'MEDIUM':
        out.medium++;
        break;
      case 'LOW':
        out.low++;
        break;
      case 'INFO':
        out.low++;
        break;
    }
  }
  return out;
}

/**
 * report parity (fix B) — count SELF-REPORTED findings by their COMPUTED
 * severity band for the Executive Summary's "Self-reported findings" cell.
 *
 * The dashboard renders each self-attested finding card with its computed
 * `verdict.findings[].band` (the analyzer's BR × DS × DM result), not the
 * raw LLM `risk.severity`. The summary cell must agree with those cards.
 *
 * Self-attested == SLF-sourced verdict findings (same `evidenceSource ===
 * 'SLF'` split the dashboard uses for its self-attested stream). We map each
 * band onto the 4 customer-facing buckets via `bucketForBand` (informational
 * folds into low) and tally.
 *
 * Fallback: when the verdict is absent or carries no `findings` array (older
 * report.json on disk, or a pre-verdict render), count the RAW
 * `report.risks[].severity` so legacy reports keep their prior behaviour.
 */
function countSelfReportedByBand(
  risks: ReadonlyArray<Risk>,
  verdict?: Verdict,
): { critical: number; high: number; medium: number; low: number } {
  const out = { critical: 0, high: 0, medium: 0, low: 0 };
  const findings = verdict?.findings;
  if (findings) {
    for (const f of findings) {
      if (f.evidenceSource !== 'SLF') continue;
      out[bucketForBand(f.band)]++;
    }
    return out;
  }
  // Legacy fallback — raw self-reported severities.
  for (const r of risks) {
    switch (r.severity) {
      case 'critical':
        out.critical++;
        break;
      case 'high':
        out.high++;
        break;
      case 'medium':
        out.medium++;
        break;
      case 'low':
        out.low++;
        break;
    }
  }
  return out;
}

function formatFindingsCount(counts: {
  critical: number;
  high: number;
  medium: number;
  low: number;
}): string {
  const parts: string[] = [];
  if (counts.critical > 0) parts.push(`${counts.critical} Critical`);
  if (counts.high > 0) parts.push(`${counts.high} High`);
  if (counts.medium > 0) parts.push(`${counts.medium} Medium`);
  if (counts.low > 0) parts.push(`${counts.low} Low`);
  if (parts.length === 0) parts.push('None');
  return parts.join(', ');
}

function renderSummary(
  report: AuditReport,
  verdict?: Verdict,
  discoveryFindings: ReadonlyArray<DiscoveryFinding> = [],
): string {
  // AAP-93 H3 — self-reported counts come from the analyzer's `risks`
  // array. Deterministic counts come from the Surface 2 discovery
  // findings passed through render context. Pre-fix the summary
  // collapsed everything into a single "Findings" cell driven by
  // `report.risks` alone — which dropped the 10 discovery MEDIUMs the
  // Findings section below was actively rendering. The two streams
  // are different evidence sources; collapsing them undercounted in
  // the reviewer's eye.
  // report parity (fix B) — the self-reported count must show the COMPUTED
  // band of each self-attested finding, matching the dashboard's finding
  // cards (which render `verdict.findings[].band`). `report.risks[].severity`
  // is the RAW LLM self-report and over-states (e.g. 'high' where the
  // computed band is 'medium'), so counting it drifted the summary above the
  // cards. The self-attested stream is exactly the SLF-sourced verdict
  // findings (same `evidenceSource === 'SLF'` split the dashboard uses), so
  // we count those by `.band`. When the verdict carries no `findings` array
  // (older / edge report.json), fall back to the raw `report.risks` severities
  // so legacy reports keep their prior count.
  const selfReportedCounts = countSelfReportedByBand(report.risks, verdict);
  const deterministicCounts = countDeterministicFindings(discoveryFindings);
  const selfReportedFindings = formatFindingsCount(selfReportedCounts);
  // Codex round 7 P2 — if the verdict's deterministicRiskLevel is
  // HIGH/CRITICAL but the per-row stream is empty (OAuth-only path),
  // the "None" cell would lie. Pivot to a "see Verification Status"
  // pointer so the cell doesn't undersell deterministic evidence.
  const allZero =
    deterministicCounts.critical === 0 &&
    deterministicCounts.high === 0 &&
    deterministicCounts.medium === 0 &&
    deterministicCounts.low === 0;
  const verdictDeterministicRaised =
    verdict?.deterministicRiskLevel === 'high' ||
    verdict?.deterministicRiskLevel === 'critical' ||
    verdict?.deterministicRiskLevel === 'medium';
  const deterministicFindings =
    allZero && verdictDeterministicRaised
      ? `See Verification Status (${verdict!.deterministicRiskLevel!.toUpperCase()} verdict)`
      : formatFindingsCount(deterministicCounts);

  // AAP-93 H4 — Systems count now reflects every category, not only
  // the business filter. A `5 systems (3 business, 1 host runtime, 1
  // audit infrastructure)` summary makes the categorisation visible
  // at a glance. Pre-fix this rendered "1" for the codex audit case
  // because everything else was silently filtered.
  const systemsByCategory = groupSystemsByCategory(report.systems);
  const businessCount = systemsByCategory.get('business')?.length ?? 0;
  const auditCount = systemsByCategory.get('audit-infrastructure')?.length ?? 0;
  const hostCount = systemsByCategory.get('host-runtime')?.length ?? 0;
  const unknownCount = systemsByCategory.get('unknown')?.length ?? 0;
  const totalSystems = businessCount + auditCount + hostCount + unknownCount;
  const breakdownParts: string[] = [];
  if (businessCount > 0) breakdownParts.push(`${businessCount} business`);
  if (hostCount > 0) breakdownParts.push(`${hostCount} host runtime`);
  if (auditCount > 0) breakdownParts.push(`${auditCount} audit infra`);
  if (unknownCount > 0) breakdownParts.push(`${unknownCount} other`);
  const systemsCell =
    breakdownParts.length > 1
      ? `${totalSystems} (${breakdownParts.join(', ')})`
      : String(totalSystems);

  // AAP-93 H3 — split Findings cell into Deterministic + Self-reported.
  let dashboard: string;
  if (verdict) {
    const verifiedCell =
      verdict.primaryRiskSource === 'deterministic'
        ? `**${(verdict.deterministicRiskLevel ?? 'unknown').toUpperCase()}**`
        : '**UNVERIFIED**';
    const selfReportedCell = verdict.interviewRiskLevel
      ? `_${verdict.interviewRiskLevel.toUpperCase()} (self-report only)_`
      : '_n/a_';
    dashboard = `| Verified Risk | Self-reported Risk | Systems | Deterministic findings | Self-reported findings |
|------|------|---------|---------|---------|
| ${verifiedCell} | ${selfReportedCell} | ${systemsCell} | ${deterministicFindings} | ${selfReportedFindings} |`;
  } else {
    dashboard = `| Risk | Systems | Deterministic findings | Self-reported findings |
|------|---------|---------|---------|
| **${report.overallRiskLevel.toUpperCase()}** | ${systemsCell} | ${deterministicFindings} | ${selfReportedFindings} |`;
  }

  let methodology = '';
  if (report.compliance) {
    const c = report.compliance as StructuredCompliance;
    const activated = ((c as any).frameworksActivated ?? []) as string[];
    const names = activated.map(id => frameworkShortName(id)).filter(Boolean);
    const fwList = names.length > 0 ? names.join(', ') : 'see Regulatory Compliance section';
    methodology = `\n\n> **Risk methodology** anchored to ${names.length} frameworks: ${fwList}. Mapping version: \`${c.mappingVersion}\`.`;
  }

  return `## Executive Summary

${dashboard}${methodology}

${report.summary}`;
}

// ─── Agent Profile ───────────────────────────────────────────────────────────

/**
 * AAP-64 — Property/Value 2-column table (Vijil-style), replacing the
 * earlier bullet list. The Property column is the small uppercase label;
 * the Value column carries the readable value. Identifiers (URLs, IDs)
 * are wrapped in backticks so markdown renderers render them in mono;
 * prose values are plain text.
 *
 * Rows are emitted in a stable order so a reader scanning multiple
 * reports finds the same fields in the same place.
 */
function renderAgentProfile(report: AuditReport): string {
  // AAP-108 — Agent name shows the Q1-extracted PRODUCT name (same source
  // the dashboard's HeaderBlock and the markdown header use), NOT the raw
  // runtime label in `metadata.target`. `resolveAgentDisplayName` already
  // falls back through report.json's stamped name → on-the-fly extraction →
  // the runtime label, so a legacy report still renders a value.
  const agentName = resolveAgentDisplayName(report);

  // First business system summary string — short identifier + truncated
  // description if present (description is also rendered on the per-system
  // block below; the agent profile only carries a one-line summary).
  const firstSys = report.systems[0];
  const systemSummary = firstSys
    ? firstSys.systemDescription && firstSys.systemDescription.trim().length > 0
      ? firstSys.systemDescription.trim().split(/\.(\s|$)/)[0].trim()
      : firstSys.systemId
    : undefined;

  const rows: Array<[string, string]> = [];
  rows.push(['Agent name', `\`${agentName}\``]);
  if (systemSummary) rows.push(['System', systemSummary]);
  if (isProvided(report.agentOwner)) rows.push(['Owner', report.agentOwner]);
  if (report.agentTrigger) rows.push(['Trigger', report.agentTrigger]);
  rows.push(['Purpose', report.agentPurpose]);

  return `## Agent Profile

| Property | Value |
|----------|-------|
${rows.map(([k, v]) => `| ${k} | ${escapeCell(v)} |`).join('\n')}`;
}

// ─── Per-System Cards ────────────────────────────────────────────────────────

/**
 * AAP-93 H4 — group every assessed system by `categorizeSystem` rather
 * than silently filtering everything that isn't `'business'`. Returns
 * a Map keyed on category in stable iteration order
 * (`business → host-runtime → audit-infrastructure → unknown`). Pre-fix
 * this was an in-place `.filter(isBusinessSystem)` that dropped audit
 * tooling, host runtime, and any unrecognised system from the report.
 */
function groupSystemsByCategory(
  systems: SystemAssessment[],
): Map<SystemCategory, SystemAssessment[]> {
  const out = new Map<SystemCategory, SystemAssessment[]>();
  out.set('business', []);
  out.set('host-runtime', []);
  out.set('audit-infrastructure', []);
  out.set('unknown', []);
  for (const s of systems) {
    const cat = categorizeSystem(s);
    out.get(cat)!.push(s);
  }
  return out;
}

function renderSystems(
  systems: SystemAssessment[],
  verdict?: Verdict,
): string {
  const grouped = groupSystemsByCategory(systems);

  // report parity (fix A) — index the persisted per-system risk snapshot by
  // `systemId` so each card header can show the SAME risk the dashboard's
  // Severity column shows (`verdict.systemsRisk.systems[]`). This is the
  // authoritative posture-aligned per-system risk; the prior
  // `computeSystemRisk` heuristic disagreed with the posture math and was
  // not what the dashboard rendered. Absent verdict / snapshot row -> the
  // card degrades to no risk label (see renderSystemCard).
  const riskBySystemId = new Map<string, SystemRiskResult>();
  for (const row of verdict?.systemsRisk?.systems ?? []) {
    riskBySystemId.set(row.systemId, row);
  }

  // AAP-93 H4/H5 — render every non-empty category. The Systems section
  // is the audit's structural surface; hiding categories made the
  // Findings section's HERON-001 (unrestricted local shell + file
  // writes) "float" with nowhere to attach.
  const sections: string[] = [];
  for (const [cat, list] of grouped) {
    if (list.length === 0) continue;
    const label = systemCategoryLabel(cat);
    const rationale = systemCategoryRationale(cat);
    const cards = list
      .map((sys) => renderSystemCard(sys, riskBySystemId.get(sys.systemId)))
      .join('\n\n');
    sections.push(`### ${label}\n\n_${rationale}_\n\n${cards}`);
  }

  if (sections.length === 0) {
    return `## Systems & Access

No systems were identified in the interview.`;
  }

  // AAP-93 H6 — single-line explanation of how per-system risk relates
  // to overall risk. Pre-fix the systems table could show `Risk: LOW`
  // for every system while the header carried `Risk Level: MEDIUM`,
  // with no clarification of why those two fields don't track each
  // other. The note below grounds the disconnect: per-system risk is
  // access-pattern only; overall risk also reads agent-behaviour
  // findings. See Verdict & Recommendations for aggregation.
  const explanation =
    "_Per-system risk shown below scores the system's own access pattern (blast radius + excessive scopes + irreversible writes + data sensitivity). Overall deployment risk also incorporates findings about the agent's behaviour around the system and the verification verdict. See **Verdict & Recommendations** for aggregation._";

  return `## Systems & Access

${explanation}

${sections.join('\n\n')}`;
}

/**
 * AAP-64 — per-system Property/Value table (Vijil-style). Replaces the
 * anonymous `| | |` 2-column shape with a named header so a markdown
 * reader (and downstream PDF exporters) can render it as a real table.
 *
 * The structured `frequency` object expands into its own
 * "Frequency dimension | Value" sub-table BELOW the main table when
 * present; pre-AAP-65 sessions that only carry the prose
 * `frequencyAndVolume` string get a single Frequency row in the main
 * table, tagged "(legacy shape)" so a reviewer knows it isn't the
 * canonical structured form.
 */
function renderSystemCard(
  sys: SystemAssessment,
  riskRow?: SystemRiskResult,
): string {
  const rows: Array<[string, string]> = [];

  // System short-id (mono, identifier) — separate from the long
  // systemDescription that lives in the main "System" row.
  rows.push(['System ID', `\`${sys.systemId}\``]);

  if (isProvided(sys.dataSensitivity)) {
    rows.push(['Data sensitivity', sys.dataSensitivity]);
  } else {
    rows.push(['Data sensitivity', `_${UNKNOWN_PLACEHOLDER}_`]);
  }

  rows.push(['Blast radius', sys.blastRadius]);

  // Scopes
  const scopes = sys.scopesRequested.filter(isProvided);
  const needed = sys.scopesNeeded.filter(isProvided);

  // AAP-65 — clean defense-in-depth strip for old persisted shapes (the
  // analyzer's sanitizeAnalyzerOutput already removes these prefixes on
  // ingest for new sessions).
  const cleanScope = (s: string): string =>
    s
      .replace(/^\s*Unused in this(?:\s+(?:audit\s+task|task))?\s+so\s+far\s*:?\s*/i, '')
      .replace(/^\s*Unused (?:in this )?(?:audit )?task(?:\s+so\s+far)?\s*:?\s*/i, '')
      .replace(/\s*\(A\d+\)\s*\.?\s*$/i, '')
      .trim() || s;
  const excessive = sys.scopesDelta.filter(isProvided).map(cleanScope);

  // AAP-69: non-OAuth systems (public web search, scraping, foundation-model
  // calls, etc.) legitimately have no scopes to enumerate. Render an explicit
  // "platform-mediated" row instead of three "Unknown" placeholders that
  // read as "did Heron forget to analyze this?".
  const isPlatformMediated =
    scopes.length === 0 && needed.length === 0 && excessive.length === 0;

  if (isPlatformMediated) {
    rows.push(['Scopes granted', '_Platform-mediated access — no OAuth scopes_']);
  } else {
    rows.push([
      'Scopes granted',
      scopes.length > 0 ? scopes.join(', ') : `_${UNKNOWN_PLACEHOLDER}_`,
    ]);
    if (needed.length > 0) {
      rows.push(['Scopes needed', needed.join(', ')]);
    }
    if (excessive.length > 0) {
      rows.push(['Excessive', excessive.join(', ')]);
    }
  }

  // Frequency — legacy fallback only. Structured frequency renders below.
  const freq = sys.frequency;
  const hasStructuredFreq =
    !!freq &&
    (freq.runsLastWeek !== undefined ||
      !!freq.callsPerRun ||
      freq.batchSize !== undefined ||
      !!freq.concurrency ||
      !!freq.notes);
  if (!hasStructuredFreq) {
    if (isProvided(sys.frequencyAndVolume)) {
      rows.push(['Frequency', `${sys.frequencyAndVolume} _(legacy shape)_`]);
    } else {
      rows.push(['Frequency', `_${UNKNOWN_PLACEHOLDER}_`]);
    }
  }

  // Write operations — keep the per-write summary inline.
  if (sys.writeOperations.length > 0) {
    const writesSummary = sys.writeOperations
      .map(w => {
        const rev = w.reversible ? 'reversible' : '**irreversible**';
        return `${w.operation} → ${w.target} (${rev}, ${w.volumePerDay})`;
      })
      .join('; ');
    rows.push(['Writes', writesSummary]);
  }

  if (sys.sources && sys.sources.length > 0) {
    rows.push(['Sources', sys.sources.join(', ')]);
  }

  // Optional descriptive paragraph above the table — italicised body text.
  const descriptionLine =
    sys.systemDescription && sys.systemDescription.trim().length > 0
      ? `\n\n_${sys.systemDescription.trim()}_\n`
      : '';

  // Build the main Property | Value table.
  const mainTable = `| Property | Value |
|----------|-------|
${rows.map(([k, v]) => `| ${k} | ${escapeCell(v)} |`).join('\n')}`;

  // Optional structured-frequency sub-table.
  let freqTable = '';
  if (hasStructuredFreq && freq) {
    const freqRows: Array<[string, string]> = [];
    if (freq.runsLastWeek !== undefined) {
      freqRows.push([
        'Runs last week',
        freq.runsLastWeek === null ? 'not observable' : String(freq.runsLastWeek),
      ]);
    }
    if (freq.callsPerRun) freqRows.push(['Calls per run', freq.callsPerRun]);
    if (freq.batchSize !== undefined) freqRows.push(['Batch size', String(freq.batchSize)]);
    if (freq.concurrency) freqRows.push(['Concurrency', freq.concurrency]);
    if (freq.notes) freqRows.push(['Notes', freq.notes]);

    freqTable = `\n\n| Frequency dimension | Value |
|---------------------|-------|
${freqRows.map(([k, v]) => `| ${k} | ${escapeCell(v)} |`).join('\n')}`;
  }

  // report parity (fix A) — header risk label is sourced from the persisted
  // per-system snapshot (`verdict.systemsRisk.systems[]`), matching the
  // dashboard's Risk column ("<severity> (<band>)", e.g. "6 (Medium)").
  // When this system has no matching snapshot row (no verdict, or a system
  // the risk pass did not score) we omit the risk label rather than fall
  // back to a heuristic that disagrees with the posture math.
  const riskLabel = riskRow
    ? ` — Risk: ${formatSeverityNumber(riskRow.severity)} (${SEVERITY_BAND_LABEL[riskRow.band]})`
    : '';

  return `### ${sys.systemId}${riskLabel}${descriptionLine}

${mainTable}${freqTable}`;
}

// ─── Findings ───────────────────────────────────────────────────────────────

/**
 * Infer which compliance finding type best matches a risk by keyword matching
 * on the risk's title and description. Returns the top-matching finding type
 * or undefined if no strong match.
 */
function inferFindingType(risk: Risk): string | undefined {
  const text = `${risk.title} ${risk.description}`.toLowerCase();
  if (/permission|scope|access.?control|excessive|least.?privilege|oauth/i.test(text)) return 'excessive-access';
  if (/write|irreversible|delete|create|modify|append/i.test(text)) return 'write-risk';
  if (/pii|personal.?data|sensitive|privacy|data.?protection/i.test(text)) return 'sensitive-data';
  if (/scope.?creep|purpose.?limit|beyond.*need|unnecessary/i.test(text)) return 'scope-creep';
  if (/classif|decision|scor|rank|profil|bias|discriminat/i.test(text)) return 'decisions-about-people';
  if (/regulat|compliance|health|sector/i.test(text)) return 'regulatory-flags';
  return undefined;
}

/**
 * Get framework basis string for a finding type from the compliance flags.
 * Returns top 3 mandatory framework controls, formatted as "GDPR Art. 25, EU AI Act Art. 10".
 *
 * AAP-88: threshold `templates_getFrameworkBasis_topN` = 3 documented in
 * src/verification/threshold-manifest.ts.
 */
function getFrameworkBasis(findingType: string, compliance?: StructuredCompliance): string {
  if (!compliance) return '—';

  const flags = (compliance.all as TypedRegulatoryFlag[]).filter(
    (f: TypedRegulatoryFlag) => f.triggeredBy === findingType && f.tier === 'mandatory',
  );

  if (flags.length === 0) {
    // Try voluntary if no mandatory
    const volFlags = (compliance.all as TypedRegulatoryFlag[]).filter(
      (f: TypedRegulatoryFlag) => f.triggeredBy === findingType,
    );
    if (volFlags.length === 0) return '—';
    // AAP-88: top-N = 3 — see templates_getFrameworkBasis_topN.
    return volFlags.slice(0, 3).map(f => `${f.frameworkId === 'eu-ai-act' ? 'EU AI Act' : f.framework.split(' — ')[0]}`).join(', ');
  }

  // Show top 3 mandatory, framework name + first control ID
  // AAP-88: top-N = 3 — see templates_getFrameworkBasis_topN.
  return flags.slice(0, 3).map(f => {
    const name = f.frameworkId === 'eu-ai-act' ? 'EU AI Act' : f.framework.split(' — ')[0];
    const ctrl = (f.controlIds ?? [])[0] ?? '';
    return ctrl ? `${name} ${ctrl}` : name;
  }).join(', ');
}

function renderFindings(risks: Risk[], compliance?: StructuredCompliance): string {
  if (risks.length === 0) {
    return `## Findings\n\n_No risks identified._`;
  }

  // AAP-88: severity rank mapping `templates_severityOrder_rankMapping`
  // (critical=4 > high=3 > medium=2 > low=1 > default=0) drives the sort;
  // see src/verification/threshold-manifest.ts.
  const sorted = [...risks].sort((a, b) => severityOrder(b.severity) - severityOrder(a.severity));

  const renderRow = (r: Risk, i: number): string => {
    const id = `HERON-${String(i + 1).padStart(3, '0')}`;
    const findingType = inferFindingType(r);
    const basis = findingType ? getFrameworkBasis(findingType, compliance) : '—';
    const remediation = r.mitigation ?? '—';
    return `| ${id} | ${r.severity.toUpperCase()} | ${basis} | ${r.title} | ${r.description} | ${remediation} |`;
  };

  const tableHeader = `| ID | Severity | Framework Basis | Finding | Description | Recommendation |
|----|----------|-----------------|---------|-------------|----------------|`;

  // AAP-43 P2 #7: Top-N triage. A flat 4+ finding table reads as "everything
  // is equal weight." A senior auditor triages: here's the real issue, and
  // here's the long tail. Split at 3; fold the rest into a collapsed section
  // so readers still have access without being buried.
  // AAP-88: top-N threshold `templates_renderFindings_topN` = 3 (also pinned
  // to the "Top 3 Findings" label below). Documented in
  // src/verification/threshold-manifest.ts.
  if (sorted.length <= 3) {
    const rows = sorted.map(renderRow).join('\n');
    return `## Findings\n\n${tableHeader}\n${rows}`;
  }

  const top = sorted.slice(0, 3).map(renderRow).join('\n');
  const rest = sorted.slice(3).map((r, i) => renderRow(r, i + 3)).join('\n');

  return `## Findings

### Top 3 Findings

${tableHeader}
${top}

<details>
<summary><strong>Additional findings (${sorted.length - 3})</strong></summary>

${tableHeader}
${rest}

</details>`;
}

// ─── AAP-63 — Verification Status, Discrepancies, Split Findings ────────────

/**
 * Render the Verification Status section explaining which Surface 2
 * sources ran on this audit. Always emitted: when no verdict / discovery
 * context is attached we render a minimal "not yet run" stub so the
 * report makes the gap explicit instead of hiding it.
 */
/**
 * AAP-93 M4 — normalise the dual shape of `discoveryStatus` /
 * `oauthIntrospectionStatus` entries into a `{status, reason}` tuple.
 * Bare strings are forward-compat shims for legacy callers; the new
 * `{status, reason}` shape is the canonical form.
 */
function normalizeStatus(
  s:
    | 'ran'
    | 'skipped'
    | 'failed'
    | { status: 'ran' | 'skipped' | 'failed'; reason?: string }
    | undefined,
  legacyReason?: string,
): { status: 'ran' | 'skipped' | 'failed'; reason?: string } {
  if (s === undefined) return { status: 'ran' };
  if (typeof s === 'string') return legacyReason ? { status: s, reason: legacyReason } : { status: s };
  return s;
}

function formatStatusCell(s: { status: string; reason?: string }): string {
  // AAP-93 M4 — render `skipped (reason: …)` so a reviewer can tell
  // "we don't have OAuth credentials" from "user denied consent" from
  // "intentionally not part of this audit". Pre-fix the cell just
  // said `skipped` with no metadata, which read as Heron silently
  // dropping a source.
  if (s.reason && (s.status === 'skipped' || s.status === 'failed')) {
    return `${s.status} (reason: ${escapeCell(s.reason)})`;
  }
  return s.status;
}

function renderVerificationStatusSection(
  verdict: Verdict | undefined,
  context: RenderMarkdownReportContext,
  reportVerificationStatus?:
    | 'interrogation-only'
    | 'partially-verified'
    | 'verified'
    | 'verification-failed',
): string {
  // Codex round 3 fix (P2): consult `report.verification.status` as a
  // secondary source. A persisted `verified` / `partially-verified`
  // report re-rendered without a `verdict` in context would otherwise
  // surface the UNVERIFIED stub here, contradicting the Limitations
  // text which already reads the persisted field. When the persisted
  // status says verification happened, the section pivots to the
  // per-source table even without a verdict in context.
  //
  // Codex round 4 fix (P2): map persisted `'verified'` → `'verified'`
  // and `'partially-verified'` → `'partial'` so the section header
  // doesn't downgrade a persisted verified report to PARTIAL on
  // re-render.
  const verdictStatus = verdict?.status;
  let persistedFallback: 'unverified' | 'partial' | 'verified' | undefined;
  if (reportVerificationStatus === 'verified') {
    persistedFallback = 'verified';
  } else if (reportVerificationStatus === 'partially-verified') {
    persistedFallback = 'partial';
  }
  // Codex round 5 P2: persisted `verification-failed` re-rendered
  // without a verdict context must NOT fall through to the
  // unverified-not-run stub — that contradicts the failure banner
  // and limitations text. Surface a dedicated failed-state stub.
  const persistedFailed =
    reportVerificationStatus === 'verification-failed' &&
    verdictStatus === undefined;
  const status = verdictStatus ?? persistedFallback ?? 'unverified';
  const lines: string[] = ['## Verification Status', ''];
  if (persistedFailed) {
    lines.push(
      '**Verification status:** _FAILED — verification was attempted but did not complete cleanly._',
    );
    lines.push('');
    lines.push(
      'See the failure banner near the top of the report for the diagnostic reason. Retry verification via the dashboard or by re-calling `start_verification` from the agent host. The findings below remain based on the interview only until verification completes.',
    );
  } else if (status === 'unverified') {
    lines.push(
      '**Verification status:** _UNVERIFIED — deterministic evidence sources have not run yet._',
    );
    lines.push('');
    lines.push(
      'The risk verdict above is the agent\'s **self-report only**. Heron strategy v3.0 §3 requires every claim to be verifiable from a deterministic source of truth. Run the discovery scan from the dashboard to read the agent\'s actual config files and re-derive the verdict.',
    );
  } else {
    lines.push(`**Verification status:** ${status.toUpperCase()}`);
    lines.push('');
    lines.push('| Source | Status |');
    lines.push('| --- | --- |');
    const discoveryStatus = normalizeStatus(context.discoveryStatus ?? 'ran');
    lines.push(
      `| Filesystem discovery | ${formatStatusCell(discoveryStatus)} |`,
    );
    const oauthRows = context.oauthIntrospectionStatus ?? [];
    if (oauthRows.length === 0) {
      // AAP-93 M4 — even with no per-provider rows, surface a default
      // skip reason so the table doesn't lie about a source that never
      // executed. The OAuth introspection skip is structural today
      // (token-capture UX is AAP-64); callers can override by passing
      // an explicit `{status, reason}` row.
      lines.push(
        '| OAuth introspection | skipped (reason: no OAuth credentials configured for this session) |',
      );
    } else {
      for (const r of oauthRows) {
        const normalized = normalizeStatus(r.status, r.reason);
        lines.push(
          `| OAuth introspection — ${escapeCell(r.provider)} | ${formatStatusCell(normalized)} |`,
        );
      }
    }
  }
  return lines.join('\n');
}

/**
 * Render the Discrepancies block. Returns the empty string when there
 * is no verdict or no discrepancies — the upstream `sections.filter`
 * drops empties so the section disappears entirely in that case.
 */
function renderDiscrepanciesSection(verdict: Verdict | undefined): string {
  if (!verdict || verdict.discrepancies.length === 0) return '';
  const lines: string[] = ['## Discrepancies', ''];
  lines.push(
    'Deterministic evidence contradicts a self-reported claim from the interview. Each row pairs the interview claim with the deterministic finding so a reviewer can decide whether the agent was misconfigured, misunderstood, or misrepresenting its own behaviour.',
  );
  lines.push('');
  lines.push('| Severity | Interview claim | Deterministic evidence |');
  lines.push('| --- | --- | --- |');
  for (const d of verdict.discrepancies) {
    lines.push(
      `| ${d.severity.toUpperCase()} | ${escapeCell(d.claim)} | ${escapeCell(d.evidence)} |`,
    );
  }
  return lines.join('\n');
}

/**
 * AAP-67 — Local discovery extras (workspace .env).
 *
 * Surfaces the per-workspace env-variable names the discovery scan
 * picked up. Returns the empty string when there's nothing to render —
 * `sections.filter(Boolean)` then drops the section so legacy reports
 * stay byte-identical.
 *
 * AAP-100 — the L3 (macOS Keychain) and L4 (cross-cutting OS
 * credentials) subsections were removed alongside their readers.
 *
 * Privacy contract: every row is a NAME, never a value. The renderer
 * does not synthesise values from the data — it just lays out what the
 * reader emitted.
 */
function renderLocalDiscoveryExtras(context: RenderMarkdownReportContext): string {
  const extras = context.localDiscoveryExtras;
  if (!extras) return '';
  const hasEnv = extras.workspaceEnv && extras.workspaceEnv.length > 0;
  const hasWarn = extras.warnings && extras.warnings.length > 0;
  if (!hasEnv && !hasWarn) return '';

  const lines: string[] = ['## Local Discovery — Workspace .env', ''];
  lines.push(
    '_Deterministic evidence beyond per-agent configs. Heron surfaces NAMES only — credential values are never read, logged, or transmitted._',
  );
  lines.push('');

  if (hasEnv) {
    lines.push('### Per-workspace env vars');
    lines.push('');
    lines.push('| File | Variable names |');
    lines.push('| --- | --- |');
    for (const e of extras.workspaceEnv!) {
      const keyList = e.keys.length === 0 ? '_(file present, no parseable keys)_' : e.keys.map(escapeCell).join(', ');
      lines.push(`| ${escapeCell(e.path)} | ${keyList} |`);
    }
    lines.push('');
  }

  if (hasWarn) {
    lines.push('### Reader warnings');
    lines.push('');
    for (const w of extras.warnings!) {
      lines.push(`- ${escapeText(w)}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

// ─── AAP-103 — Vijil-style Failure Pattern cards ────────────────────────────

/**
 * Source label per evidenceSource prefix. Surfaced as a one-word tag
 * on the finding card so the reader sees the provenance without having
 * to memorise the 3-letter codes.
 */
const EVIDENCE_SOURCE_LABEL: Readonly<Record<EvidenceSource, string>> = {
  MCP: 'MCP server / tool inventory',
  OAU: 'OAuth scope introspection',
  ENV: 'Workspace .env / secret material',
  PLG: 'Plugin / skill / auth credential',
  SLF: 'Self-attested (interview only)',
};

/**
 * Render a single Vijil-style Failure Pattern card for a coded
 * VerdictFinding. Returns markdown ready to be appended to the
 * Findings section.
 *
 * Structure (matches Frame 09 of the Vijil visual reference):
 *
 *   #### MCP-001 — <title>
 *   **Severity**: 9 (High) · BR 2 × DS 3 × DM 1.5 · _Source: MCP_
 *
 *   <description>
 *
 *   **Implications**
 *   - …
 *
 *   > **Mitigations**
 *   > - …
 *
 * Implications: derived from the finding's `description` + framework
 * cross-references when present. Mitigations: lookup via
 * `getMitigationHint`, fallback to generic copy.
 */
/**
 * AAP-127 (S11) — the GitHub-style heading anchor for a finding card.
 *
 * Each finding card's heading is `#### {code} — {title}` (see `renderFindingCard`
 * below). The compact per-framework reference (S11) links to the FULL card in
 * the GLOBAL "Self-Attested Findings" stream via this anchor, so the slug here
 * must match what a markdown renderer auto-generates for that heading:
 * lowercase, drop characters that are not word-chars / spaces / hyphens (so the
 * `—` em-dash and the leading `#`s are removed), then spaces → hyphens. The
 * card heading is slugged from the RAW `code` + `title` (not the `escapeText`-ed
 * form) because a renderer computes the anchor from the rendered heading text,
 * with backslash-escapes already resolved.
 */
function findingCardAnchor(finding: { code: string; title: string }): string {
  const headingText = `${finding.code} — ${finding.title}`;
  return headingText
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function renderFindingCard(
  finding: CodedVerdictFinding,
  compliance: StructuredCompliance | undefined,
  legacyRisk?: Risk,
  // Live OAuth-introspection + discovery state for this session, built once by
  // the caller via the shared `buildSlfMitigationState`. Consumed ONLY for SLF
  // findings, so the markdown SLF mitigation is state-aware and identical to
  // the dashboard (e.g. introspection attempted + rejected -> refresh the
  // token; .env already read -> rotate). Ignored for non-SLF findings.
  slfState?: SlfMitigationState,
): string {
  const sevText = formatSeverityNumber(finding.severityScore);
  const bandLabel = SEVERITY_BAND_LABEL[finding.band];
  const sourceLabel = EVIDENCE_SOURCE_LABEL[finding.evidenceSource];

  // Hover-hint formula. In markdown we emit it as an italic line under
  // the severity header (no native tooltip; the HTML / dashboard get
  // a real `title` attribute).
  const formula = renderSeverityFormula({
    severity: finding.severityScore,
    br: finding.severityComponents.br,
    ds: finding.severityComponents.ds,
    dm: finding.severityComponents.dm,
    ...(finding.severityComponents.brW !== undefined && { brW: finding.severityComponents.brW }),
    ...(finding.severityComponents.brR !== undefined && { brR: finding.severityComponents.brR }),
    ...(finding.severityComponents.brA !== undefined && { brA: finding.severityComponents.brA }),
  });

  // Framework cross-references — same legacy lookup the prior flat
  // table used. When the finding has a typed FindingType (only true
  // for findings sourced from the analyzer LLM via `risks`), surface
  // the basis as an "Anchored to:" line. Discovery / OAuth findings
  // don't carry a typed FindingType yet — they get an empty basis.
  const findingType = legacyRisk ? inferFindingType(legacyRisk) : undefined;
  const basis = findingType ? getFrameworkBasis(findingType, compliance) : '';
  const anchorLine = basis && basis !== '—' ? `\n_Anchored to: ${basis}_\n` : '';

  // Implications — for MVP we extract two simple rules from the
  // existing data:
  //   1. Mitigation field on legacyRisk (when present) reads as one
  //      implication / next step. We surface it here when not used as
  //      the Mitigations callout below.
  //   2. Evidence-source-specific implication for surface-source
  //      findings (OAuth diff → "scope creep", etc.).
  const implications = renderImplications(finding, legacyRisk);

  // Mitigations callout — 1-line actionable hint. (Doc links were removed
  // in AAP-105 F3: `docs.heron` was a placeholder domain, not a real docs
  // site; they get added back when real docs exist.)
  //
  // SLF parity: self-attested findings resolve their hint through
  // `getSlfMitigationHint(finding, slfState)` — the SAME state-aware lookup the
  // dashboard's `MinimalFindingCard` uses — so the markdown picks the
  // subcategory variant (oauth / credentials / write / vendor / …) AND the
  // state-aware copy (introspection attempted+rejected -> refresh the token;
  // .env already read -> rotate) instead of the generic evidence-source SLF
  // line that drifted from the dashboard. Non-SLF findings keep the existing
  // findingType > evidenceSource lookup.
  const mitigationHint =
    finding.evidenceSource === 'SLF'
      ? getSlfMitigationHint(
          { title: finding.title, description: finding.description },
          slfState,
        )
      : getMitigationHint({
          ...(findingType ? { findingType } : {}),
          evidenceSource: finding.evidenceSource,
        });

  // Use a blockquote-style green callout in markdown (`>`). The HTML
  // renderer + dashboard map to a proper green-tinted box.
  const lines: string[] = [
    `#### ${finding.code} — ${escapeText(finding.title)}`,
    '',
    `**Severity**: ${sevText} (${bandLabel}) · _Formula: ${escapeText(formula)}_  ·  **Source**: ${sourceLabel}`,
  ];
  if (anchorLine) lines.push(anchorLine.trimEnd());
  lines.push('');
  lines.push(escapeText(finding.description));
  lines.push('');
  if (implications.length > 0) {
    lines.push('**Implications**');
    lines.push('');
    for (const i of implications) lines.push(`- ${escapeText(i)}`);
    lines.push('');
  }
  // Mitigations as a green-tinted callout — markdown blockquote.
  lines.push('> **Mitigations**');
  lines.push(`> - ${escapeText(mitigationHint)}`);
  return lines.join('\n');
}

/**
 * Derive a short Implications bullet list for a finding. MVP: 2-4 short
 * lines drawn from existing data:
 *   - The legacy `mitigation` field (if it sounds like a consequence
 *     statement and we aren't using it as the Mitigations callout)
 *   - Evidence-source-specific lift ("MCP scope creep increases blast
 *     radius across all clients of this server.")
 *   - SLF caveat for self-attested findings
 */
function renderImplications(
  finding: CodedVerdictFinding,
  legacyRisk?: Risk,
): string[] {
  const out: string[] = [];

  // Source-specific implication boilerplate.
  switch (finding.evidenceSource) {
    case 'MCP':
      out.push('Tools registered at runtime that are not declared in the MCP server config expand the agent\'s effective blast radius beyond what reviewers approved.');
      break;
    case 'OAU':
      out.push('OAuth scopes granted at the provider exceed what the agent consumer requested, so the agent can perform actions that were not justified during scope review.');
      break;
    case 'ENV':
      out.push('Credentials in workspace .env files are accessible to anyone with filesystem access; this widens the credential blast radius beyond a secret manager\'s audit boundary.');
      break;
    case 'PLG':
      out.push('Plugin / skill / auth credential grants live outside the MCP scope contract, so the declared scope of the agent does not bound what this artefact can do.');
      break;
    case 'SLF':
      out.push('This claim is self-reported and not verified against deterministic evidence. A reviewer should attach a config file, audit log, or scope record before relying on it.');
      break;
  }

  // Include the legacy mitigation prose when it reads as a consequence
  // (we still produce a Mitigations callout below via the catalog).
  if (legacyRisk?.mitigation && legacyRisk.mitigation !== 'NOT PROVIDED' && legacyRisk.mitigation !== '—') {
    out.push(`Analyzer note: ${legacyRisk.mitigation}`);
  }

  return out;
}

/**
 * AAP-108 — did a deterministic discovery / verification pass actually run
 * for this session? Pure mirror of `discoveryRanFor` in the dashboard's
 * `MinimalReportView.tsx` (kept inline so this Node renderer doesn't import
 * a `'use client'` React module). True when the systems-risk pass scored
 * systems, the verdict status is past the no-evidence baseline, or
 * discovery findings exist.
 */
function discoveryRanForVerdict(
  verdict: Verdict,
  discoveryFindings: ReadonlyArray<DiscoveryFinding>,
): boolean {
  if (verdict.systemsRisk?.scanned) return true;
  if (verdict.status !== undefined && verdict.status !== 'unverified') return true;
  return discoveryFindings.length > 0;
}

/**
 * AAP-108 — Findings empty-state copy when the Verified stream is empty.
 * Pure mirror of `findingsEmptyState` in the dashboard (AAP-107):
 *
 *   - discovery NOT run                     -> honest "scan has not run yet"
 *   - discovery ran, systems scored         -> "No declared-vs-actual
 *       discrepancies. Posture reflects deployment risk from the systems
 *       above." (the demo case: never claim the agent is clean)
 *   - discovery ran, no systems scored      -> plain "no discrepancies"
 *
 * This replaces the pre-G9 line that collapsed "scan never ran" and "scan
 * ran clean" into one misleading sentence. NO em-dashes.
 */
function findingsEmptyStateLine(
  verdict: Verdict,
  discoveryFindings: ReadonlyArray<DiscoveryFinding>,
): string {
  const discoveryRan = discoveryRanForVerdict(verdict, discoveryFindings);
  if (!discoveryRan) {
    return 'Discovery scan has not run yet. Run verification to compare declared access against deterministic evidence.';
  }
  const systemsRiskNonZero =
    (verdict.posture ?? 0) > 0 || (verdict.systemsRisk?.systems?.length ?? 0) > 0;
  if (systemsRiskNonZero) {
    return 'No declared-vs-actual discrepancies. Posture reflects deployment risk from the systems above.';
  }
  return 'No declared-vs-actual discrepancies found in the deterministic evidence.';
}

/**
 * Pair each SLF VerdictFinding to its originating interview `Risk`, keyed by
 * finding id. The match is positional: interview risks are appended to
 * `verdict.findings` in source order by `computeVerdict`, so the Nth SLF finding
 * pairs with `risks[N]`. The Risk carries the `mitigation` prose + the basis for
 * the `findingType` anchor that `renderFindingCard` surfaces.
 *
 * AAP-123 (S7) — extracted so the global Self-Attested stream
 * (`renderFindingsCards`) AND the per-framework lens sub-list
 * (`renderFrameworkLensBlock`) resolve a finding's legacy Risk through the SAME
 * mapping, so a finding's card reads identically in both places.
 *
 * Defensive: pre-AAP-102 fixtures may pass a Verdict without `findings`; the
 * caller passes `[]` then and this returns an empty map.
 */
function slfRiskByFindingId(
  verdictFindings: readonly VerdictFinding[],
  risks: readonly Risk[],
): Map<string, Risk> {
  const out = new Map<string, Risk>();
  const slfFindingsInVerdict = verdictFindings.filter((f) => f.evidenceSource === 'SLF');
  slfFindingsInVerdict.forEach((vf, idx) => {
    const r = risks[idx];
    if (r) out.set(vf.id, r);
  });
  return out;
}

/**
 * Render the Findings section as Vijil-style Failure Pattern cards.
 *
 * Two streams remain (Verified vs Self-attested per AAP-93 H3) so the
 * "deterministic before self-report" wedge stays visible, but every
 * finding inside each stream is now an individual card rather than a
 * row in a flat table. Findings ordered by severity within each stream.
 *
 * Falls back to the legacy `renderFindingsSplit` flat table when no
 * verdict has been computed yet (the only place that should hit is the
 * pre-analyzer markdown render — every persisted report goes through
 * the verdict pipeline).
 */
function renderFindingsCards(
  risks: Risk[],
  compliance: StructuredCompliance | undefined,
  verdict: Verdict,
  discoveryFindings: DiscoveryFinding[],
  // Live session state (OAuth introspection + .env discovery) for the SLF
  // mitigation hints, built once by `renderMarkdownReport` via the shared
  // `buildSlfMitigationState`. Forwarded to each SLF card so the markdown SLF
  // mitigation matches the dashboard's state-aware copy.
  slfState?: SlfMitigationState,
): string {
  // Pair each VerdictFinding to a Risk for FindingType + mitigation prose
  // lookup (see `slfRiskByFindingId`). Defensive: pre-AAP-102 test fixtures may
  // pass a Verdict literal without the `findings` array — treat absent as empty
  // so we fall through to the empty-state copy rather than crash.
  const verdictFindings = verdict.findings ?? [];
  const slfRiskByIndex = slfRiskByFindingId(verdictFindings, risks);

  // Assign Vijil-style codes (MCP-001 / OAU-001 / ...).
  const coded = assignFindingCodes(verdictFindings);

  // Sort within each stream: highest severity first.
  const verified = coded
    .filter((f) => f.evidenceSource !== 'SLF')
    .slice()
    .sort((a, b) => b.severityScore - a.severityScore);
  const selfAttested = coded
    .filter((f) => f.evidenceSource === 'SLF')
    .slice()
    .sort((a, b) => b.severityScore - a.severityScore);

  const lines: string[] = ['## Findings', ''];

  // ── Verified stream ──
  lines.push('### Verified Findings');
  lines.push('');
  lines.push(
    '_Deterministic evidence: MCP server inventory, OAuth scope introspection, workspace .env scans, plugin / skill / auth credentials. These drive the posture indicator above._',
  );
  lines.push('');
  if (verified.length === 0) {
    // AAP-108 — G9 state-aware empty-state (mirrors the dashboard). When
    // discovery ran with zero verified discrepancies we must NOT say the
    // scan "has not run yet" and must NOT imply the agent is clean: posture
    // still reflects the systems' deployment risk.
    lines.push(`_${findingsEmptyStateLine(verdict, discoveryFindings)}_`);
    lines.push('');
  } else {
    for (const f of verified) {
      lines.push(renderFindingCard(f, compliance));
      lines.push('');
    }
  }

  // ── Cross-runtime note (preserved from AAP-93 M2) ──
  if (discoveryFindings.length > 0) {
    const runtimesSeen = new Set<string>();
    for (const df of discoveryFindings) {
      if (df.runtime && df.runtime !== '—') runtimesSeen.add(df.runtime);
    }
    if (runtimesSeen.size > 1) {
      const runtimeList = [...runtimesSeen].filter((r) => r !== '—').sort().join(', ');
      lines.push(
        `_Findings cover all AI-runtime configs present on the host machine (${runtimeList}). Findings tagged with a runtime other than the audited agent indicate cross-runtime artefacts on the same workstation._`,
      );
      lines.push('');
    }
  }

  // ── Self-attested stream ──
  lines.push('### Self-Attested Findings');
  lines.push('');
  lines.push(
    '_These findings are derived from the agent\'s interview answers only. They appear here for transparency but do not move the posture indicator above. Treat each as a working hypothesis until matched to deterministic evidence._',
  );
  lines.push('');
  if (selfAttested.length === 0) {
    lines.push('_No self-attested findings._');
  } else {
    for (const f of selfAttested) {
      const legacy = slfRiskByIndex.get(f.id);
      lines.push(renderFindingCard(f, compliance, legacy, slfState));
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd();
}

/**
 * Split Findings section: Deterministic (Surface 2) above
 * Self-Reported (Surface 1). When no Surface 2 findings are supplied
 * the deterministic subsection still appears with an empty-state line
 * so the structural promise of the report ("deterministic comes
 * first") remains visible.
 */
function renderFindingsSplit(
  risks: Risk[],
  compliance: StructuredCompliance | undefined,
  discoveryFindings: DiscoveryFinding[],
): string {
  const lines: string[] = ['## Findings', ''];

  // ── Deterministic (Surface 2) ────────────────────────────────────
  lines.push('### Deterministic Findings');
  lines.push('');
  if (discoveryFindings.length === 0) {
    lines.push('_No deterministic findings — either the discovery scan has not run yet, or it ran and found no inconsistencies. Re-run discovery if the agent configuration has changed._');
  } else {
    // AAP-93 M2 — when discovery findings span more than one runtime
    // (Codex + Claude Code on the same machine), surface a note so
    // the reader doesn't read it as "the Codex audit somehow knows
    // about Claude Code". The discovery scan is host-machine wide;
    // each row's Runtime column tells the reader which runtime's
    // config produced the evidence.
    //
    // Codex post-review fix (P3): MISSING findings carry the sentinel
    // `runtime: '—'` (no file source); excluding it stops the
    // cross-runtime callout from firing on a single-runtime audit
    // that happens to have one EXTRA + one MISSING row.
    const runtimesSeen = new Set<string>();
    for (const f of discoveryFindings) {
      if (f.runtime && f.runtime !== '—') runtimesSeen.add(f.runtime);
    }
    if (runtimesSeen.size > 1) {
      const runtimeList = [...runtimesSeen]
        .filter((r) => r !== '—')
        .sort()
        .join(', ');
      lines.push(
        `_Findings cover all AI-runtime configs present on the host machine (${runtimeList}). Each row's **Runtime** column identifies the runtime whose config produced the evidence — findings tagged with a runtime other than the audited agent indicate cross-runtime artefacts on the same workstation._`,
      );
      lines.push('');
    }

    // AAP-93 M3 — `Source` column carries the evidence path so a
    // reviewer can verify each finding against the underlying config
    // file. MISSING findings (absence-evidence) render `—`.
    //
    // Codex round 4 fix (P3): `escapeInlineCode` does NOT escape pipe
    // characters, so a config path containing `|` would split the
    // table row into extra cells. Wrap the rendered cell in
    // `escapeCell` for table-safety.
    lines.push('| Kind | Severity | Server / Runtime | Source | Description |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const f of discoveryFindings) {
      const source = f.sourcePath
        ? escapeCell(`\`${escapeInlineCode(f.sourcePath)}\``)
        : '—';
      lines.push(
        `| ${escapeCell(f.kind)} | ${f.severity} | ${escapeCell(f.serverName)} / ${escapeCell(f.runtime)} | ${source} | ${escapeCell(f.description)} |`,
      );
    }
  }
  lines.push('');

  // ── Self-Reported (Surface 1) ────────────────────────────────────
  lines.push('### Self-Reported Findings');
  lines.push('');
  lines.push(
    '_These findings are derived from the agent\'s interview answers and should be verified against deterministic evidence. They are supplementary narrative, not the primary verdict._',
  );
  lines.push('');
  lines.push(renderFindings(risks, compliance).replace(/^## Findings\n\n/, ''));

  return lines.join('\n');
}

// ─── Positive Findings ─────────────────────────────────────────────────────

function renderPositiveFindings(
  report: AuditReport,
  discoveryFindings: ReadonlyArray<DiscoveryFinding> = [],
): string {
  const positives: string[] = [];
  const systems = report.systems.filter(isBusinessSystem);

  // All writes reversible
  const allWrites = systems.flatMap(s => s.writeOperations);
  if (allWrites.length > 0 && allWrites.every(w => w.reversible)) {
    positives.push('All write operations are reversible');
  }

  // No excessive scopes
  // Reviewer feedback (2026-04-25): a single report had both
  // "No excessive permissions detected" AND a HIGH "Broad Google OAuth
  // write scope exceeds stated single-sheet/single-folder need" finding —
  // a direct internal contradiction. Root cause: the LLM put the broad-
  // scope finding into `risks` (with a HIGH severity) but did not populate
  // `scopesDelta`, so the structural counter said zero excessive scopes.
  // Gate the positive on BOTH: zero scopesDelta entries AND no high-
  // severity risk that the finding-type inferrer classifies as access /
  // excessive-permissions / scope-creep.
  //
  // AAP-93 H7 — additionally gate on `discoveryFindings.kind === 'EXTRA'`.
  // A Surface 2 EXTRA finding means an MCP server or plugin was
  // discovered that the agent did NOT declare in the interview; that
  // is, by definition, excess permission surface. The positive
  // "follows least-privilege principle" must not coexist with even
  // one EXTRA discovery finding.
  const totalExcessive = systems.reduce((n, s) => n + s.scopesDelta.length, 0);
  const hasAccessRisk = report.risks.some((r) => {
    if (r.severity !== 'high' && r.severity !== 'critical') return false;
    const t = inferFindingType(r);
    return t === 'excessive-access' || t === 'scope-creep';
  });
  const extraFindings = discoveryFindings.filter((f) => f.kind === 'EXTRA');
  if (
    totalExcessive === 0 &&
    systems.length > 0 &&
    !hasAccessRisk &&
    extraFindings.length === 0
  ) {
    positives.push('No excessive permissions detected — follows least-privilege principle');
  }

  // Limited blast radius
  if (systems.length > 0 && systems.every(s => s.blastRadius === 'single-user' || s.blastRadius === 'single-record')) {
    positives.push('Blast radius limited to single user/record');
  }

  // Approval required on writes
  if (allWrites.length > 0 && allWrites.some(w => w.approvalRequired)) {
    positives.push('Some write operations require approval before execution');
  }

  // Low frequency
  const freqText = systems.map(s => s.frequencyAndVolume).join(' ');
  if (/\b(1|2|once|twice)\b.*\b(week|month)\b/i.test(freqText)) {
    positives.push('Low execution frequency reduces operational risk');
  }

  // No decisions about people
  if (report.makesDecisionsAboutPeople === false) {
    positives.push('Does not make automated decisions about people');
  }

  if (positives.length === 0) return '';

  return `## What's Working Well

${positives.map(p => `- ✓ ${p}`).join('\n')}`;
}

// ─── Verdict (merged Recommendation + Recommendations) ───────────────────────

/**
 * AAP-64 — derive a short bold lead-in title (≤60 chars) from a
 * recommendation body. Picks the first short sentence; if no sentence
 * boundary falls inside 60 chars, falls back to the first phrase clipped
 * at the last space before 50 chars. Always ends with a period so the
 * bold lead-in reads as a title in markdown.
 */
function recommendationTitle(body: string): string {
  const trimmed = body.trim();
  // First sentence — split on period/colon/semicolon.
  const sentenceMatch = trimmed.match(/^(.{1,60}?[.;:])\s/);
  if (sentenceMatch) {
    let t = sentenceMatch[1].trim();
    if (!/[.;:]$/.test(t)) t += '.';
    return t;
  }
  // Short body that fits in 60 chars: title IS the body.
  if (trimmed.length <= 60) {
    return /[.;:]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  }
  // Long body with no early sentence break: clip at last space ≤50 chars.
  const cut = trimmed.slice(0, 50);
  const lastSpace = cut.lastIndexOf(' ');
  const head = lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
  return `${head.trim()}.`;
}

function renderVerdict(
  report: AuditReport,
  discoveryFindings: ReadonlyArray<DiscoveryFinding> = [],
  _verdictContext?: Verdict,
): string {
  // AAP-104 D1 — `calibrateVerdictLabel` is the AAP-102 stub that
  // returns ''. The `hasHighFindings` argument no longer affects the
  // output. Kept the call so the deprecation chain stays explicit;
  // the verdict empty-string carve-out below renders no bold label.
  const verdict = calibrateVerdictLabel({
    recommendation: report.recommendation,
    verificationStatus: report.verification?.status,
    hasHighFindings: false,
  });
  const recs = report.recommendations;

  // Ensure standard condition is always present
  const standardCondition = 'Verify self-reported claims against actual system configurations before granting production access';
  let allRecs = recs.some(r => /verify.*self.reported|verify.*claim/i.test(r))
    ? recs
    : [standardCondition, ...recs];

  // AAP-93 H7 — when Surface 2 EXTRA findings exist (MCP servers or
  // plugins the agent never mentioned in the interview), inject a
  // concrete remediation recommendation. Pre-fix the report could
  // simultaneously claim "follows least-privilege principle" AND list
  // 8 EXTRA findings — a direct internal contradiction. With this
  // recommendation in place, even if the "no excessive permissions"
  // positive accidentally surfaces, the Verdict section names the
  // gap explicitly.
  const extras = discoveryFindings.filter((f) => f.kind === 'EXTRA');
  if (extras.length > 0) {
    const mcpExtra = extras.filter((f) =>
      /mcp server/i.test(f.description),
    ).length;
    const pluginExtra = extras.filter((f) =>
      /plugin/i.test(f.description),
    ).length;
    const counts: string[] = [];
    if (mcpExtra > 0) counts.push(`${mcpExtra} MCP server${mcpExtra === 1 ? '' : 's'}`);
    if (pluginExtra > 0) counts.push(`${pluginExtra} plugin${pluginExtra === 1 ? '' : 's'}`);
    const breakdown = counts.length > 0 ? counts.join(' and ') : `${extras.length} item${extras.length === 1 ? '' : 's'}`;
    const extraRec =
      `Reduce tool surface to declared scope. ${breakdown} were discovered but not mentioned in the interview — review whether they are required for this deployment.`;
    // Prepend if not already present (a verify-claims rec is usually
    // first; we want the Surface 2 specific item above generic prose).
    if (!allRecs.some((r) => /reduce tool surface to declared scope/i.test(r))) {
      allRecs = [extraRec, ...allRecs];
    }
  }

  // AAP-104 D1 — `calibrateVerdictLabel` is the AAP-102 no-op stub
  // returning the empty-string sentinel. When the renderer just emits
  // `**${verdict}**` the markdown body is left with a bare `****` line
  // (and the dashboard mirrors it via VerdictBanner). Skip the line
  // entirely when there is no label. The reviewer decides the verdict;
  // Heron computes posture. The empty-string carve-out below preserves
  // the legacy path for any pre-AAP-102 persisted report that still
  // carries a string label (`APPROVE WITH CONDITIONS`, …).
  let body = verdict ? `**${verdict}**` : '';

  if (allRecs.length > 0) {
    // AAP-64 — each recommendation becomes a markdown blockquote card.
    // Lead-in is the inferred short title, bolded; body follows on the
    // same line. A blank line between cards keeps each card visually
    // distinct in any markdown renderer.
    body +=
      '\n\n' +
      allRecs
        .map(r => {
          const title = recommendationTitle(r);
          const trimmed = r.trim();
          // Strip the title prefix from the body if it's the same span
          // (avoid "Foo. Foo. ..." duplication when title IS the body).
          const sameTitle = title === trimmed || title === `${trimmed}.`;
          if (sameTitle) {
            return `> **${title}**`;
          }
          // AAP-93 polish: when the title is a prefix of the body
          // (e.g. title "Reduce tool surface to declared scope." +
          // body "Reduce tool surface to declared scope. 8 plugins …"),
          // emit the title once and drop the prefix from the body so
          // the card doesn't read as duplicated.
          const lowerTitle = title.toLowerCase();
          const lowerBody = trimmed.toLowerCase();
          if (lowerBody.startsWith(lowerTitle)) {
            const rest = trimmed.slice(title.length).trimStart();
            return rest.length > 0 ? `> **${title}** ${rest}` : `> **${title}**`;
          }
          return `> **${title}** ${trimmed}`;
        })
        .join('\n>\n');
  }

  // Permissions delta — grouped by system
  const excessiveBySystem = new Map<string, string[]>();
  const missingBySystem = new Map<string, string[]>();
  for (const sys of report.systems) {
    if (!isBusinessSystem(sys)) continue;

    for (const scope of sys.scopesDelta) {
      if (isProvided(scope)) {
        if (!excessiveBySystem.has(sys.systemId)) excessiveBySystem.set(sys.systemId, []);
        excessiveBySystem.get(sys.systemId)!.push(scope);
      }
    }
    for (const scope of sys.scopesNeeded) {
      if (!sys.scopesRequested.includes(scope) && isProvided(scope)) {
        if (!missingBySystem.has(sys.systemId)) missingBySystem.set(sys.systemId, []);
        missingBySystem.get(sys.systemId)!.push(scope);
      }
    }
  }

  if (excessiveBySystem.size > 0 || missingBySystem.size > 0) {
    body += '\n\n**Permissions delta**:\n';
    if (excessiveBySystem.size > 0) {
      body += '\n*Excessive (can be revoked):*\n';
      for (const [system, scopes] of excessiveBySystem) {
        body += `- **${system}**: ${scopes.join('; ')}\n`;
      }
    }
    if (missingBySystem.size > 0) {
      body += '\n*Minimum needed:*\n';
      for (const [system, scopes] of missingBySystem) {
        body += `- **${system}**: ${scopes.join('; ')}\n`;
      }
    }
  }

  return `## Verdict & Recommendations

${body}`;
}

// ─── Transcript ──────────────────────────────────────────────────────────────

function renderTranscript(transcript: QAPair[]): string {
  const items = transcript
    .map((qa, i) => `### Q${i + 1} [${qa.category}]\n\n**Q:** ${qa.question}\n\n**A:** ${qa.answer}`)
    .join('\n\n');

  return `## Interview Transcript

<details>
<summary>Full transcript (${transcript.length} questions)</summary>

${items}

</details>`;
}

// ─── Regulatory Compliance (AAP-31) ────────────────────────────────────────

import type { RiskCategory } from '../compliance/types.js';

const CATEGORIES: Array<{ key: RiskCategory; title: string }> = [
  { key: 'privacy', title: 'Privacy' },
  { key: 'ip', title: 'IP' },
  { key: 'consumer-protection', title: 'Consumer Protection' },
  { key: 'sector-specific', title: 'Sector-Specific' },
];

// ─── Applicability Summary Table ─────────────────────────────────────────

/** Human-readable descriptions for why a framework didn't fire. */
const NOT_TRIGGERED_REASONS: Record<string, string> = {
  'gdpr': 'No personal data signals detected',
  'eu-ai-act': 'No applicable signals detected',
};

/** Short applicability condition for mandatory frameworks that DID fire. */
const APPLICABILITY_CONDITIONS: Record<string, string> = {
  'gdpr': 'If you serve EU data subjects',
  'eu-ai-act': 'If AI placed on EU market or outputs used in EU',
};

/** Map finding types to human-readable gap descriptions. */
const GAP_LABELS: Record<string, string> = {
  'excessive-access': 'Excessive permissions',
  'write-risk': 'Write operation risks',
  'sensitive-data': 'Data handling',
  // AAP-132: SECURITY finding type for plaintext / inactive credentials.
  'credential-exposure': 'Credential hygiene',
  'scope-creep': 'Scope exceeds purpose',
  'decisions-about-people': 'Automated decision-making',
  'regulatory-flags': 'Regulatory concerns',
};

/** Excluded from gap counting — always fires as methodology anchor, not a real gap. */
const GAP_EXCLUDED = new Set(['risk-score']);

function getGaps(frameworkId: string, allFlags: TypedRegulatoryFlag[]): string[] {
  const flags = allFlags.filter(f => f.frameworkId === frameworkId && !GAP_EXCLUDED.has(f.triggeredBy));
  // Also exclude decisions-about-people when it says "No decisions" (impact = none)
  const meaningful = flags.filter(f =>
    !(f.triggeredBy === 'decisions-about-people' && /no decisions about people/i.test(f.description)),
  );
  const uniqueTypes = [...new Set(meaningful.map(f => f.triggeredBy))];
  return uniqueTypes.map(t => GAP_LABELS[t] ?? t);
}

/**
 * AAP-84 — typed-projection variant. Reads `controlResults` instead of
 * `compliance.all`. Same shape contract: returns the unique gap-type
 * labels for the framework, dropping `risk-score` (methodology anchor,
 * not a gap, mirrors GAP_EXCLUDED).
 */
function getGapsFromControlResults(frameworkId: string, results: ControlResult[]): string[] {
  return gapLabelsForFramework(results, frameworkId as any, GAP_LABELS, GAP_EXCLUDED);
}

/**
 * Codex post-review fix (Blocker 1) — MERGED projection.
 *
 * Returns the union of gap labels from BOTH sources:
 *   - typed `controlResults` (per-control verdicts, the new source of truth)
 *   - legacy `compliance.all` flags (prose-only detectors that haven't
 *     migrated to the typed path yet)
 *
 * Dedup is by finding-type. The typed path wins for finding-types it
 * covers (more specific evidence); the legacy path fills in finding-
 * types the typed path doesn't cover. This prevents the old
 * "switch-on-non-empty" bug where a typed-only fail would hide every
 * prose-only flag from the same framework.
 */
function mergedGapsForFramework(
  frameworkId: string,
  results: ControlResult[],
  allFlags: TypedRegulatoryFlag[],
): string[] {
  const typedGaps = getGapsFromControlResults(frameworkId, results);
  const legacyGaps = getGaps(frameworkId, allFlags);
  // Set semantics give us label-level dedup. Order: typed first (the
  // newer projection), then legacy entries the typed pass missed.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const label of [...typedGaps, ...legacyGaps]) {
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

function formatGaps(gaps: string[]): { status: string; details: string } {
  if (gaps.length === 0) return { status: '✅ No gaps', details: '—' };
  return {
    status: `⚠️ ${gaps.length} gap${gaps.length > 1 ? 's' : ''}`,
    details: gaps.join(', '),
  };
}

// ─── Compliance lens (AAP-121 / S5 of AAP-117) ────────────────────────────

/** Short framework display names for the lens header rows. */
const LENS_FRAMEWORK_NAMES: Record<string, string> = {
  'eu-ai-act': 'EU AI Act',
  'gdpr': 'GDPR',
  'iso-42001': 'ISO/IEC 42001',
  'aiuc-1': 'AIUC-1',
  'nist-ai-rmf': 'NIST AI RMF',
};

/**
 * Per-control verdict badge for the lens active-control list. Extends the
 * `renderVerdictBadge` vocabulary with the `self-attested` sentinel state the
 * lens uses for agent self-reports (which are not deterministic verdicts).
 */
function renderLensVerdictBadge(verdict: LensControl['verdict']): string {
  if (verdict === 'self-attested') return '🗣️ self-attested';
  return renderVerdictBadge(verdict);
}

/**
 * Render one framework's lens block: a state-based header count line, an
 * out-of-scope count against the published universe, and the ordered list of
 * ACTIVE controls only (verified -> partial -> self-attested). Out-of-scope
 * controls are a count, never a list (per Ilya 2026-06-02).
 *
 * AAP-122 — when `slfFindings` are supplied (the self-attested findings whose
 * finding-type maps to THIS framework via `CONTROL_MAPPINGS`), they render in
 * a small sub-list AFTER the control rows. These are the SAME findings the
 * global "Self-Attested Findings" stream lists — shown here additionally for
 * framework attribution, never relocated.
 *
 * AAP-127 (S11) — the sub-list is now COMPACT one-line references (code + title,
 * linked to the full card in the global stream), not duplicated full cards, so
 * this block no longer needs the card-rendering context (`compliance` /
 * `slfRiskById` / `slfState`) that the AAP-123/S7 full-card path used.
 */
/**
 * S13 — one compact nested self-attested-finding reference under a control row:
 * `↳ CODE Title ↗`, linked to the FULL card in the GLOBAL "Self-Attested
 * Findings" stream via its heading anchor. `code` + `title` are the only fields
 * read; the full card (severity / description / mitigation) is never duplicated
 * here.
 */
function renderLensFindingRef(ref: LensFindingRef): string {
  // The global card heading is `#### {code} — {title}` (renderFindingCard); its
  // anchor must match what a markdown renderer slugs from that heading.
  const anchor = findingCardAnchor({ code: ref.code, title: ref.title });
  return `    - ↳ [\`${escapeText(ref.code)}\`](#${anchor}) ${escapeText(ref.title)} ↗`;
}

function renderFrameworkLensBlock(
  lens: FrameworkLens,
  // S13 — the coded SLF findings attributed to this framework; each NESTS under
  // the control it anchors to (or, in the fallback, as a standalone compact row
  // at the end). `code` + `title` are the only fields read; each links to its
  // full card in the global Self-Attested stream.
  slfFindings: readonly CodedVerdictFinding[] = [],
): string {
  const name = LENS_FRAMEWORK_NAMES[lens.frameworkId] ?? lens.frameworkId;
  const { counts } = lens;

  // S13 — compose the render model: nest each finding under its anchored control
  // (synthesising a `self-attested` control row when the anchor did not
  // independently activate), fallback orphans to standalone rows.
  const composed = composeFrameworkLensRows(lens, slfFindings);

  // S13 — the header is `{A} of {C} covered · {N−C} out of scope · {N} in
  // framework`. A = distinct controls surfaced as rows this audit (activated +
  // finding-anchored), C = static capability coverage (catalog-derived,
  // identical every audit), N = published universe. The verbose per-verdict
  // breakdown and the `~` prefix are gone (spec points 2 + 3); per-control
  // verdicts show on each row's badge.
  let out = `#### ${name}\n\n`;
  out +=
    `**${composed.surfaced} of ${counts.covered} covered** · ` +
    `${counts.outOfScope} out of scope · ${counts.publishedControlCount} in framework\n\n`;

  if (composed.rows.length === 0 && composed.orphanFindings.length === 0) {
    out += `_No active controls for this framework._\n\n`;
    return out;
  }

  // Control rows, each followed by its nested self-attested findings.
  for (const row of composed.rows) {
    const { control } = row;
    const nameSuffix = control.controlName ? ` — ${escapeText(control.controlName)}` : '';
    out += `- \`${control.controlId}\` ${renderLensVerdictBadge(control.verdict)}${nameSuffix}\n`;
    for (const ref of row.findings) out += `${renderLensFindingRef(ref)}\n`;
  }

  // FALLBACK — findings whose anchor could not be resolved to a control render
  // as standalone compact rows at the end (never dropped, spec point 1).
  for (const ref of composed.orphanFindings) {
    const anchor = findingCardAnchor({ code: ref.code, title: ref.title });
    out += `- ↳ [\`${escapeText(ref.code)}\`](#${anchor}) ${escapeText(ref.title)} ↗\n`;
  }
  out += `\n`;

  return out;
}

/**
 * AAP-121 — the honest compliance lens. One block per framework, ALL five,
 * mandatory-first (FIX 1 of S5: 0-active frameworks no longer vanish — a
 * framework with no active control still gets its card with the honest
 * "0 of ~N, the rest out of scope" summary). State-based header counts, only
 * active controls listed, out-of-scope as a count against the published
 * universe. Replaces the flat partial-wall + EU-AI-Act "prose only" special
 * case with one typed path for all five frameworks.
 *
 * Shares its counting / grouping / ordering math with the dashboard via
 * `src/report/compliance-lens.ts` so the two surfaces cannot drift (AAP-108).
 */
function renderComplianceLens(
  c: StructuredCompliance,
  // AAP-127 (S11) — the coded findings; each becomes a compact reference under
  // every framework its finding-type maps to (linked to the full card in the
  // global Self-Attested stream). Was the FULL coded set fed to a per-framework
  // card renderer (AAP-123/S7); the full card now lives only in the global
  // stream, so no risk map / slfState is needed here anymore.
  slfFindings: readonly CodedVerdictFinding[] = [],
): string {
  const controlResults = ((c as any).controlResults ?? []) as ControlResult[];
  const allFlags = (c.all ?? []) as TypedRegulatoryFlag[];

  // AAP-127 (S11) FIX 2 — ALWAYS render all five framework cards, even when no
  // control fired this audit. The old all-or-nothing gate (return early with
  // "No active controls" when `lensFrameworks(...)` is empty) is removed: each
  // card now carries an honest STATIC "C of ~N covered · (N−C) out of scope"
  // capability summary that is meaningful regardless of per-audit signals, so a
  // 0-active framework must still show its card (matches `allLensFrameworks`).

  let out = `### Compliance Lens\n\n`;
  // S13 — NO top-of-lens aggregate line (spec point 4). Per-framework cards
  // only; the single legend lives ONCE at the BOTTOM (below).

  for (const frameworkId of allLensFrameworks()) {
    // AAP-122 — the SLF findings whose finding-type maps to this framework
    // (deterministically, via CONTROL_MAPPINGS). Empty for findings with no
    // findingType, so those stay global-only. S13 — nested under their anchored
    // control, as compact references into the global stream.
    out += renderFrameworkLensBlock(
      frameworkLens(frameworkId, controlResults, allFlags),
      slfFindingsForFramework(frameworkId, slfFindings),
    );
  }

  // S13 — the single legend, ONCE at the bottom (spec points 4 + 5). Explains
  // verified / warn / self-attested controls, the nested self-attested findings
  // (agent self-report, does not move posture — full detail in the global
  // Self-Attested Findings stream), and what out-of-scope means. The verbose
  // per-framework blurbs are gone; this is the only place the explanation lives.
  out +=
    `_Some controls can earn a clean **verified**; others only ever **warn** ` +
    `(the deterministic-flag set), and **self-attested** controls are the agent's ` +
    `own answers, not deterministic verdicts. Findings nested under a control ` +
    `(↳) are self-reported (full detail in the [Self-Attested Findings](#self-attested-findings) ` +
    `stream) and do not move posture. Out-of-scope controls need a corporate ` +
    `artifact or an external probe Heron can't reach in an interview._\n\n`;

  return out;
}

function renderApplicabilitySummary(c: StructuredCompliance): string {
  const controlResults = ((c as any).controlResults ?? []) as ControlResult[];
  const allFlags = (c.all ?? []) as TypedRegulatoryFlag[];

  // Codex post-review fix (Blocker 2): activation comes from BOTH
  // `frameworksActivated` (legacy prose path) AND
  // `activatedFrameworksFromControlResults(controlResults)` (typed
  // detectors). A typed-only "GDPR Art. 6 fail" with empty
  // `frameworksActivated` must still render GDPR as applicable.
  const activated = new Set<string>([
    ...((c as any).frameworksActivated ?? []),
    ...activatedFrameworksFromControlResults(controlResults),
  ]);

  const mandatoryFrameworks: Array<{ id: string; name: string }> = [
    { id: 'eu-ai-act', name: 'EU AI Act' },
    { id: 'gdpr', name: 'GDPR' },
  ];

  const voluntaryFrameworks: Array<{ id: string; name: string }> = [
    { id: 'iso-42001', name: 'ISO/IEC 42001' },
    { id: 'aiuc-1', name: 'AIUC-1 (Q2-2026)' },
    { id: 'nist-ai-rmf', name: 'NIST AI RMF' },
  ];

  // EU AI Act classification scope label — single line replaces the prior
  // two-entry split (`eu-ai-act` + `eu-ai-act-high-risk`).
  const euClassification = (c as any).euAiActClassification as
    | { classification: string; annexIIICategories: string[] }
    | undefined;

  // Codex post-review fix (Blocker 1): gap rendering uses a MERGED
  // projection, not an either/or switch. `controlResults` is partial —
  // it carries only typed-detector verdicts. Prose-only flags from
  // `compliance.all` still describe real gaps for finding types where
  // no typed detector ran. Merging dedups by `findingType` so a
  // (typed, prose) double-cover for the same finding-type renders once,
  // sourced from the typed path (the more specific signal).
  const gapsFor = (frameworkId: string): string[] =>
    mergedGapsForFramework(frameworkId, controlResults, allFlags);

  const mandatoryRows = mandatoryFrameworks.map(fw => {
    const isActive = activated.has(fw.id);
    if (!isActive) {
      const reason = NOT_TRIGGERED_REASONS[fw.id] ?? 'No matching signals';
      return `| ${fw.name} | ✅ Not applicable | ${reason} |`;
    }
    const gaps = gapsFor(fw.id);
    let displayName = fw.name;
    if (fw.id === 'eu-ai-act' && euClassification) {
      const cls = euClassification.classification;
      if (cls === 'high-risk' && euClassification.annexIIICategories.length > 0) {
        displayName = `${fw.name} — High-Risk (Annex III ${euClassification.annexIIICategories.join(', ')})`;
      } else if (cls === 'limited') {
        displayName = `${fw.name} — Limited-Risk (Art. 50 transparency)`;
      } else if (cls === 'prohibited') {
        displayName = `${fw.name} — Prohibited Practice`;
      }
    }
    if (gaps.length > 0) {
      const condition = APPLICABILITY_CONDITIONS[fw.id] ?? '';
      return `| ${displayName} | ⚠️ ${gaps.length} gap${gaps.length > 1 ? 's' : ''} | ${gaps.join(', ')} — ${condition} |`;
    }
    const condition = APPLICABILITY_CONDITIONS[fw.id] ?? 'Check applicability';
    return `| ${displayName} | ⚠️ Check | ${condition} |`;
  });

  const voluntaryRows = voluntaryFrameworks.map(fw => {
    const gaps = gapsFor(fw.id);
    const { status, details } = formatGaps(gaps);
    return `| ${fw.name} | ${status} | ${details} |`;
  });

  return `### Applicability Summary

| Framework | Status | Gaps Found |
|-----------|--------|------------|
| **Mandatory Law** | | |
${mandatoryRows.join('\n')}
| **Voluntary Frameworks** | | |
${voluntaryRows.join('\n')}`;
}

// ─── Finding-first detail (replaces framework-first tier sections) ────────

/**
 * Build agent-specific gap description from actual report data.
 * Falls back to generic text if no specific context available.
 */
function buildGapDescription(findingType: string, report?: AuditReport): string {
  const systems = report?.systems?.filter(isBusinessSystem) ?? [];
  const systemNames = systems.map(s => s.systemId).join(', ');
  const excessiveScopes = systems.flatMap(s => s.scopesDelta?.map(d => `${s.systemId}: ${d}`) ?? []);
  // AAP-108 (defect 5) — the "on N system(s)" count must reflect only the
  // systems that ACTUALLY carry an excessive scope (a non-empty
  // `scopesDelta`), not the total business-system count. Pre-fix this used
  // `systems.length` (7 in the demo), implying every connected system was
  // over-permissioned when only one (google-drive) had a real scope delta.
  const systemsWithExcessive = systems.filter(
    s => (s.scopesDelta ?? []).some(isProvided),
  ).length;
  const writes = systems.flatMap(s => s.writeOperations?.map(w => `${w.operation} → ${w.target}`) ?? []);
  const hasIrreversible = systems.some(s => s.writeOperations?.some(w => !w.reversible));
  const dataSensitivities = [...new Set(systems.map(s => s.dataSensitivity).filter(Boolean))];
  const decisionDetails = report?.decisionMakingDetails ?? '';

  switch (findingType) {
    case 'excessive-access':
      if (excessiveScopes.length > 0) {
        return `Agent holds permissions beyond stated need on ${systemsWithExcessive} system(s). Excessive scopes detected: ${excessiveScopes.join('; ')}. Narrow each to the minimum required scope.`;
      }
      return `Agent holds permissions beyond stated need on ${systemNames || 'connected systems'}. Review and narrow scopes to the minimum required (least-privilege).`;

    case 'write-risk':
      if (writes.length > 0) {
        const qualifier = hasIrreversible ? 'including irreversible operations' : 'all reported as reversible';
        return `Agent performs ${writes.length} write operation(s) (${qualifier}): ${writes.join('; ')}. Require approval, monitoring, and rollback paths for high-impact operations.`;
      }
      return 'Write operations detected that can affect users or downstream systems. Require approval, monitoring, and rollback paths.';

    case 'sensitive-data':
      if (dataSensitivities.length > 0) {
        return `Agent processes ${dataSensitivities.join(', ')} data across ${systemNames || 'connected systems'}. Ensure lawful basis under GDPR Art. 6, data minimization (Art. 5(1)(c)), and breach-readiness (Art. 33).`;
      }
      return 'Agent processes personal data. Ensure lawful basis, data minimization, and breach-readiness.';

    case 'credential-exposure':
      // AAP-132: plaintext / inactive credential hygiene — security of
      // processing (GDPR Art. 32), NOT personal-data processing.
      return 'Credential material is stored in plaintext or inactive credentials are retained. Encrypt or move secrets to a manager and retire unused credentials (GDPR Art. 32 — security of processing).';

    case 'scope-creep':
      return `Requested scopes on ${systemNames || 'one or more systems'} exceed what is needed for the stated purpose. Review purpose-limitation (GDPR Art. 5(1)(b)) and change-management process.`;

    case 'decisions-about-people':
      if (decisionDetails) {
        return `Agent makes or influences automated decisions affecting individuals: "${decisionDetails.slice(0, 150)}". Requires human oversight, contestability, transparency, and data-subject rights (GDPR Art. 22).`;
      }
      return 'Agent makes or influences automated decisions affecting individuals. Requires human oversight, contestability, transparency, and data-subject rights.';

    case 'regulatory-flags':
      return 'Agent may operate in a regulated domain. Clarify the agent\'s domain to determine sector-specific obligations.';

    default:
      return '';
  }
}

/** Short framework display names for the "Affects" line. */
function frameworkShortName(id: string): string {
  const names: Record<string, string> = {
    'eu-ai-act': 'EU AI Act',
    'gdpr': 'GDPR',
    'iso-42001': 'ISO 42001',
    'aiuc-1': 'AIUC-1 (Q2-2026)',
    'nist-ai-rmf': 'NIST AI RMF',
  };
  return names[id] ?? id;
}

function renderFindingFirstDetail(c: StructuredCompliance, report?: AuditReport): string {
  const controlResults = ((c as any).controlResults ?? []) as ControlResult[];
  const allFlags = (c.all ?? []) as TypedRegulatoryFlag[];

  // Codex post-review fix (Blocker 1): render from a MERGED projection
  // instead of an either/or switch. controlResults is partial — typed
  // detectors cover only some finding-types. Prose-only flags from
  // `compliance.all` describe the rest. We render typed sections first
  // (richer per-control verdict pills) and fall back to the legacy
  // prose path for finding-types the typed projection does NOT cover.
  if (controlResults.length === 0 && allFlags.length === 0) {
    // Nothing on either side — emit the standard "no gaps" stub.
    return `### Compliance Detail\n\n_No compliance gaps identified from current signals._\n`;
  }
  return renderFindingFirstDetailMerged(controlResults, allFlags, report);
}

/**
 * Codex post-review fix (Blocker 1) — MERGED finding-first detail.
 *
 * Renders one section per finding type. Source-of-truth ordering:
 *   1. controlResults (typed detectors) — per-control verdicts surface
 *      with the new badge format.
 *   2. compliance.all (legacy prose flags) — for finding-types the
 *      typed projection does NOT cover. Rendered in the legacy shape so
 *      reader output is identical to the pre-AAP-84 behaviour for any
 *      finding-type without a typed detector.
 *
 * Finding-types that appear in BOTH sources render once, sourced from
 * the typed path (more specific evidence wins).
 */
function renderFindingFirstDetailMerged(
  results: ControlResult[],
  allFlags: TypedRegulatoryFlag[],
  report?: AuditReport,
): string {
  const typedSection = controlResults_renderSections(results, report);
  // AAP-108 (defect 4) — finding-types the typed section actually
  // rendered a BODY for. A finding-type that also appears in the legacy
  // prose flags must NOT re-emit its `#### label` + description block (that
  // is the duplicate-body drift: "two control-mapping rows share one
  // finding body"). The legacy renderer instead folds its residual control
  // citations into an Affects continuation under the already-rendered body.
  const typedRenderedFindingTypes = renderedFindingTypesFromControlResults(results);
  // AAP-121 (S5) — the per-control dedup that used to live here (filtering
  // legacy flags whose `findingType:frameworkId:controlId` a typed result
  // already covered) is GONE. The mapper now owns that precedence: S2's
  // `applyDeterministicPrecedence` (src/compliance/mapper.ts) strips every
  // detector-covered control out of the prose flags — at the SAME per-control
  // grain — before `compliance.all` ever reaches this renderer. Re-running the
  // identical filter here was idempotent dead code (a no-op on real pipeline
  // data), so the flags pass straight through to the legacy renderer. The
  // `alreadyRenderedTypes` guard below still prevents a finding-type BODY from
  // double-rendering across the typed + prose sections (AAP-108 defect 4).
  const legacySection = legacyOnly_renderSections(
    allFlags,
    report,
    typedRenderedFindingTypes,
  );

  const sections = [typedSection, legacySection].filter((s) => s.length > 0);
  if (sections.length === 0) {
    return `### Compliance Detail\n\n_No compliance gaps identified from current signals._\n`;
  }

  let out = `### Compliance Detail\n\n`;
  for (const block of sections) out += block;
  return out;
}

/**
 * AAP-108 (defect 4) — finding-types that `controlResults_renderSections`
 * renders a BODY for. Mirrors that function's own filtering (drop
 * `GAP_EXCLUDED`; keep only finding-types with at least one gap-class
 * control) so the merged renderer knows which bodies the typed section
 * already owns and the legacy path must not duplicate.
 */
function renderedFindingTypesFromControlResults(
  results: ControlResult[],
): Set<string> {
  const deduped = dedupeControlResults(results).filter(
    (r) => !GAP_EXCLUDED.has(r.findingType),
  );
  const byFinding = new Map<string, ControlResult[]>();
  for (const r of deduped) {
    const arr = byFinding.get(r.findingType) ?? [];
    arr.push(r);
    byFinding.set(r.findingType, arr);
  }
  const out = new Set<string>();
  for (const [findingType, all] of byFinding) {
    if (all.some((r) => isGapResult(r))) out.add(findingType);
  }
  return out;
}

/**
 * AAP-84 — typed-projection body renderer. Returns just the per-
 * finding-type body blocks (no `### Compliance Detail` header) so the
 * merged renderer can concatenate them with the legacy body blocks
 * under a single shared header.
 *
 * Renders one section per finding type, grouping controls by framework
 * and SHOWING per-control verdict (`verified | partial | unverified |
 * fail`) honestly rather than collapsing every control under a
 * framework into a single severity.
 *
 * This is the load-bearing renderer migration described in the AAP-84
 * ticket: an auditor who sees `AIUC-1 (A003.3 fail, A003.4 verified)`
 * gets strictly more information than the prior `AIUC-1 (A003.3,
 * A003.4)` flat citation list.
 */
function controlResults_renderSections(
  results: ControlResult[],
  report?: AuditReport,
): string {
  const deduped = dedupeControlResults(results);

  // Only surface gap-class results in the per-finding section. `verified`
  // and `not-applicable` controls don't deserve a "Compliance Detail"
  // entry — they roll up into the applicability summary's "no gaps"
  // marker but the detail block is for things the reader needs to act
  // on. This mirrors the legacy `GAP_EXCLUDED` filter on `triggeredBy`.
  const surfaced = deduped.filter(
    (r) => !GAP_EXCLUDED.has(r.findingType),
  );

  // Group by findingType — same shape the legacy renderer used.
  const byFinding = new Map<string, ControlResult[]>();
  for (const r of surfaced) {
    const arr = byFinding.get(r.findingType) ?? [];
    arr.push(r);
    byFinding.set(r.findingType, arr);
  }

  // Drop finding-type buckets where every control verified or is
  // not-applicable — there's no gap to render.
  const gapFindings = new Map<string, ControlResult[]>();
  for (const [findingType, all] of byFinding) {
    const gaps = all.filter((r) => isGapResult(r));
    if (gaps.length > 0) gapFindings.set(findingType, all);
  }

  if (gapFindings.size === 0) return '';

  let out = '';

  for (const [findingType, ctrls] of gapFindings) {
    const label = GAP_LABELS[findingType] ?? findingType;
    const description = buildGapDescription(findingType, report);

    // Group per-framework so the Affects line stays compact.
    const byFramework = new Map<string, ControlResult[]>();
    for (const r of ctrls) {
      const fwName = frameworkShortName(r.frameworkId);
      const existing = byFramework.get(fwName) ?? [];
      existing.push(r);
      byFramework.set(fwName, existing);
    }

    // Render `Framework (controlId verdict, controlId verdict, …)`. We
    // show every control under the framework, with its verdict suffix
    // so the reader sees evidence-grounded per-control state instead of
    // the legacy collapsed severity.
    const affectsParts = [...byFramework.entries()].map(([fw, rows]) => {
      const seen = new Set<string>();
      const items: string[] = [];
      for (const r of rows) {
        if (seen.has(r.controlId)) continue;
        seen.add(r.controlId);
        items.push(`${r.controlId} ${renderVerdictBadge(r.verdict)}`);
      }
      return items.length === 0 ? fw : `${fw} (${items.join(', ')})`;
    });

    out += `#### ${label}\n\n`;
    out += `${description}\n\n`;
    out += `**Affects:** ${affectsParts.join(' · ')}\n\n`;
  }

  return out;
}

/**
 * Legacy prose-flag body renderer — body blocks only, no header.
 * Codex post-review fix (Blocker 1) consumes this from the merged
 * renderer to surface prose-only flags that have no typed-detector
 * coverage (e.g. finding-types still living on the prose synthesis
 * pre-Phase 9). Pre-AAP-84 markdown contract preserved.
 */
function legacyOnly_renderSections(
  allFlags: TypedRegulatoryFlag[],
  report?: AuditReport,
  alreadyRenderedTypes: ReadonlySet<string> = new Set(),
): string {
  // Group flags by finding type (triggeredBy)
  const byFinding = new Map<string, TypedRegulatoryFlag[]>();
  for (const f of allFlags) {
    if (GAP_EXCLUDED.has(f.triggeredBy)) continue;
    if (f.triggeredBy === 'decisions-about-people' && /no decisions about people/i.test(f.description)) continue;
    const arr = byFinding.get(f.triggeredBy) ?? [];
    arr.push(f);
    byFinding.set(f.triggeredBy, arr);
  }

  if (byFinding.size === 0) return '';

  let out = '';

  for (const [findingType, flags] of byFinding) {
    const label = GAP_LABELS[findingType] ?? findingType;
    const description = buildGapDescription(findingType, report);

    // Group controls by framework for the "Affects" line.
    // Reviewer feedback (2026-04-25): the prior "+N more" truncation
    // ("AIUC-1 (A001, A002, A005, +1 more)") hides the very citations the
    // report is asserting — in an audit deliverable, you don't redact
    // your evidence. The earlier AAP-43 P2 #9 cap (3 per framework) was
    // motivated by readability, not by citation hygiene. With the
    // table-layout: fixed + overflow-wrap CSS now in place, long control
    // lists wrap cleanly inside their cells, so we show the full list.
    const byFramework = new Map<string, string[]>();
    for (const f of flags) {
      const fwName = frameworkShortName(f.frameworkId);
      const existing = byFramework.get(fwName) ?? [];
      for (const ctrl of (f.controlIds ?? [])) {
        if (!existing.includes(ctrl)) existing.push(ctrl);
      }
      byFramework.set(fwName, existing);
    }

    const affectsParts = [...byFramework.entries()].map(([fw, ctrls]) =>
      ctrls.length === 0 ? fw : `${fw} (${ctrls.join(', ')})`,
    );

    // AAP-108 (defect 4) — the typed section already rendered this
    // finding-type's BODY (`#### label` + description). Do NOT repeat it;
    // that is the duplicate-body drift. Emit only the residual legacy
    // control citations as an Affects continuation so the auditor still
    // sees those framework references attached to the single body above.
    if (alreadyRenderedTypes.has(findingType)) {
      if (affectsParts.length > 0) {
        out += `**Affects (self-reported):** ${affectsParts.join(' · ')}\n\n`;
      }
      continue;
    }

    out += `#### ${label}\n\n`;
    out += `${description}\n\n`;
    out += `**Affects:** ${affectsParts.join(' · ')}\n\n`;
  }

  return out;
}

/**
 * AAP-84 — predicate matching `gapResults` filter logic. Inlined here
 * (instead of importing the projection helper) because templates.ts
 * already pulls `dedupeControlResults` and we want the renderer-local
 * decision to be obvious.
 */
function isGapResult(r: ControlResult): boolean {
  return r.verdict === 'fail' || r.verdict === 'partial' || r.verdict === 'unverified';
}

/**
 * AAP-84 — verdict badge for the markdown affects line. Uses unicode
 * marks rather than emoji so the badges render consistently across
 * markdown previewers (the existing applicability summary already
 * mixes ✅ / ⚠️ so we stay consistent).
 *
 *   - `fail`           → ❌ fail
 *   - `partial`        → ⚠️ Needs review   (AAP-130 / B2 — was "partial")
 *   - `unverified`     → ❓ unverified
 *   - `verified`       → ✅ verified
 *   - `not-applicable` → ➖ n/a
 *
 * AAP-130 (B2): the `partial` display string is the shared `verdictDisplayLabel`
 * ("Needs review"), so the markdown badge and the dashboard `ControlRow` badge
 * read identically. The verdict VALUE stays `partial`.
 */
function renderVerdictBadge(verdict: ControlResult['verdict']): string {
  switch (verdict) {
    case 'fail': return '❌ fail';
    case 'partial': return `⚠️ ${verdictDisplayLabel('partial')}`;
    case 'unverified': return '❓ unverified';
    case 'verified': return '✅ verified';
    case 'not-applicable': return '➖ n/a';
    default: return verdict;
  }
}

// ─── Obligations Requiring Further Review ─────────────────────────────────

function renderObligationsChecklist(c: StructuredCompliance, report?: AuditReport): string {
  // Codex post-review fix (Blocker 2): activation comes from BOTH
  // `frameworksActivated` (legacy) AND
  // `activatedFrameworksFromControlResults(controlResults)` (typed).
  // Without this union, a typed-only GDPR fail with empty
  // `frameworksActivated` would skip the entire obligations table.
  const controlResults = ((c as any).controlResults ?? []) as ControlResult[];
  const activated = new Set<string>([
    ...((c as any).frameworksActivated ?? []),
    ...activatedFrameworksFromControlResults(controlResults),
  ]);
  const rows: Array<{ obligation: string; action: string }> = [];

  // AAP-43 P1 #3: GDPR obligations are signal-gated, not dumped as a 14-row
  // boilerplate. Each row requires an explicit signal; if no PII/decisions/
  // transfer signals fire, the table is skipped entirely.
  const hasGdpr = activated.has('gdpr');
  const signals = c.signals;

  if (hasGdpr && signals) {
    // ── PII-driven obligations ──────────────────────────────────────────
    if (signals.hasPII) {
      rows.push({ obligation: 'GDPR Art. 6', action: 'Decide and document WHY you are allowed to process this data (e.g. legitimate business interest — must document a balancing test)' });
      rows.push({ obligation: 'GDPR Art. 13/14', action: 'Tell people you are collecting their data: what, why, how long, and their rights' });
      rows.push({ obligation: 'GDPR Art. 15', action: 'Be ready to show someone all data you hold on them if they ask' });
      rows.push({ obligation: 'GDPR Art. 17', action: "Be ready to delete someone's data from all systems if they ask" });
      rows.push({ obligation: 'GDPR Art. 30', action: 'Keep a written log of what personal data you process, why, and who has access' });
      rows.push({ obligation: 'GDPR Art. 5(1)(e)', action: 'Set rules for how long you keep data — then actually delete it on schedule' });
    }

    // ── Profiling / automated decisions ─────────────────────────────────
    if (signals.hasDecisionsAboutPeople) {
      rows.push({ obligation: 'GDPR Art. 21', action: 'Let people opt out of being profiled for sales/marketing — you must stop if they object' });
    }

    // ── Processor contracts ─────────────────────────────────────────────
    if (signals.hasPII && signals.hasExternalProcessors) {
      // AAP-93 H9 — name actual systems in the obligation copy. Pre-fix
      // hardcoded "(Google, Apify, etc.)" even for audits that touched
      // neither, which read as off-the-shelf boilerplate.
      const procNames = (report?.systems ?? [])
        .filter(isBusinessSystem)
        .map((s) => s.systemId)
        .slice(0, 3);
      const procClause =
        procNames.length > 0
          ? `(e.g. ${procNames.join(', ')})`
          : '(every external service receiving personal data)';
      rows.push({
        obligation: 'GDPR Art. 28',
        action: `Sign data processing contracts with every service you send data to ${procClause}.`,
      });
    }

    // ── DPIA: large-scale OR decisions OR sensitive PII ─────────────────
    if (signals.hasLargeScaleProcessing || signals.hasDecisionsAboutPeople || signals.hasSensitivePII) {
      rows.push({ obligation: 'GDPR Art. 35', action: 'Do a privacy impact assessment before going live (large-scale / profiling / sensitive data → likely required)' });
    }

    // ── International transfer ──────────────────────────────────────────
    if (signals.hasPII && signals.hasInternationalTransfer) {
      // AAP-93 H9 — name the actual destination systems instead of the
      // legacy "Google/Apify" boilerplate.
      const intlNames = (report?.systems ?? [])
        .filter(isBusinessSystem)
        .map((s) => s.systemId)
        .slice(0, 3);
      const intlClause =
        intlNames.length > 0
          ? `(e.g. ${intlNames.join(', ')})`
          : '(non-EU processors)';
      rows.push({
        obligation: 'GDPR Arts. 44-49',
        action: `Data leaves the EU to non-EU processors ${intlClause} — you need a legal basis for that transfer (SCCs, adequacy decision, etc.).`,
      });
    }

    // ── Art. 22 automated-decisions safeguard ───────────────────────────
    if (signals.hasDecisionsAboutPeople) {
      rows.push({ obligation: 'GDPR Art. 22', action: 'AI makes decisions about people: ensure a human can review, people can contest, and the logic is explainable' });
    }
  }

  // Always applicable — baseline operational obligations
  rows.push({ obligation: 'Credentials', action: 'Store API keys/tokens in a secrets manager (not in code or env files), rotate them regularly' });
  // AAP-93 H9 — Platform ToS row is gated on the systems present in the
  // audit. Pre-fix the row hardcoded "LinkedIn, Google, or other
  // connected services (scraping, rate limits, usage policies)" even
  // for audits whose systems didn't touch any of those — that read as
  // boilerplate pollution. The row only renders when at least one
  // business system is present, and the example list is drawn from
  // the actual systems names so the obligation cites real vendors.
  const businessSystems = (report?.systems ?? []).filter(isBusinessSystem);
  if (businessSystems.length > 0) {
    const sysNames = businessSystems
      .map((s) => s.systemId)
      .slice(0, 3)
      .join(', ');
    const sysClause =
      sysNames.length > 0 ? `(e.g. ${sysNames})` : '(connected platforms)';
    rows.push({
      obligation: 'Platform ToS',
      action: `Check you are not violating the rules of the connected platforms ${sysClause} — usage limits, rate limits, prohibited use cases.`,
    });
  }
  rows.push({ obligation: 'Incident response', action: 'Have a plan: if data leaks, who do you notify and within what timeframe? (EU: 72 hours to regulator)' });

  if (rows.length === 0) return '';

  const tableRows = rows.map(r => `| ${r.obligation} | ${r.action} |`).join('\n');

  return `### Obligations Requiring Further Review

The following cannot be assessed from this interview alone — the deployer must address independently:

| Obligation | Action Required |
|------------|-----------------|
${tableRows}`;
}

export function renderStructuredCompliance(
  c: StructuredCompliance,
  report?: AuditReport,
  // AAP-123 (S7) — the coded findings so the per-framework SLF sub-lists can be
  // built. AAP-127 (S11) — those sub-lists are now COMPACT references (code +
  // title, linked to the full card in the GLOBAL stream), so only `code` +
  // `title` are read here; the legacy-risk map + session state, which the
  // AAP-123 full-card path needed, are no longer forwarded to the lens. The
  // params are kept on this (public) signature for caller back-compat — the
  // full global cards (`renderFindingsBlock`) still consume `slfRiskById` /
  // `slfState` upstream.
  slfFindings: readonly CodedVerdictFinding[] = [],
  _slfRiskById?: Map<string, Risk>,
  _slfState?: SlfMitigationState,
): string {
  return [
    `## Regulatory Compliance`,
    ``,
    `### Methodology`,
    ``,
    `Findings are anchored to EU AI Act 2024/1689, GDPR 2016/679, ISO/IEC 42001 (AI management system), AIUC-1 (agent-native standard, pinned to Q2-2026 release 2026-04-15), and NIST AI RMF 1.0 (US-origin voluntary risk-management framework; GOVERN/MAP/MEASURE/MANAGE). Mapping version: \`${c.mappingVersion}\`. EU AI Act is a single framework entry; Annex III high-risk obligations are surfaced as a classification scope label on that entry (replacing the prior two-entry split). Control mappings are indicative — they show which framework clauses a finding typically activates and do not constitute legal advice.`,
    ``,
    renderComplianceLens(c, slfFindings),
    ``,
    renderApplicabilitySummary(c),
    ``,
    renderFindingFirstDetail(c, report),
    renderObligationsChecklist(c, report),
  ].join('\n');
}

function renderRegulatoryCompliance(
  compliance: StructuredCompliance,
  report?: AuditReport,
  slfFindings: readonly CodedVerdictFinding[] = [],
  slfRiskById?: Map<string, Risk>,
  slfState?: SlfMitigationState,
): string {
  return renderStructuredCompliance(compliance, report, slfFindings, slfRiskById, slfState);
}

// ─── Disclaimer ─────────────────────────────────────────────────────────────

function renderDisclaimer(): string {
  return `---

*This report was generated automatically by [Heron](https://github.com/theonaai/Heron), an open-source AI agent auditor. It is based on the agent's self-reported information obtained through a structured interview. This is not a formal security audit, penetration test, or compliance certification. Claims have not been independently verified against tool manifests, runtime behavior, or system configurations. Findings should be independently verified before making access control decisions.*`;
}

// AAP-88: rank mapping `templates_severityOrder_rankMapping` (critical=4,
// high=3, medium=2, low=1, default=0) — categorical rank ordering used to
// sort findings before the Top-N triage split in `renderFindings` and to
// sort discovery diffs in `renderVerificationSection`. Documented in
// src/verification/threshold-manifest.ts.
function severityOrder(severity: string): number {
  switch (severity) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

// ─── Verification (AAP-48) ───────────────────────────────────────────────

/**
 * Render the Markdown "Verification" section for a `VerificationReport`.
 *
 * Exported so the MCP-scan CLI path can splice the section into its existing
 * tool-inventory report without going through the full interrogation report.
 * The same renderer will be called from the full report pipeline once
 * AAP-49 wires it in.
 *
 * Output escaping: MCP-server-supplied strings (tool descriptions,
 * annotations) are treated as untrusted. We escape `<`, `>`, leading `!`
 * + `[` (image syntax), and pipe characters to defend against layout
 * injection and credential-leaking hot-linked images. The same pattern
 * mirrors the PR #14 F-6 hardening; when the wider report renderer
 * adopts a shared escape helper, swap this inline helper for it.
 */
export function renderVerificationSection(report: VerificationReport): string {
  const lines: string[] = [];
  lines.push('## Verification');
  lines.push('');

  // Verdict summary table — one row per source.
  lines.push('| Source | Verdict | Findings |');
  lines.push('| --- | --- | --- |');
  for (const s of report.sources) {
    const verdictLabel = formatVerdict(s.verdict);
    const findingsCell = s.verdict === 'unverified' ? '—' : String(s.diffs.length);
    lines.push(`| ${escapeCell(s.sourceId)} | ${verdictLabel} | ${findingsCell} |`);
  }
  lines.push('');

  // Findings — flatten across sources, sort by severity desc, then kind.
  lines.push('### Findings');
  lines.push('');
  const allDiffs: DiffEntry[] = report.sources.flatMap(s => s.diffs);
  if (allDiffs.length === 0) {
    lines.push('_No discrepancies found._');
  } else {
    const sorted = [...allDiffs].sort((a, b) => {
      const sevDelta = severityOrder(b.severity) - severityOrder(a.severity);
      if (sevDelta !== 0) return sevDelta;
      // Stable secondary sort by kind so the rendered order matches the
      // golden snapshots regardless of map insertion order.
      const kindRank: Record<DiffEntry['kind'], number> = { extra: 0, mismatch: 1, missing: 2 };
      return kindRank[a.kind] - kindRank[b.kind];
    });
    for (const d of sorted) {
      lines.push(...renderDiffEntry(d));
    }
  }
  lines.push('');

  // Sources — per-source provenance and error surfacing.
  lines.push('### Sources');
  lines.push('');
  for (const s of report.sources) {
    lines.push(renderSourceLine(s));
  }

  // AAP-49: framework mapping section appears AFTER the existing
  // verification table and per-source provenance — it is the synthesis
  // layer that explains what the diffs MEAN for compliance. Section
  // is only rendered when the orchestrator attached a mapping (i.e.
  // HERON_FRAMEWORK_MAPPING_DISABLED was not set).
  if (report.frameworkMapping) {
    lines.push('');
    lines.push(renderFrameworkMappingSection(report.frameworkMapping));
  }

  return lines.join('\n');
}

function formatVerdict(v: VerificationVerdict): string {
  switch (v) {
    case 'verified': return 'Verified';
    case 'discrepancy': return 'Discrepancy';
    case 'unverified': return 'Unverified';
    default: {
      const _exhaustive: never = v;
      void _exhaustive;
      return String(v);
    }
  }
}

function renderDiffEntry(d: DiffEntry): string[] {
  const sev = d.severity.toUpperCase();
  const src = escapeText(d.source);

  if (d.kind === 'extra') {
    const name = d.dimension === 'tool'
      ? (d.actual as { name: string }).name
      : `${(d.actual as { service: string }).service}:${(d.actual as { scope: string }).scope}`;
    const header = d.dimension === 'tool'
      ? `- **[${sev}] Extra ${d.dimension} \`${escapeInlineCode(name)}\`** (${src})`
      : `- **[${sev}] Extra ${d.dimension} \`${escapeInlineCode(name)}\`** (${src})`;
    const out: string[] = [header];
    if (d.dimension === 'tool') {
      const desc = (d.actual as { description?: string }).description;
      if (desc) out.push(`  - Description: ${escapeText(desc)}`);
    }
    return out;
  }

  if (d.kind === 'missing') {
    const name = d.dimension === 'tool'
      ? (d.declared as { name: string }).name
      : `${(d.declared as { service: string }).service}:${(d.declared as { scope: string }).scope}`;
    return [
      `- **[${sev}] Missing ${d.dimension} \`${escapeInlineCode(name)}\`** (${src}, declared but not exposed by the source)`,
    ];
  }

  // mismatch
  const decl = d.dimension === 'tool'
    ? (d.declared as { name: string; description?: string })
    : null;
  const act = d.dimension === 'tool'
    ? (d.actual as { name: string; description?: string })
    : null;
  if (decl && act) {
    const out: string[] = [
      `- **[${sev}] Mismatch on tool \`${escapeInlineCode(act.name)}\`** (${src}, declared description differs from actual)`,
    ];
    if (decl.description) out.push(`  - Declared: ${escapeText(decl.description)}`);
    if (act.description) out.push(`  - Actual: ${escapeText(act.description)}`);
    return out;
  }
  // Scope mismatches do not currently fire (the differ does not produce
  // them), but keep a sensible fallback so the renderer never crashes on
  // a future expansion.
  return [`- **[${sev}] Mismatch on ${d.dimension}** (${src})`];
}

function renderSourceLine(s: SourceVerification): string {
  const id = escapeText(s.sourceId);
  if (s.error) {
    return `- ${id} — **read failed** (${escapeText(s.error.kind)}): ${escapeText(s.error.message)}`;
  }
  const ts = s.inventory?.capturedAt ?? '(unknown)';
  const toolCount = s.inventory?.tools?.length;
  const scopeCount = s.inventory?.scopes?.length;
  const parts: string[] = [];
  if (toolCount !== undefined) parts.push(`${toolCount} tool${toolCount === 1 ? '' : 's'}`);
  if (scopeCount !== undefined) parts.push(`${scopeCount} scope${scopeCount === 1 ? '' : 's'}`);
  const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  const head = `- ${id} — read succeeded at ${escapeText(ts)}${detail}`;
  // F-1 (PR #16 round 2): surface warnings under the source line so an
  // auditor reading the report can tell a partial read from a complete
  // one. Without this, a 4-probe oauth-scopes source with 2 failed
  // probes would render identically to a clean run.
  if (s.warnings && s.warnings.length > 0) {
    const warned = s.warnings
      .map(w => `  - warning: ${escapeText(w)}`)
      .join('\n');
    return `${head}\n${warned}`;
  }
  return head;
}

// Escape helpers — see `src/util/markdown-escape.ts`. Re-imported above as
// `escapeText`, `escapeInlineCode`, and (under the local alias `escapeCell`)
// `escapeTableCell` to keep the call sites in this file stable.

// ─── AAP-56 — Analysis-failed report ─────────────────────────────────────────
//
// When `analyzeTranscript` fails (double-parse failure, LLM 502, network
// timeout) we MUST NOT produce a normal-shaped report. The previous behaviour
// fabricated a clean-looking "LOW RISK / APPROVE WITH CONDITIONS" report from
// an empty fallback object, which a reviewer could mistake for a real clean
// audit. Heron strategy v3.0 forbids self-attestation without verification.
//
// `renderAnalysisFailedReport` emits a dedicated markdown body that:
//   • leads with "REPORT GENERATION FAILED"
//   • explains why (reason + last error + timestamp + attempt count)
//   • preserves the verbatim transcript for manual review
//   • intentionally OMITS risk badges, findings, compliance, recommendations
//
// The renderer is stateless and side-effect-free. Wiring lives in
// `src/server/sessions.ts` (storage) and `src/server/mcp-server.ts`
// (transport).

const FAILURE_REASON_LABELS: Record<AnalyzeFailureReason, string> = {
  parse_failure: 'LLM response could not be parsed',
  llm_unreachable: 'LLM gateway unreachable',
  unknown: 'Unknown analyzer failure',
};

export interface AnalysisFailedReportMeta {
  agentName?: string;
  sessionId: string;
  questionsAsked: number;
  analysisError: {
    reason: AnalyzeFailureReason;
    message: string;
    responsePreview?: string;
    attemptCount: number;
    occurredAt: string;
  };
}

/**
 * Render the AAP-56 "analysis failed" markdown report.
 *
 * No risk level, no verdict, no findings, no compliance section. Just an
 * explicit failure banner + the transcript. Callers should write this to
 * `report.md` and set the session status to `'analysis_failed'` — they must
 * NOT also write `report.json`, since there is no analysis to serialize.
 */
export function renderAnalysisFailedReport(
  transcript: QAPair[],
  meta: AnalysisFailedReportMeta,
): string {
  const { analysisError } = meta;
  const reasonLabel = FAILURE_REASON_LABELS[analysisError.reason];

  // Header — also surfaces agentName + sessionId so a triage operator can
  // find the right session from a copy/pasted report.
  const headerLines = ['# Agent Access Audit — REPORT GENERATION FAILED', ''];
  const subtitleParts: string[] = [];
  if (meta.agentName && meta.agentName.length > 0) {
    subtitleParts.push(`**Agent**: ${escapeText(meta.agentName)}`);
  }
  subtitleParts.push(`**Session**: \`${escapeInlineCode(meta.sessionId)}\``);
  headerLines.push(subtitleParts.join(' · '));

  // Failure banner — blockquote so it renders distinct from prose.
  const bannerLines = [
    '',
    '> **This audit could not produce a verified report.**',
    `> The LLM analysis step failed after ${analysisError.attemptCount} attempts.`,
    `> Reason: **${reasonLabel}**`,
    `> Last error: \`${escapeInlineCode(analysisError.message)}\``,
    `> Occurred at: ${analysisError.occurredAt}`,
    '> ',
    '> Heron does not produce a risk verdict when the analysis cannot complete.',
    '> No findings, no recommendations, and no framework mapping are surfaced below.',
    '> The interview transcript is preserved verbatim for manual review.',
    '> ',
    '> **To retry:** Re-run the audit once the underlying LLM gateway is reachable.',
  ];

  // Transcript — same shape as the success-path transcript block (Q1/Q2/…).
  const transcriptHeader = `## Interview transcript (${transcript.length} questions)`;
  const transcriptBody = transcript
    .map(
      (qa, i) =>
        `### Q${i + 1} [${escapeText(qa.category)}]\n\n**Q:** ${escapeText(qa.question)}\n\n**A:** ${escapeText(qa.answer)}`,
    )
    .join('\n\n');

  const footer =
    '_End of report. Findings, risk level, and compliance sections are intentionally omitted because no analysis was performed._';

  const sections = [
    headerLines.join('\n'),
    bannerLines.join('\n'),
    transcriptHeader + (transcript.length > 0 ? '\n\n' + transcriptBody : ''),
    footer,
  ];

  return sections.join('\n\n---\n\n');
}
