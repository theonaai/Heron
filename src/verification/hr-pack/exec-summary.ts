/**
 * DPO-readable Executive Summary renderer (AAP-51, pilot deliverable #6).
 *
 * Produces a 1-page memo placed at the TOP of the verification report.
 * The DPO does not read the per-control table — the exec summary is
 * the headline view for someone making the go/no-go call on production
 * agent access.
 *
 * Layout (Markdown):
 *   # Executive Summary
 *   **Agent:** ...   **Owner:** ...   **Scan Date:** ...   **Vertical:** ...
 *   ## Compliance Posture
 *   ## Headline Findings
 *   ## Framework Coverage
 *   ## Recommended Actions
 *   ## Approval Trail
 *   ---
 *   *Detailed findings below.*
 *
 * Inputs:
 *   - `VerificationReport`: provides declared.agent.{name,owner,purpose},
 *     frameworkMapping (when present), approvalChain (when present).
 *   - `HRPackResult`: provides HR signal verdicts + recommendations
 *     for the headline + actions sections.
 *
 * Output escaping: all user-controlled strings (agent name, owner,
 * actor names, rationales, recommendations) flow through `escapeText`
 * and are truncated to bounded lengths so an attacker cannot push a
 * multi-MB blob or smuggle Markdown injection through the exec summary.
 *
 * Graceful degradation:
 *   - Missing `frameworkMapping` → "framework mapping disabled" line.
 *   - Missing `approvalChain`    → "Not recorded — required for
 *                                    compliance evidence pack."
 *   - Missing `declared[0].agent` → falls back to `agentLabel` and
 *                                    "Owner not declared".
 *
 * Tracking: https://linear.app/theona/issue/AAP-51
 */

import { escapeText, truncateControlChars } from '../../util/markdown-escape.js';
import type { VerificationReport } from '../types.js';
import type {
  ControlSeverity,
  ControlVerdict,
  FrameworkControl,
  FrameworkId,
} from '../frameworks/types.js';
import type { HRPackResult, HRSignal } from './types.js';

/** Bounded length for free-form fields in the exec summary. */
const MAX_NAME_LEN = 128;
const MAX_OWNER_LEN = 128;
const MAX_RECOMMENDATION_LEN = 255;
const MAX_RATIONALE_LEN = 255;

/** Truncate + control-strip + escapeText, in that order. */
function safeField(value: string | undefined, maxLen: number, fallback: string): string {
  if (value === undefined || value.length === 0) return fallback;
  return escapeText(truncateControlChars(value, maxLen));
}

const SEVERITY_RANK: Record<ControlSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/**
 * One unified "issue" view spanning HR signals + framework controls.
 * Used for the headline-findings sort which is severity-first across
 * BOTH signal classes.
 */
interface HeadlineItem {
  severity: ControlSeverity;
  label: string;       // "CRITICAL" / "HIGH" / ...
  title: string;       // human-readable name
  rationale: string;   // short rationale used as the body
  citation: string;    // framework citation (e.g. "GDPR Article 22")
}

function severityLabel(s: ControlSeverity): string {
  return s.toUpperCase();
}

/**
 * Map an HR signal to a citation string by signalId. Static lookup —
 * keeps the citation text in one place so a future regulator update
 * touches one file.
 */
const HR_CITATIONS: Record<string, string> = {
  'auto-rejection-without-disclosure': 'GDPR Article 22, NYC LL 144',
  'ats-write-scope-sprawl': 'AIUC-1 B006 (least-privilege)',
  'candidate-pii-in-logs': 'GDPR Article 5',
  'scoring-without-criteria': 'EU AI Act Annex III §4',
  'do-not-contact-bypass': 'GDPR Article 21, CAN-SPAM',
  'offer-letter-out-of-range': 'Compensation policy',
  'sub-agent-scope-expansion': 'AIUC-1 D003',
};

function frameworkCitation(c: FrameworkControl): string {
  const fwLabel: Record<FrameworkId, string> = {
    'aiuc-1': 'AIUC-1',
    'eu-ai-act': 'EU AI Act',
    'gdpr': 'GDPR',
    'nist-ai-rmf': 'NIST AI RMF',
  };
  return `${fwLabel[c.framework]} ${c.controlId}`;
}

function collectHeadlineItems(
  report: VerificationReport,
  hr: HRPackResult,
): HeadlineItem[] {
  const items: HeadlineItem[] = [];
  for (const sig of hr.signals) {
    if (sig.verdict !== 'detected') continue;
    items.push({
      severity: sig.severity,
      label: severityLabel(sig.severity),
      title: sig.name,
      rationale: sig.rationale,
      citation: HR_CITATIONS[sig.signalId] ?? 'HR vertical pack',
    });
  }
  if (report.frameworkMapping) {
    for (const c of report.frameworkMapping.controls) {
      if (c.verdict !== 'fail') continue;
      items.push({
        severity: c.severity,
        label: severityLabel(c.severity),
        title: c.controlName,
        rationale: c.rationale,
        citation: frameworkCitation(c),
      });
    }
  }
  items.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  return items;
}

/**
 * Render the overall verdict line. Three branches:
 *   - Any HR-pack critical detected OR any framework FAIL with
 *     critical severity → "Partial compliance — N critical issues".
 *   - Any HR-pack detected OR any framework FAIL → "Partial".
 *   - Else → "Clean".
 */
function renderCompliancePosture(hr: HRPackResult, report: VerificationReport): string {
  const fmFails = report.frameworkMapping
    ? report.frameworkMapping.controls.filter((c) => c.verdict === 'fail')
    : [];
  const criticalCount =
    hr.summary.criticalDetected +
    fmFails.filter((c) => c.severity === 'critical').length;
  const totalFails = hr.summary.detectedCount + fmFails.length;

  if (criticalCount > 0) {
    return `**Overall verdict:** ⚠ Partial compliance — ${criticalCount} critical issue${criticalCount === 1 ? '' : 's'} detected.`;
  }
  if (totalFails > 0) {
    return `**Overall verdict:** ⚠ Partial compliance — ${totalFails} issue${totalFails === 1 ? '' : 's'} detected.`;
  }
  return '**Overall verdict:** ✓ Clean — no critical issues detected.';
}

function renderHeadlineFindings(items: HeadlineItem[]): string {
  if (items.length === 0) {
    return '## Headline Findings\n\n_No critical or high-severity issues detected._';
  }
  const top = items.slice(0, 5);
  const lines: string[] = ['## Headline Findings', ''];
  for (let i = 0; i < top.length; i++) {
    const it = top[i]!;
    const title = escapeText(truncateControlChars(it.title, MAX_NAME_LEN));
    const cite = escapeText(truncateControlChars(it.citation, MAX_NAME_LEN));
    lines.push(`${i + 1}. **${it.label}:** ${title}. (${cite})`);
  }
  return lines.join('\n');
}

function renderFrameworkCoverage(report: VerificationReport): string {
  if (!report.frameworkMapping) {
    return '## Framework Coverage\n\n_framework mapping disabled (HERON_FRAMEWORK_MAPPING_DISABLED=true)._';
  }
  const byFramework = new Map<FrameworkId, FrameworkControl[]>();
  for (const c of report.frameworkMapping.controls) {
    const arr = byFramework.get(c.framework) ?? [];
    arr.push(c);
    byFramework.set(c.framework, arr);
  }
  const fwLabel: Record<FrameworkId, string> = {
    'aiuc-1': 'AIUC-1',
    'eu-ai-act': 'EU AI Act',
    'gdpr': 'GDPR',
    'nist-ai-rmf': 'NIST AI RMF',
  };
  const lines: string[] = ['## Framework Coverage', ''];
  for (const [fw, controls] of byFramework) {
    const total = controls.length;
    const verified = controls.filter((c) => c.verdict === 'verified').length;
    const fails = controls.filter((c) => c.verdict === 'fail');
    const partials = controls.filter((c) => c.verdict === 'partial');
    const failList = fails.length > 0 ? `, ${fails.length} fail (${fails.map((c) => escapeText(c.controlId)).join(', ')})` : '';
    const partialList = partials.length > 0 ? `, ${partials.length} partial` : '';
    lines.push(`- **${fwLabel[fw]}:** ${verified}/${total} controls verified${failList}${partialList}`);
  }
  return lines.join('\n');
}

function renderRecommendedActions(hr: HRPackResult, report: VerificationReport): string {
  const recs: string[] = [];
  const seen = new Set<string>();
  for (const sig of hr.signals) {
    if (sig.verdict !== 'detected') continue;
    const r = escapeText(truncateControlChars(sig.recommendation, MAX_RECOMMENDATION_LEN));
    if (!seen.has(r)) {
      seen.add(r);
      recs.push(r);
    }
  }
  if (report.frameworkMapping) {
    for (const c of report.frameworkMapping.controls) {
      if (c.verdict !== 'fail') continue;
      const r = escapeText(
        truncateControlChars(
          `Address ${frameworkCitation(c)} (${c.controlName}): ${c.rationale}`,
          MAX_RECOMMENDATION_LEN,
        ),
      );
      if (!seen.has(r)) {
        seen.add(r);
        recs.push(r);
      }
    }
  }
  if (recs.length === 0) {
    return '## Recommended Actions\n\n_No corrective actions required._';
  }
  const lines: string[] = ['## Recommended Actions', ''];
  for (let i = 0; i < recs.length; i++) {
    lines.push(`${i + 1}. ${recs[i]}`);
  }
  return lines.join('\n');
}

function renderApprovalTrail(report: VerificationReport): string {
  if (!report.approvalChain) {
    return '## Approval Trail\n\n_Not recorded — required for compliance evidence pack._';
  }
  const chain = report.approvalChain.chain;
  const integrity = report.approvalChain.integrity;

  const declared = chain.entries.find((e) => e.action === 'declared');
  const reviewed = chain.entries.find((e) => e.action === 'reviewed');
  const approved = chain.entries.find((e) => e.action === 'approved');

  const lines: string[] = ['## Approval Trail', ''];
  if (declared) {
    lines.push(
      `- **Declared:** ${escapeText(truncateControlChars(declared.actor.name, MAX_NAME_LEN))} (${escapeText(truncateControlChars(declared.actor.role, MAX_NAME_LEN))}), ${escapeText(declared.timestamp)}`,
    );
  }
  if (reviewed) {
    lines.push(
      `- **Reviewed:** ${escapeText(truncateControlChars(reviewed.actor.name, MAX_NAME_LEN))} (${escapeText(truncateControlChars(reviewed.actor.role, MAX_NAME_LEN))}), ${escapeText(reviewed.timestamp)}`,
    );
  }
  if (approved) {
    lines.push(
      `- **Approved:** ${escapeText(truncateControlChars(approved.actor.name, MAX_NAME_LEN))} (${escapeText(truncateControlChars(approved.actor.role, MAX_NAME_LEN))}), ${escapeText(approved.timestamp)}`,
    );
  }
  lines.push('');
  if (integrity.ok) {
    lines.push(`Chain integrity: ✓ Intact (${chain.entries.length} entries, SHA-256 hash chain verified)`);
  } else {
    lines.push(`Chain integrity: ✕ BROKEN at entry ${integrity.brokenAt} — audit trail cannot be trusted`);
  }
  void MAX_RATIONALE_LEN; // reserved for future detail row
  return lines.join('\n');
}

/**
 * Render the DPO-grade executive summary.
 *
 * Returns a single Markdown string. Caller is responsible for
 * placing this at the TOP of the verification report (the CLI does
 * this in `src/commands/mcp-scan.ts`).
 */
export function renderExecutiveSummary(
  report: VerificationReport,
  hr: HRPackResult,
): string {
  const declared = report.declared[0];
  const agent = declared?.agent;

  const name = safeField(
    agent?.name,
    MAX_NAME_LEN,
    safeField(report.agentLabel, MAX_NAME_LEN, 'Unknown agent'),
  );
  const owner = safeField(agent?.owner, MAX_OWNER_LEN, 'Owner not declared');
  const scanDate = escapeText(report.capturedAt);
  const vertical = hr.isHRAgent ? 'HR / Recruiting' : 'Generic agent';

  const headlineItems = collectHeadlineItems(report, hr);

  const out: string[] = [];
  out.push('# Executive Summary');
  out.push('');
  out.push(`**Agent:** ${name}`);
  out.push(`**Owner:** ${owner}`);
  out.push(`**Scan Date:** ${scanDate}`);
  out.push(`**Vertical:** ${vertical}`);
  out.push('');
  out.push('## Compliance Posture');
  out.push('');
  out.push(renderCompliancePosture(hr, report));
  out.push('');
  out.push(renderHeadlineFindings(headlineItems));
  out.push('');
  out.push(renderFrameworkCoverage(report));
  out.push('');
  out.push(renderRecommendedActions(hr, report));
  out.push('');
  out.push(renderApprovalTrail(report));
  out.push('');
  out.push('---');
  out.push('');
  out.push('*Detailed findings below.*');

  return out.join('\n');
}
