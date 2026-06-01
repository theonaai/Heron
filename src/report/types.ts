import { z } from 'zod';
import type { CategorizedCompliance } from '../compliance/mapper.js';

// ─── Severity & Blast Radius enums ──────────────────────────────────────────

export const severityLevels = ['low', 'medium', 'high', 'critical'] as const;
/** Coerce common severity variations */
function normalizeSeverity(val: string): string {
  const lower = val.toLowerCase().trim();
  if (lower === 'info' || lower === 'none') return 'low';
  if (severityLevels.includes(lower as Severity)) return lower;
  return 'medium'; // safe default
}
export const severitySchema = z.string().transform(normalizeSeverity).pipe(z.enum(severityLevels)).or(z.enum(severityLevels));
export type Severity = 'low' | 'medium' | 'high' | 'critical';

export const blastRadiusLevels = [
  'single-record',
  'single-user',
  'team-scope',
  'org-wide',
  'cross-tenant',
] as const;
export const blastRadiusSchema = z.enum(blastRadiusLevels);
export type BlastRadius = z.infer<typeof blastRadiusSchema>;

// ─── QAPair ─────────────────────────────────────────────────────────────────

export const categoryValues = [
  'purpose', 'data', 'frequency', 'access', 'writes', 'followup',
] as const;

export const qaPairSchema = z.object({
  question: z.string(),
  answer: z.string(),
  category: z.enum(categoryValues),
});
export type QAPair = z.infer<typeof qaPairSchema>;

// ─── Per-system SystemAssessment (7 compliance fields) ──────────────────────

export const writeOperationSchema = z.object({
  // AAP-65: cap each field at a short structured value.
  operation: z.string().max(80),
  target: z.string().max(80),
  // AAP-109: true ONLY when the write is fully, safely undoable. Nuanced
  // answers ("partly reversible", "no automatic rollback") are normalized to
  // false by normalizeReversibilityInPayload (../analysis/reversibility.ts)
  // before this schema runs, so the irreversibility signal the risk model
  // keys off is not lost. The agent's original phrasing is kept in
  // reversibilityNote.
  reversible: z.boolean().default(false),
  reversibilityNote: z.string().max(200).optional(),
  approvalRequired: z.boolean().default(false),
  // AAP-43 P0 #2: default to empty string (not "NOT PROVIDED" sentinel).
  // Callers use isProvided() to detect missing fields, which now renders
  // an explicit "Unknown — ask deployer" placeholder in customer-facing output.
  volumePerDay: z.string().max(40).default(''),
});
export type WriteOperation = z.infer<typeof writeOperationSchema>;

/** Coerce common blast radius variations to the canonical enum values */
function normalizeBlastRadius(val: string): string {
  const lower = val.toLowerCase().replace(/[_\s]+/g, '-');
  if (lower.includes('cross') && lower.includes('tenant')) return 'cross-tenant';
  if (lower.includes('org')) return 'org-wide';
  if (lower.includes('team')) return 'team-scope';
  if (lower.includes('single') && lower.includes('record')) return 'single-record';
  if (lower.includes('single') && lower.includes('user')) return 'single-user';
  // Try direct match
  if (blastRadiusLevels.includes(lower as BlastRadius)) return lower;
  return 'single-user'; // safe default
}

// AAP-65: structured frequency object replaces the prose
// `frequencyAndVolume` string. The old field is preserved as a fallback so
// pre-AAP-65 reports on disk still load — the analyzer's sanitization pass
// parses the prose into this object on the way in. The renderer prefers
// `frequency` and falls back to `frequencyAndVolume` for back-compat.
export const frequencyShapeSchema = z.object({
  runsLastWeek: z.union([z.number().int().nonnegative(), z.null()]).optional(),
  callsPerRun: z.string().max(40).optional(),
  batchSize: z.union([z.number().int().positive(), z.string().max(20)]).optional(),
  concurrency: z.enum(['sequential', 'parallel', 'mixed', 'unknown']).optional(),
  notes: z.string().max(400).optional(),
});
export type FrequencyShape = z.infer<typeof frequencyShapeSchema>;

export const systemAssessmentSchema = z.object({
  // AAP-65: short kebab-case identifier (≤50 chars). Long descriptive text
  // belongs in `systemDescription`. The analyzer's sanitization pass reshapes
  // pre-AAP-65 prose-style systemId into this form before Zod validation.
  systemId: z.string().min(1).max(50).regex(
    /^[a-z][a-z0-9_-]*$/,
    'systemId must be a short kebab-case identifier (e.g. "openai-codex-backend"), not a sentence',
  ),
  // AAP-65: optional long descriptive text — the full prose description of
  // what this system is and how it's accessed. Lives here, NOT in systemId.
  systemDescription: z.string().max(800).optional(),
  // AAP-65: pulled-out source refs (e.g. "A3", "A4"). The LLM tends to inline
  // these like "... (A3, A4)." — sanitization extracts them into this array.
  sources: z.array(z.string().regex(/^A\d+$/)).max(20).default([]),

  scopesRequested: z.array(z.string().max(80)).default([]),
  scopesNeeded: z.array(z.string().max(80)).default([]),
  scopesDelta: z.array(z.string().max(80)).default([]),
  // AAP-43 P0 #2: empty-string defaults (see volumePerDay note above).
  // `dataSensitivity` is the human-readable prose basis (kept as-is).
  dataSensitivity: z.string().default(''),
  // DS-tier rework (fix/report-render-parity): structured DATA SENSITIVITY TIER the
  // LLM analyzer emits directly, grounded in the W3C DPV taxonomy. Replaces
  // the brittle regex classifier (`classifySystemDS`) that was negation-blind
  // ("no student names found" matched `names` → T2) and over-matched ("folder
  // names" → T2). The analyzer understands negation/context; this is the value
  // the per-system DS axis keys off (systems-risk.ts). Optional because the LLM
  // may occasionally omit it — the consumer defaults conservatively to T2.
  dataSensitivityTier: z.enum(['T1', 'T2', 'T3']).optional(),
  blastRadius: z.string().transform(normalizeBlastRadius).pipe(blastRadiusSchema).or(blastRadiusSchema).default('single-user'),
  // AAP-65: structured frequency object (preferred). `frequencyAndVolume`
  // kept for back-compat with pre-AAP-65 sessions on disk.
  frequency: frequencyShapeSchema.optional(),
  frequencyAndVolume: z.string().default(''),
  writeOperations: z.array(writeOperationSchema).default([]),
});
export type SystemAssessment = z.infer<typeof systemAssessmentSchema>;

// ─── Legacy flat types (kept for migration compatibility) ───────────────────

export const dataNeedSchema = z.object({
  dataType: z.string(),
  system: z.string(),
  justification: z.string(),
});
export type DataNeed = z.infer<typeof dataNeedSchema>;

export const accessClaimSchema = z.object({
  resource: z.string(),
  accessLevel: z.string(),
  justification: z.string(),
});
export type AccessClaim = z.infer<typeof accessClaimSchema>;

export const writeActionSchema = z.object({
  target: z.string(),
  action: z.string(),
  scope: z.string(),
});
export type WriteAction = z.infer<typeof writeActionSchema>;

// ─── Finding evidence source (AAP-102) ──────────────────────────────────────
//
// Provenance for every finding. The wedge between Verified and Self-attested
// claims (Heron strategy v3.0 §3): typed deterministic detectors stamp one of
// MCP / OAU / ENV / PLG depending on which evidence surface fired; findings
// emerging from the prose engine (regex on the interview transcript driving
// `CONTROL_MAPPINGS`) and findings minted by the analyzer LLM from the
// transcript are SLF (self-attested).
//
// `posture` aggregation (AAP-102) reads ONLY Verified findings — SLF findings
// are scored via `computeSeverity` against self-reported inputs but never
// drive posture. This is the "verified-only high-water-mark" rule from
// /Users/ilaivanov/Claude/Claude1/heron-session-context-2026-05-28.md
// § "Уточнение по весам".
export const evidenceSourceValues = ['MCP', 'OAU', 'ENV', 'PLG', 'SLF'] as const;
export const evidenceSourceSchema = z.enum(evidenceSourceValues);
export type EvidenceSource = typeof evidenceSourceValues[number];

// BR × DS × DM component bands, mirrored from
// `src/verification/severity-scoring.ts`. The schema accepts numbers
// (1 / 2 / 3 for BR-W / BR-R / BR-A) so the renderer can attach the
// breakdown to a finding row.
export const severityComponentsSchema = z.object({
  br: z.number(),
  ds: z.number(),
  dm: z.number(),
  brW: z.number().optional(),
  brR: z.number().optional(),
  brA: z.number().optional(),
});
export type SeverityComponents = z.infer<typeof severityComponentsSchema>;

// AAP-105 A6 — per-finding severity inputs for self-attested (SLF) risks.
//
// Pre-A6, every SLF finding was scored by the SESSION-WIDE blast radius
// (`computeSeverity` with no per-finding hint), so all of them collapsed to
// the same severity number (e.g. `9 HIGH` on the demo). That pasted the whole
// agent's blast radius onto every card — "Telegram alerting fails open" (low
// real blast radius) scored identically to "Broad Google OAuth permissions"
// (genuinely high reach). It misrepresented both.
//
// A6 lets the analyzer LLM assess EACH risk's own BR × DS × DM axes (the same
// rubric used by deterministic findings, see
// `src/verification/severity-scoring.ts`). The field is OPTIONAL: old sessions
// and any LLM extraction that omits it fall back to the prior session-wide
// path in `interviewRiskToVerdictFinding`, so there is no regression for legacy
// data. This stays honest because SLF findings are self-attested by
// definition — a per-finding severity estimate from the same interview source,
// scored by the same rubric and clearly marked "self-attested estimate, not
// verified", is strictly more accurate than the agent-level number on
// everything.
//
//   - brW / brR / brA: blast-radius axes (write scope / reach / autonomy),
//     each 1 / 2 / 3 — assessed for THIS risk, not the whole agent.
//   - ds: data sensitivity 1 (T1) / 2 (T2 PII) / 3 (T3 GDPR Art. 9 / financial
//     creds / gov IDs).
//   - dm: domain multiplier 1.0 default / 1.5 if EU AI Act Annex III domain OR
//     GDPR Art. 35(3) DPIA trigger applies.
//
// severity = max(brW, brR, brA) × ds × dm — identical math to
// `computeSeverity`, just sourced per-risk.
export const axisBandSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export const domainMultiplierSchema = z.union([z.literal(1), z.literal(1.5)]);
export const severityInputsSchema = z.object({
  brW: axisBandSchema,
  brR: axisBandSchema,
  brA: axisBandSchema,
  ds: axisBandSchema,
  dm: domainMultiplierSchema,
});
export type SeverityInputs = z.infer<typeof severityInputsSchema>;

export const riskSchema = z.object({
  severity: severitySchema,
  title: z.string(),
  description: z.string(),
  mitigation: z.string().optional(),
  /** AAP-102 — BR × DS × DM severity number (one of 1, 1.5, 2, 3, 4, 4.5, 6, 9, 13.5). */
  severityScore: z.number().optional(),
  /** AAP-102 — per-axis breakdown for the renderer. */
  severityComponents: severityComponentsSchema.optional(),
  /** AAP-102 — provenance: MCP / OAU / ENV / PLG (Verified) vs SLF (Self-attested). */
  evidenceSource: evidenceSourceSchema.optional(),
  /**
   * AAP-105 A6 — per-finding severity axes for SLF risks. Optional; when
   * present, `interviewRiskToVerdictFinding` scores THIS risk from these
   * inputs instead of the session-wide blast radius. Absent → legacy
   * session-wide fallback. See `severityInputsSchema` doc above.
   */
  severityInputs: severityInputsSchema.optional(),
});
export type Risk = z.infer<typeof riskSchema>;

// ─── Access Assessment ──────────────────────────────────────────────────────

export const accessAssessmentSchema = z.object({
  claimed: z.array(accessClaimSchema),
  actuallyNeeded: z.array(accessClaimSchema),
  excessive: z.array(accessClaimSchema),
  missing: z.array(accessClaimSchema),
});
export type AccessAssessment = z.infer<typeof accessAssessmentSchema>;

// ─── Interview Result ───────────────────────────────────────────────────────

export const interviewResultSchema = z.object({
  agentPurpose: z.string(),
  dataNeeds: z.array(dataNeedSchema),
  accessFrequency: z.string(),
  currentAccess: z.array(accessClaimSchema),
  writesAndModifications: z.array(writeActionSchema),
  rawTranscript: z.array(qaPairSchema),
});
export type InterviewResult = z.infer<typeof interviewResultSchema>;

// ─── Recommendation ─────────────────────────────────────────────────────────

export const recommendationValues = [
  'APPROVE',
  'APPROVE WITH CONDITIONS',
  'DENY',
] as const;
export const recommendationSchema = z.enum(recommendationValues);
export type Recommendation = z.infer<typeof recommendationSchema>;

// ─── Analysis Result (LLM output schema) ────────────────────────────────────

export const analysisResultSchema = z.object({
  // AAP-65: cap top-level prose fields at short structured limits.
  summary: z.string().max(800),
  agentPurpose: z.string().max(600),
  agentTrigger: z.string().max(600).optional(),
  agentOwner: z.string().max(200).optional(),
  systems: z.array(systemAssessmentSchema),
  risks: z.array(riskSchema),
  recommendations: z.array(z.string().max(400)).max(20),
  recommendation: recommendationSchema.optional(),
  overallRiskLevel: severitySchema,
  makesDecisionsAboutPeople: z.boolean().optional(),
  decisionMakingDetails: z.string().max(800).optional(),
});
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

// ─── Data Quality ────────────────────────────────────────────────────────────

export const dataQualitySchema = z.object({
  score: z.number(),                   // 0-100
  uniqueAnswers: z.number(),           // answers that aren't greetings or repeats
  totalQuestions: z.number(),
  fieldsProvided: z.array(z.string()), // compliance fields with real data
  fieldsMissing: z.array(z.string()),  // compliance fields with no/canned data
  repeatedAnswers: z.number(),         // count of duplicate canned responses
});
export type DataQuality = z.infer<typeof dataQualitySchema>;

// ─── Regulatory Flags ──────────────────────────────────────────────────────

export interface RegulatoryFlag {
  framework: string;       // e.g. "EU AI Act", "GDPR Article 22", "ISO/IEC 42001 A.6.2.6"
  severity: 'info' | 'warning' | 'action-required' | 'clarification-needed';
  description: string;
  /** AAP-31: control IDs activated by this finding (optional for legacy flags). */
  controlIds?: string[];
  /** AAP-31: risk category. */
  category?: 'privacy' | 'ip' | 'consumer-protection' | 'sector-specific';
  /** AAP-31: mandatory vs voluntary tier. */
  tier?: 'mandatory' | 'voluntary';
  /** AAP-31: jurisdictions where the framework is mandatory. */
  mandatoryIn?: ReadonlyArray<'EU' | 'UK' | 'US' | 'global'>;
  /** AAP-31: human-readable jurisdictional scope clarification. */
  scopeNote?: string;
}

/** AAP-31: per-category buckets under mandatory / voluntary tiers. */
export interface CategorizedBucket {
  privacy: RegulatoryFlag[];
  ip: RegulatoryFlag[];
  'consumer-protection': RegulatoryFlag[];
  'sector-specific': RegulatoryFlag[];
}

/** AAP-31: replaces legacy RegulatoryCompliance {eu, us, uk} on AuditReport. */
export type StructuredCompliance = CategorizedCompliance;

// ─── Verification status (AAP-79) ───────────────────────────────────────────

/**
 * AAP-79 — report-level verification lifecycle.
 *
 * Reflects whether the runtime evidence scan (`start_verification` MCP
 * tool or the dashboard `Run verification` button) has run for this
 * report:
 *
 *   - `'interrogation-only'` — the report is the LLM analyzer's read of
 *     the interview transcript only. No deterministic Surface 2 evidence
 *     has been merged in. Markdown + dashboard render the orange banner
 *     prompting the operator (or the agent) to start verification.
 *   - `'verified'` — every Surface 2 source ran cleanly. Stage 3
 *     framework mapping has been re-computed against the analyzer
 *     signals + discovery evidence. Banner disappears.
 *   - `'partially-verified'` — at least one Surface 2 source ran, but
 *     the verdict came back as `partial` (some sources did not run, or
 *     produced findings). Banner switches to the amber "partially
 *     verified" variant. AAP-80 introduced this state to stop the
 *     `start_verification` and `/api/discovery/scan` paths from
 *     hardcoding `'verified'` when only one source had been exercised.
 *   - `'verification-failed'` — Surface 2 was attempted but errored.
 *     `reason` carries a short diagnostic so the operator can retry.
 *     Banner switches to the failure variant.
 *
 * Distinct from `session.meta.verificationStatus` (AAP-63), which
 * tracks the verdict-level surface 2 state (`unverified` / `partial`
 * / `verified`). The two move together on success, but the report-level
 * field is what the renderer reads for the banner so legacy sessions
 * persisted before AAP-79 (no field) silently default to "no banner".
 */
export const reportVerificationStatusValues = [
  'interrogation-only',
  'verified',
  'partially-verified',
  'verification-failed',
] as const;
export type ReportVerificationStatus = typeof reportVerificationStatusValues[number];

export const reportVerificationSchema = z.object({
  status: z.enum(reportVerificationStatusValues),
  /** Diagnostic note when status === 'verification-failed'. */
  reason: z.string().max(400).optional(),
  /** ISO-8601 of the last status change. */
  updatedAt: z.string().optional(),
});
export type ReportVerification = z.infer<typeof reportVerificationSchema>;

// ─── Verdict snapshot for the dashboard (AAP-103) ──────────────────────────
//
// The dashboard reads report.json directly, so persisted reports must
// carry the posture + findings shape the new Vijil-style cards need.
// `verdictSnapshot` mirrors the subset of `Verdict` that drives display:
// posture, postureBand, and the findings array (Verified + SLF).
// Aggregation (FIPS 199 high-water-mark) happens server-side in
// `computeVerdict`; this snapshot is read-only on the dashboard.

export const severityBandValues = ['informational', 'low', 'medium', 'high', 'critical'] as const;
export const severityBandSchema = z.enum(severityBandValues);
export type ReportSeverityBand = typeof severityBandValues[number];

export const verdictFindingSnapshotSchema = z.object({
  id: z.string(),
  band: severityBandSchema,
  severityScore: z.number(),
  severityComponents: z.object({
    br: z.number(),
    ds: z.number(),
    dm: z.number(),
    brW: z.number().optional(),
    brR: z.number().optional(),
    brA: z.number().optional(),
  }),
  evidenceSource: evidenceSourceSchema,
  title: z.string(),
  description: z.string(),
  /** AAP-104 B9 — analyzer-supplied mitigation text (semicolon-joined
   *  suggestions). Optional; the SLF mitigation renderer prefers this
   *  over the generic evidence-source fallback when present. */
  analyzerNotes: z.string().optional(),
  kind: z.string().optional(),
});
export type VerdictFindingSnapshot = z.infer<typeof verdictFindingSnapshotSchema>;

/**
 * AAP-105 (G8b) — one reclassified host-wide MCP server. A discovered
 * EXTRA server on a `global`-scope runtime (codex) is NOT a deviation by
 * the audited agent — `~/.codex/config.toml` is shared host-wide — so it
 * is lifted out of `findings` into here. Informational only: no severity,
 * does not move posture, rendered as a muted note (not a finding card).
 */
export const hostCapabilitySnapshotSchema = z.object({
  serverName: z.string(),
  runtime: z.string(),
  transport: z.string(),
  note: z.string(),
});
export type HostCapabilitySnapshot = z.infer<typeof hostCapabilitySnapshotSchema>;

/**
 * G9 (AAP-106) — per-system deployment-risk row. The system's
 * BR × DS × DM severity (same scale as findings) plus the T-tier + a short
 * basis sentence for the PII-basis-inline transparency fix. Persisted in
 * report.json so the dashboard can render the basis next to the sensitivity
 * badge and explain why posture is what it is.
 */
export const systemRiskSnapshotSchema = z.object({
  systemId: z.string(),
  severity: z.number(),
  band: severityBandSchema,
  br: z.number(),
  ds: z.number(),
  dm: z.number(),
  dsTier: z.enum(['T1', 'T2', 'T3']),
  dsBasis: z.string(),
  hasIrreversibleWrite: z.boolean(),
});
export type SystemRiskSnapshot = z.infer<typeof systemRiskSnapshotSchema>;

/**
 * G9 (AAP-106) — systems-risk summary: the per-system HWM posture + the
 * breakdown. `scanned` distinguishes "systems were scored" (clean-low-risk
 * green label) from "no systems at all" (gray Not-yet-verified label).
 */
export const systemsRiskSnapshotSchema = z.object({
  posture: z.number(),
  postureBand: severityBandSchema,
  scanned: z.boolean(),
  systems: z.array(systemRiskSnapshotSchema),
});
export type SystemsRiskSnapshot = z.infer<typeof systemsRiskSnapshotSchema>;

export const verdictSnapshotSchema = z.object({
  /** Technical execution state: 'verified' / 'partial' / 'unverified'. */
  status: z.enum(['verified', 'partial', 'unverified']),
  /**
   * G9 (AAP-106) — DEPLOYMENT RISK posture: FIPS HWM of per-system risk and
   * the verified-discrepancy HWM. > 0 for an honest-but-risky agent.
   */
  posture: z.number(),
  /** Coarse band for `posture`. */
  postureBand: severityBandSchema,
  /**
   * G9 (AAP-106) — verified-discrepancy-only HWM (pre-G9 posture). Optional +
   * defaulted so report.json blobs persisted before G9 deserialise cleanly.
   */
  discrepancyPosture: z.number().optional().default(0),
  /**
   * G9 (AAP-106) — per-system deployment-risk breakdown. Optional + defaulted
   * for back-compat with pre-G9 report.json.
   */
  systemsRisk: systemsRiskSnapshotSchema
    .optional()
    .default({ posture: 0, postureBand: 'informational', scanned: false, systems: [] }),
  /** Every finding (Verified + SLF), with severity + provenance attached. */
  findings: z.array(verdictFindingSnapshotSchema),
  /**
   * AAP-105 (G8b) — global-scope MCP servers reclassified out of
   * `findings` (host capability, not agent-bound). Optional + defaulted
   * so report.json blobs persisted before G8b deserialise cleanly.
   */
  hostCapabilities: z.array(hostCapabilitySnapshotSchema).optional().default([]),
});
export type VerdictSnapshot = z.infer<typeof verdictSnapshotSchema>;

// ─── Audit Report ───────────────────────────────────────────────────────────

export const auditReportSchema = z.object({
  // AAP-65: same length caps as analysisResultSchema. Note: the auditReport
  // is mostly read FROM disk, not validated TO disk — for pre-AAP-65
  // sessions, the analyzer sanitization pass shapes the data into the
  // tightened schema before it ever hits this validator.
  summary: z.string().max(800),
  agentPurpose: z.string().max(600),
  agentTrigger: z.string().max(600).optional(),
  agentOwner: z.string().max(200).optional(),
  systems: z.array(systemAssessmentSchema),
  // Legacy flat fields for backward compat
  dataNeeds: z.array(dataNeedSchema),
  accessAssessment: accessAssessmentSchema,
  risks: z.array(riskSchema),
  recommendations: z.array(z.string().max(400)).max(20),
  recommendation: recommendationSchema.optional(),
  overallRiskLevel: severitySchema,
  transcript: z.array(qaPairSchema),
  dataQuality: dataQualitySchema.optional(),
  makesDecisionsAboutPeople: z.boolean().optional(),
  decisionMakingDetails: z.string().max(800).optional(),
  compliance: z.any().optional(), // StructuredCompliance (CategorizedCompliance, not Zod-validated)
  // AAP-69: writer-side alias for `compliance`. The dashboard's ReportView
  // and the diff route both read `regulatoryCompliance`; the markdown
  // template + CLI path both read `compliance`. Rather than rename the
  // canonical field (and risk breaking every CLI / markdown reader),
  // emit BOTH keys with the same payload from the report builder. The
  // alias is populated in `src/report/generator.ts:buildSuccessReport`.
  regulatoryCompliance: z.any().optional(), // alias of `compliance` — see AAP-69
  metadata: z.object({
    date: z.string(),
    target: z.string(),
    interviewDuration: z.number(),
    questionsAsked: z.number(),
  }),
  /**
   * AAP-79 — report-level verification lifecycle. Initialised to
   * `'interrogation-only'` by the analyzer pipeline, flipped to
   * `'verified'` by `start_verification` (or the dashboard
   * `Run verification` button) on success, and to
   * `'verification-failed'` on error.
   */
  verification: reportVerificationSchema.optional(),
  /**
   * AAP-103 — verdict snapshot for the dashboard. Carries posture,
   * postureBand, and the unified findings list with severity
   * components + provenance. Populated by the verification pipeline
   * after Surface 2 evidence is reconciled.
   */
  verdict: verdictSnapshotSchema.optional(),
});
export type AuditReport = z.infer<typeof auditReportSchema> & {
  compliance?: StructuredCompliance;
  /** AAP-69: writer-side alias of `compliance` so the dashboard
   *  ReportView (which reads `json.regulatoryCompliance`) renders. */
  regulatoryCompliance?: StructuredCompliance;
  /** AAP-79: see reportVerificationSchema. */
  verification?: ReportVerification;
  /** AAP-103: posture + findings snapshot for the dashboard. */
  verdict?: VerdictSnapshot;
};
