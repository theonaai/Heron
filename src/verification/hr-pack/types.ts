/**
 * Type contract for the AAP-51 HR vertical pack.
 *
 * The 12 framework detectors in `src/verification/frameworks/detectors.ts`
 * (AAP-49, lifted out of the deleted `router.ts` in AAP-86) are generic —
 * they fire on any scope or tool misalignment
 * regardless of vertical. The HR pack adds 7 detectors specific to HR
 * agent failure modes documented in the brain (see
 * `agent-access-platform-brain/custdevs/signals/
 *  2026-05-13-theona-templates-hr-sales-scan.md`):
 *
 *   1. auto-rejection-without-disclosure
 *   2. ats-write-scope-sprawl
 *   3. candidate-pii-in-logs
 *   4. scoring-without-criteria
 *   5. do-not-contact-bypass
 *   6. offer-letter-out-of-range
 *   7. sub-agent-scope-expansion
 *
 * Each detector is a PURE function consuming the same
 * `VerificationSignals` envelope as the framework detectors (re-used so
 * a future signal-extraction utility can be shared). Returns one
 * `HRSignal` with verdict, severity, rationale, evidence refs, and a
 * recommendation string the DPO can act on.
 *
 * The pack runs only when `isHRAgent(signals) === true` — see the
 * framework router for the HR-classification heuristic. Non-HR agents
 * return an empty result with `isHRAgent: false`; detectors do not
 * execute at all so they cannot false-flag.
 *
 * Toggleable via env `HERON_HR_PACK_DISABLED=true` (default enabled).
 *
 * Tracking: https://linear.app/theona/issue/AAP-51
 */

/**
 * Verdict for a single HR signal.
 *
 *  - `detected`     — the failure-mode pattern was matched.
 *  - `not-detected` — the failure-mode pattern was NOT matched (signal
 *                     evaluated cleanly).
 *  - `unverified`   — the detector could not evaluate (e.g. no MCP tool
 *                     inventory available for a tool-shape detector).
 *
 * Distinct from the framework `ControlVerdict` ladder because HR
 * signals are detector-style binary risk flags, not graded control
 * verdicts. Conflating the two would force every HR detector to author
 * a "verified" / "partial" rationale even when the underlying check is
 * a yes/no detection.
 */
export type HRSignalVerdict = 'detected' | 'not-detected' | 'unverified';

/**
 * Severity ladder for an HR signal. Matches `ControlSeverity` so the
 * exec-summary "headline findings" pass can sort HR signals and
 * framework controls in a single list.
 */
export type HRSignalSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * Back-link from an HR signal to the signal source that drove it.
 * Same vocabulary as `ControlEvidenceRef` for consistency across the
 * report renderer.
 *
 *  - `kind: 'diff'`       — a `DiffEntry` in the report.
 *  - `kind: 'inventory'`  — a specific actual-inventory entry (tool or
 *                            scope) that exists and triggered the
 *                            detector.
 *  - `kind: 'declared'`   — a `DeclaredInventory` entry (or its absence
 *                            of a documented field) drove the verdict.
 *  - `kind: 'approval'`   — an approval-chain entry was the basis.
 *  - `kind: 'absence'`    — the verdict was driven by something NOT
 *                            being present (e.g. no DNC mention in
 *                            agent.purpose).
 */
export interface HRSignalEvidenceRef {
  kind: 'diff' | 'inventory' | 'declared' | 'approval' | 'absence';
  ref: string;
}

/**
 * One per detector result.
 *
 *  - `signalId` is a stable kebab-case identifier (used for sorting,
 *    matching against `HR_INTERVIEW_QUESTIONS.topic`, etc.). DO NOT
 *    change a `signalId` once shipped — downstream tooling pins on it.
 *  - `name` is the human-readable title.
 *  - `rationale` may embed user-controlled strings (scope service /
 *    name, tool name). The renderer routes it through `escapeText`.
 *  - `recommendation` is a short imperative the DPO can drop into a
 *    remediation ticket. Static per detector — no embedded
 *    user-controlled strings — but still escaped at render time as
 *    defence in depth.
 */
export interface HRSignal {
  signalId: string;
  name: string;
  verdict: HRSignalVerdict;
  severity: HRSignalSeverity;
  rationale: string;
  evidenceRefs: HRSignalEvidenceRef[];
  recommendation: string;
}

/**
 * Aggregate output of `runHRPack`.
 *
 *  - `isHRAgent` mirrors the `isHRAgent` boolean from the framework
 *    classifier (`src/verification/frameworks/classify.ts`). Callers
 *    branch on this to omit the entire HR section when the agent is
 *    not HR-class.
 *  - `signals` is the ordered list of 7 detector results (when
 *    `isHRAgent === true`) or `[]` (when false / disabled).
 *  - `summary` is a counter rollup, convenient for the renderer.
 *
 * The ordering of `signals` is stable (matches the order in
 * `HR_DETECTOR_TABLE`) so snapshot tests do not depend on Map
 * iteration order.
 */
export interface HRPackResult {
  isHRAgent: boolean;
  signals: HRSignal[];
  summary: HRPackSummary;
}

export interface HRPackSummary {
  detectedCount: number;
  notDetectedCount: number;
  unverifiedCount: number;
  criticalDetected: number;
  highDetected: number;
}

/**
 * One row in the static HR-interview question list.
 *
 * Used by the future `heron interview hr` CLI command to walk an
 * operator through HR-specific declared-baseline capture. For PR #22
 * the command just prints each question; capture-into-file is
 * deferred.
 *
 *  - `id` is a stable kebab/numeric id (`hr-001` …) — pin downstream
 *    tooling on it.
 *  - `topic` matches a portion of an `HRSignal.signalId` so an
 *    operator who hits a detected signal can find the relevant
 *    question.
 *  - `expectedScopes` is an empty array for capability questions that
 *    do not map to a single scope (e.g. human-oversight).
 */
export interface HRInterviewQuestion {
  id: string;
  topic: string;
  question: string;
  expectedScopes: string[];
}

/**
 * Optional agent-metadata block on `DeclaredInventory` (file backend
 * already parses this — see
 * `src/verification/sources/agent-declaration/file.ts`). Re-declared
 * here as a shape consumed by HR detectors so the HR pack can read
 * `purpose` without circularly importing from the file backend.
 *
 * AAP-51 scope: the field is OPTIONAL on `DeclaredInventory`. Existing
 * callers that don't set it continue to work; HR detectors gracefully
 * treat `undefined` as "no purpose declared".
 */
export interface DeclaredAgentMetadata {
  name?: string;
  purpose?: string;
  owner?: string;
  version?: string;
}
