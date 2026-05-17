/**
 * Vendored & adapted from Heron_v1 (jonydony/Heron_v1) report.css.
 * Both repos are owned by the same author (Ilya Ivanov).
 *
 * Original: frontend/components/heron-v1/dashboard/report.css (1982 lines).
 * Adapted for server-side static HTML — interactive React widgets removed
 * (drawer, share popover, diff picker, tab row), but every visual primitive
 * the verification report uses (severity pills, section headers, tables,
 * key-value lists, callouts, score bar, numlist, framework chips, EU banner,
 * delta notes) is preserved verbatim or near-verbatim. The `.report` scope
 * is kept so this CSS never leaks into the existing `SHARED_CSS` for
 * interview-session pages.
 *
 * Why inline as a TS constant: the OSS package has no bundler — `tsc`
 * compiles `.ts` to `.js` and that's it. A `.css` file would need a copy
 * step in the build; a string constant ships with the module.
 */

/* eslint-disable */

export const REPORT_CSS = `
/* Adapted from Heron_v1 (jonydony/Heron_v1) report.css.
   Both repos owned by same author. */

.heron-report {
  /* Surface */
  --r-bg: #ffffff;
  --r-bg-muted: #fafafa;
  --r-bg-subtle: #f4f4f5;
  --r-bg-row-hover: #f8f8f7;

  /* Borders / lines */
  --r-border: #e6e6e3;
  --r-border-strong: #d4d4d0;

  /* Ink */
  --r-ink: #18181b;
  --r-ink-2: #3f3f46;
  --r-ink-3: #71717a;
  --r-ink-4: #a1a1aa;

  /* Severity ramp */
  --r-crit:    #991b1b; --r-crit-bg:    #fef2f2; --r-crit-bd:    #fecaca;
  --r-high:    #c2410c; --r-high-bg:    #fff4ed; --r-high-bd:    #fed7aa;
  --r-med:     #a16207; --r-med-bg:     #fef9c3; --r-med-bd:     #fde68a;
  --r-low:     #15803d; --r-low-bg:     #f0fdf4; --r-low-bd:     #bbf7d0;
  --r-info:    #1e40af; --r-info-bg:    #eff6ff; --r-info-bd:    #bfdbfe;
  --r-review:  #92400e; --r-review-bg:  #fffbeb; --r-review-bd:  #fde68a;

  /* Type stack */
  --r-font-sans: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --r-font-serif: "Newsreader", "Charter", Georgia, "Times New Roman", serif;
  --r-font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;

  --r-radius: 6px;

  font-family: var(--r-font-sans);
  font-size: 14px;
  line-height: 1.55;
  letter-spacing: -0.005em;
  color: var(--r-ink);
  background: var(--r-bg);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;

  max-width: 1400px;
  margin: 0 auto;
  padding: 32px 40px 80px;
}
@media (max-width: 1100px) {
  .heron-report { padding: 22px 28px 60px; }
}
@media (max-width: 700px) {
  .heron-report { padding: 18px 18px 48px; }
}

.heron-report * { box-sizing: border-box; }
.heron-report h1, .heron-report h2, .heron-report h3, .heron-report h4 {
  margin: 0;
  letter-spacing: -0.015em;
}
.heron-report p { margin: 0; }
.heron-report dl, .heron-report dd { margin: 0; }
.heron-report ol, .heron-report ul { margin: 0; padding: 0; list-style: none; }

.heron-report a { color: var(--r-info); text-decoration: none; }
.heron-report a:hover { text-decoration: underline; }

.heron-report .mono {
  font-family: var(--r-font-mono);
  font-variant-numeric: tabular-nums;
}
.heron-report .muted   { color: var(--r-ink-3); }
.heron-report .muted-2 { color: var(--r-ink-4); }

/* ─── Cover ─────────────────────────────────────────────────────── */
/* PR #26: more generous breathing room between cover / TOC / first
   section. The PR #25 spacing was print-dense; Vijil's reference has
   ~80px gaps between major blocks. */
.heron-report .cover {
  display: flex;
  flex-direction: column;
  gap: 28px;
  padding: 0 0 56px;
  border-bottom: 1px solid var(--r-border);
  margin-bottom: 64px;
}
.heron-report .cover-brand {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.heron-report .cover-mark {
  font-family: var(--r-font-serif);
  font-weight: 500;
  font-size: 36px;
  letter-spacing: -0.025em;
  color: var(--r-ink);
  line-height: 1;
}
/* PR #26 editorial polish: .cover-tag rule preserved for backwards
   compatibility but no longer emitted from the default cover. */
.heron-report .cover-tag {
  font-family: var(--r-font-mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--r-ink-3);
}
.heron-report .cover-titles {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.heron-report .cover-title {
  font-family: var(--r-font-serif);
  font-size: 36px;
  font-weight: 500;
  line-height: 1.1;
  letter-spacing: -0.02em;
  color: var(--r-ink);
}
.heron-report .cover-subtitle {
  font-family: var(--r-font-sans);
  font-size: 14px;
  font-weight: 500;
  color: var(--r-ink-3);
  letter-spacing: 0.01em;
}
.heron-report .cover-summary-row {
  display: grid;
  grid-template-columns: minmax(220px, 280px) 1fr;
  gap: 32px;
  align-items: center;
}
@media (max-width: 700px) {
  .heron-report .cover-summary-row {
    grid-template-columns: 1fr;
  }
}

/* Verdict badge — large, rounded, single colour ramp.
   PR #26: simplified to a single-content box (just the word) to match
   Vijil's badge punch. The .verdict-label / .verdict-value child rules
   are gone — the badge IS the verdict word. */
.heron-report .verdict-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 22px 28px;
  border: 1px solid;
  border-radius: 10px;
  font-family: var(--r-font-mono);
  font-size: 32px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  line-height: 1;
  min-width: 220px;
}
.heron-report .verdict-passed {
  color: var(--r-low);
  background: var(--r-low-bg);
  border-color: var(--r-low-bd);
}
.heron-report .verdict-partial {
  color: var(--r-med);
  background: var(--r-med-bg);
  border-color: var(--r-med-bd);
}
.heron-report .verdict-failed {
  color: var(--r-crit);
  background: var(--r-crit-bg);
  border-color: var(--r-crit-bd);
}

/* Compliance score block */
.heron-report .score-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.heron-report .score-label {
  font-family: var(--r-font-mono);
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--r-ink-3);
}
.heron-report .score-value {
  font-family: var(--r-font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 48px;
  font-weight: 600;
  color: var(--r-ink);
  line-height: 1;
  letter-spacing: -0.02em;
}
.heron-report .score-threshold {
  font-family: var(--r-font-mono);
  font-size: 12px;
  color: var(--r-ink-3);
  letter-spacing: 0.04em;
}
/* PR #26: cover meta is a definition list (dl/dt/dd) — looks like a
   document header, not a row of debug-strip spans. The old span-soup
   layout shipped 4 inline labels that read like telemetry; this two-
   column grid renders dt as a small mono caption + dd as readable value. */
.heron-report .cover-meta {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 6px 18px;
  align-items: baseline;
  font-size: 13px;
  color: var(--r-ink-2);
  margin: 0;
}
.heron-report .cover-meta > dt {
  font-family: var(--r-font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--r-ink-3);
}
.heron-report .cover-meta > dd {
  font-family: var(--r-font-sans);
  color: var(--r-ink-2);
  margin: 0;
}
.heron-report .cover-meta > dd code.mono {
  /* Inherit the dl row baseline rather than the default code styling. */
  font-size: 12px;
}

/* ─── Table of contents ────────────────────────────────────────── */
/* PR #26: bigger margins around the TOC so it reads as a discrete
   block sandwiched between cover and first section, not a strip glued
   to either. */
.heron-report .toc {
  border: 1px solid var(--r-border);
  border-radius: var(--r-radius);
  background: var(--r-bg-muted);
  padding: 20px 24px;
  margin-top: 8px;
  margin-bottom: 64px;
}
.heron-report .toc-title {
  font-family: var(--r-font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--r-ink-3);
  margin-bottom: 12px;
}
.heron-report .toc-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 24px;
}
@media (max-width: 700px) {
  .heron-report .toc-list { grid-template-columns: 1fr; }
}
.heron-report .toc-list li {
  display: flex;
  gap: 10px;
  font-size: 13px;
  color: var(--r-ink-2);
  align-items: baseline;
}
.heron-report .toc-list li .toc-num {
  font-family: var(--r-font-mono);
  font-size: 11px;
  color: var(--r-ink-4);
  min-width: 18px;
}
.heron-report .toc-list a {
  color: var(--r-ink-2);
  text-decoration: none;
}
.heron-report .toc-list a:hover { color: var(--r-ink); text-decoration: underline; }

/* ─── Section header ────────────────────────────────────────────── */
/* PR #26: more vertical breathing room between sections so the report
   reads as a memo, not a console dump. ~56px above each h-section. */
.heron-report .h-section {
  display: flex;
  align-items: baseline;
  gap: 12px;
  border-top: 1px solid var(--r-border);
  padding-top: 32px;
  margin-top: 56px;
  margin-bottom: 20px;
  scroll-margin-top: 20px;
}
/* First h-section after the TOC needs extra top breathing room — the
   TOC already added its own 64px bottom margin, but the section
   header's own border-top reads tight without this nudge. */
.heron-report .toc + .h-section {
  margin-top: 0;
  border-top: none;
  padding-top: 0;
}
.heron-report .h-section .num {
  font-family: var(--r-font-mono);
  font-size: 11px;
  color: var(--r-ink-4);
  letter-spacing: 0.05em;
}
.heron-report .h-section .label {
  font-family: var(--r-font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  color: var(--r-ink-3);
  text-transform: uppercase;
}
.heron-report .h-section .title {
  font-size: 18px;
  font-weight: 600;
  color: var(--r-ink);
  letter-spacing: -0.01em;
}
.heron-report .h-section .meta {
  margin-left: auto;
  font-size: 12px;
  color: var(--r-ink-3);
  font-family: var(--r-font-mono);
}
.heron-report .h-sub {
  font-family: var(--r-font-mono);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--r-ink-3);
  margin: 20px 0 10px;
}

/* ─── Executive summary subsections (PR #26) ──────────────────────
   The exec summary is the DPO-readable evidence pack. Each subsection
   (Compliance Posture, Headline Findings, Framework Coverage,
   Recommended Actions, Approval Trail) renders as a labelled block
   with an h3 caption and a body. The h3 here uses the serif stack so
   the section reads like a memo, not a console dump. */
.heron-report .exec-sub {
  margin: 18px 0 8px;
}
.heron-report .exec-sub h3 {
  font-family: var(--r-font-serif);
  font-size: 16px;
  font-weight: 600;
  color: var(--r-ink);
  letter-spacing: -0.01em;
  margin: 0 0 8px;
}
.heron-report .exec-sub p {
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--r-ink-2);
}
.heron-report .findings-list,
.heron-report .recommended-actions {
  counter-reset: ef;
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 4px 0 0;
}
.heron-report .findings-list > li,
.heron-report .recommended-actions > li {
  display: grid;
  grid-template-columns: 28px 1fr;
  gap: 8px;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--r-ink-2);
  padding-left: 0;
}
.heron-report .findings-list > li::before,
.heron-report .recommended-actions > li::before {
  content: counter(ef, decimal-leading-zero);
  counter-increment: ef;
  font-family: var(--r-font-mono);
  font-size: 11px;
  color: var(--r-ink-4);
  letter-spacing: 0.05em;
  padding-top: 3px;
}
.heron-report .framework-coverage {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13.5px;
  color: var(--r-ink-2);
}
.heron-report .framework-coverage > li {
  padding-left: 0;
}
.heron-report .approval-summary {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13.5px;
  color: var(--r-ink-2);
}
.heron-report .chain-status {
  font-family: var(--r-font-mono);
  font-size: 11.5px;
  color: var(--r-ink-3);
  letter-spacing: 0.02em;
  margin-top: 6px;
}

/* ─── Severity pill ─────────────────────────────────────────────── */
.heron-report .sev {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--r-font-mono);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 3px 7px;
  border-radius: 3px;
  border: 1px solid;
  white-space: nowrap;
}
.heron-report .sev-critical { color: var(--r-crit);   background: var(--r-crit-bg);   border-color: var(--r-crit-bd); }
.heron-report .sev-high     { color: var(--r-high);   background: var(--r-high-bg);   border-color: var(--r-high-bd); }
.heron-report .sev-medium   { color: var(--r-med);    background: var(--r-med-bg);    border-color: var(--r-med-bd); }
.heron-report .sev-low      { color: var(--r-low);    background: var(--r-low-bg);    border-color: var(--r-low-bd); }
.heron-report .sev-info     { color: var(--r-info);   background: var(--r-info-bg);   border-color: var(--r-info-bd); }
.heron-report .sev-review   { color: var(--r-review); background: var(--r-review-bg); border-color: var(--r-review-bd); }
.heron-report .sev-ok       { color: var(--r-low);    background: var(--r-low-bg);    border-color: var(--r-low-bd); }
.heron-report .sev-neutral  { color: var(--r-ink-3);  background: var(--r-bg-muted);  border-color: var(--r-border); }

/* Verdict mini-pill — for compliance / verification verdicts */
.heron-report .vp {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--r-font-mono);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 3px 7px;
  border-radius: 3px;
  border: 1px solid;
  white-space: nowrap;
}
.heron-report .vp-verified       { color: var(--r-low);  background: var(--r-low-bg);  border-color: var(--r-low-bd); }
.heron-report .vp-partial        { color: var(--r-med);  background: var(--r-med-bg);  border-color: var(--r-med-bd); }
.heron-report .vp-fail           { color: var(--r-crit); background: var(--r-crit-bg); border-color: var(--r-crit-bd); }
.heron-report .vp-unverified     { color: var(--r-ink-3); background: var(--r-bg-muted); border-color: var(--r-border); }
.heron-report .vp-not-applicable { color: var(--r-ink-4); background: var(--r-bg-subtle); border-color: var(--r-border); }
.heron-report .vp-discrepancy    { color: var(--r-high); background: var(--r-high-bg); border-color: var(--r-high-bd); }
.heron-report .vp-detected       { color: var(--r-crit); background: var(--r-crit-bg); border-color: var(--r-crit-bd); }
.heron-report .vp-not-detected   { color: var(--r-low);  background: var(--r-low-bg);  border-color: var(--r-low-bd); }

/* ─── Tables ───────────────────────────────────────────────────── */
.heron-report .tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  border: 1px solid var(--r-border);
  border-radius: var(--r-radius);
  overflow: hidden;
  background: var(--r-bg);
  margin: 0 0 16px;
}
.heron-report .tbl thead th {
  text-align: left;
  font-family: var(--r-font-mono);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--r-ink-3);
  text-transform: uppercase;
  background: var(--r-bg-muted);
  border-bottom: 1px solid var(--r-border);
  padding: 10px 14px;
}
.heron-report .tbl td {
  padding: 12px 14px;
  border-bottom: 1px solid var(--r-border);
  vertical-align: top;
  color: var(--r-ink);
}
.heron-report .tbl tbody tr:last-child td { border-bottom: none; }
.heron-report .tbl .empty {
  text-align: center;
  color: var(--r-ink-4);
  font-size: 12.5px;
  padding: 20px;
}
.heron-report .tbl-wrap { width: 100%; overflow-x: auto; }
.heron-report .tbl-findings { min-width: 720px; }
.heron-report .tbl-findings td {
  word-break: normal;
  overflow-wrap: anywhere;
}
.heron-report .tbl code, .heron-report code.mono {
  font-family: var(--r-font-mono);
  font-size: 12px;
  background: var(--r-bg-subtle);
  border: 1px solid var(--r-border);
  border-radius: 3px;
  padding: 1px 5px;
  color: var(--r-ink);
}

/* ─── Panel / card ─────────────────────────────────────────────── */
.heron-report .panel {
  border: 1px solid var(--r-border);
  border-radius: var(--r-radius);
  background: var(--r-bg);
}
.heron-report .panel-pad   { padding: 16px 18px; }
.heron-report .panel-muted { background: var(--r-bg-muted); }

/* ─── Key-value definition list ───────────────────────────────── */
.heron-report .kv {
  display: grid;
  grid-template-columns: 200px 1fr;
  font-size: 13px;
  border: 1px solid var(--r-border);
  border-radius: var(--r-radius);
  overflow: hidden;
  background: var(--r-bg);
  margin-bottom: 16px;
}
.heron-report .kv > dt {
  font-family: var(--r-font-mono);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--r-ink-3);
  padding: 12px 16px;
  border-bottom: 1px solid var(--r-border);
  background: var(--r-bg-muted);
}
.heron-report .kv > dd {
  padding: 12px 16px;
  border-bottom: 1px solid var(--r-border);
  color: var(--r-ink-2);
  overflow-wrap: anywhere;
}
.heron-report .kv > dt:last-of-type,
.heron-report .kv > dd:last-of-type { border-bottom: none; }
@media (max-width: 700px) {
  .heron-report .kv { grid-template-columns: 1fr; }
  .heron-report .kv > dt { border-bottom: none; padding-bottom: 4px; }
  .heron-report .kv > dd { padding-top: 4px; }
}

/* ─── Callout (left-border accent) ─────────────────────────────── */
.heron-report .callout {
  border: 1px solid var(--r-border);
  border-left: 3px solid var(--r-ink-2);
  background: var(--r-bg-muted);
  color: var(--r-ink-2);
  font-size: 13.5px;
  line-height: 1.6;
  padding: 14px 18px;
  border-radius: 0 var(--r-radius) var(--r-radius) 0;
  margin-bottom: 16px;
}
.heron-report .callout.callout-info {
  border-left-color: var(--r-info);
  background: var(--r-info-bg);
  border-color: var(--r-info-bd);
  color: var(--r-info);
}
.heron-report .callout.callout-warn {
  border-left-color: var(--r-high);
  background: var(--r-high-bg);
  border-color: var(--r-high-bd);
  color: var(--r-high);
}
.heron-report .callout.callout-fail {
  border-left-color: var(--r-crit);
  background: var(--r-crit-bg);
  border-color: var(--r-crit-bd);
  color: var(--r-crit);
}
.heron-report .callout.callout-ok {
  border-left-color: var(--r-low);
  background: var(--r-low-bg);
  border-color: var(--r-low-bd);
  color: var(--r-low);
}

/* ─── Score bar (data quality / overall score) ──────────────── */
.heron-report .score-bar-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 8px;
}
.heron-report .score-bar-track {
  flex: 1;
  height: 10px;
  background: var(--r-bg-subtle);
  border-radius: 5px;
  overflow: hidden;
  position: relative;
  border: 1px solid var(--r-border);
}
.heron-report .score-bar-fill {
  height: 100%;
  background: var(--r-low);
  transition: width .2s;
}
.heron-report .score-bar-fill.warn { background: var(--r-med); }
.heron-report .score-bar-fill.crit { background: var(--r-crit); }
.heron-report .score-bar-threshold {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 2px;
  background: var(--r-ink);
  opacity: 0.55;
}
.heron-report .score-bar-num {
  font-family: var(--r-font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 16px;
  font-weight: 600;
  color: var(--r-ink);
  min-width: 60px;
  text-align: right;
}
.heron-report .score-bar-legend {
  font-family: var(--r-font-mono);
  font-size: 11px;
  color: var(--r-ink-3);
  letter-spacing: 0.04em;
}

/* ─── Group header (framework group) ────────────────────────── */
.heron-report .group-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--r-bg-muted);
  border: 1px solid var(--r-border);
  border-radius: var(--r-radius) var(--r-radius) 0 0;
  border-bottom: none;
  font-family: var(--r-font-mono);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--r-ink-2);
}
.heron-report .group-head .count {
  margin-left: auto;
  color: var(--r-ink-3);
  font-weight: 500;
  letter-spacing: 0.04em;
}
.heron-report .group-head + .tbl, .heron-report .group-head + .tbl-wrap > .tbl {
  border-radius: 0 0 var(--r-radius) var(--r-radius);
}
.heron-report .group + .group { margin-top: 18px; }

/* ─── Source row ────────────────────────────────────────────── */
.heron-report .source-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--r-border);
  border-radius: var(--r-radius);
  margin-bottom: 8px;
  background: var(--r-bg);
}
.heron-report .source-row .source-name {
  font-family: var(--r-font-mono);
  font-size: 13px;
  font-weight: 500;
  color: var(--r-ink);
}
.heron-report .source-row .source-count {
  margin-left: auto;
  font-family: var(--r-font-mono);
  font-size: 11.5px;
  color: var(--r-ink-3);
}

/* ─── Numbered list (recommendations) ───────────────────────── */
.heron-report .numlist {
  counter-reset: nl;
  border: 1px solid var(--r-border);
  border-radius: var(--r-radius);
  background: var(--r-bg);
  padding: 4px 18px;
  margin: 0 0 16px;
}
.heron-report .numlist > li {
  display: grid;
  grid-template-columns: 36px 1fr;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid var(--r-border);
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--r-ink-2);
}
.heron-report .numlist > li:last-child { border-bottom: none; }
.heron-report .numlist > li::before {
  content: counter(nl, decimal-leading-zero);
  counter-increment: nl;
  font-family: var(--r-font-mono);
  font-size: 11px;
  color: var(--r-ink-4);
  letter-spacing: 0.05em;
  padding-top: 2px;
}

/* ─── Timeline (approval chain) ─────────────────────────────── */
.heron-report .timeline {
  margin: 0 0 16px;
}
.heron-report .timeline-actor {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.heron-report .timeline-actor .name {
  font-weight: 500;
  color: var(--r-ink);
}
.heron-report .timeline-actor .role {
  font-family: var(--r-font-mono);
  font-size: 11.5px;
  color: var(--r-ink-3);
  letter-spacing: 0.02em;
}
.heron-report .timeline .evidence-list {
  font-family: var(--r-font-mono);
  font-size: 11.5px;
  color: var(--r-ink-3);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* Hash chain footer note */
.heron-report .chain-note {
  font-family: var(--r-font-mono);
  font-size: 11.5px;
  color: var(--r-ink-3);
  padding: 10px 14px;
  background: var(--r-bg-muted);
  border: 1px dashed var(--r-border);
  border-radius: var(--r-radius);
  margin-top: 4px;
  margin-bottom: 16px;
  letter-spacing: 0.02em;
}

/* ─── Layout helpers ───────────────────────────────────────── */
.heron-report .row        { display: flex; align-items: center; gap: 8px; }
.heron-report .row-tight  { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.heron-report .stack      { display: flex; flex-direction: column; gap: 4px; }
.heron-report .stack-md   { display: flex; flex-direction: column; gap: 12px; }
.heron-report .stack-lg   { display: flex; flex-direction: column; gap: 22px; }
.heron-report .spread     { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.heron-report .grow       { flex: 1; }
.heron-report .nowrap     { white-space: nowrap; }

/* ─── Framework chip ──────────────────────────────────────── */
.heron-report .fw-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--r-font-mono);
  font-size: 11px;
  padding: 3px 7px;
  border-radius: 3px;
  border: 1px solid var(--r-border);
  background: var(--r-bg-muted);
  color: var(--r-ink-2);
}

/* ─── Details (appendix) ──────────────────────────────────── */
.heron-report details {
  margin: 8px 0;
  border: 1px solid var(--r-border);
  border-radius: var(--r-radius);
  background: var(--r-bg);
}
.heron-report details > summary {
  cursor: pointer;
  padding: 10px 14px;
  font-family: var(--r-font-mono);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--r-ink-2);
  list-style: none;
}
.heron-report details > summary::-webkit-details-marker { display: none; }
.heron-report details > summary::before {
  content: '▸ ';
  color: var(--r-ink-4);
  font-size: 10px;
}
.heron-report details[open] > summary::before {
  content: '▾ ';
}
.heron-report details > div, .heron-report details > p, .heron-report details > ul, .heron-report details > .tbl-wrap {
  padding: 4px 14px 14px;
}
.heron-report details > .tbl-wrap { padding: 0 14px 14px; }

/* ─── Footer ──────────────────────────────────────────────── */
.heron-report .report-footer {
  margin-top: 56px;
  padding-top: 18px;
  border-top: 1px solid var(--r-border);
  display: flex;
  justify-content: space-between;
  color: var(--r-ink-3);
  font-family: var(--r-font-mono);
  font-size: 11px;
  letter-spacing: 0.05em;
  flex-wrap: wrap;
  gap: 12px;
}
.heron-report .report-footer a { color: var(--r-ink-3); }
.heron-report .report-footer a:hover { color: var(--r-ink); }

/* ─── Print (PR #26) ───────────────────────────────────────────
   When a DPO does Cmd+P → Save as PDF, the report should look like a
   proper document: narrower outer padding, no light-on-light tints
   that vanish on grayscale printers, page-breaks that respect section
   boundaries, and link text that prints in the body colour rather
   than blue. */
@media print {
  .heron-report {
    max-width: none;
    padding: 0 24px 32px;
    font-size: 11.5pt;
    color: #000;
  }
  .heron-report .cover { margin-bottom: 36px; padding-bottom: 32px; }
  .heron-report .toc { margin-bottom: 36px; page-break-after: avoid; }
  .heron-report .h-section {
    margin-top: 28px;
    padding-top: 18px;
    page-break-after: avoid;
    break-after: avoid;
  }
  .heron-report .exec-sub { page-break-inside: avoid; break-inside: avoid; }
  .heron-report .tbl-wrap { page-break-inside: avoid; break-inside: avoid; }
  .heron-report .group { page-break-inside: avoid; break-inside: avoid; }
  .heron-report .source-row { page-break-inside: avoid; break-inside: avoid; }
  .heron-report a { color: inherit; text-decoration: none; }
  .heron-report details { page-break-inside: avoid; break-inside: avoid; }
  .heron-report details > summary { cursor: default; }
  /* Force-open all collapsible details for printing — the DPO needs the
     full inventory in the saved PDF, not the appendix half-folded. */
  .heron-report details:not([open]) > div,
  .heron-report details:not([open]) > p,
  .heron-report details:not([open]) > ul,
  .heron-report details:not([open]) > .tbl-wrap { display: block; }
  .heron-report .report-footer { margin-top: 32px; }
}
`;

/**
 * `<head>` snippet to load the typography stack from Google Fonts.
 * Single external resource — justified by typography being core to the
 * design. If the network is unavailable, the system stack in --r-font-sans
 * / --r-font-mono / --r-font-serif takes over gracefully.
 */
export const REPORT_FONTS_HEAD = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Newsreader:wght@400;500;600&display=swap">`;
