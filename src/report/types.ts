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
  reversible: z.boolean().default(false),
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
  // AAP-43 P0 #2: empty-string defaults (see volumePerDay note above)
  dataSensitivity: z.string().default(''),
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

export const riskSchema = z.object({
  severity: severitySchema,
  title: z.string(),
  description: z.string(),
  mitigation: z.string().optional(),
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
  agentTrigger: z.string().max(200).optional(),
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

// ─── Audit Report ───────────────────────────────────────────────────────────

export const auditReportSchema = z.object({
  // AAP-65: same length caps as analysisResultSchema. Note: the auditReport
  // is mostly read FROM disk, not validated TO disk — for pre-AAP-65
  // sessions, the analyzer sanitization pass shapes the data into the
  // tightened schema before it ever hits this validator.
  summary: z.string().max(800),
  agentPurpose: z.string().max(600),
  agentTrigger: z.string().max(200).optional(),
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
  metadata: z.object({
    date: z.string(),
    target: z.string(),
    interviewDuration: z.number(),
    questionsAsked: z.number(),
  }),
});
export type AuditReport = z.infer<typeof auditReportSchema> & {
  compliance?: StructuredCompliance;
};
