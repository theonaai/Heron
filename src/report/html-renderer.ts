/**
 * AAP-54 — Production-grade HTML renderer for `VerificationReport`.
 *
 * Replaces the prior `markdownToHtml(markdown)` path for `--format html`
 * and the `/scans/:id` server route. Produces a self-contained,
 * SOC-style report document — cover, numbered TOC, executive summary,
 * agent specification, verification results, framework mapping, HR
 * vertical signals (when applicable), approval audit trail (when
 * present), conclusion, appendix.
 *
 * Design is ported from Heron_v1's `ReportView.tsx` + `report.css`
 * (both repos owned by Ilya Ivanov, same author). React component
 * structure was the reference for which sections exist and how they
 * lay out; the CSS lives in `./styles.ts` (`REPORT_CSS` constant).
 *
 * Security:
 *   - Every user-controlled string flows through `escapeHtml` at the
 *     boundary. Tool names, scope strings, actor names/roles/emails,
 *     comments, evidence refs, agent label/owner/purpose are ALL
 *     escaped before they touch the output buffer.
 *   - The CSS is shipped inline (no external <style> file) and the
 *     ONE external resource is the Google Fonts stylesheet for the
 *     typography stack — degrades gracefully to the system stack when
 *     unreachable (offline / DPO firewall / static-export viewer).
 *
 * Backwards compat:
 *   - `markdownToHtml` + `SHARED_CSS` in `src/server/render.ts` stay
 *     intact and continue to power interview-session pages
 *     (`/sessions/:id`) which still emit markdown-shaped reports.
 *   - This module is opt-in: callers route their VerificationReport
 *     here explicitly; nothing previously rendering via markdown is
 *     touched until the call site is migrated.
 */
import type { ApprovalChain, ApprovalEntry } from '../approvals/types.js';
import type {
  ControlSeverity,
  ControlVerdict,
  FrameworkControl,
  FrameworkId,
  FrameworkMapping,
} from '../verification/frameworks/types.js';
import type {
  HRPackResult,
  HRSignal,
  HRSignalSeverity,
  HRSignalVerdict,
} from '../verification/hr-pack/types.js';
import type {
  DeclaredInventory,
  DiffEntry,
  DiffSeverity,
  SourceVerification,
  VerificationReport,
} from '../verification/types.js';
import { FAVICON_LINK } from '../server/render.js';
import { HERON_LOGO_SVG } from './logo.js';
import { REPORT_CSS, REPORT_FONTS_HEAD } from './styles.js';

// ─── Public types ───────────────────────────────────────────────────

export interface HtmlRenderOptions {
  /** Human-readable agent label for the cover. */
  agentLabel: string;
  /** Unique evaluation / scan id printed on the cover. */
  evaluationId: string;
  /** ISO-8601 timestamp printed as "Generated …" on the cover. */
  generatedAt: string;
  /**
   * Optional HR pack result. When present and `isHRAgent === true`,
   * the HR Vertical Signals section is rendered. Computed separately
   * (in `runHRPack`) so this module stays a pure renderer.
   */
  hrPack?: HRPackResult;
  /**
   * Optional MCP target string (sanitised, as stored in `ScanRecord.mcpConfig`).
   * Rendered in Agent Specification when present.
   */
  mcpConfig?: string;
}

export interface ComplianceScoreResult {
  /** Two-decimal score 0..100. */
  score: number;
  /** PASSED / PARTIAL / FAILED. */
  verdict: 'PASSED' | 'PARTIAL' | 'FAILED';
  /** Threshold for PASSED/PARTIAL, currently fixed at 70.00. */
  threshold: number;
}

// ─── Escape helpers ────────────────────────────────────────────────

/**
 * Escape the four HTML metacharacters needed for safe rendering in this
 * file: `&`, `<`, `>`, `"`. Defensive against `null` / `undefined`
 * (those coerce to the empty string rather than the literal "null").
 *
 * Single-quote (`'`) is intentionally NOT escaped. Safe ONLY because
 * every attribute value emitted by this renderer is wrapped in double
 * quotes. If a future contributor adds a single-quoted attribute they
 * MUST escape `'` here too — or, better, keep using double quotes and
 * preserve the renderer-wide invariant.
 *
 * The four-character set is also what every browser HTML serialiser
 * emits for `textContent` and attribute interpolation; staying inside
 * this set keeps the output byte-identical to what the DOM would
 * produce for the same logical string.
 */
export function escapeHtml(s: unknown): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Replace internal newlines with `<br>` (text input only). */
function nl2br(s: string): string {
  return s.replace(/\n/g, '<br>');
}

// ─── Score computation ─────────────────────────────────────────────

/**
 * Two-axis verdict logic:
 *  - PASSED: 0 critical fails AND 0 high fails AND score >= 85
 *  - PARTIAL: 0 critical AND <=3 high AND score >= 70
 *  - FAILED: anything else
 *
 * When `frameworkMapping` is absent OR has no evaluable controls, we
 * cannot honestly score the agent — return FAILED with score 0 rather
 * than fabricate a passing verdict. The cover surfaces this explicitly
 * via the executive summary's fallback text.
 *
 * AAP-88: thresholds documented in src/verification/threshold-manifest.ts.
 *   - htmlRenderer_complianceScore_threshold (PARTIAL/PASSED threshold = 70)
 *   - htmlRenderer_complianceScore_passedThreshold (PASSED threshold = 85)
 *   - htmlRenderer_complianceScore_partialMaxHighFails (PARTIAL max highs = 3)
 *   - htmlRenderer_complianceScore_zeroCriticalForPassed (categorical gate)
 *   - htmlRenderer_complianceScore_partialCounts (partial counts 0.5x)
 *   - htmlRenderer_complianceScore_emptyMappingFailed (categorical gate)
 */
export function computeComplianceScore(report: VerificationReport): ComplianceScoreResult {
  const threshold = 70;
  const fm = report.frameworkMapping;
  // PR #25 round 2 (MEDIUM): 3-way guard. The type contract guarantees
  // `controls` is an array, but a corrupted / partial-mock report can
  // arrive with `controls === undefined` and the previous
  // `fm.controls.length` access threw `TypeError`. Bail out early with
  // a FAILED verdict instead of crashing the renderer.
  if (!fm || !fm.controls || fm.controls.length === 0) {
    return { score: 0, verdict: 'FAILED', threshold };
  }
  // PR #25 round 2 (LOW): clamp negative summary counts at zero. A
  // corrupted state where (e.g.) `verifiedCount === -1` would otherwise
  // produce a nonsense PASSED verdict from `(-1)/(-1)*100 === 100`.
  const verifiedCount = Math.max(0, fm.summary.verifiedCount);
  const partialCount = Math.max(0, fm.summary.partialCount);
  const failCount = Math.max(0, fm.summary.failCount);
  const unverifiedCount = Math.max(0, fm.summary.unverifiedCount);
  const total = verifiedCount + partialCount + failCount + unverifiedCount;
  if (total === 0) {
    return { score: 0, verdict: 'FAILED', threshold };
  }
  const raw = ((verifiedCount + 0.5 * partialCount) / total) * 100;
  const score = Math.round(raw * 100) / 100;

  const critFails = fm.controls.filter((c) => c.verdict === 'fail' && c.severity === 'critical').length;
  const highFails = fm.controls.filter((c) => c.verdict === 'fail' && c.severity === 'high').length;

  let verdict: ComplianceScoreResult['verdict'];
  if (critFails === 0 && highFails === 0 && score >= 85) verdict = 'PASSED';
  else if (critFails === 0 && highFails <= 3 && score >= threshold) verdict = 'PARTIAL';
  else verdict = 'FAILED';

  return { score, verdict, threshold };
}

// ─── Pill helpers ──────────────────────────────────────────────────

const SEVERITY_CLASSES: Record<string, string> = {
  critical: 'sev sev-critical',
  high: 'sev sev-high',
  medium: 'sev sev-medium',
  low: 'sev sev-low',
  info: 'sev sev-info',
};

export function severityPillClass(severity: string): string {
  return SEVERITY_CLASSES[severity.toLowerCase()] ?? 'sev sev-neutral';
}

function severityPill(s: DiffSeverity | ControlSeverity | HRSignalSeverity | string): string {
  return `<span class="${severityPillClass(s)}">${escapeHtml(s)}</span>`;
}

const VERDICT_CLASSES: Record<string, string> = {
  verified: 'vp vp-verified',
  partial: 'vp vp-partial',
  fail: 'vp vp-fail',
  unverified: 'vp vp-unverified',
  'not-applicable': 'vp vp-not-applicable',
  discrepancy: 'vp vp-discrepancy',
  detected: 'vp vp-detected',
  'not-detected': 'vp vp-not-detected',
};

function verdictPill(v: ControlVerdict | HRSignalVerdict | string): string {
  const cls = VERDICT_CLASSES[v] ?? 'vp vp-unverified';
  return `<span class="${cls}">${escapeHtml(v)}</span>`;
}

// ─── Framework display ─────────────────────────────────────────────

const FRAMEWORK_DISPLAY: Record<FrameworkId, string> = {
  'aiuc-1': 'AIUC-1',
  'eu-ai-act': 'EU AI Act',
  'gdpr': 'GDPR',
  'nist-ai-rmf': 'NIST AI RMF',
};

function frameworkLabel(f: FrameworkId): string {
  return FRAMEWORK_DISPLAY[f] ?? String(f);
}

// ─── Section primitives ───────────────────────────────────────────

/**
 * Section header: number + title only. We dropped the original
 * `<span class="label">Section</span>` after Ilya's PR #25 review —
 * the word "Section" next to every numbered header was template noise
 * that added no information. The `.label` CSS rule still exists for
 * future use but is not emitted by the default header anymore.
 */
function sectionHeader(num: string, title: string, meta?: string, anchor?: string): string {
  const id = anchor ? ` id="${escapeHtml(anchor)}"` : '';
  return `<div class="h-section"${id}>
  <span class="num">${escapeHtml(num)}</span>
  <span class="title">${escapeHtml(title)}</span>
  ${meta ? `<span class="meta">${escapeHtml(meta)}</span>` : ''}
</div>`;
}

function kv(rows: Array<[string, string | null | undefined]>): string {
  // null/undefined values dropped — keep the table tight.
  const visible = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (visible.length === 0) return '';
  const body = visible
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v ?? ''}</dd>`)
    .join('\n');
  return `<dl class="kv">${body}</dl>`;
}

function callout(text: string, tone: 'info' | 'warn' | 'fail' | 'ok' | 'neutral' = 'neutral'): string {
  const cls = tone === 'neutral' ? 'callout' : `callout callout-${tone}`;
  return `<div class="${cls}">${text}</div>`;
}

// ─── Cover ─────────────────────────────────────────────────────────

function verdictBadgeClass(v: ComplianceScoreResult['verdict']): string {
  switch (v) {
    case 'PASSED': return 'verdict-badge verdict-passed';
    case 'PARTIAL': return 'verdict-badge verdict-partial';
    case 'FAILED': return 'verdict-badge verdict-failed';
  }
}

/**
 * Format an ISO-8601 timestamp as "YYYY-MM-DD HH:MM UTC". Readers don't
 * care about milliseconds; the full ISO form on the cover was telemetry
 * noise. We strip control chars defensively, then parse.
 */
function formatGeneratedTimestamp(iso: string): string {
  // Defensive: a corrupted opts.generatedAt should not crash the cover.
  if (typeof iso !== 'string' || iso.length === 0) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    // Fall back to the raw string (escaped) rather than fabricate a date.
    return iso;
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

function renderCoverPage(_report: VerificationReport, opts: HtmlRenderOptions, score: ComplianceScoreResult): string {
  // PR #26: editorial polish after Ilya's PR #25 review.
  // - Brand strip is Heron mark only — the "Open-Source Agent
  //   Verification" tag underneath was redundant: the h1 + subtitle
  //   below already explain what the report is.
  // - h1 changes from "AI Agent Scope Verification & Compliance
  //   Assessment" (AI-stuffed compound noun phrase) to the cleaner
  //   "Compliance Evidence Pack" with a "Scope verification report"
  //   subtitle.
  // - Verdict badge inner content is a single word now. The previous
  //   structure had <span class="verdict-label">Overall verdict</span>
  //   inside the badge, which diluted the visual punch — Vijil's badge
  //   is just "PASSED" / "FAILED" / "PARTIAL".
  // - Cover meta is a <dl class="cover-meta"> with 3 items: Agent,
  //   Evaluation ID, Generated. Captured was a near-duplicate of
  //   Generated and confused readers about which is which.
  // - Generated timestamp is formatted YYYY-MM-DD HH:MM UTC rather
  //   than the raw ISO with milliseconds.
  // PR #25 round 2 (LOW): the original cover code wrote
  // `${scoreClass ? 'mono' : 'mono'}` — a dead ternary whose two
  // branches were identical. The design intent here is to tag the
  // verdict label with both the typographic class (`mono`) and the
  // verdict-tone class (`warn` / `crit`) so the cover can colour it.
  // PASSED stays plain `mono` (no extra tone). Combining both classes
  // restores the original intent without leaving the dead branch.
  const scoreToneClass = score.verdict === 'PASSED' ? 'mono' : score.verdict === 'PARTIAL' ? 'mono warn' : 'mono crit';
  const generatedFormatted = formatGeneratedTimestamp(opts.generatedAt);
  // PR #29 / AAP-58: embed the Heron brand mark as an inline SVG next
  // to the wordmark. The constant in ./logo.js carries class="cover-logo"
  // and fill="currentColor"; sizing lives in styles.ts (.cover-logo).
  return `<section class="cover">
  <div class="cover-brand">
    ${HERON_LOGO_SVG}
    <span class="cover-mark">Heron</span>
  </div>
  <div class="cover-titles">
    <h1 class="cover-title">Compliance Evidence Pack</h1>
    <p class="cover-subtitle">Scope verification report</p>
  </div>
  <div class="cover-summary-row">
    <div class="${verdictBadgeClass(score.verdict)}">${escapeHtml(score.verdict)}</div>
    <div class="score-block">
      <span class="score-label">Compliance Score</span>
      <span class="score-value">${score.score.toFixed(2)}</span>
      <span class="score-threshold">Threshold: ${score.threshold.toFixed(2)} <span class="muted">(<span class="${scoreToneClass}">${score.verdict}</span>)</span></span>
    </div>
  </div>
  <dl class="cover-meta">
    <dt>Agent</dt><dd>${escapeHtml(opts.agentLabel)}</dd>
    <dt>Evaluation ID</dt><dd><code class="mono">${escapeHtml(opts.evaluationId)}</code></dd>
    <dt>Generated</dt><dd>${escapeHtml(generatedFormatted)}</dd>
  </dl>
</section>`;
}

// ─── Table of contents ────────────────────────────────────────────

function renderTOC(opts: { isHR: boolean; hasChain: boolean }): string {
  const items: Array<[string, string, string]> = [
    ['01', 'sec-exec-summary', 'Executive Summary'],
    ['02', 'sec-agent-spec', 'Agent Specification'],
    ['03', 'sec-verification', 'Verification Results'],
    ['04', 'sec-frameworks', 'Compliance Framework Mapping'],
  ];
  let n = 5;
  if (opts.isHR) {
    items.push([String(n++).padStart(2, '0'), 'sec-hr', 'HR Vertical Signals']);
  }
  if (opts.hasChain) {
    items.push([String(n++).padStart(2, '0'), 'sec-approval', 'Approval Audit Trail']);
  }
  items.push([String(n++).padStart(2, '0'), 'sec-conclusion', 'Conclusion']);
  items.push([String(n++).padStart(2, '0'), 'sec-appendix', 'Appendix']);

  const li = items
    .map(([num, anchor, title]) =>
      `<li><span class="toc-num">${escapeHtml(num)}</span><a href="#${escapeHtml(anchor)}">${escapeHtml(title)}</a></li>`,
    )
    .join('\n');

  return `<nav class="toc">
  <div class="toc-title">Contents</div>
  <ol class="toc-list">${li}</ol>
</nav>`;
}

// ─── Section 1 — Executive summary ────────────────────────────────

/**
 * Pluralise a noun by count. Avoids the robot "(s)" suffix that reads
 * like template output rather than human writing.
 */
function pluralise(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : (plural ?? `${singular}s`);
}

/**
 * Static framework-label table — mirrored from exec-summary.ts so the
 * HTML renderer can build citations without round-tripping through the
 * markdown layer.
 */
const FRAMEWORK_CITATION_LABEL: Record<FrameworkId, string> = {
  'aiuc-1': 'AIUC-1',
  'eu-ai-act': 'EU AI Act',
  'gdpr': 'GDPR',
  'nist-ai-rmf': 'NIST AI RMF',
};

const SEVERITY_RANK_EXEC: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/**
 * Headline finding item — unified view across HR signals and framework
 * controls so the headline list can be sorted by severity once.
 */
interface HeadlineRow {
  severity: ControlSeverity | HRSignalSeverity;
  title: string;
  citation: string;
}

/**
 * Citation table for HR signals — duplicated from exec-summary.ts so
 * the HTML renderer can build citations directly. The pair stays in
 * sync: changing one without the other is a review-time defect to call
 * out.
 */
const HR_SIGNAL_CITATIONS: Record<string, string> = {
  'auto-rejection-without-disclosure': 'GDPR Article 22, NYC LL 144',
  'ats-write-scope-sprawl': 'AIUC-1 B006 (least-privilege)',
  'candidate-pii-in-logs': 'GDPR Article 5',
  'scoring-without-criteria': 'EU AI Act Annex III §4',
  'do-not-contact-bypass': 'GDPR Article 21, CAN-SPAM',
  'offer-letter-out-of-range': 'Compensation policy',
  'sub-agent-scope-expansion': 'AIUC-1 D003',
};

function collectHeadlineRows(report: VerificationReport, hr?: HRPackResult): HeadlineRow[] {
  const rows: HeadlineRow[] = [];
  if (hr) {
    for (const sig of hr.signals) {
      if (sig.verdict !== 'detected') continue;
      rows.push({
        severity: sig.severity,
        title: sig.name,
        citation: HR_SIGNAL_CITATIONS[sig.signalId] ?? 'HR vertical pack',
      });
    }
  }
  if (report.frameworkMapping) {
    for (const c of report.frameworkMapping.controls) {
      if (c.verdict !== 'fail') continue;
      rows.push({
        severity: c.severity,
        title: c.controlName,
        citation: `${FRAMEWORK_CITATION_LABEL[c.framework]} ${c.controlId}`,
      });
    }
  }
  rows.sort((a, b) => (SEVERITY_RANK_EXEC[b.severity] ?? 0) - (SEVERITY_RANK_EXEC[a.severity] ?? 0));
  return rows;
}

function renderCompliancePostureLine(score: ComplianceScoreResult, report: VerificationReport, hr?: HRPackResult): string {
  const fmFails = report.frameworkMapping?.controls.filter((c) => c.verdict === 'fail') ?? [];
  const criticalCount =
    (hr?.summary.criticalDetected ?? 0) +
    fmFails.filter((c) => c.severity === 'critical').length;
  const highCount =
    (hr?.summary.highDetected ?? 0) +
    fmFails.filter((c) => c.severity === 'high').length;
  const totalFails = (hr?.summary.detectedCount ?? 0) + fmFails.length;

  if (!report.frameworkMapping) {
    return `<strong>Overall verdict:</strong> ${escapeHtml(score.verdict)} — framework mapping was not evaluated, so a compliance verdict cannot be issued.`;
  }
  if (criticalCount > 0) {
    return `<strong>Overall verdict:</strong> ${escapeHtml(score.verdict)} — ${criticalCount} critical ${pluralise(criticalCount, 'issue')} detected.`;
  }
  if (highCount > 0) {
    return `<strong>Overall verdict:</strong> ${escapeHtml(score.verdict)} — ${highCount} high-severity ${pluralise(highCount, 'issue')} detected.`;
  }
  if (totalFails > 0) {
    return `<strong>Overall verdict:</strong> ${escapeHtml(score.verdict)} — ${totalFails} ${pluralise(totalFails, 'issue')} detected.`;
  }
  return `<strong>Overall verdict:</strong> ${escapeHtml(score.verdict)} — no critical or high-severity issues detected.`;
}

function renderHeadlineFindingsBlock(rows: HeadlineRow[]): string {
  if (rows.length === 0) {
    return `<div class="exec-sub">
  <h3>Headline Findings</h3>
  <p class="muted">No critical or high-severity issues detected.</p>
</div>`;
  }
  // AAP-88: threshold `htmlRenderer_headlineFindings_topN` = 5.
  // See src/verification/threshold-manifest.ts.
  const top = rows.slice(0, 5);
  const items = top
    .map((r) => {
      const sevClass = severityPillClass(String(r.severity));
      const sevLabel = String(r.severity).toUpperCase();
      return `    <li><span class="${sevClass}">${escapeHtml(sevLabel)}</span> ${escapeHtml(r.title)}. <span class="muted">(${escapeHtml(r.citation)})</span></li>`;
    })
    .join('\n');
  return `<div class="exec-sub">
  <h3>Headline Findings</h3>
  <ol class="findings-list">
${items}
  </ol>
</div>`;
}

function renderFrameworkCoverageBlock(report: VerificationReport): string {
  if (!report.frameworkMapping) {
    return `<div class="exec-sub">
  <h3>Framework Coverage</h3>
  <p class="muted">Framework mapping disabled — no per-framework coverage to report.</p>
</div>`;
  }
  const byFramework = new Map<FrameworkId, FrameworkControl[]>();
  for (const c of report.frameworkMapping.controls) {
    if (!byFramework.has(c.framework)) byFramework.set(c.framework, []);
    byFramework.get(c.framework)!.push(c);
  }
  const items: string[] = [];
  for (const [fw, controls] of byFramework) {
    const total = controls.length;
    const verified = controls.filter((c) => c.verdict === 'verified').length;
    const fails = controls.filter((c) => c.verdict === 'fail').length;
    const partials = controls.filter((c) => c.verdict === 'partial').length;
    const failPart = fails > 0 ? `, ${fails} ${pluralise(fails, 'fail', 'fails')}` : '';
    const partialPart = partials > 0 ? `, ${partials} partial` : '';
    items.push(`    <li><strong>${escapeHtml(FRAMEWORK_CITATION_LABEL[fw])}:</strong> ${verified}/${total} verified${failPart}${partialPart}</li>`);
  }
  return `<div class="exec-sub">
  <h3>Framework Coverage</h3>
  <ul class="framework-coverage">
${items.join('\n')}
  </ul>
</div>`;
}

function renderRecommendedActionsBlock(report: VerificationReport, hr?: HRPackResult): string {
  const recs: string[] = [];
  const seen = new Set<string>();
  if (hr) {
    for (const sig of hr.signals) {
      if (sig.verdict !== 'detected') continue;
      const r = sig.recommendation;
      if (!seen.has(r)) {
        seen.add(r);
        recs.push(r);
      }
    }
  }
  if (report.frameworkMapping) {
    for (const c of report.frameworkMapping.controls) {
      if (c.verdict !== 'fail') continue;
      const r = `Address ${FRAMEWORK_CITATION_LABEL[c.framework]} ${c.controlId} (${c.controlName}): ${c.rationale}`;
      if (!seen.has(r)) {
        seen.add(r);
        recs.push(r);
      }
    }
  }
  if (recs.length === 0) {
    return `<div class="exec-sub">
  <h3>Recommended Actions</h3>
  <p class="muted">No corrective actions required.</p>
</div>`;
  }
  // AAP-88: threshold `htmlRenderer_recommendedActions_topN` = 5.
  // See src/verification/threshold-manifest.ts.
  const items = recs.slice(0, 5).map((r) => `    <li>${escapeHtml(r)}</li>`).join('\n');
  return `<div class="exec-sub">
  <h3>Recommended Actions</h3>
  <ol class="recommended-actions">
${items}
  </ol>
</div>`;
}

function renderApprovalTrailBlock(report: VerificationReport): string {
  if (!report.approvalChain) return '';
  const chain = report.approvalChain.chain;
  const integrity = report.approvalChain.integrity;
  const declared = chain.entries.find((e) => e.action === 'declared');
  const reviewed = chain.entries.find((e) => e.action === 'reviewed');
  const approved = chain.entries.find((e) => e.action === 'approved');

  const fmtDate = (iso: string): string => {
    // Trim ISO timestamp to YYYY-MM-DD so the trail reads like a memo not a log line.
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(iso);
    return m ? m[1]! : iso;
  };

  const lines: string[] = [];
  if (declared) {
    lines.push(`    <li><strong>Declared:</strong> ${escapeHtml(declared.actor.name)} (${escapeHtml(declared.actor.role)}), ${escapeHtml(fmtDate(declared.timestamp))}</li>`);
  }
  if (reviewed) {
    lines.push(`    <li><strong>Reviewed:</strong> ${escapeHtml(reviewed.actor.name)} (${escapeHtml(reviewed.actor.role)}), ${escapeHtml(fmtDate(reviewed.timestamp))}</li>`);
  }
  if (approved) {
    lines.push(`    <li><strong>Approved:</strong> ${escapeHtml(approved.actor.name)} (${escapeHtml(approved.actor.role)}), ${escapeHtml(fmtDate(approved.timestamp))}</li>`);
  }
  const integrityLine = integrity.ok
    ? '<p class="chain-status">Chain integrity: <strong>Intact</strong></p>'
    : `<p class="chain-status">Chain integrity: <strong>BROKEN at entry ${integrity.brokenAt}</strong> — ${escapeHtml(integrity.reason)}</p>`;
  return `<div class="exec-sub">
  <h3>Approval Trail</h3>
  <ul class="approval-summary">
${lines.join('\n')}
  </ul>
  ${integrityLine}
</div>`;
}

function renderExecutiveSummary(report: VerificationReport, opts: HtmlRenderOptions, score: ComplianceScoreResult): string {
  // PR #25 round 2 (LOW): `?? []` is belt-and-braces — the type
  // contract guarantees `sources`, but a partial mock or future caller
  // could pass `undefined`. The renderer must not crash on missing
  // optional collections.
  const sourceCount = (report.sources ?? []).length;
  const sourceWord = pluralise(sourceCount, 'verification source', 'verification sources');
  const verdictPhrase =
    score.verdict === 'PASSED' ? 'passed' :
      score.verdict === 'PARTIAL' ? 'partially passed' :
        'failed';
  let calloutBody: string;
  if (!report.frameworkMapping) {
    calloutBody = `This evaluation assessed <strong>${escapeHtml(opts.agentLabel)}</strong> against ${sourceCount} ${sourceWord} covering scope and approval lifecycle. Framework mapping was not evaluated, so a compliance verdict cannot be issued; the agent is reported as <strong>${escapeHtml(score.verdict)}</strong> until framework analysis is enabled.`;
  } else {
    calloutBody = `This evaluation assessed <strong>${escapeHtml(opts.agentLabel)}</strong> against ${sourceCount} ${sourceWord} covering scope, framework compliance, and approval lifecycle. The agent <strong>${verdictPhrase}</strong> with overall compliance score of <strong>${score.score.toFixed(2)}</strong> (threshold: ${score.threshold.toFixed(2)}).`;
  }

  const headline = collectHeadlineRows(report, opts.hrPack);

  const tone = score.verdict === 'PASSED' ? 'ok' : score.verdict === 'PARTIAL' ? 'warn' : 'fail';

  const parts: string[] = [
    sectionHeader('01', 'Executive Summary', undefined, 'sec-exec-summary'),
    callout(calloutBody, tone),
    `<div class="exec-sub">
  <h3>Compliance Posture</h3>
  <p>${renderCompliancePostureLine(score, report, opts.hrPack)}</p>
</div>`,
    renderHeadlineFindingsBlock(headline),
    renderFrameworkCoverageBlock(report),
    renderRecommendedActionsBlock(report, opts.hrPack),
    renderApprovalTrailBlock(report),
  ].filter((s) => s !== '');
  return parts.join('\n');
}

// ─── Section 2 — Agent specification ──────────────────────────────

function extractAgentInfo(declared: DeclaredInventory[]): { name?: string; purpose?: string; owner?: string; declaredSources: string[] } {
  let name: string | undefined;
  let purpose: string | undefined;
  let owner: string | undefined;
  const declaredSources: string[] = [];
  for (const d of declared) {
    if (!declaredSources.includes(d.source)) declaredSources.push(d.source);
    if (d.agent) {
      if (!name && d.agent.name) name = d.agent.name;
      if (!purpose && d.agent.purpose) purpose = d.agent.purpose;
      if (!owner && d.agent.owner) owner = d.agent.owner;
    }
  }
  return { name, purpose, owner, declaredSources };
}

function renderAgentSpec(report: VerificationReport, opts: HtmlRenderOptions): string {
  // PR #25 round 2 (LOW): `?? []` guards against partial-mock reports
  // that omit declared / sources. Type contract requires both, but the
  // renderer would crash on the missing field rather than degrade.
  const info = extractAgentInfo(report.declared ?? []);
  const isHR = !!opts.hrPack?.isHRAgent;
  const verifySources = (report.sources ?? []).map((s) => `<code class="mono">${escapeHtml(s.sourceId)}</code>`).join(', ') || '<span class="muted">—</span>';
  const declaredSources = info.declaredSources.map((s) => `<code class="mono">${escapeHtml(s)}</code>`).join(', ') || '<span class="muted">—</span>';
  const approvalAgentId = report.approvalChain?.chain.agentId;

  const rows: Array<[string, string | null | undefined]> = [
    ['Agent Name', escapeHtml(info.name ?? opts.agentLabel)],
    ['Owner', info.owner ? escapeHtml(info.owner) : '<span class="muted">— not declared</span>'],
    ['Purpose', info.purpose ? nl2br(escapeHtml(info.purpose)) : '<span class="muted">— not declared</span>'],
    ['Vertical', isHR ? 'HR' : 'Generic'],
    ['Scan Date (UTC)', escapeHtml(report.capturedAt)],
    ['MCP Target', opts.mcpConfig ? `<code class="mono">${escapeHtml(opts.mcpConfig)}</code>` : null],
    ['Verification Sources', verifySources],
    ['Declared Source', declaredSources],
    ['Approval Agent ID', approvalAgentId ? `<code class="mono">${escapeHtml(approvalAgentId)}</code>` : null],
  ];

  return `${sectionHeader('02', 'Agent Specification', undefined, 'sec-agent-spec')}
${kv(rows)}`;
}

// ─── Section 3 — Verification results ─────────────────────────────

function renderScoreBar(score: ComplianceScoreResult): string {
  const fillCls = score.verdict === 'PASSED' ? '' : score.verdict === 'PARTIAL' ? 'warn' : 'crit';
  const pct = Math.max(0, Math.min(100, score.score));
  const thresholdPct = Math.max(0, Math.min(100, score.threshold));
  return `<div class="score-bar-row">
  <div class="score-bar-track" aria-label="Compliance score">
    <div class="score-bar-fill ${fillCls}" style="width: ${pct.toFixed(2)}%"></div>
    <div class="score-bar-threshold" style="left: ${thresholdPct.toFixed(2)}%" title="Threshold ${score.threshold.toFixed(2)}"></div>
  </div>
  <div class="score-bar-num">${score.score.toFixed(2)}</div>
</div>
<div class="score-bar-legend">Threshold ${score.threshold.toFixed(2)} &middot; ${score.verdict === 'PASSED' || score.verdict === 'PARTIAL' ? 'PASS' : 'FAIL'}</div>`;
}

function describeSourceVerdict(v: SourceVerification): string {
  if (v.verdict === 'verified') return 'verified';
  if (v.verdict === 'discrepancy') return 'discrepancy';
  return 'unverified';
}

function renderSources(report: VerificationReport): string {
  if (report.sources.length === 0) {
    return '<div class="empty">No verification sources ran for this agent.</div>';
  }
  return report.sources
    .map((s) => {
      const findingCount = s.diffs.length;
      const findingLabel = findingCount === 1 ? '1 finding' : `${findingCount} findings`;
      const warnings = (s.warnings || []).length;
      const warnText = warnings > 0 ? ` &middot; ${warnings} warning${warnings === 1 ? '' : 's'}` : '';
      return `<div class="source-row">
  <span class="source-name">${escapeHtml(s.sourceId)}</span>
  ${verdictPill(describeSourceVerdict(s))}
  <span class="source-count">${escapeHtml(findingLabel)}${warnText}</span>
</div>`;
    })
    .join('\n');
}

function diffCode(d: DiffEntry, index: number): string {
  const sourcePart = d.source.split('-')[0]?.toUpperCase() ?? 'GEN';
  return `${sourcePart}-${String(index + 1).padStart(3, '0')}`;
}

function diffIssue(d: DiffEntry): string {
  switch (d.kind) {
    case 'extra': {
      const name = 'name' in d.actual ? d.actual.name : `${d.actual.service}:${d.actual.scope}`;
      return `Extra ${d.dimension} present in ${d.source}: <code class="mono">${escapeHtml(name)}</code>${d.details ? ` — ${escapeHtml(d.details)}` : ''}`;
    }
    case 'missing': {
      const name = 'name' in d.declared ? d.declared.name : `${d.declared.service}:${d.declared.scope}`;
      return `Declared ${d.dimension} not exercised in ${d.source}: <code class="mono">${escapeHtml(name)}</code>${d.details ? ` — ${escapeHtml(d.details)}` : ''}`;
    }
    case 'mismatch': {
      const name = 'name' in d.declared ? d.declared.name : `${d.declared.service}:${d.declared.scope}`;
      return `Mismatch on ${d.dimension} <code class="mono">${escapeHtml(name)}</code> between declared and actual${d.details ? ` — ${escapeHtml(d.details)}` : ''}`;
    }
  }
}

function renderFindingsTable(report: VerificationReport): string {
  const allDiffs: DiffEntry[] = [];
  for (const s of report.sources) {
    for (const d of s.diffs) allDiffs.push(d);
  }
  if (allDiffs.length === 0) {
    return '<div class="callout callout-ok">No discrepancies detected across verification sources.</div>';
  }
  const rows = allDiffs
    .map((d, i) =>
      `<tr>
  <td><code class="mono">${escapeHtml(diffCode(d, i))}</code></td>
  <td>${diffIssue(d)}</td>
  <td>${severityPill(d.severity)}</td>
</tr>`,
    )
    .join('\n');
  return `<div class="tbl-wrap"><table class="tbl tbl-findings">
  <thead><tr><th>Code</th><th>Issue</th><th>Severity</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
}

function renderVerificationResults(report: VerificationReport, score: ComplianceScoreResult): string {
  return `${sectionHeader('03', 'Verification Results', undefined, 'sec-verification')}
<div class="h-sub">3.1 &middot; Overall Score</div>
${renderScoreBar(score)}
<div class="h-sub">3.2 &middot; Per-Source Breakdown</div>
${renderSources(report)}
<div class="h-sub">3.3 &middot; Diff Findings</div>
${renderFindingsTable(report)}`;
}

// ─── Section 4 — Framework mapping ────────────────────────────────

function renderFrameworkMapping(mapping: FrameworkMapping | undefined): string {
  const header = sectionHeader('04', 'Compliance Framework Mapping', undefined, 'sec-frameworks');
  if (!mapping) {
    return `${header}
${callout('Framework mapping was not run for this agent (HERON_FRAMEWORK_MAPPING_DISABLED or no mapper available).', 'warn')}`;
  }
  const failed = mapping.controls.filter((c) => c.verdict === 'fail');
  const counts = {
    critical: failed.filter((c) => c.severity === 'critical').length,
    high: failed.filter((c) => c.severity === 'high').length,
    medium: failed.filter((c) => c.severity === 'medium').length,
    low: failed.filter((c) => c.severity === 'low').length,
  };
  const tone: 'warn' | 'fail' | 'ok' = failed.length === 0 ? 'ok' : (counts.critical > 0 || counts.high > 0) ? 'fail' : 'warn';
  const summary = failed.length === 0
    ? 'All evaluable controls verified or partially verified — no framework-level failures detected.'
    : `${failed.length} ${pluralise(failed.length, 'failure')} detected (${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low).`;

  // Group by framework, preserve order of first appearance.
  const groups = new Map<FrameworkId, FrameworkControl[]>();
  for (const c of mapping.controls) {
    if (!groups.has(c.framework)) groups.set(c.framework, []);
    groups.get(c.framework)!.push(c);
  }

  const groupHtml: string[] = [];
  for (const [fw, controls] of groups) {
    const verifiedInGroup = controls.filter((c) => c.verdict === 'verified' || c.verdict === 'partial').length;
    const rows = controls
      .map((c) => `<tr>
  <td><code class="mono">${escapeHtml(c.controlId)}</code></td>
  <td>${escapeHtml(c.controlName)}</td>
  <td>${verdictPill(c.verdict)}</td>
  <td>${severityPill(c.severity)}</td>
  <td>${escapeHtml(c.rationale)}</td>
</tr>`)
      .join('\n');
    groupHtml.push(`<div class="group">
  <div class="group-head">
    <span>${escapeHtml(frameworkLabel(fw))}</span>
    <span class="count">${verifiedInGroup}/${controls.length} verified</span>
  </div>
  <div class="tbl-wrap"><table class="tbl tbl-findings">
    <thead><tr><th>Control ID</th><th>Control Name</th><th>Verdict</th><th>Severity</th><th>Rationale</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>
</div>`);
  }

  return `${header}
${callout(summary, tone)}
${groupHtml.join('\n')}`;
}

// ─── Section 5 — HR vertical signals ──────────────────────────────

function renderHRSignals(hr: HRPackResult, num: string): string {
  const detected = hr.signals.filter((s) => s.verdict === 'detected');
  const tone: 'warn' | 'fail' | 'ok' = detected.length === 0 ? 'ok' : hr.summary.criticalDetected > 0 ? 'fail' : 'warn';
  const callBody = detected.length === 0
    ? 'No HR-specific risk signals detected.'
    : `${detected.length} HR-specific ${pluralise(detected.length, 'signal')} detected (${hr.summary.criticalDetected} critical, ${hr.summary.highDetected} high).`;
  const rows = hr.signals
    .map((s: HRSignal) => `<tr>
  <td><code class="mono">${escapeHtml(s.signalId)}</code></td>
  <td>${escapeHtml(s.name)}</td>
  <td>${verdictPill(s.verdict)}</td>
  <td>${severityPill(s.severity)}</td>
  <td>${escapeHtml(s.rationale)}</td>
</tr>`)
    .join('\n');
  return `${sectionHeader(num, 'HR Vertical Signals', undefined, 'sec-hr')}
${callout(callBody, tone)}
<div class="tbl-wrap"><table class="tbl tbl-findings">
  <thead><tr><th>Signal ID</th><th>Name</th><th>Verdict</th><th>Severity</th><th>Rationale</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>`;
}

// ─── Section 6 — Approval audit trail ─────────────────────────────

function renderApprovalEntry(entry: ApprovalEntry, idx: number): string {
  const evidence = (entry.evidenceRefs || []).map((e) => `<div>${escapeHtml(e)}</div>`).join('') || '<span class="muted">—</span>';
  const comment = entry.comment ? `<div class="muted">${escapeHtml(entry.comment)}</div>` : '';
  return `<tr>
  <td><code class="mono">${escapeHtml(entry.timestamp)}</code></td>
  <td><div class="timeline-actor">
    <span class="name">${escapeHtml(entry.actor.name)}</span>
    <span class="role">${escapeHtml(entry.actor.role)}${entry.actor.email ? ` &middot; ${escapeHtml(entry.actor.email)}` : ''}</span>
  </div></td>
  <td>${escapeHtml(entry.action)}</td>
  <td><div class="evidence-list">${evidence}</div>${comment}</td>
</tr>`;
}

function renderApprovalTrail(chain: ApprovalChain, integrity: { ok: true } | { ok: false; brokenAt: number; reason: string }, num: string): string {
  const banner = integrity.ok
    ? callout('Chain integrity verified — every entry hash matches.', 'ok')
    : callout(`Chain integrity BROKEN at entry ${integrity.brokenAt}: ${escapeHtml(integrity.reason)}`, 'fail');
  const rows = chain.entries.map((e, i) => renderApprovalEntry(e, i)).join('\n');
  return `${sectionHeader(num, 'Approval Audit Trail', undefined, 'sec-approval')}
${banner}
<div class="tbl-wrap"><table class="tbl timeline">
  <thead><tr><th>Timestamp (UTC)</th><th>Actor</th><th>Action</th><th>Evidence &middot; Comment</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
<div class="chain-note">SHA-256 hash chain (prevHash on every entry after the first). Detects point edits to past entries; does not substitute for filesystem ACLs on the chain file itself.</div>`;
}

// ─── Section 7 — Conclusion ───────────────────────────────────────

function renderConclusion(report: VerificationReport, opts: HtmlRenderOptions, num: string): string {
  const actions: string[] = [];
  // Pull from highest-severity framework fails first
  if (report.frameworkMapping) {
    const fails = [...report.frameworkMapping.controls].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
    for (const c of fails) {
      if (c.verdict === 'fail' || c.verdict === 'partial') {
        actions.push(`<strong>${escapeHtml(frameworkLabel(c.framework))} &middot; ${escapeHtml(c.controlId)}</strong> — ${escapeHtml(c.rationale)}`);
      }
    }
  }
  // Pull HR recommendations
  if (opts.hrPack?.isHRAgent) {
    for (const s of opts.hrPack.signals) {
      if (s.verdict === 'detected') {
        actions.push(`<strong>HR &middot; ${escapeHtml(s.name)}</strong> — ${escapeHtml(s.recommendation)}`);
      }
    }
  }
  // Pull source-level diffs as fallback when nothing higher-level surfaced
  if (actions.length === 0) {
    for (const s of report.sources) {
      for (const d of s.diffs) {
        if (d.severity === 'critical' || d.severity === 'high') {
          actions.push(diffIssue(d));
        }
      }
    }
  }
  const body = actions.length === 0
    ? callout('No remediation actions required — verification clean across all surfaces.', 'ok')
    : `<ol class="numlist">${actions.map((a) => `<li>${a}</li>`).join('\n')}</ol>`;
  return `${sectionHeader(num, 'Conclusion', undefined, 'sec-conclusion')}
<div class="h-sub">Recommended Actions</div>
${body}`;
}

function severityRank(s: string): number {
  switch (s) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

// ─── Section 8 — Appendix ─────────────────────────────────────────

function renderAppendix(report: VerificationReport, num: string): string {
  const allTools: Array<{ source: string; name: string; description?: string }> = [];
  const allScopes: Array<{ source: string; service: string; scope: string }> = [];
  for (const src of report.sources) {
    if (!src.inventory) continue;
    if (src.inventory.tools) {
      for (const t of src.inventory.tools) {
        const entry: { source: string; name: string; description?: string } = {
          source: src.inventory.source,
          name: t.name,
        };
        if (t.description !== undefined) entry.description = t.description;
        allTools.push(entry);
      }
    }
    if (src.inventory.scopes) {
      for (const sc of src.inventory.scopes) allScopes.push({ source: src.inventory.source, service: sc.service, scope: sc.scope });
    }
  }
  const toolRows = allTools.length === 0
    ? '<tr><td colspan="3" class="empty">No tools captured.</td></tr>'
    : allTools.map((t) => `<tr>
  <td><code class="mono">${escapeHtml(t.source)}</code></td>
  <td><code class="mono">${escapeHtml(t.name)}</code></td>
  <td>${escapeHtml(t.description ?? '')}</td>
</tr>`).join('\n');
  const scopeRows = allScopes.length === 0
    ? '<tr><td colspan="3" class="empty">No scopes captured.</td></tr>'
    : allScopes.map((s) => `<tr>
  <td><code class="mono">${escapeHtml(s.source)}</code></td>
  <td><code class="mono">${escapeHtml(s.service)}</code></td>
  <td><code class="mono">${escapeHtml(s.scope)}</code></td>
</tr>`).join('\n');

  return `${sectionHeader(num, 'Appendix', undefined, 'sec-appendix')}
<details ${allTools.length > 0 ? 'open' : ''}>
  <summary>Tool inventory (${allTools.length})</summary>
  <div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Source</th><th>Tool</th><th>Description</th></tr></thead>
    <tbody>${toolRows}</tbody>
  </table></div>
</details>
<details>
  <summary>Scope inventory (${allScopes.length})</summary>
  <div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>Source</th><th>Service</th><th>Scope</th></tr></thead>
    <tbody>${scopeRows}</tbody>
  </table></div>
</details>`;
}

// ─── Top-level renderer ───────────────────────────────────────────

export function renderVerificationReportHtml(
  reportInput: VerificationReport,
  opts: HtmlRenderOptions,
): string {
  // PR #25 round 2 (LOW): belt-and-braces normalisation. The type
  // contract guarantees `sources` and `declared`, but partial mocks
  // and future callers should not crash if either is undefined. We
  // coerce once at the entry point so downstream sections can keep
  // assuming arrays.
  const report: VerificationReport = {
    ...reportInput,
    declared: reportInput.declared ?? [],
    sources: reportInput.sources ?? [],
  };
  const score = computeComplianceScore(report);
  const isHR = !!opts.hrPack?.isHRAgent;
  const hasChain = !!report.approvalChain;

  // Section numbers shift based on which optional sections are present.
  let n = 5;
  const hrNum = isHR ? String(n++).padStart(2, '0') : '';
  const approvalNum = hasChain ? String(n++).padStart(2, '0') : '';
  const conclusionNum = String(n++).padStart(2, '0');
  const appendixNum = String(n++).padStart(2, '0');

  const body = [
    renderCoverPage(report, opts, score),
    renderTOC({ isHR, hasChain }),
    renderExecutiveSummary(report, opts, score),
    renderAgentSpec(report, opts),
    renderVerificationResults(report, score),
    renderFrameworkMapping(report.frameworkMapping),
    isHR && opts.hrPack ? renderHRSignals(opts.hrPack, hrNum) : '',
    hasChain && report.approvalChain ? renderApprovalTrail(report.approvalChain.chain, report.approvalChain.integrity, approvalNum) : '',
    renderConclusion(report, opts, conclusionNum),
    renderAppendix(report, appendixNum),
    `<footer class="report-footer">
  <span>Heron OSS &middot; <code class="mono">${escapeHtml(opts.evaluationId)}</code></span>
  <span>Generated ${escapeHtml(opts.generatedAt)} (UTC)</span>
</footer>`,
  ].filter((s) => s !== '').join('\n');

  const title = `Heron Verification &middot; ${escapeHtml(opts.agentLabel)}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${FAVICON_LINK}
${REPORT_FONTS_HEAD}
<style>${REPORT_CSS}</style>
</head>
<body>
<main class="heron-report">
${body}
</main>
</body>
</html>`;
}
