import type { AnalyzeFailureReason } from '../analysis/analyzer.js';
import type { AuditReport, QAPair, DataQuality, Risk, SystemAssessment, WriteOperation, StructuredCompliance, RegulatoryFlag } from './types.js';
import type { TypedRegulatoryFlag } from '../compliance/mapper.js';
import { isProvided, UNKNOWN_PLACEHOLDER } from '../util/provided.js';
import { isBusinessSystem } from '../util/systems.js';
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
import type { Verdict } from '../verification/verdict.js';
import type { DiscoveryFinding } from '../discovery/types.js';

// ─── AAP-43 P1 #5: overall regulatory status ──────────────────────────────

/**
 * Reduce all activated framework flags into a single status label + gap
 * counter. Replaces the prior EU/US/UK jurisdiction matrix which couldn't
 * vary without US/UK frameworks in the OSS registry.
 *
 * Labels (descending severity):
 *   - "Action Required"      — at least one action-required flag
 *   - "Needs Clarification"  — at least one clarification-needed flag
 *   - "Review"               — at least one warning-level flag
 *   - "Not Triggered"        — no activated framework flags
 */
function summarizeOverallStatus(c: StructuredCompliance): string {
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
  /** Optional per-source verification status for the report header. */
  discoveryStatus?: 'ran' | 'skipped' | 'failed';
  oauthIntrospectionStatus?: Array<{ provider: string; status: 'ran' | 'skipped' | 'failed' }>;
}

export function renderMarkdownReport(
  report: AuditReport,
  context: RenderMarkdownReportContext = {},
): string {
  const verdict = context.verdict;
  const discoveryFindings = context.discoveryFindings ?? [];

  const sections = [
    renderHeader(report, verdict),
    // AAP-63 — Verification Status sits near the top so an auditor sees
    // "deterministic or not?" before reading any findings.
    renderVerificationStatusSection(verdict, context),
    renderScopeAndMethodology(report),
    renderSummary(report, verdict),
    renderAgentProfile(report),
    // AAP-63 — discrepancies between Surface 1 claims and Surface 2
    // evidence appear above the findings tables so the reviewer is
    // primed to read findings critically.
    renderDiscrepanciesSection(verdict),
    renderFindingsSplit(
      report.risks,
      report.compliance as StructuredCompliance | undefined,
      discoveryFindings,
    ),
    renderSystems(report.systems),
    renderPositiveFindings(report),
    renderVerdict(report),
    report.compliance ? renderRegulatoryCompliance(report.compliance as StructuredCompliance, report) : null,
    report.dataQuality ? renderDataQuality(report.dataQuality) : null,
    renderTranscript(report.transcript),
    renderDisclaimer(),
  ];

  return sections.filter(Boolean).join('\n\n---\n\n');
}

// ─── Header ──────────────────────────────────────────────────────────────────

function renderHeader(report: AuditReport, verdict?: Verdict): string {
  // Reviewer feedback (2026-04-25): the prior `!!` exclamation marker on
  // HIGH/CRITICAL headers ("Risk Level: HIGH !!") was called out as
  // "not a serious-document tone" — CISOs do not want excitement in audit
  // headers. The `**Risk Level**: HIGH` label itself is already strong;
  // the riskIcon adds nothing and undercuts credibility. Dropped.
  const dqPart = report.dataQuality ? ` | **Data Quality**: ${report.dataQuality.score}/100` : '';

  // AAP-63 — the header risk level now comes from the verdict's
  // primaryRiskLevel when supplied. When no verdict is attached we
  // fall back to the legacy `overallRiskLevel` from the analyzer for
  // back-compat (e.g. the existing report golden tests that don't
  // thread a verdict in). The label is hedged with "self-reported"
  // when the primary verdict is `'unverified'`.
  const primaryRisk =
    verdict?.primaryRiskLevel ?? report.overallRiskLevel;
  const riskLine =
    verdict && verdict.primaryRiskSource !== 'no-evidence'
      ? `**Risk Level (Verified)**: ${primaryRisk.toUpperCase()}`
      : verdict
        ? `**Risk Level**: UNVERIFIED (self-reported only — run discovery to verify)`
        : `**Risk Level**: ${report.overallRiskLevel.toUpperCase()}`;

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

  return `# Agent Access Audit Report

**Generated**: ${report.metadata.date} | **Agent**: ${report.metadata.target} | ${riskLine}${dqPart}${regLine}`;
}

// ─── Scope & Methodology ────────────────────────────────────────────────────

function renderScopeAndMethodology(report: AuditReport): string {
  return `## Scope & Methodology

**Assessment type**: Automated structured interview

**Method**: Heron conducted a ${report.metadata.questionsAsked}-question interview covering agent purpose, data access, permissions, write operations, and operational frequency. **Duration**: ${Math.round(report.metadata.interviewDuration / 1000)}s.

**Limitations**: This assessment is based solely on the agent's self-reported information. No runtime analysis, code review, or network traffic inspection was performed. Findings should be verified against actual system configurations.`;
}

// ─── Data Quality Badge ──────────────────────────────────────────────────────

function renderDataQuality(dq: DataQuality): string {
  const provided = dq.fieldsProvided.length;
  const total = provided + dq.fieldsMissing.length;
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

function renderSummary(report: AuditReport, verdict?: Verdict): string {
  // Dashboard: finding counts by severity
  const allRisks = report.risks;
  const countBySeverity = (sev: string) => allRisks.filter(r => r.severity === sev).length;
  const critical = countBySeverity('critical');
  const high = countBySeverity('high');
  const medium = countBySeverity('medium');
  const low = countBySeverity('low');

  const findingsParts: string[] = [];
  if (critical > 0) findingsParts.push(`${critical} Critical`);
  if (high > 0) findingsParts.push(`${high} High`);
  if (medium > 0) findingsParts.push(`${medium} Medium`);
  if (low > 0) findingsParts.push(`${low} Low`);
  if (findingsParts.length === 0) findingsParts.push('None');

  const systemCount = report.systems.filter(isBusinessSystem).length;

  // AAP-63 — the executive-summary dashboard now carries TWO risk
  // columns: "Verified Risk" (deterministic Surface 2) and
  // "Self-reported Risk" (LLM Surface 1, italicised). When no verdict
  // is attached we fall back to the legacy single-column layout.
  let dashboard: string;
  if (verdict) {
    const verifiedCell =
      verdict.primaryRiskSource === 'deterministic'
        ? `**${(verdict.deterministicRiskLevel ?? 'unknown').toUpperCase()}**`
        : '**UNVERIFIED**';
    const selfReportedCell = verdict.interviewRiskLevel
      ? `_${verdict.interviewRiskLevel.toUpperCase()} (self-report only)_`
      : '_n/a_';
    dashboard = `| Verified Risk | Self-reported Risk | Systems | Findings |
|------|------|---------|----------|
| ${verifiedCell} | ${selfReportedCell} | ${systemCount} | ${findingsParts.join(', ')} |`;
  } else {
    dashboard = `| Risk | Systems | Findings |
|------|---------|----------|
| **${report.overallRiskLevel.toUpperCase()}** | ${systemCount} | ${findingsParts.join(', ')} |`;
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
  // Agent name — best-effort: metadata.target is the canonical handle the
  // CLI / dashboard surface. Fall back to first systemId, then to a stub.
  const agentName =
    report.metadata?.target ||
    report.systems[0]?.systemId ||
    'unknown-agent';

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

function renderSystems(systems: SystemAssessment[]): string {
  const businessSystems = systems.filter(isBusinessSystem);

  if (businessSystems.length === 0) {
    return `## Systems & Access

No systems were identified in the interview.`;
  }

  const cards = businessSystems.map(renderSystemCard).join('\n\n');

  return `## Systems & Access

${cards}`;
}

function computeSystemRisk(sys: SystemAssessment): string {
  let score = 0;
  // Blast radius
  const brScores: Record<string, number> = { 'single-record': 0, 'single-user': 1, 'team-scope': 2, 'org-wide': 3, 'cross-tenant': 4 };
  score += brScores[sys.blastRadius] ?? 1;
  // Excessive scopes
  if (sys.scopesDelta.length > 0) score += 1;
  // Irreversible writes
  if (sys.writeOperations.some(w => !w.reversible)) score += 2;
  // Data sensitivity
  if (/pii|personal|health|financial|credit/i.test(sys.dataSensitivity)) score += 1;

  if (score >= 5) return 'HIGH';
  if (score >= 3) return 'MEDIUM';
  return 'LOW';
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
function renderSystemCard(sys: SystemAssessment): string {
  const rows: Array<[string, string]> = [];
  const risk = computeSystemRisk(sys);

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
  rows.push([
    'Scopes granted',
    scopes.length > 0 ? scopes.join(', ') : `_${UNKNOWN_PLACEHOLDER}_`,
  ]);

  const needed = sys.scopesNeeded.filter(isProvided);
  if (needed.length > 0) {
    rows.push(['Scopes needed', needed.join(', ')]);
  }

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
  if (excessive.length > 0) {
    rows.push(['Excessive', excessive.join(', ')]);
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

  return `### ${sys.systemId} — Risk: ${risk}${descriptionLine}

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
    return volFlags.slice(0, 3).map(f => `${f.frameworkId === 'eu-ai-act' ? 'EU AI Act' : f.framework.split(' — ')[0]}`).join(', ');
  }

  // Show top 3 mandatory, framework name + first control ID
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
function renderVerificationStatusSection(
  verdict: Verdict | undefined,
  context: RenderMarkdownReportContext,
): string {
  const status = verdict?.status ?? 'unverified';
  const lines: string[] = ['## Verification Status', ''];
  if (status === 'unverified') {
    lines.push(
      '**Verification status:** _UNVERIFIED — Surface 2 deterministic sources have not run yet._',
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
    const discoveryStatus = context.discoveryStatus ?? 'ran';
    lines.push(`| Filesystem discovery (Surface 2) | ${discoveryStatus} |`);
    const oauthRows = context.oauthIntrospectionStatus ?? [];
    if (oauthRows.length === 0) {
      lines.push(`| OAuth introspection (Surface 2) | skipped |`);
    } else {
      for (const r of oauthRows) {
        lines.push(`| OAuth introspection — ${escapeCell(r.provider)} | ${r.status} |`);
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
    'Surface 2 evidence contradicts a self-reported claim from the interview. Each row pairs the interview claim with the deterministic finding so a reviewer can decide whether the agent was misconfigured, misunderstood, or misrepresenting its own behaviour.',
  );
  lines.push('');
  lines.push('| Severity | Interview claim | Surface 2 evidence |');
  lines.push('| --- | --- | --- |');
  for (const d of verdict.discrepancies) {
    lines.push(
      `| ${d.severity.toUpperCase()} | ${escapeCell(d.claim)} | ${escapeCell(d.evidence)} |`,
    );
  }
  return lines.join('\n');
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
  lines.push('### Deterministic Findings (Surface 2)');
  lines.push('');
  if (discoveryFindings.length === 0) {
    lines.push('_No deterministic findings — either the discovery scan has not run yet, or it ran and found no inconsistencies. Re-run discovery if the agent configuration has changed._');
  } else {
    lines.push('| Kind | Severity | Server / Runtime | Description |');
    lines.push('| --- | --- | --- | --- |');
    for (const f of discoveryFindings) {
      lines.push(
        `| ${escapeCell(f.kind)} | ${f.severity} | ${escapeCell(f.serverName)} / ${escapeCell(f.runtime)} | ${escapeCell(f.description)} |`,
      );
    }
  }
  lines.push('');

  // ── Self-Reported (Surface 1) ────────────────────────────────────
  lines.push('### Self-Reported Findings (Surface 1)');
  lines.push('');
  lines.push(
    '_These findings are derived from the agent\'s interview answers and should be verified against Surface 2 evidence. They are supplementary narrative, not the primary verdict._',
  );
  lines.push('');
  lines.push(renderFindings(risks, compliance).replace(/^## Findings\n\n/, ''));

  return lines.join('\n');
}

// ─── Positive Findings ─────────────────────────────────────────────────────

function renderPositiveFindings(report: AuditReport): string {
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
  const totalExcessive = systems.reduce((n, s) => n + s.scopesDelta.length, 0);
  const hasAccessRisk = report.risks.some((r) => {
    if (r.severity !== 'high' && r.severity !== 'critical') return false;
    const t = inferFindingType(r);
    return t === 'excessive-access' || t === 'scope-creep';
  });
  if (totalExcessive === 0 && systems.length > 0 && !hasAccessRisk) {
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

function renderVerdict(report: AuditReport): string {
  // Never allow bare APPROVE for self-reported interview — always at least "WITH CONDITIONS"
  let verdict = report.recommendation ?? 'APPROVE WITH CONDITIONS';
  if (verdict === 'APPROVE') {
    verdict = 'APPROVE WITH CONDITIONS';
  }
  const recs = report.recommendations;

  // Ensure standard condition is always present
  const standardCondition = 'Verify self-reported claims against actual system configurations before granting production access';
  const allRecs = recs.some(r => /verify.*self.reported|verify.*claim/i.test(r))
    ? recs
    : [standardCondition, ...recs];

  let body = `**${verdict}**`;

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
          // Strip the title prefix from the body if it's the same span
          // (avoid "Foo. Foo. ..." duplication when title IS the body).
          const sameTitle = title === r.trim() || title === `${r.trim()}.`;
          if (sameTitle) {
            return `> **${title}**`;
          }
          return `> **${title}** ${r.trim()}`;
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

function formatGaps(gaps: string[]): { status: string; details: string } {
  if (gaps.length === 0) return { status: '✅ No gaps', details: '—' };
  return {
    status: `⚠️ ${gaps.length} gap${gaps.length > 1 ? 's' : ''}`,
    details: gaps.join(', '),
  };
}

function renderApplicabilitySummary(c: StructuredCompliance): string {
  const activated = new Set((c as any).frameworksActivated ?? []);
  const allFlags = (c.all ?? []) as TypedRegulatoryFlag[];

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

  const mandatoryRows = mandatoryFrameworks.map(fw => {
    const isActive = activated.has(fw.id);
    if (!isActive) {
      const reason = NOT_TRIGGERED_REASONS[fw.id] ?? 'No matching signals';
      return `| ${fw.name} | ✅ Not applicable | ${reason} |`;
    }
    const gaps = getGaps(fw.id, allFlags);
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
    const gaps = getGaps(fw.id, allFlags);
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
  const writes = systems.flatMap(s => s.writeOperations?.map(w => `${w.operation} → ${w.target}`) ?? []);
  const hasIrreversible = systems.some(s => s.writeOperations?.some(w => !w.reversible));
  const dataSensitivities = [...new Set(systems.map(s => s.dataSensitivity).filter(Boolean))];
  const decisionDetails = report?.decisionMakingDetails ?? '';

  switch (findingType) {
    case 'excessive-access':
      if (excessiveScopes.length > 0) {
        return `Agent holds permissions beyond stated need on ${systems.length} system(s). Excessive scopes detected: ${excessiveScopes.join('; ')}. Narrow each to the minimum required scope.`;
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
  const allFlags = (c.all ?? []) as TypedRegulatoryFlag[];

  // Group flags by finding type (triggeredBy)
  const byFinding = new Map<string, TypedRegulatoryFlag[]>();
  for (const f of allFlags) {
    if (GAP_EXCLUDED.has(f.triggeredBy)) continue;
    if (f.triggeredBy === 'decisions-about-people' && /no decisions about people/i.test(f.description)) continue;
    const arr = byFinding.get(f.triggeredBy) ?? [];
    arr.push(f);
    byFinding.set(f.triggeredBy, arr);
  }

  if (byFinding.size === 0) {
    return `### Compliance Detail\n\n_No compliance gaps identified from current signals._\n`;
  }

  let out = `### Compliance Detail\n\n`;

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

    out += `#### ${label}\n\n`;
    out += `${description}\n\n`;
    out += `**Affects:** ${affectsParts.join(' · ')}\n\n`;
  }

  return out;
}

// ─── Obligations Requiring Further Review ─────────────────────────────────

function renderObligationsChecklist(c: StructuredCompliance, report?: AuditReport): string {
  const activated = new Set((c as any).frameworksActivated ?? []);
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
      rows.push({ obligation: 'GDPR Art. 28', action: 'Sign data processing contracts with every service you send data to (Google, Apify, etc.)' });
    }

    // ── DPIA: large-scale OR decisions OR sensitive PII ─────────────────
    if (signals.hasLargeScaleProcessing || signals.hasDecisionsAboutPeople || signals.hasSensitivePII) {
      rows.push({ obligation: 'GDPR Art. 35', action: 'Do a privacy impact assessment before going live (large-scale / profiling / sensitive data → likely required)' });
    }

    // ── International transfer ──────────────────────────────────────────
    if (signals.hasPII && signals.hasInternationalTransfer) {
      rows.push({ obligation: 'GDPR Arts. 44-49', action: 'Data leaves the EU (e.g. to US-based Google/Apify) — you need a legal basis for that transfer (SCCs, adequacy decision, etc.)' });
    }

    // ── Art. 22 automated-decisions safeguard ───────────────────────────
    if (signals.hasDecisionsAboutPeople) {
      rows.push({ obligation: 'GDPR Art. 22', action: 'AI makes decisions about people: ensure a human can review, people can contest, and the logic is explainable' });
    }
  }

  // Always applicable — baseline operational obligations
  rows.push({ obligation: 'Credentials', action: 'Store API keys/tokens in a secrets manager (not in code or env files), rotate them regularly' });
  rows.push({ obligation: 'Platform ToS', action: 'Check you are not violating the rules of LinkedIn, Google, or other connected services (scraping, rate limits, usage policies)' });
  rows.push({ obligation: 'Incident response', action: 'Have a plan: if data leaks, who do you notify and within what timeframe? (EU: 72 hours to regulator)' });

  if (rows.length === 0) return '';

  const tableRows = rows.map(r => `| ${r.obligation} | ${r.action} |`).join('\n');

  return `### Obligations Requiring Further Review

The following cannot be assessed from this interview alone — the deployer must address independently:

| Obligation | Action Required |
|------------|-----------------|
${tableRows}`;
}

export function renderStructuredCompliance(c: StructuredCompliance, report?: AuditReport): string {
  return [
    `## Regulatory Compliance`,
    ``,
    `### Methodology`,
    ``,
    `Findings are anchored to EU AI Act 2024/1689, GDPR 2016/679, ISO/IEC 42001 (AI management system), AIUC-1 (agent-native standard, pinned to Q2-2026 release 2026-04-15), and NIST AI RMF 1.0 (US-origin voluntary risk-management framework; GOVERN/MAP/MEASURE/MANAGE). Mapping version: \`${c.mappingVersion}\`. EU AI Act is a single framework entry; Annex III high-risk obligations are surfaced as a classification scope label on that entry (replacing the prior two-entry split). Control mappings are indicative — they show which framework clauses a finding typically activates and do not constitute legal advice.`,
    ``,
    renderApplicabilitySummary(c),
    ``,
    renderFindingFirstDetail(c, report),
    renderObligationsChecklist(c, report),
  ].join('\n');
}

function renderRegulatoryCompliance(compliance: StructuredCompliance, report?: AuditReport): string {
  return renderStructuredCompliance(compliance, report);
}

// ─── Disclaimer ─────────────────────────────────────────────────────────────

function renderDisclaimer(): string {
  return `---

*This report was generated automatically by [Heron](https://github.com/theonaai/Heron), an open-source AI agent auditor. It is based on the agent's self-reported information obtained through a structured interview. This is not a formal security audit, penetration test, or compliance certification. Claims have not been independently verified against tool manifests, runtime behavior, or system configurations. Findings should be independently verified before making access control decisions.*`;
}

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
