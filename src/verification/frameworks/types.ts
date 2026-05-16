/**
 * Type contract for AAP-49 framework-mapping layer.
 *
 * The differ (AAP-48) produces a structural account of declared-vs-actual
 * discrepancies. The framework mapper takes that structural output plus the
 * approval chain and translates each signal into a control-level verdict
 * against named compliance frameworks (AIUC-1, EU AI Act, GDPR, NIST AI RMF).
 *
 * Detection rules live in `router.ts`. They are PURE functions: given the
 * input signals, they return the same `FrameworkControl` every time. No I/O,
 * no LLM, no async. The mapper itself runs synchronously after the
 * verification orchestrator finishes.
 *
 * Control identifiers (`controlId`) follow each framework's own vocabulary:
 *  - AIUC-1: `A003`, `B006`, `D003`, `E004`, `E015` (single-letter family
 *    + 3-digit numeric, per the Q2-2026 release).
 *  - EU AI Act: `Annex III §4`, `Article 14`, `Article 12` — verbatim
 *    article references from Regulation (EU) 2024/1689.
 *  - GDPR: `Article 22`, `Article 5` — verbatim references from Regulation
 *    (EU) 2016/679.
 *  - NIST AI RMF: `MEASURE`, `MANAGE` (function-level rollup; per-control
 *    citations live in `controlName`).
 *
 * Tracking: https://linear.app/theona/issue/AAP-49
 *
 * Design notes:
 *  - `FrameworkId` is a fixed union; adding a new framework requires a
 *    deliberate change here, not a stringly-typed override at the call site.
 *  - `ControlVerdict` mirrors the verification verdict ladder but adds two
 *    new states: `partial` (some-but-not-all signals satisfied) and
 *    `not-applicable` (the control's preconditions did not fire — e.g.
 *    Annex III §4 on a non-HR agent). Conflating these into `unverified`
 *    would lose the auditor's most important distinction: "no evidence" vs.
 *    "evidence says this does not apply".
 *  - `evidenceRefs` is structured rather than free-form so a future JSON
 *    export can point directly at the specific diff / approval entry that
 *    drove the verdict. The `ref` string itself stays human-readable for
 *    the Markdown renderer.
 *  - `severity` mirrors the diff severity ladder so the mapping table can
 *    sort consistently with the verification findings table.
 */

/**
 * Compliance frameworks the mapper produces verdicts against.
 *
 * The four entries match the HR-pilot deliverable #4 enumeration:
 * AIUC-1 (agent-native, voluntary, used as the procurement evidence anchor),
 * EU AI Act (Annex III §4 — employment — is the load-bearing reference),
 * GDPR (Article 22 — automated decision-making — and Article 5(1)(c) — data
 * minimisation), and NIST AI RMF (US-origin voluntary; MEASURE / MANAGE
 * functions roll up the verification activity as evidence).
 */
export type FrameworkId = 'aiuc-1' | 'eu-ai-act' | 'gdpr' | 'nist-ai-rmf';

/**
 * Per-control verdict.
 *
 *  - `verified`       — all signals required by the rule fired positively.
 *  - `partial`        — some required signals fired; others were absent or
 *                       weak. Not a hard failure, but explicit "more work
 *                       needed".
 *  - `unverified`     — the signal source the rule needs is not present
 *                       (e.g. no MCP inventory → D003 cannot be evaluated).
 *  - `fail`           — at least one signal directly contradicts the rule
 *                       (e.g. extra `gmail.send` scope for B006).
 *  - `not-applicable` — the rule's preconditions are not met by THIS agent
 *                       (e.g. Annex III §4 employment routing on a non-HR
 *                       agent). Distinct from `unverified` — we have
 *                       evidence the control does not bind.
 */
export type ControlVerdict =
  | 'verified'
  | 'partial'
  | 'unverified'
  | 'fail'
  | 'not-applicable';

/**
 * Severity ladder for a control verdict. Matches `DiffSeverity` so the
 * compliance mapping table can sort alongside the diff table.
 */
export type ControlSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * One link from a control verdict back to the signal that drove it.
 *
 *  - `kind: 'diff'`       — a specific `DiffEntry` in the report.
 *  - `kind: 'inventory'`  — a specific `ActualInventory` entry (tool /
 *                            scope) that exists but was the source of the
 *                            verdict (e.g. risky tool present without
 *                            annotation).
 *  - `kind: 'approval'`   — a specific entry in the `ApprovalChain`.
 *  - `kind: 'declared'`   — a specific `DeclaredInventory` entry.
 *  - `kind: 'absence'`    — the verdict was driven by something NOT
 *                            being present (e.g. no approval chain at
 *                            all → E004 fails).
 *
 * `ref` is a free-form human-readable descriptor like `'diff[3]: extra
 * scope gmail.send'` — enough for an auditor to find the row in the
 * verification table. We intentionally keep this as a string rather than
 * a structural pointer so the renderer can output it verbatim without
 * a second lookup pass.
 */
export interface ControlEvidenceRef {
  kind: 'diff' | 'inventory' | 'approval' | 'declared' | 'absence';
  ref: string;
}

/**
 * Per-control mapping result.
 *
 *  - `framework` + `controlId` together form a stable primary key. Keep
 *    them in lock-step with the framework's own vocabulary.
 *  - `controlName` is the human-readable name (e.g. "Limit Data Access").
 *    Treated as static reference data — NOT user-controlled, never
 *    escaped at render time beyond standard Markdown defence in depth.
 *  - `rationale` is a 1-3 sentence explanation of WHY this verdict was
 *    produced. May embed user-controlled strings (scope names, tool
 *    names, actor names) — the renderer routes it through `escapeText`.
 *  - `evidenceRefs` is the structured back-link (see above).
 *  - `severity` lets the renderer sort and colour-code by impact.
 */
export interface FrameworkControl {
  framework: FrameworkId;
  controlId: string;
  controlName: string;
  verdict: ControlVerdict;
  rationale: string;
  evidenceRefs: ControlEvidenceRef[];
  severity: ControlSeverity;
}

/**
 * Aggregate output of the framework mapper.
 *
 *  - `generatedAt` is the ISO timestamp captured when the mapper ran.
 *    Distinct from the verification report's `capturedAt` so the same
 *    report can be re-mapped against an updated control catalogue
 *    without rewriting the inventory timestamp.
 *  - `controls` is the ordered list of per-control verdicts. Order is
 *    stable for snapshot tests: AIUC-1 family first (A → B → D → E),
 *    then EU AI Act, then GDPR, then NIST AI RMF. The ordering policy
 *    lives in `router.ts`.
 *  - `summary` is a counter rollup. Convenient for the renderer and for
 *    future dashboards. Re-derivable from `controls` but stored once
 *    rather than re-counted at every render.
 */
export interface FrameworkMapping {
  generatedAt: string;
  controls: FrameworkControl[];
  summary: FrameworkMappingSummary;
}

export interface FrameworkMappingSummary {
  verifiedCount: number;
  partialCount: number;
  unverifiedCount: number;
  failCount: number;
  notApplicableCount: number;
}
