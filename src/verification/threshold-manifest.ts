/**
 * AAP-88 — canonical source of truth for all verdict thresholds.
 *
 * Every threshold (numeric cutoff OR categorical gate) that participates in
 * `computeVerdict`, `verification.status` derivation, risk-score weighting,
 * compliance-mapper gating, framework/HR/discovery detectors, the report-
 * level renderer, and the control-results projection lives here as a
 * documented entry. The threshold-defining files either (a) import constants
 * from this manifest as the source of truth, or (b) reference manifest
 * entries by name in their doc comments so an auditor can trace from code to
 * canonical.
 *
 * Snapshot tested — any change requires explicit reviewer attention via PR
 * diff. Per-framework configurability deferred to AAP-89 (Phase B).
 *
 * ## Phase A scope (this ticket)
 *
 * - Pure documentation + snapshot. ZERO behavior change.
 * - Inventory every threshold across 10 files. Capture rationale, source,
 *   and verdict states affected.
 * - Do NOT change any threshold value.
 *
 * ## Phase B scope (AAP-89, deferred)
 *
 * - Per-framework configurability so adopters can tune thresholds for their
 *   risk tolerance / regulatory posture without forking source.
 *
 * ## Honesty principle
 *
 * Many of these thresholds are Heron internal heuristics — they reflect
 * judgement calls from the design-partner conversations and the AAP-63 / -70
 * / -75 / -80 / -85 / -86 iteration history rather than a citable line in EU
 * AI Act / AIUC-1 / GDPR / NIST AI RMF text. Those are marked `source:
 * 'Heron internal heuristic, design-partner feedback pending'`. External
 * references are cited only when the regulation actually pins a number or a
 * categorical gate.
 *
 * ## Threshold types
 *
 * - `numeric` — a literal numeric cutoff (e.g. `>=3 HIGH discovery
 *   findings`, `score >= 85`).
 * - `categorical` — a rule about WHICH inputs / which combinations gate a
 *   verdict (e.g. "any `fail` means Action Required", "verified requires
 *   both discovery AND OAuth evidence").
 *
 * Categorical entries carry `value` as a string describing the rule.
 *
 * ## Stable ordering
 *
 * Entries are grouped by source file (and within a file, by code order) so
 * the manifest reads as a top-to-bottom walk of the verdict pipeline. The
 * snapshot serializer will preserve this order — a new entry inserted in
 * the middle will show up as a localised diff rather than a global churn.
 */

/* eslint-disable @typescript-eslint/no-magic-numbers */

export type ThresholdType = 'numeric' | 'categorical';

export interface ThresholdSite {
  /** Source file (repo-relative path). */
  file: string;
  /** Optional symbol name (function / constant) where the threshold lives. */
  symbol?: string;
}

export interface ThresholdEntry {
  /** Stable identifier used in code references and snapshot keys. */
  name: string;
  /** Numeric value OR categorical rule description. */
  value: number | string;
  /** Type of threshold. */
  type: ThresholdType;
  /** Where this threshold lives in code (one or more sites). */
  sites: ThresholdSite[];
  /** Human rationale for THIS value (not a generic restatement of the rule). */
  rationale: string;
  /** External framework reference if any; otherwise honestly mark internal. */
  source: string;
  /** Which verdict states / framework outputs this threshold influences. */
  affects: string[];
}

const INTERNAL_HEURISTIC = 'Heron internal heuristic, design-partner feedback pending';

export const THRESHOLD_MANIFEST: Record<string, ThresholdEntry> = {
  // ──────────────────────────────────────────────────────────────────────
  // src/verification/verdict.ts — per-control + per-session verdicts
  // ──────────────────────────────────────────────────────────────────────

  verdict_discoveryRisk_highEscalate: {
    name: 'verdict_discoveryRisk_highEscalate',
    value: 3,
    type: 'numeric',
    sites: [{ file: 'src/verification/verdict.ts', symbol: 'discoveryRiskLevel' }],
    rationale:
      'Three or more HIGH discovery findings escalates deterministic risk to `high`. Picked because one HIGH on its own is treated as a single misconfig (`medium`) while a cluster of three signals a systemic posture problem worth the higher pill.',
    source: INTERNAL_HEURISTIC,
    affects: ['Verdict.deterministicRiskLevel', 'Verdict.primaryRiskLevel'],
  },
  verdict_discoveryRisk_highToMedium: {
    name: 'verdict_discoveryRisk_highToMedium',
    value: 1,
    type: 'numeric',
    sites: [{ file: 'src/verification/verdict.ts', symbol: 'discoveryRiskLevel' }],
    rationale:
      'Any single HIGH discovery finding bumps the deterministic risk to `medium`. AAP-63 brief: "CRITICAL → high, HIGH → medium, MEDIUM → medium" — one HIGH on its own is medium, not low.',
    source: INTERNAL_HEURISTIC,
    affects: ['Verdict.deterministicRiskLevel'],
  },
  verdict_discoveryRisk_mediumEscalate: {
    name: 'verdict_discoveryRisk_mediumEscalate',
    value: 3,
    type: 'numeric',
    sites: [{ file: 'src/verification/verdict.ts', symbol: 'discoveryRiskLevel' }],
    rationale:
      'Three or more MEDIUM discovery findings escalates to `medium`. Fewer than three is treated as `low` so isolated info-grade noise does not promote the pill.',
    source: INTERNAL_HEURISTIC,
    affects: ['Verdict.deterministicRiskLevel'],
  },
  verdict_writeTools_highLift: {
    name: 'verdict_writeTools_highLift',
    value: 5,
    type: 'numeric',
    sites: [{ file: 'src/verification/verdict.ts', symbol: 'liftForWriteTools' }],
    rationale:
      'AAP-75 — 5 or more write-classified MCP tools across all servers lifts the deterministic risk to `high`, regardless of LLM analysis. Threshold intentionally low because the same agent that claims "read-only" but ships 5+ write tools is precisely the misclaim AAP-75 exists to expose.',
    source: INTERNAL_HEURISTIC,
    affects: ['Verdict.deterministicRiskLevel', 'Verdict.primaryRiskLevel'],
  },
  verdict_writeTools_mediumLift: {
    name: 'verdict_writeTools_mediumLift',
    value: 1,
    type: 'numeric',
    sites: [{ file: 'src/verification/verdict.ts', symbol: 'liftForWriteTools' }],
    rationale:
      'AAP-75 — even 1 write-classified MCP tool lifts a baseline-clean discovery from `low` to `medium`. The cost of a false-positive medium is low; the cost of missing a single write tool in an agent claimed as read-only is high.',
    source: INTERNAL_HEURISTIC,
    affects: ['Verdict.deterministicRiskLevel'],
  },
  verdict_writeTools_noLift: {
    name: 'verdict_writeTools_noLift',
    value: 0,
    type: 'numeric',
    sites: [{ file: 'src/verification/verdict.ts', symbol: 'liftForWriteTools' }],
    rationale:
      'AAP-75 — zero write tools leaves the baseline unchanged. Zero MUST be the no-op case so legitimately read-only agents stay at their baseline risk.',
    source: INTERNAL_HEURISTIC,
    affects: ['Verdict.deterministicRiskLevel'],
  },
  verdict_writeTools_noDowngrade: {
    name: 'verdict_writeTools_noDowngrade',
    value: 'liftForWriteTools never DOWNGRADES — if discovery findings already say `high`, the write-tool ramp does not drop it to `medium`. Implemented via maxRisk(baseline, ramp).',
    type: 'categorical',
    sites: [{ file: 'src/verification/verdict.ts', symbol: 'liftForWriteTools' }],
    rationale:
      'AAP-75 invariant: ramping a `high` discovery down to `medium` because the write-tool count happened to land in the medium band would mask the original signal. Lift only, never drop.',
    source: INTERNAL_HEURISTIC,
    affects: ['Verdict.deterministicRiskLevel'],
  },
  verdict_oauthRisk_criticalToHigh: {
    name: 'verdict_oauthRisk_criticalToHigh',
    value: 1,
    type: 'numeric',
    sites: [{ file: 'src/verification/verdict.ts', symbol: 'oauthRiskLevel' }],
    rationale:
      'A single critical-severity OAuth diff entry promotes the OAuth-side risk to `high`. OAuth scope diffs are deterministic introspection results, so one critical mismatch is enough.',
    source: INTERNAL_HEURISTIC,
    affects: ['Verdict.deterministicRiskLevel (oauth contribution)'],
  },
  verdict_oauthRisk_highEscalate: {
    name: 'verdict_oauthRisk_highEscalate',
    value: 3,
    type: 'numeric',
    sites: [{ file: 'src/verification/verdict.ts', symbol: 'oauthRiskLevel' }],
    rationale:
      'Three or more high-severity OAuth diff entries also promote to `high`. Mirrors the discovery ramp at the diff-severity level.',
    source: INTERNAL_HEURISTIC,
    affects: ['Verdict.deterministicRiskLevel (oauth contribution)'],
  },
  verdict_oauthRisk_highToMedium: {
    name: 'verdict_oauthRisk_highToMedium',
    value: 1,
    type: 'numeric',
    sites: [{ file: 'src/verification/verdict.ts', symbol: 'oauthRiskLevel' }],
    rationale:
      'A single high-severity OAuth diff lifts to `medium`. Matches discovery side: one HIGH = medium.',
    source: INTERNAL_HEURISTIC,
    affects: ['Verdict.deterministicRiskLevel (oauth contribution)'],
  },
  verdict_oauthRisk_mediumEscalate: {
    name: 'verdict_oauthRisk_mediumEscalate',
    value: 3,
    type: 'numeric',
    sites: [{ file: 'src/verification/verdict.ts', symbol: 'oauthRiskLevel' }],
    rationale:
      'Three or more medium-severity OAuth diffs escalate to `medium`. Mirrors discovery ramp.',
    source: INTERNAL_HEURISTIC,
    affects: ['Verdict.deterministicRiskLevel (oauth contribution)'],
  },
  verdict_discrepancy_windowChars: {
    name: 'verdict_discrepancy_windowChars',
    value: 80,
    type: 'numeric',
    sites: [{ file: 'src/verification/verdict.ts', symbol: 'detectDiscrepancies' }],
    rationale:
      'Discrepancy detector requires a denial token AND a service-name token within ~80 chars of each other (40 before + 40 after the service-name match, expanding to up to 160 chars window for the regex test). Conservative on purpose: false positives in this list erode trust in the broader verdict.',
    source: INTERNAL_HEURISTIC,
    affects: ['Verdict.discrepancies'],
  },
  verdict_status_verifiedRequiresBoth: {
    name: 'verdict_status_verifiedRequiresBoth',
    value: '`verified` requires BOTH discovery AND OAuth introspection ran AND both produced clean evidence. Missing OAuth (token-capture UX deferred to AAP-64) means sessions land on `partial` for the foreseeable future even when discovery returns zero findings. AAP-91: any single-source Surface 2 case (e.g., `discoveredAgents`-only enumeration without discovery diff or OAuth) also lands on `partial` even when sources are clean — `hasAgents` participates ONLY in the Surface 2 presence gate, never in the verified gate.',
    type: 'categorical',
    sites: [{ file: 'src/verification/verdict.ts', symbol: 'computeVerdict' }],
    rationale:
      'AAP-63 design choice: `verified` is the strongest claim Heron makes about an agent. Both Surface 2 sources must run AND both must be clean. Anything short of that is `partial` — a calibrated half-claim.',
    source: INTERNAL_HEURISTIC,
    affects: ['Verdict.status'],
  },
  verdict_status_partialWhenAny: {
    name: 'verdict_status_partialWhenAny',
    value: '`partial` when at least one Surface 2 source ran (discovery, OAuth, OR discoveredAgents — AAP-91) but the verified-requires-both gate fails.',
    type: 'categorical',
    sites: [{ file: 'src/verification/verdict.ts', symbol: 'computeVerdict' }],
    rationale:
      'AAP-63: any Surface 2 evidence is better than none, but a single source is not enough for the strongest claim. `partial` is the honest middle ground.',
    source: INTERNAL_HEURISTIC,
    affects: ['Verdict.status'],
  },
  verdict_status_unverifiedNoSurface2: {
    name: 'verdict_status_unverifiedNoSurface2',
    value: '`unverified` when none of the Surface 2 sources ran (no discovery, no OAuth, no discoveredAgents — AAP-91). Falls back to "no-evidence" verdict with `primaryRiskLevel: \'unverified\'`.',
    type: 'categorical',
    sites: [{ file: 'src/verification/verdict.ts', symbol: 'computeVerdict' }],
    rationale:
      'AAP-63 strategy v3.0 §3 — "every claim about an AI agent should be verifiable from a deterministic source of truth". With zero Surface 2 evidence we make no claim; the badge surfaces as "VERIFICATION REQUIRED" rather than inventing a risk level.',
    source: INTERNAL_HEURISTIC,
    affects: ['Verdict.status', 'Verdict.primaryRiskLevel'],
  },
  verdict_writeTools_excludeUnknown: {
    name: 'verdict_writeTools_excludeUnknown',
    value: '`unknown`-classified MCP tools are NOT counted toward the write-tool ramp; only `write`-classified tools count.',
    type: 'categorical',
    sites: [{ file: 'src/verification/verdict.ts', symbol: 'countWriteTools' }],
    rationale:
      'AAP-75 conservative posture: surfacing `unknown` tools in the report lets an operator manually resolve them, but the verdict ramp stays conservative — we do not promote risk on tools the classifier could not type confidently.',
    source: INTERNAL_HEURISTIC,
    affects: ['Verdict.deterministicRiskLevel'],
  },

  // ──────────────────────────────────────────────────────────────────────
  // src/verification/verdict-pipeline.ts — AAP-80 verification.status mapping
  // ──────────────────────────────────────────────────────────────────────

  verdict_pipeline_verifiedMapping: {
    name: 'verdict_pipeline_verifiedMapping',
    value: '`verdict.status === "verified"` → report `verification.status: "verified"`.',
    type: 'categorical',
    sites: [{ file: 'src/verification/verdict-pipeline.ts', symbol: 'reportVerificationStatusFromVerdict' }],
    rationale:
      'AAP-80: clean Surface 2 across both sources is reported as `verified`. 1:1 mapping; no ambiguity.',
    source: INTERNAL_HEURISTIC,
    affects: ['ReportVerificationStatus'],
  },
  verdict_pipeline_partialMapping: {
    name: 'verdict_pipeline_partialMapping',
    value: '`verdict.status === "partial"` → report `verification.status: "partially-verified"`.',
    type: 'categorical',
    sites: [{ file: 'src/verification/verdict-pipeline.ts', symbol: 'reportVerificationStatusFromVerdict' }],
    rationale:
      'AAP-80: most common steady-state for AAP-79-era audits — discovery runs but OAuth introspection (AAP-64) is wired manually, so the verdict can almost never reach `verified`. The renderer needs a distinct label for this state vs interrogation-only.',
    source: INTERNAL_HEURISTIC,
    affects: ['ReportVerificationStatus'],
  },
  verdict_pipeline_interrogationOnlyMapping: {
    name: 'verdict_pipeline_interrogationOnlyMapping',
    value: '`verdict.status === "unverified"` AND no Surface 2 attempted → `interrogation-only`. Pre-scan baseline.',
    type: 'categorical',
    sites: [{ file: 'src/verification/verdict-pipeline.ts', symbol: 'reportVerificationStatusFromVerdict' }],
    rationale:
      'AAP-80: pre-scan reports must surface as "we interrogated but did not verify" so the reader knows the absence of Surface 2 is the diagnosis, not a failure. Defaults to this branch when the caller omits the `surface2Attempted` flag (conservative default).',
    source: INTERNAL_HEURISTIC,
    affects: ['ReportVerificationStatus'],
  },
  verdict_pipeline_verificationFailedMapping: {
    name: 'verdict_pipeline_verificationFailedMapping',
    value: '`verdict.status === "unverified"` AND surface2Attempted=true → `verification-failed`. A Surface 2 source was attempted but failed.',
    type: 'categorical',
    sites: [{ file: 'src/verification/verdict-pipeline.ts', symbol: 'reportVerificationStatusFromVerdict' }],
    rationale:
      'AAP-80: distinct from `interrogation-only` so the operator knows verification was attempted, not skipped. Caller opts in via `options.surface2Attempted: true`.',
    source: INTERNAL_HEURISTIC,
    affects: ['ReportVerificationStatus'],
  },

  // ──────────────────────────────────────────────────────────────────────
  // src/compliance/mapper.ts — risk-score weighting + EU AI Act classification
  // ──────────────────────────────────────────────────────────────────────

  mapper_decisionImpact_minDetailsLen: {
    name: 'mapper_decisionImpact_minDetailsLen',
    value: 10,
    type: 'numeric',
    sites: [{ file: 'src/compliance/mapper.ts', symbol: 'classifyDecisionImpact' }],
    rationale:
      'Decision-impact classifier treats `details` shorter than 10 chars (or "NOT PROVIDED") as unclear. Below 10 chars is too short to extract meaningful intent.',
    source: INTERNAL_HEURISTIC,
    affects: ['DecisionImpact', 'EUAIActClassification'],
  },
  mapper_largeScale_minBusinessSystems: {
    name: 'mapper_largeScale_minBusinessSystems',
    value: 3,
    type: 'numeric',
    sites: [{ file: 'src/compliance/mapper.ts', symbol: 'detectSignals' }],
    rationale:
      "AAP-43 P1: `hasLargeScaleProcessing` fires at 3+ business systems OR any org-wide / cross-tenant blast radius. Three systems is the threshold where a single agent's compliance surface starts to span the organisation rather than a single workflow.",
    source: INTERNAL_HEURISTIC,
    affects: ['ComplianceSignals.hasLargeScaleProcessing', 'GDPR Art. 35 DPIA gating'],
  },
  mapper_negationWindow_filler: {
    name: 'mapper_negationWindow_filler',
    value: 80,
    type: 'numeric',
    sites: [{ file: 'src/compliance/mapper.ts', symbol: 'NEGATION_WINDOW_RE' }],
    rationale:
      'AAP-70: negation window allows up to 80 chars of filler between a negation cue and the Annex III keyword. Tuned to catch "I do not do biometric ID" without spanning sentence boundaries (the inner `[^.!?]{0,80}` halts at sentence punctuation).',
    source: INTERNAL_HEURISTIC,
    affects: ['ComplianceSignals.hasBiometricSignal', 'ComplianceSignals.isEducationAssessmentContext', 'ComplianceSignals.isLawEnforcementContext', 'ComplianceSignals.hasEssentialServicesSignal'],
  },
  mapper_negationWindow_trailingChain: {
    name: 'mapper_negationWindow_trailingChain',
    value: 40,
    type: 'numeric',
    sites: [{ file: 'src/compliance/mapper.ts', symbol: 'NEGATION_WINDOW_RE' }],
    rationale:
      'AAP-70: trailing keywords in a chained negation ("not biometric, education, or essential services") each get up to 40 chars of inter-keyword filler. Tighter than the head window because the chain is already inside a negation scope.',
    source: INTERNAL_HEURISTIC,
    affects: ['ComplianceSignals annexIII signals'],
  },
  mapper_negationWindow_trailingMax: {
    name: 'mapper_negationWindow_trailingMax',
    value: 6,
    type: 'numeric',
    sites: [{ file: 'src/compliance/mapper.ts', symbol: 'NEGATION_WINDOW_RE' }],
    rationale:
      'AAP-70: up to 6 trailing keywords in a single negation chain. Six is generous enough for a comma-separated list of the 5 Annex III categories plus one alias.',
    source: INTERNAL_HEURISTIC,
    affects: ['ComplianceSignals annexIII signals'],
  },
  mapper_metaList_minCategories: {
    name: 'mapper_metaList_minCategories',
    value: 3,
    type: 'numeric',
    sites: [{ file: 'src/compliance/mapper.ts', symbol: 'META_LIST_RE' }],
    rationale:
      'AAP-70: a sentence containing 3+ Annex III category names is treated as a meta-list (the agent is enumerating categories, not declaring use). Two is too aggressive (two categories can co-occur legitimately); three is the threshold for "the agent is listing".',
    source: INTERNAL_HEURISTIC,
    affects: ['ComplianceSignals annexIII signals'],
  },
  mapper_employment_negationFiller: {
    name: 'mapper_employment_negationFiller',
    value: 3,
    type: 'numeric',
    sites: [{ file: 'src/compliance/mapper.ts', symbol: 'detectSignals' }],
    rationale:
      'AAP-43 post-merge fix: employment-negation regex allows up to 3 filler words between negation cue and keyword. Covers "does not involve hiring", "not used for recruiting", "not a hiring agent". Wider than 3 starts catching unrelated clauses.',
    source: INTERNAL_HEURISTIC,
    affects: ['ComplianceSignals.hasEmploymentDecisions'],
  },
  mapper_decisionsAboutPeople_minDetailsLen: {
    name: 'mapper_decisionsAboutPeople_minDetailsLen',
    value: 10,
    type: 'numeric',
    sites: [{ file: 'src/compliance/mapper.ts', symbol: 'detectSignals' }],
    rationale:
      'AAP-43 P1: trust `decisionMakingDetails` over transcript scrape only when the field is longer than 10 chars. Below 10 chars the LLM-extracted summary is too thin to be authoritative.',
    source: INTERNAL_HEURISTIC,
    affects: ['ComplianceSignals.hasEmploymentDecisions'],
  },
  mapper_annexIII_biometricGate: {
    name: 'mapper_annexIII_biometricGate',
    value: 'EU AI Act Annex III §1 fires when prose biometric signal + sensitive PII + decisions-about-people are all present. Typed-signal elevation path requires same prose gates PLUS a typed biometric vendor key (Rekognition, Azure Face, etc.).',
    type: 'categorical',
    sites: [{ file: 'src/compliance/mapper.ts', symbol: 'classifyEUAIAct' }],
    rationale:
      'AAP-70 + AAP-85: biometric vendor APIs (Rekognition, Azure Face) are widely used for non-Annex-III purposes (photo organisation, accessibility). The three-signal gate prevents elevation on a lone Rekognition key in a photo-tagging agent.',
    source: 'EU AI Act Annex III §1 (biometric identification/categorisation/emotion recognition) — Heron categorisation gate is internal heuristic',
    affects: ['EUAIActClassification', 'Annex III §1 control rendering'],
  },
  mapper_annexIII_employmentGate: {
    name: 'mapper_annexIII_employmentGate',
    value: 'EU AI Act Annex III §4 fires when hasEmploymentDecisions + decisionImpact !== "none". Typed-signal elevation requires same prose gates PLUS a typed employment vendor (BAMBOOHR, GREENHOUSE, ADP, Workday, …) AND the prose has not negated employment.',
    type: 'categorical',
    sites: [{ file: 'src/compliance/mapper.ts', symbol: 'classifyEUAIAct' }],
    rationale:
      'AAP-85: typed signal is strongest in employment (HRIS/ATS credentials are high-confidence employment indicators). ELEVATE-not-OVERRIDE invariant: typed signal cannot flip an explicit prose negation ("we make no employment decisions").',
    source: 'EU AI Act Annex III §4 (employment, workers management, access to self-employment) — Heron gating is internal heuristic',
    affects: ['EUAIActClassification', 'Annex III §4 control rendering'],
  },
  mapper_annexIII_essentialServicesGate: {
    name: 'mapper_annexIII_essentialServicesGate',
    value: 'EU AI Act Annex III §5 requires hasEssentialServicesSignal + decisionImpact === "high" + decisions-about-people (prose path). Typed elevation requires high-impact decisions + (typed financial+health-insurance) OR (typed + prose essential-services).',
    type: 'categorical',
    sites: [{ file: 'src/compliance/mapper.ts', symbol: 'classifyEUAIAct' }],
    rationale:
      'AAP-85 conservative posture: the cost of a false-positive on essential services is high (AAP-70 repro). A lone Stripe / Plaid key in a budgeting agent that makes high-impact decisions about people still should not fire §5 — convergence requirement.',
    source: 'EU AI Act Annex III §5 (access to and enjoyment of essential public/private services) — Heron gating is internal heuristic',
    affects: ['EUAIActClassification', 'Annex III §5 control rendering'],
  },
  mapper_annexIII_lawEnforcementGate: {
    name: 'mapper_annexIII_lawEnforcementGate',
    value: 'EU AI Act Annex III §6 requires isLawEnforcementContext + decisions-about-people + decisionImpact !== "none". NO typed signal contribution — the credential surface has no reliable law-enforcement pattern.',
    type: 'categorical',
    sites: [{ file: 'src/compliance/mapper.ts', symbol: 'classifyEUAIAct' }],
    rationale:
      'AAP-70 + AAP-85: no typed signal for §6 because there is no widely-deployed border / immigration / forensic API with a recognisable key name, and the cost of a false positive is the AAP-70 repro.',
    source: 'EU AI Act Annex III §6 (law enforcement) — Heron gating is internal heuristic',
    affects: ['EUAIActClassification', 'Annex III §6 control rendering'],
  },
  mapper_annexIII_educationGate: {
    name: 'mapper_annexIII_educationGate',
    value: 'EU AI Act Annex III §3 requires isEducationAssessmentContext + decisions-about-people. Typed elevation: typed education vendor (Canvas LMS, Blackboard, …) + decisions-about-people, only when prose has not negated education / decisions.',
    type: 'categorical',
    sites: [{ file: 'src/compliance/mapper.ts', symbol: 'classifyEUAIAct' }],
    rationale:
      'AAP-70 + AAP-85: §3 stays single-prose-signal because EDUCATION_ASSESSMENT_PATTERN is narrow enough not to fire on unrelated transcripts. Typed signal elevates when prose talks about "students" without using canonical "grading"/"assessment" vocabulary.',
    source: 'EU AI Act Annex III §3 (education and vocational training) — Heron gating is internal heuristic',
    affects: ['EUAIActClassification', 'Annex III §3 control rendering'],
  },
  mapper_typed_elevateNotOverride: {
    name: 'mapper_typed_elevateNotOverride',
    value: 'Typed Surface 2 signals can ELEVATE a classification when prose is ambiguous, but cannot OVERRIDE an explicit prose negation. If the agent says `makesDecisionsAboutPeople: false` AND decisionImpact === "none", NO typed signal can re-classify as high-risk.',
    type: 'categorical',
    sites: [{ file: 'src/compliance/mapper.ts', symbol: 'classifyEUAIAct' }],
    rationale:
      'AAP-85 invariant: load-bearing for the AAP-70 Claude Code self-audit fixture. A stray HRIS env key in an agent that has declared "no decisions about people" must NOT flip the classification.',
    source: INTERNAL_HEURISTIC,
    affects: ['EUAIActClassification'],
  },
  mapper_categoryNegation_perCategory: {
    name: 'mapper_categoryNegation_perCategory',
    value: 'Each Annex III category honours its own explicit prose negation (proseExplicitlyNoBiometric, proseExplicitlyNoEducation, proseExplicitlyNoEmployment, proseExplicitlyNoEssentialServices). Typed elevation must respect both whole-classification AND category-specific negation.',
    type: 'categorical',
    sites: [{ file: 'src/compliance/mapper.ts', symbol: 'classifyEUAIAct' }],
    rationale:
      'AAP-85 Codex post-review: a BAMBOOHR env key in an agent that has said "no employment decisions" must NOT elevate §4, even when prose decisions-about-people is true (agent may make decisions in some other domain).',
    source: INTERNAL_HEURISTIC,
    affects: ['EUAIActClassification per-category'],
  },

  // ──────────────────────────────────────────────────────────────────────
  // src/analysis/risk-scorer.ts — rubric weights + severity ladder
  // ──────────────────────────────────────────────────────────────────────

  riskScorer_weight_excessiveAccess: {
    name: 'riskScorer_weight_excessiveAccess',
    value: 0.35,
    type: 'numeric',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'WEIGHTS' }],
    rationale:
      'Excessive access carries the largest rubric weight (35%) because over-broad scopes are the most common and most exploited misconfig pattern in agent deployments.',
    source: INTERNAL_HEURISTIC,
    affects: ['RiskScore.score', 'RiskScore.overall'],
  },
  riskScorer_weight_writeRisk: {
    name: 'riskScorer_weight_writeRisk',
    value: 0.30,
    type: 'numeric',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'WEIGHTS' }],
    rationale:
      'Write risk is the second-largest weight (30%). Writes are typically reversible with effort; over-broad scopes are continuously dangerous. Hence smaller than excessiveAccess but larger than data sensitivity.',
    source: INTERNAL_HEURISTIC,
    affects: ['RiskScore.score', 'RiskScore.overall'],
  },
  riskScorer_weight_sensitiveData: {
    name: 'riskScorer_weight_sensitiveData',
    value: 0.20,
    type: 'numeric',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'WEIGHTS' }],
    rationale:
      'Sensitive-data weight (20%). Data sensitivity is downstream of access; the access + write weights already capture much of the data-side risk.',
    source: INTERNAL_HEURISTIC,
    affects: ['RiskScore.score', 'RiskScore.overall'],
  },
  riskScorer_weight_scopeCreep: {
    name: 'riskScorer_weight_scopeCreep',
    value: 0.15,
    type: 'numeric',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'WEIGHTS' }],
    rationale:
      'Scope-creep weight (15%) — smallest of the four. Scope creep is a leading indicator (declared > needed) rather than a realised risk, so it scores lower than the operational categories.',
    source: INTERNAL_HEURISTIC,
    affects: ['RiskScore.score', 'RiskScore.overall'],
  },
  riskScorer_blastRadius_singleRecord: {
    name: 'riskScorer_blastRadius_singleRecord',
    value: 0.2,
    type: 'numeric',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'BLAST_RADIUS_MULTIPLIER' }],
    rationale:
      'Single-record blast radius scales risk down to 20%. A misconfig that affects one record per call is bounded; the multiplier reflects that.',
    source: INTERNAL_HEURISTIC,
    affects: ['per-component scores'],
  },
  riskScorer_blastRadius_singleUser: {
    name: 'riskScorer_blastRadius_singleUser',
    value: 0.4,
    type: 'numeric',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'BLAST_RADIUS_MULTIPLIER' }],
    rationale:
      'Single-user blast radius — 40%. Covers per-user scopes (one Gmail account, one Drive). Larger than single-record because a user has many records.',
    source: INTERNAL_HEURISTIC,
    affects: ['per-component scores'],
  },
  riskScorer_blastRadius_teamScope: {
    name: 'riskScorer_blastRadius_teamScope',
    value: 0.6,
    type: 'numeric',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'BLAST_RADIUS_MULTIPLIER' }],
    rationale:
      'Team scope — 60%. A shared inbox / shared drive — material reach but not org-wide.',
    source: INTERNAL_HEURISTIC,
    affects: ['per-component scores'],
  },
  riskScorer_blastRadius_orgWide: {
    name: 'riskScorer_blastRadius_orgWide',
    value: 0.85,
    type: 'numeric',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'BLAST_RADIUS_MULTIPLIER' }],
    rationale:
      'Org-wide blast radius — 85%. An admin-grade scope reaching every user in the tenant. Almost the maximum; cross-tenant is the only larger amplifier.',
    source: INTERNAL_HEURISTIC,
    affects: ['per-component scores'],
  },
  riskScorer_blastRadius_crossTenant: {
    name: 'riskScorer_blastRadius_crossTenant',
    value: 1.0,
    type: 'numeric',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'BLAST_RADIUS_MULTIPLIER' }],
    rationale:
      "Cross-tenant blast radius — 100% (the maximum). Reaching beyond the agent owner's tenant is the worst case.",
    source: INTERNAL_HEURISTIC,
    affects: ['per-component scores'],
  },
  riskScorer_escalation_highLLMRisks: {
    name: 'riskScorer_escalation_highLLMRisks',
    value: 2,
    type: 'numeric',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'computeRiskScore' }],
    rationale:
      'Two or more HIGH-severity LLM risks add +10 to the rubric score (capped at 100). Two HIGHs from LLM analysis indicate the agent has multiple distinct serious issues, justifying a bump above the rubric average.',
    source: INTERNAL_HEURISTIC,
    affects: ['RiskScore.score'],
  },
  riskScorer_escalation_addPoints: {
    name: 'riskScorer_escalation_addPoints',
    value: 10,
    type: 'numeric',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'computeRiskScore' }],
    rationale:
      'Escalation bump is +10 points. Tuned so a borderline-medium can promote to high but cannot single-handedly create a critical.',
    source: INTERNAL_HEURISTIC,
    affects: ['RiskScore.score'],
  },
  riskScorer_writeRisk_baseScore: {
    name: 'riskScorer_writeRisk_baseScore',
    value: 40,
    type: 'numeric',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'scoreWriteRisk' }],
    rationale:
      'Write operations exist → base 40 points. Below 50 (medium threshold) so writes alone do not auto-promote to medium unless reversibility/approval/blast-radius push it higher.',
    source: INTERNAL_HEURISTIC,
    affects: ['RiskScore.breakdown.writeRisk'],
  },
  riskScorer_writeRisk_irreversiblePenalty: {
    name: 'riskScorer_writeRisk_irreversiblePenalty',
    value: 30,
    type: 'numeric',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'scoreWriteRisk' }],
    rationale:
      'Irreversible writes add +30. Combined with the base 40 and an org-wide multiplier (0.85), an irreversible write at org scope lands above the high threshold.',
    source: INTERNAL_HEURISTIC,
    affects: ['RiskScore.breakdown.writeRisk'],
  },
  riskScorer_writeRisk_noApprovalPenalty: {
    name: 'riskScorer_writeRisk_noApprovalPenalty',
    value: 15,
    type: 'numeric',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'scoreWriteRisk' }],
    rationale:
      'Missing approval-required adds +15. Smaller than irreversibility because "no approval flow" is a process gap rather than a permanent state mutation.',
    source: INTERNAL_HEURISTIC,
    affects: ['RiskScore.breakdown.writeRisk'],
  },
  riskScorer_sensitivity_perKeywordPoints: {
    name: 'riskScorer_sensitivity_perKeywordPoints',
    value: 25,
    type: 'numeric',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'scoreSensitiveData' }],
    rationale:
      'Each sensitivity-keyword hit adds 25 points (capped at 100). 25 means 4 unique sensitive-data terms saturate the sensitivity score.',
    source: INTERNAL_HEURISTIC,
    affects: ['RiskScore.breakdown.sensitiveData'],
  },
  riskScorer_scopeCreep_ratioBands: {
    name: 'riskScorer_scopeCreep_ratioBands',
    value: 'Scope-creep score bands: ratio<=1 → 0, ratio<=1.5 → 25, ratio<=2 → 50, ratio<=3 → 75, ratio>3 → 100. Plus: needed=0 + requested>0 → 75 (any scopes without stated need).',
    type: 'categorical',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'scoreScopeCreep' }],
    rationale:
      'Logarithmic-ish ramp tuned so 2x over-request is mid-tier and 3x is the maximum penalty short of "no stated need at all".',
    source: INTERNAL_HEURISTIC,
    affects: ['RiskScore.breakdown.scopeCreep'],
  },
  riskScorer_severityLadder_lowMax: {
    name: 'riskScorer_severityLadder_lowMax',
    value: 20,
    type: 'numeric',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'scoreToLevel' }],
    rationale:
      'Score 0-20 → `low`. Below 20 is the band where rubric components score near-zero across the board.',
    source: INTERNAL_HEURISTIC,
    affects: ['RiskScore.overall'],
  },
  riskScorer_severityLadder_mediumMax: {
    name: 'riskScorer_severityLadder_mediumMax',
    value: 45,
    type: 'numeric',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'scoreToLevel' }],
    rationale:
      'Score 21-45 → `medium`. 45 is slightly above the 40-pt write-risk base so "writes exist with bounded scope" lands in medium.',
    source: INTERNAL_HEURISTIC,
    affects: ['RiskScore.overall'],
  },
  riskScorer_severityLadder_highMax: {
    name: 'riskScorer_severityLadder_highMax',
    value: 70,
    type: 'numeric',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'scoreToLevel' }],
    rationale:
      'Score 46-70 → `high`. 70 caps the high band; 71+ is critical. Matches the AAP-54 compliance-score threshold (PARTIAL >= 70).',
    source: INTERNAL_HEURISTIC,
    affects: ['RiskScore.overall'],
  },
  riskScorer_publicPII_volumeKeywords: {
    name: 'riskScorer_publicPII_volumeKeywords',
    value: 'Public PII at scale = (PUBLIC_PII_KEYWORDS match) AND (LARGE_VOLUME_KEYWORDS match OR org-wide / cross-tenant blast radius). Either weak signal alone is insufficient.',
    type: 'categorical',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'computeSeveritySignals' }],
    rationale:
      'AAP-43 post-merge fix: LinkedIn-style agents handle public PII (names, emails, profile URLs) that does not match sensitive-PII keywords. Combination of public-PII keyword + scale indicator (>=500 records, bulk, org-wide) is the shape reviewers called HIGH on the LinkedIn ICP reference case.',
    source: INTERNAL_HEURISTIC,
    affects: ['SeveritySignals.hasPublicPIIAtScale', 'severityFloor for access/data risks'],
  },
  riskScorer_severityFloor_decisionsHigh: {
    name: 'riskScorer_severityFloor_decisionsHigh',
    value: 'decisions kind + hasDecisionsAboutPeople → floor at `high`. Decisions about people get an automatic HIGH floor regardless of LLM analysis.',
    type: 'categorical',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'severityFloor' }],
    rationale:
      'AAP-43 P0: determinism in audit reports. LLM-assigned severities flip run-to-run; the rule-based floor pins decisions-about-people at HIGH minimum so the verdict cannot regress on rerun.',
    source: INTERNAL_HEURISTIC,
    affects: ['Risk.severity post-applySeverityOverrides'],
  },
  riskScorer_calibrate_denyMinHigh: {
    name: 'riskScorer_calibrate_denyMinHigh',
    value: 'recommendation=DENY → overall floor at `high`. Preserves CRITICAL if rubric reached it; bumps up if rubric was below high.',
    type: 'categorical',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'calibrateOverallRiskLevel' }],
    rationale:
      'AAP-69: HR-persona test surfaced "recommendation: DENY paired with overallRiskLevel: medium" contradiction. DENY must coincide with HIGH or CRITICAL or the dashboard pill and verdict pill argue.',
    source: INTERNAL_HEURISTIC,
    affects: ['Severity overall label'],
  },
  riskScorer_calibrate_approveMaxHigh: {
    name: 'riskScorer_calibrate_approveMaxHigh',
    value: 'recommendation=APPROVE + overall=CRITICAL → cap at `high`. APPROVE WITH CONDITIONS is the catch-all and is NOT capped.',
    type: 'categorical',
    sites: [{ file: 'src/analysis/risk-scorer.ts', symbol: 'calibrateOverallRiskLevel' }],
    rationale:
      'AAP-69: bare APPROVE on a CRITICAL-rated agent is structurally self-contradictory. Soften to HIGH so the reviewer can still see HIGH and decide to escalate.',
    source: INTERNAL_HEURISTIC,
    affects: ['Severity overall label'],
  },

  // ──────────────────────────────────────────────────────────────────────
  // src/report/control-results-projection.ts — gap counting + status label
  // ──────────────────────────────────────────────────────────────────────

  projection_gapVerdicts_set: {
    name: 'projection_gapVerdicts_set',
    value: 'Gap verdicts = {`fail`, `partial`, `unverified`}. `verified` and `not-applicable` are NOT gaps.',
    type: 'categorical',
    sites: [{ file: 'src/report/control-results-projection.ts', symbol: 'GAP_VERDICTS' }],
    rationale:
      'AAP-84 Phase 4: unverified counts as a gap because the absence of evidence IS the gap. Phase 6+ will route around this once classifyEUAIAct stops emitting unverified for legitimately-not-applicable controls.',
    source: INTERNAL_HEURISTIC,
    affects: ['Gap counter', 'Per-framework projection'],
  },
  projection_statusLabel_actionRequiredOnFail: {
    name: 'projection_statusLabel_actionRequiredOnFail',
    value: 'Any `fail` verdict in the deduped result set → status label "Action Required", regardless of severity.',
    type: 'categorical',
    sites: [{ file: 'src/report/control-results-projection.ts', symbol: 'statusLabelFromControlResults' }],
    rationale:
      'AAP-84 Phase 4: a fail is a fail. The verdict ladder is the new ground truth post-AAP-83 unification; severity is for sorting / pill colour, not for the top-level label.',
    source: INTERNAL_HEURISTIC,
    affects: ['Report overall status label'],
  },
  projection_statusLabel_needsClarificationOnPartial: {
    name: 'projection_statusLabel_needsClarificationOnPartial',
    value: 'Any `partial` (no fails) → "Needs Clarification".',
    type: 'categorical',
    sites: [{ file: 'src/report/control-results-projection.ts', symbol: 'statusLabelFromControlResults' }],
    rationale:
      'AAP-84 Phase 4: partial is the "we have some evidence but not enough" state — reviewer needs to fill in the missing piece.',
    source: INTERNAL_HEURISTIC,
    affects: ['Report overall status label'],
  },
  projection_statusLabel_reviewOnUnverified: {
    name: 'projection_statusLabel_reviewOnUnverified',
    value: 'Any `unverified` (no fails, no partials) → "Review".',
    type: 'categorical',
    sites: [{ file: 'src/report/control-results-projection.ts', symbol: 'statusLabelFromControlResults' }],
    rationale:
      'AAP-84 Phase 4: unverified means no Surface 2 evidence either way — reviewer needs to manually attest or trigger discovery.',
    source: INTERNAL_HEURISTIC,
    affects: ['Report overall status label'],
  },
  projection_statusLabel_notTriggered: {
    name: 'projection_statusLabel_notTriggered',
    value: 'Empty result set OR only `verified` / `not-applicable` → "Not Triggered".',
    type: 'categorical',
    sites: [{ file: 'src/report/control-results-projection.ts', symbol: 'statusLabelFromControlResults' }],
    rationale:
      'AAP-84 Phase 4: nothing to report means nothing to flag. Empty == Not Triggered.',
    source: INTERNAL_HEURISTIC,
    affects: ['Report overall status label'],
  },
  projection_dedup_byStableKey: {
    name: 'projection_dedup_byStableKey',
    value: 'Dedupe by `stableKey` — detectors sharing a (findingType, frameworkId, controlId) triple count once.',
    type: 'categorical',
    sites: [{ file: 'src/report/control-results-projection.ts', symbol: 'dedupeControlResults' }],
    rationale:
      'AAP-84 Phase 4: catalog adapters register the same detector under multiple triples (e.g. AIUC-1 A003.3 + A003.4 share detectAIUC1_A003). Without dedup the gap counter would double-count.',
    source: INTERNAL_HEURISTIC,
    affects: ['Gap counter', 'Status label'],
  },
  projection_severityRank: {
    name: 'projection_severityRank',
    value: 'ControlResultSeverity rank: critical=5, high=4, medium=3, low=2, info=1. Mirrors the legacy flag-severity ladder.',
    type: 'categorical',
    sites: [{ file: 'src/report/control-results-projection.ts', symbol: 'CR_SEVERITY_RANK' }],
    rationale:
      'AAP-84 Phase 4: integer ranks for sort/max ops on severity. info=1 (not zero) so a missing severity still sorts above no-severity.',
    source: INTERNAL_HEURISTIC,
    affects: ['worstSeverity sorting'],
  },

  // ──────────────────────────────────────────────────────────────────────
  // src/report/html-renderer.ts — compliance score + verdict + sections
  // ──────────────────────────────────────────────────────────────────────

  htmlRenderer_complianceScore_threshold: {
    name: 'htmlRenderer_complianceScore_threshold',
    value: 70,
    type: 'numeric',
    sites: [{ file: 'src/report/html-renderer.ts', symbol: 'computeComplianceScore' }],
    rationale:
      'PARTIAL/PASSED threshold: compliance score must be >= 70 (out of 100) to clear PARTIAL. Matches the risk-scorer high cap at 70 and the industry rule-of-thumb for "70% passing".',
    source: INTERNAL_HEURISTIC,
    affects: ['ComplianceScoreResult.verdict'],
  },
  htmlRenderer_complianceScore_passedThreshold: {
    name: 'htmlRenderer_complianceScore_passedThreshold',
    value: 85,
    type: 'numeric',
    sites: [{ file: 'src/report/html-renderer.ts', symbol: 'computeComplianceScore' }],
    rationale:
      'PASSED tier requires score >= 85 (in addition to zero critical/high fails). 85 is the "comfortable A" — below that the buyer should still scrutinise.',
    source: INTERNAL_HEURISTIC,
    affects: ['ComplianceScoreResult.verdict (PASSED tier)'],
  },
  htmlRenderer_complianceScore_partialMaxHighFails: {
    name: 'htmlRenderer_complianceScore_partialMaxHighFails',
    value: 3,
    type: 'numeric',
    sites: [{ file: 'src/report/html-renderer.ts', symbol: 'computeComplianceScore' }],
    rationale:
      'PARTIAL tier allows up to 3 high-severity fails (with zero critical). More than 3 high fails crosses into FAILED regardless of score. Tuned so a partially-clean agent with isolated high issues can still pass partial.',
    source: INTERNAL_HEURISTIC,
    affects: ['ComplianceScoreResult.verdict (PARTIAL tier)'],
  },
  htmlRenderer_complianceScore_zeroCriticalForPassed: {
    name: 'htmlRenderer_complianceScore_zeroCriticalForPassed',
    value: 'PASSED requires 0 critical-severity fails AND 0 high-severity fails AND score >= 85. PARTIAL requires 0 critical AND <=3 high AND score >= 70. FAILED otherwise.',
    type: 'categorical',
    sites: [{ file: 'src/report/html-renderer.ts', symbol: 'computeComplianceScore' }],
    rationale:
      'Two-axis verdict logic. Score alone is insufficient because a single critical fail must FAIL the agent regardless of how many trivial controls passed.',
    source: INTERNAL_HEURISTIC,
    affects: ['ComplianceScoreResult.verdict'],
  },
  htmlRenderer_complianceScore_partialCounts: {
    name: 'htmlRenderer_complianceScore_partialCounts',
    value: 0.5,
    type: 'numeric',
    sites: [{ file: 'src/report/html-renderer.ts', symbol: 'computeComplianceScore' }],
    rationale:
      'Partial verdicts count as 0.5× a verified control in the score numerator. Partial means "some evidence" so half-credit is the natural midpoint.',
    source: INTERNAL_HEURISTIC,
    affects: ['ComplianceScoreResult.score'],
  },
  htmlRenderer_complianceScore_emptyMappingFailed: {
    name: 'htmlRenderer_complianceScore_emptyMappingFailed',
    value: 'Missing frameworkMapping OR zero evaluable controls → FAILED verdict with score 0. Cover surfaces the fallback explicitly.',
    type: 'categorical',
    sites: [{ file: 'src/report/html-renderer.ts', symbol: 'computeComplianceScore' }],
    rationale:
      'Cannot honestly score the agent without controls. Return FAILED rather than fabricate a passing verdict — defensibility over optics.',
    source: INTERNAL_HEURISTIC,
    affects: ['ComplianceScoreResult.verdict'],
  },
  htmlRenderer_headlineFindings_topN: {
    name: 'htmlRenderer_headlineFindings_topN',
    value: 5,
    type: 'numeric',
    sites: [{ file: 'src/report/html-renderer.ts', symbol: 'renderHeadlineFindingsBlock' }],
    rationale:
      'Top 5 headline findings render in the executive summary. Five is the standard "scannable" count for an executive overview; more than 5 dilutes attention.',
    source: INTERNAL_HEURISTIC,
    affects: ['Executive Summary headline list'],
  },
  htmlRenderer_recommendedActions_topN: {
    name: 'htmlRenderer_recommendedActions_topN',
    value: 5,
    type: 'numeric',
    sites: [{ file: 'src/report/html-renderer.ts', symbol: 'renderRecommendedActionsBlock' }],
    rationale:
      'Top 5 recommended actions render in the executive summary. Mirrors the headline-findings limit so the section stays visually balanced.',
    source: INTERNAL_HEURISTIC,
    affects: ['Executive Summary recommended actions'],
  },

  // ──────────────────────────────────────────────────────────────────────
  // src/verification/frameworks/detectors.ts — framework controls
  // ──────────────────────────────────────────────────────────────────────

  frameworks_a003_failOnBroadExtra: {
    name: 'frameworks_a003_failOnBroadExtra',
    value: 'AIUC-1 A003 (Limit Data Access) → `fail` when any extra scope on the actual side matches a broad-read pattern (drive.readonly, admin.directory.user, gmail.readonly, etc.). `unverified` when no scope inventory exists; `verified` when declared scopes present + no extra broad reads.',
    type: 'categorical',
    sites: [{ file: 'src/verification/frameworks/detectors.ts', symbol: 'detectAIUC1_A003' }],
    rationale:
      'AIUC-1 A003 is the least-privilege test. Any unexplained broad-read scope is a fail; absence of inventory means we cannot assert verified.',
    source: 'AIUC-1 A003 (limit data access) — Heron broad-read pattern list + extra-scope verdict gate is internal heuristic',
    affects: ['ControlResult for AIUC-1 A003', 'GDPR Art. 5 (via detectGDPR_Article5 reuse)'],
  },
  frameworks_b006_failOnActionExtra: {
    name: 'frameworks_b006_failOnActionExtra',
    value: 'AIUC-1 B006 (Unauthorized Actions) → `fail` when any extra scope matches an action-class pattern (gmail.send, :write, :create, :delete, :modify, .send, etc.). `unverified` with no inventory; `verified` otherwise.',
    type: 'categorical',
    sites: [{ file: 'src/verification/frameworks/detectors.ts', symbol: 'detectAIUC1_B006' }],
    rationale:
      'AIUC-1 B006 catches agents that can perform writes beyond their declared mandate. Pattern list focuses on widely-used scope vocabularies.',
    source: 'AIUC-1 B006 (unauthorized actions) — Heron action-class pattern list + extra-scope verdict gate is internal heuristic',
    affects: ['ControlResult for AIUC-1 B006'],
  },
  frameworks_d003_unsafeToolGate: {
    name: 'frameworks_d003_unsafeToolGate',
    value: 'AIUC-1 D003 (Unsafe Tool Calls) → `fail` when an MCP tool matches RISKY_TOOL_NAME_PATTERNS or RISKY_TOOL_DESCRIPTION_PATTERNS AND lacks acknowledgement annotation (destructiveHint, idempotency:false, unsafeAcknowledged). `unverified` with no MCP inventory; `verified` when no risky tools OR all acknowledged.',
    type: 'categorical',
    sites: [{ file: 'src/verification/frameworks/detectors.ts', symbol: 'detectAIUC1_D003' }],
    rationale:
      'AIUC-1 D003 requires per-call validation for risky tools. Annotation is the operator-declared "I know this is risky and accept it" signal. Round-2 Fix 2 widened the pattern set to catch short forms (del_, rm_), table verbs (drop_, truncate_), and lifecycle-management verbs.',
    source: 'AIUC-1 D003 (unsafe tool calls) — Heron RISKY_TOOL_NAME_PATTERNS / RISKY_TOOL_DESCRIPTION_PATTERNS + acknowledgement-annotation gate is internal heuristic',
    affects: ['ControlResult for AIUC-1 D003'],
  },
  frameworks_e004_accountabilityGate: {
    name: 'frameworks_e004_accountabilityGate',
    value: 'AIUC-1 E004 (Assigned Accountability): `fail` if no approval chain OR chain integrity broken. `verified` if chain has an `approved` action with named actor. `partial` if chain present but no approved action yet.',
    type: 'categorical',
    sites: [{ file: 'src/verification/frameworks/detectors.ts', symbol: 'detectAIUC1_E004' }],
    rationale:
      'AIUC-1 E004 requires a named owner with documented approval evidence. Broken hash chain elevates to critical severity (audit trail cannot be trusted).',
    source: 'AIUC-1 E004 (assigned accountability) — Heron approval-chain integrity + named-actor evidence gate is internal heuristic',
    affects: ['ControlResult for AIUC-1 E004'],
  },
  frameworks_e015_loggingGate: {
    name: 'frameworks_e015_loggingGate',
    value: 'AIUC-1 E015 (System Activity Logging): `verified` when chain present with intact integrity. `fail` (severity critical) when integrity broken. `partial` when no structured chain.',
    type: 'categorical',
    sites: [{ file: 'src/verification/frameworks/detectors.ts', symbol: 'detectAIUC1_E015' }],
    rationale:
      'AIUC-1 E015 — the approval chain is the load-bearing record. Broken hash chain means the trail cannot be trusted.',
    source: 'AIUC-1 E015 (system activity logging) — Heron approval-chain integrity gate is internal heuristic',
    affects: ['ControlResult for AIUC-1 E015'],
  },
  frameworks_annexIII4_dependsOnCompanion: {
    name: 'frameworks_annexIII4_dependsOnCompanion',
    value: 'EU AI Act Annex III §4 (Employment): not-applicable when not HR agent. When HR: `verified` if A003+B006+D003+E004 all verified; `fail` if any underlying fail; `partial` otherwise.',
    type: 'categorical',
    sites: [{ file: 'src/verification/frameworks/detectors.ts', symbol: 'detectEUAIAct_AnnexIII4' }],
    rationale:
      'Annex III §4 high-risk obligations are carried by underlying controls (least-privilege, unauthorized actions, unsafe tool calls, accountability). Reusing companion verdicts avoids double-counting.',
    source: 'EU AI Act Annex III §4 (employment, workers management) — Heron companion-control composition (A003+B006+D003+E004) is internal heuristic',
    affects: ['ControlResult for EU AI Act Annex III §4'],
  },
  frameworks_article14_distinctActorRequired: {
    name: 'frameworks_article14_distinctActorRequired',
    value: 'EU AI Act Article 14 (Human Oversight): `verified` requires separate reviewed + approved entries AND at least one distinct actor pair (reviewer != approver by email or name+role). Reviewer==approver → `partial`. No chain → `fail`.',
    type: 'categorical',
    sites: [{ file: 'src/verification/frameworks/detectors.ts', symbol: 'detectEUAIAct_Article14' }],
    rationale:
      'Round-2 Fix 3 (MEDIUM-1): Article 14 requires two-person oversight. If every reviewer overlaps every approver, the chain has only one human and Article 14 is not satisfied. Email is the strongest distinctness signal; name+role catches actors without an email.',
    source: 'EU AI Act Article 14 (human oversight) — Heron distinct-actor evidence gate is internal heuristic',
    affects: ['ControlResult for EU AI Act Article 14'],
  },
  frameworks_article12_minChainEntries: {
    name: 'frameworks_article12_minChainEntries',
    value: 2,
    type: 'numeric',
    sites: [{ file: 'src/verification/frameworks/detectors.ts', symbol: 'detectEUAIAct_Article12' }],
    rationale:
      'EU AI Act Article 12 (Record-Keeping): chain with 2+ entries → `verified` (spans at least one lifecycle step). 1 entry → `partial` (record-keeping started but incomplete). No chain → `fail`.',
    source: 'EU AI Act Article 12 (record-keeping for high-risk systems) — Heron "2+ entries" evidence gate is internal heuristic',
    affects: ['ControlResult for EU AI Act Article 12'],
  },
  frameworks_article22_substantiveReviewGate: {
    name: 'frameworks_article22_substantiveReviewGate',
    value: 'GDPR Article 22 (Automated Decision-Making): `not-applicable` when no decision-class scope. With decision-class scope: `partial` if approval chain has a SUBSTANTIVE reviewed action (evidence OR comment present) AND integrity ok. Else `fail` (severity critical).',
    type: 'categorical',
    sites: [{ file: 'src/verification/frameworks/detectors.ts', symbol: 'detectGDPR_Article22' }],
    rationale:
      'Round-2 Fix 4 (MEDIUM-2): a bare reviewed row with no comment and no evidenceRefs is a rubber-stamp signature, not a substantive review. Article 22 prohibits decisions based solely on automated processing — rubber-stamps do not count.',
    source: 'GDPR Article 22 (automated decision-making) — Heron "substantive review = evidence OR comment" gate is internal heuristic',
    affects: ['ControlResult for GDPR Article 22'],
  },
  frameworks_article5_reusesA003: {
    name: 'frameworks_article5_reusesA003',
    value: 'GDPR Article 5 (Data Minimisation): re-frames AIUC-1 A003 verdict. Same surface (broad-read scope extras) under a GDPR-flavored rationale.',
    type: 'categorical',
    sites: [{ file: 'src/verification/frameworks/detectors.ts', symbol: 'detectGDPR_Article5' }],
    rationale:
      'GDPR Art. 5(1)(c) data minimisation maps 1:1 onto AIUC-1 A003 least-privilege. Reusing the verdict avoids drift between two controls measuring the same thing.',
    source: 'GDPR Article 5(1)(c) (data minimisation) — Heron choice to reuse AIUC-1 A003 verdict is internal heuristic',
    affects: ['ControlResult for GDPR Article 5'],
  },
  frameworks_nistMeasure_inventoryGate: {
    name: 'frameworks_nistMeasure_inventoryGate',
    value: 'NIST AI RMF MEASURE: `verified` when any actual inventory exists OR any diffs present. `unverified` when both empty.',
    type: 'categorical',
    sites: [{ file: 'src/verification/frameworks/detectors.ts', symbol: 'detectNIST_Measure' }],
    rationale:
      'MEASURE function in NIST AI RMF is about evidencing trustworthy-AI characteristics. Running any verification source is sufficient evidence; nothing run means we cannot evidence measurement.',
    source: 'NIST AI RMF MEASURE (2.1, 2.2, 2.3) — Heron "any inventory OR any diffs" evidence gate is internal heuristic',
    affects: ['ControlResult for NIST AI RMF MEASURE'],
  },
  frameworks_nistManage_approvalGate: {
    name: 'frameworks_nistManage_approvalGate',
    value: 'NIST AI RMF MANAGE: `verified` when approval chain present. `partial` (severity medium) when no chain — MANAGE process is undocumented.',
    type: 'categorical',
    sites: [{ file: 'src/verification/frameworks/detectors.ts', symbol: 'detectNIST_Manage' }],
    rationale:
      'MANAGE function requires structured risk-management process. Approval chain is the closest deterministic signal Heron has for "process exists".',
    source: 'NIST AI RMF MANAGE (2.1, 4.1) — Heron "approval chain present = verified" evidence gate is internal heuristic',
    affects: ['ControlResult for NIST AI RMF MANAGE'],
  },

  // ──────────────────────────────────────────────────────────────────────
  // src/verification/frameworks/classify.ts — HR-agent two-signal gate
  // ──────────────────────────────────────────────────────────────────────

  classify_hrAgent_minSignals: {
    name: 'classify_hrAgent_minSignals',
    value: 2,
    type: 'numeric',
    sites: [{ file: 'src/verification/frameworks/classify.ts', symbol: 'isHRAgent' }],
    rationale:
      'PR #22 round-2 MEDIUM fix: HR-agent classification requires AT LEAST TWO independent signals from {connector, scope, keyword}. Two prevents false-positive HR classification on agents that share one keyword with the HR domain ("candidate accounts" in marketing, "hire a car" in travel-booking).',
    source: INTERNAL_HEURISTIC,
    affects: ['isHRAgent', 'HR vertical pack gating', 'EU AI Act Annex III §4 routing'],
  },
  classify_hrConnector_exactMatch: {
    name: 'classify_hrConnector_exactMatch',
    value: 'HR connector match uses EXACT (lowercased, trimmed) equality, not substring. A SaaS product whose name contains "greenhouse" cannot be misclassified.',
    type: 'categorical',
    sites: [{ file: 'src/verification/frameworks/classify.ts', symbol: 'matchesHRConnector' }],
    rationale:
      'PR #22 round-2 MEDIUM fix: substring matching produced false positives ("greenhouse-marketing" matched "greenhouse"). Exact match is the conservative posture.',
    source: INTERNAL_HEURISTIC,
    affects: ['isHRAgent'],
  },

  // ──────────────────────────────────────────────────────────────────────
  // src/verification/hr-pack/detectors.ts — 7 HR vertical signal detectors
  // ──────────────────────────────────────────────────────────────────────

  hrPack_truncCap: {
    name: 'hrPack_truncCap',
    value: 128,
    type: 'numeric',
    sites: [{ file: 'src/verification/hr-pack/detectors.ts', symbol: 'MAX_DETECTOR_FIELD_LEN' }],
    rationale:
      'PR #22 round-2 LOW fix: tool / scope / service names flowing into rationale and evidenceRefs are capped at 128 chars to prevent adversary-controlled MCP servers from blowing up JSON consumers with 10K-char tool names.',
    source: INTERNAL_HEURISTIC,
    affects: ['HRSignal.rationale', 'HRSignal.evidenceRefs[].ref'],
  },
  hrPack_d1_keywordDisarmGate: {
    name: 'hrPack_d1_keywordDisarmGate',
    value: 'D1 (auto-rejection-without-disclosure): `detected` (severity critical) when rejection scope/tool present AND purpose lacks DISCLOSURE_KEYWORDS. `not-detected` if purpose matches disclosure keywords. `unverified` with no inventory.',
    type: 'categorical',
    sites: [{ file: 'src/verification/hr-pack/detectors.ts', symbol: 'detectAutoRejectionWithoutDisclosure' }],
    rationale:
      'AAP-51: trust signal, not behavioural assertion. Disclosure keywords in declared purpose disarm the detector — known limitation: keyword stuffing or negation can bypass. Documented at file top; out of scope for OSS verification engine.',
    source: 'GDPR Article 22 + NYC LL 144 (disclosure obligations) — Heron rejection-tool vocabulary + DISCLOSURE_KEYWORDS disarm gate is internal heuristic',
    affects: ['HRSignal for D1'],
  },
  hrPack_d2_atsWriteSprawlGate: {
    name: 'hrPack_d2_atsWriteSprawlGate',
    value: 'D2 (ats-write-scope-sprawl): `detected` (severity high) when ATS write scope present and purpose neither declares write actions nor describes narrow read-side activity. Disarmed by WRITE_ACTION_KEYWORDS in purpose.',
    type: 'categorical',
    sites: [{ file: 'src/verification/hr-pack/detectors.ts', symbol: 'detectATSWriteScopeSprawl' }],
    rationale:
      'AAP-51: AIUC-1 B006 reframed for HR. ATS write scopes (candidates:write, applications:write, jobs:write, offers:write) are high-value targets — operator must either narrow or document.',
    source: 'AIUC-1 B006 (least-privilege) — Heron ATS-scope vocabulary + WRITE_ACTION_KEYWORDS disarm gate is internal heuristic',
    affects: ['HRSignal for D2'],
  },
  hrPack_d3_piiLogsGate: {
    name: 'hrPack_d3_piiLogsGate',
    value: 'D3 (candidate-pii-in-logs): `detected` (severity medium) when PII-exposing scope (gmail.readonly, drive.readonly, admin.directory) present AND purpose lacks LOGGING_POLICY_KEYWORDS.',
    type: 'categorical',
    sites: [{ file: 'src/verification/hr-pack/detectors.ts', symbol: 'detectCandidatePIIInLogs' }],
    rationale:
      'AAP-51: surfaces risk surface, does NOT inspect log content. GDPR Art. 5 retention obligations are the regulatory anchor.',
    source: 'GDPR Article 5 (retention / minimisation) — Heron PII-scope vocabulary + LOGGING_POLICY_KEYWORDS disarm gate is internal heuristic',
    affects: ['HRSignal for D3'],
  },
  hrPack_d4_scoringNoCriteriaGate: {
    name: 'hrPack_d4_scoringNoCriteriaGate',
    value: 'D4 (scoring-without-criteria): `detected` (severity high) when scoring/ranking tool present AND purpose lacks SCORING_CRITERIA_KEYWORDS.',
    type: 'categorical',
    sites: [{ file: 'src/verification/hr-pack/detectors.ts', symbol: 'detectScoringWithoutCriteria' }],
    rationale:
      'AAP-51: EU AI Act Annex III §4 transparency obligation requires published scoring criteria. Tool-name-based detection (^score, ^rank, ^match).',
    source: 'EU AI Act Annex III §4 (employment transparency) — Heron scoring-tool regex + SCORING_CRITERIA_KEYWORDS disarm gate is internal heuristic',
    affects: ['HRSignal for D4'],
  },
  hrPack_d5_dncBypassGate: {
    name: 'hrPack_d5_dncBypassGate',
    value: 'D5 (do-not-contact-bypass): `detected` (severity high) when outreach capability (gmail.send, mail.send, :send, outreach: scopes / send_email / outreach_ tools) present AND purpose lacks DNC_KEYWORDS.',
    type: 'categorical',
    sites: [{ file: 'src/verification/hr-pack/detectors.ts', symbol: 'detectDoNotContactBypass' }],
    rationale:
      'AAP-51: CAN-SPAM + GDPR Article 21 (right to object) obligations. Disarm via "do-not-contact", "DNC", "consent", "opt-out", "unsubscribe".',
    source: 'CAN-SPAM + GDPR Article 21 (right to object) — Heron outreach-capability vocabulary + DNC_KEYWORDS disarm gate is internal heuristic',
    affects: ['HRSignal for D5'],
  },
  hrPack_d6_offerNoApprovalGate: {
    name: 'hrPack_d6_offerNoApprovalGate',
    value: 'D6 (offer-letter-out-of-range): `detected` (severity critical) when offer-generation tool (generate_offer, send_offer, create_offer_letter) present AND purpose lacks SALARY_BAND_KEYWORDS.',
    type: 'categorical',
    sites: [{ file: 'src/verification/hr-pack/detectors.ts', symbol: 'detectOfferLetterOutOfRange' }],
    rationale:
      'AAP-51: Heron cannot read offer values; flags the capability, not specific dollar amounts. Disarm via salary-band / approval-workflow keywords.',
    source: 'Compensation policy (organisational, not regulatory) — Heron offer-tool vocabulary + SALARY_BAND_KEYWORDS disarm gate is internal heuristic',
    affects: ['HRSignal for D6'],
  },
  hrPack_d7_subAgentExpansionGate: {
    name: 'hrPack_d7_subAgentExpansionGate',
    value: 'D7 (sub-agent-scope-expansion): `detected` (severity high) when orchestration tool (run_subagent, delegate_, spawn_) present AND purpose lacks SUBAGENT_ARCH_KEYWORDS.',
    type: 'categorical',
    sites: [{ file: 'src/verification/hr-pack/detectors.ts', symbol: 'detectSubAgentScopeExpansion' }],
    rationale:
      'AAP-51: AIUC-1 D003 reframed for HR sub-agent risk. Sub-agents may inherit parent OAuth scopes without explicit narrowing — operator must document the architecture.',
    source: 'AIUC-1 D003 (unsafe tool calls) — Heron sub-agent orchestration-tool vocabulary + SUBAGENT_ARCH_KEYWORDS disarm gate is internal heuristic',
    affects: ['HRSignal for D7'],
  },

  // ──────────────────────────────────────────────────────────────────────
  // src/compliance/detectors/discovery-detectors.ts — typed credential gates
  // ──────────────────────────────────────────────────────────────────────

  discovery_sensitivePII_fail: {
    name: 'discovery_sensitivePII_fail',
    value: 'Sensitive-PII detector: `fail` (severity high) when discovery surface contains sensitive PII credential names (stripe / plaid / SSN / passport / national ID / tax) or medical (hipaa / phi / patient).',
    type: 'categorical',
    sites: [{ file: 'src/compliance/detectors/discovery-detectors.ts', symbol: 'makeSensitiveDataDetector' }],
    rationale:
      'AAP-83 Phase 5: typed evidence detector — reads DiscoveryResult directly instead of synthesising prose. Fail is the default verdict because presence of a sensitive credential without compensating controls is a GDPR Art. 6 / 35 / 33 trigger.',
    source: 'GDPR Articles 5, 6, 33, 35; AIUC-1 A006 — Heron credential-key vocabulary + sensitive-PII fail-by-default verdict gate is internal heuristic',
    affects: ['ControlResult for GDPR Art. 6, Art. 35, Art. 33, AIUC-1 A006'],
  },
  discovery_externalProcessor_partial: {
    name: 'discovery_externalProcessor_partial',
    value: 'External-processor detector: `partial` (severity medium) when discovery surface contains third-party SaaS credentials (slack / hubspot / salesforce / linear / github / openai / anthropic) OR international-transfer signals (aws / azure / gcp).',
    type: 'categorical',
    sites: [{ file: 'src/compliance/detectors/discovery-detectors.ts', symbol: 'makeProcessorDetector' }],
    rationale:
      'AAP-83 Phase 5: third-party processor presence is partial, not fail — it activates Art. 28 DPA obligations but is not a violation on its own. International transfer (cloud provider) escalates rationale text but not verdict.',
    source: 'GDPR Article 28 (processor obligations) — Heron credential-key vocabulary + processor-detected-as-partial verdict gate is internal heuristic',
    affects: ['ControlResult for AIUC-1 A001 (Input data policy)'],
  },
  discovery_classifier_singleSource: {
    name: 'discovery_classifier_singleSource',
    value: '`classifyKeyName` is the SINGLE source of truth for credential-name → category mapping. Future additions (new payment processor, new HRIS) only land here.',
    type: 'categorical',
    sites: [{ file: 'src/compliance/detectors/discovery-detectors.ts', symbol: 'classifyKeyName' }],
    rationale:
      'AAP-86: the prose-path shadow in `src/report/recompute-compliance.ts` was deleted once the renderer migrated to controlResults. Single-source rule prevents drift between code paths.',
    source: INTERNAL_HEURISTIC,
    affects: ['All discovery-detector verdicts'],
  },

  // ──────────────────────────────────────────────────────────────────────
  // src/report/templates.ts — markdown report renderer presentation bands
  // ──────────────────────────────────────────────────────────────────────

  templates_dataQuality_goodBoundary: {
    name: 'templates_dataQuality_goodBoundary',
    value: 70,
    type: 'numeric',
    sites: [{ file: 'src/report/templates.ts', symbol: 'renderDataQuality' }],
    rationale:
      'Data-quality score >= 70 renders the "Good" label in the report header. Boundary picked so an interview that captured most key fields (systemId, scopes, sensitivity, blastRadius) lands as Good, while one missing several required fields drops to Partial.',
    source: INTERNAL_HEURISTIC,
    affects: ['Markdown report Data Quality label'],
  },
  templates_dataQuality_partialBoundary: {
    name: 'templates_dataQuality_partialBoundary',
    value: 40,
    type: 'numeric',
    sites: [{ file: 'src/report/templates.ts', symbol: 'renderDataQuality' }],
    rationale:
      'Data-quality score in [40, 70) renders "Partial"; below 40 renders "Poor". Below 40 the interview captured fewer than half of the required fields, so the report cannot be relied upon for go/no-go.',
    source: INTERNAL_HEURISTIC,
    affects: ['Markdown report Data Quality label'],
  },
  templates_systemRisk_highBand: {
    name: 'templates_systemRisk_highBand',
    value: 5,
    type: 'numeric',
    sites: [{ file: 'src/report/templates.ts', symbol: 'computeSystemRisk' }],
    rationale:
      'Per-system risk score >= 5 renders "HIGH" on the system card. Score is the sum of blast-radius points + 1 (excessive scopes) + 2 (irreversible writes) + 1 (sensitive data). Five matches an org-wide blast radius with irreversible writes, or cross-tenant blast radius plus any other risk factor.',
    source: INTERNAL_HEURISTIC,
    affects: ['Markdown report per-system risk band'],
  },
  templates_systemRisk_mediumBand: {
    name: 'templates_systemRisk_mediumBand',
    value: 3,
    type: 'numeric',
    sites: [{ file: 'src/report/templates.ts', symbol: 'computeSystemRisk' }],
    rationale:
      'Per-system risk score in [3, 5) renders "MEDIUM"; below 3 renders "LOW". Three matches a team-scope blast radius with one risk factor (extra scopes OR sensitive data) plus the baseline blast-radius score.',
    source: INTERNAL_HEURISTIC,
    affects: ['Markdown report per-system risk band'],
  },
  templates_blastRadius_singleRecord: {
    name: 'templates_blastRadius_singleRecord',
    value: 0,
    type: 'numeric',
    sites: [{ file: 'src/report/templates.ts', symbol: 'computeSystemRisk' }],
    rationale:
      'Blast radius "single-record" contributes 0 to the per-system risk score — the lowest blast-radius tier. A misconfig affecting one record is not, on its own, a system-card-level risk.',
    source: INTERNAL_HEURISTIC,
    affects: ['Markdown report per-system risk band'],
  },
  templates_blastRadius_singleUser: {
    name: 'templates_blastRadius_singleUser',
    value: 1,
    type: 'numeric',
    sites: [{ file: 'src/report/templates.ts', symbol: 'computeSystemRisk' }],
    rationale:
      'Blast radius "single-user" contributes 1 — the default tier when no blast-radius is provided. One unit above baseline so risk-score lifts predictably as blast radius widens.',
    source: INTERNAL_HEURISTIC,
    affects: ['Markdown report per-system risk band'],
  },
  templates_blastRadius_teamScope: {
    name: 'templates_blastRadius_teamScope',
    value: 2,
    type: 'numeric',
    sites: [{ file: 'src/report/templates.ts', symbol: 'computeSystemRisk' }],
    rationale:
      'Blast radius "team-scope" contributes 2 — one above single-user. Combined with one other risk factor (extra scopes OR sensitive data) reaches the MEDIUM band threshold.',
    source: INTERNAL_HEURISTIC,
    affects: ['Markdown report per-system risk band'],
  },
  templates_blastRadius_orgWide: {
    name: 'templates_blastRadius_orgWide',
    value: 3,
    type: 'numeric',
    sites: [{ file: 'src/report/templates.ts', symbol: 'computeSystemRisk' }],
    rationale:
      'Blast radius "org-wide" contributes 3 — the MEDIUM band entry point on blast radius alone. Adding irreversible writes (+2) pushes the system into HIGH.',
    source: INTERNAL_HEURISTIC,
    affects: ['Markdown report per-system risk band'],
  },
  templates_blastRadius_crossTenant: {
    name: 'templates_blastRadius_crossTenant',
    value: 4,
    type: 'numeric',
    sites: [{ file: 'src/report/templates.ts', symbol: 'computeSystemRisk' }],
    rationale:
      'Blast radius "cross-tenant" contributes 4 — one below the HIGH band threshold. Any additional risk factor pushes the system into HIGH.',
    source: INTERNAL_HEURISTIC,
    affects: ['Markdown report per-system risk band'],
  },
  templates_systemRisk_excessiveScopesContribution: {
    name: 'templates_systemRisk_excessiveScopesContribution',
    value: 1,
    type: 'numeric',
    sites: [{ file: 'src/report/templates.ts', symbol: 'computeSystemRisk' }],
    rationale:
      'Any non-empty scopesDelta contributes 1 to the per-system risk score. Binary signal — counting individual extra scopes would double-count what the per-control verdicts already capture; the markdown card just needs a single bump.',
    source: INTERNAL_HEURISTIC,
    affects: ['Markdown report per-system risk band'],
  },
  templates_systemRisk_irreversibleWritesContribution: {
    name: 'templates_systemRisk_irreversibleWritesContribution',
    value: 2,
    type: 'numeric',
    sites: [{ file: 'src/report/templates.ts', symbol: 'computeSystemRisk' }],
    rationale:
      'Any irreversible write contributes 2 — heaviest single contribution besides cross-tenant blast radius. Irreversible writes are the canonical "cannot rollback" risk and earn the largest bump.',
    source: INTERNAL_HEURISTIC,
    affects: ['Markdown report per-system risk band'],
  },
  templates_systemRisk_sensitiveDataContribution: {
    name: 'templates_systemRisk_sensitiveDataContribution',
    value: 1,
    type: 'numeric',
    sites: [{ file: 'src/report/templates.ts', symbol: 'computeSystemRisk' }],
    rationale:
      'Sensitive data class (PII / personal / health / financial / credit, case-insensitive regex) contributes 1. Binary lift; downstream framework controls (GDPR Art. 5, A006) carry the substantive verdict.',
    source: INTERNAL_HEURISTIC,
    affects: ['Markdown report per-system risk band'],
  },
  templates_getFrameworkBasis_topN: {
    name: 'templates_getFrameworkBasis_topN',
    value: 3,
    type: 'numeric',
    sites: [{ file: 'src/report/templates.ts', symbol: 'getFrameworkBasis' }],
    rationale:
      'Top 3 framework controls (mandatory if present, otherwise voluntary) render in the Framework Basis cell of each finding row. Three is the column-width budget for "GDPR Art. 25, EU AI Act Art. 10, AIUC-1 A003" before the cell wraps and breaks the table layout — and three named frameworks is enough to anchor the finding against the most-cited regulations without burying the reader.',
    source: INTERNAL_HEURISTIC,
    affects: ['Markdown report Findings table Framework Basis column'],
  },
  templates_renderFindings_topN: {
    name: 'templates_renderFindings_topN',
    value: 3,
    type: 'numeric',
    sites: [{ file: 'src/report/templates.ts', symbol: 'renderFindings' }],
    rationale:
      'AAP-43 P2 #7 — Top-3 triage split. When there are 4+ findings, the 3 most-severe render in the prominent "Top 3 Findings" table and the rest collapse into a `<details>` block. Three is the senior-auditor "real issue" count: flat 4+ tables read as "everything is equal weight"; three creates a clear hierarchy between headline issues and the long tail without hiding the tail. The "Top 3 Findings" label and the threshold are coupled — changing the threshold requires changing the label.',
    source: INTERNAL_HEURISTIC,
    affects: ['Markdown report Findings section Top-N split', 'Markdown report "Top 3 Findings" / "Additional findings" labels'],
  },
  templates_severityOrder_rankMapping: {
    name: 'templates_severityOrder_rankMapping',
    value: 'severityOrder rank mapping for sorting findings before the Top-N triage split: critical=4, high=3, medium=2, low=1, default=0. Higher rank sorts earlier (descending sort in `renderFindings`). Reused by `renderVerificationSection` to sort discovery diffs by severity.',
    type: 'categorical',
    sites: [{ file: 'src/report/templates.ts', symbol: 'severityOrder' }],
    rationale:
      'Categorical rank ordering, not a single numeric cutoff: the integer gaps are arbitrary but the *order* (critical > high > medium > low > anything else) is the audit-grade convention shared across the verdict pipeline, html-renderer, and exec-summary. Default=0 means an unknown severity sorts to the bottom rather than crashing the sort — defensive default since severities are stringly-typed at this layer. Changing the ordering would reshuffle which findings land in the Top 3 triage slice (see `templates_renderFindings_topN`).',
    source: INTERNAL_HEURISTIC,
    affects: ['Markdown report Findings table sort order', 'Markdown report Verification section findings sort order', 'Top-N triage selection in renderFindings'],
  },

  // ──────────────────────────────────────────────────────────────────────
  // src/verification/hr-pack/exec-summary.ts — DPO-readable headline
  // ──────────────────────────────────────────────────────────────────────

  execSummary_headlineFindings_topN: {
    name: 'execSummary_headlineFindings_topN',
    value: 5,
    type: 'numeric',
    sites: [{ file: 'src/verification/hr-pack/exec-summary.ts', symbol: 'renderHeadlineFindings' }],
    rationale:
      'Top 5 issues (HR signals + framework fails, severity-sorted) render in the DPO Executive Summary headline list. Five mirrors the html-renderer headline count and the recommended-actions limit — a one-page DPO memo cannot absorb more than five top-line items without losing scannability.',
    source: INTERNAL_HEURISTIC,
    affects: ['Executive Summary headline findings list'],
  },
  execSummary_posture_criticalGate: {
    name: 'execSummary_posture_criticalGate',
    value: 'Any HR-pack critical detected OR any framework FAIL with critical severity → "Partial compliance — N critical issues" verdict line.',
    type: 'categorical',
    sites: [{ file: 'src/verification/hr-pack/exec-summary.ts', symbol: 'renderCompliancePosture' }],
    rationale:
      'Critical-severity issues dominate the headline verdict. A single critical issue calls the entire compliance posture into question, so the headline surfaces critical count even when other detected counts are higher.',
    source: INTERNAL_HEURISTIC,
    affects: ['Executive Summary compliance-posture line'],
  },
  execSummary_posture_partialGate: {
    name: 'execSummary_posture_partialGate',
    value: 'Any HR-pack detected OR any framework FAIL (with no critical) → "Partial compliance — N issues" verdict line.',
    type: 'categorical',
    sites: [{ file: 'src/verification/hr-pack/exec-summary.ts', symbol: 'renderCompliancePosture' }],
    rationale:
      'Any detected HR signal or fail-verdict framework control downgrades the posture to Partial. Heron does not claim "compliant" while any signal is open — Partial is the honest middle ground.',
    source: INTERNAL_HEURISTIC,
    affects: ['Executive Summary compliance-posture line'],
  },
  execSummary_posture_cleanGate: {
    name: 'execSummary_posture_cleanGate',
    value: 'No HR-pack detections AND no framework FAILs → "Clean — no critical issues detected" verdict line.',
    type: 'categorical',
    sites: [{ file: 'src/verification/hr-pack/exec-summary.ts', symbol: 'renderCompliancePosture' }],
    rationale:
      'Clean requires absence of detected signals AND fail-verdict controls. Partial verdicts on framework controls do NOT block Clean because partial is itself a calibrated half-claim (some evidence ran); the posture line speaks only to detected issues / fails.',
    source: INTERNAL_HEURISTIC,
    affects: ['Executive Summary compliance-posture line'],
  },
};
