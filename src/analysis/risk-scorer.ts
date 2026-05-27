import type { Risk, SystemAssessment, Severity, BlastRadius, Recommendation } from '../report/types.js';
import type { ReportVerificationStatus } from '../report/types.js';

export interface RiskScore {
  overall: Severity;
  score: number; // 0-100
  breakdown: {
    excessiveAccess: number;
    writeRisk: number;
    sensitiveData: number;
    scopeCreep: number;
  };
}

// ─── Rubric weights ─────────────────────────────────────────────────────────
// AAP-88: thresholds documented in src/verification/threshold-manifest.ts.
//   - riskScorer_weight_excessiveAccess (0.35)
//   - riskScorer_weight_writeRisk (0.30)
//   - riskScorer_weight_sensitiveData (0.20)
//   - riskScorer_weight_scopeCreep (0.15)

const WEIGHTS = {
  excessiveAccess: 0.35,
  writeRisk: 0.30,
  sensitiveData: 0.20,
  scopeCreep: 0.15,
} as const;

// ─── Blast radius severity multiplier ────────────────────────────────────────
// AAP-88: thresholds documented in src/verification/threshold-manifest.ts.
//   - riskScorer_blastRadius_singleRecord (0.2)
//   - riskScorer_blastRadius_singleUser (0.4)
//   - riskScorer_blastRadius_teamScope (0.6)
//   - riskScorer_blastRadius_orgWide (0.85)
//   - riskScorer_blastRadius_crossTenant (1.0)

const BLAST_RADIUS_MULTIPLIER: Record<BlastRadius, number> = {
  'single-record': 0.2,
  'single-user': 0.4,
  'team-scope': 0.6,
  'org-wide': 0.85,
  'cross-tenant': 1.0,
};

// ─── Sensitivity keywords for scoring ────────────────────────────────────────

const SENSITIVE_KEYWORDS = [
  'pii', 'personal', 'credential', 'confidential', 'financial',
  'password', 'secret', 'token', 'ssn', 'credit card', 'health',
  'medical', 'salary', 'compensation',
];

// ─── Public-PII-at-scale keywords (AAP-43 post-merge fix 2026-04-24) ────────
//
// LinkedIn-style agents handle *public* PII (names, emails, profile URLs,
// titles) which never contains SSN/bank-level sensitivity keywords above, so
// `hasSensitivePII` is always false. The AAP-43 severity-anchor in
// src/llm/prompts.ts nevertheless tells the LLM that "OAuth scope
// `spreadsheets` with 500 PII rows → HIGH", but the rule-based floor could
// not enforce the same thing because it only recognised sensitive PII.
//
// The fix: recognise public PII explicitly. When it is stored at scale (org-
// wide blast radius, >=500 rows per run, or scraping) floor-severity for
// access / data risks is raised to HIGH so the LinkedIn ICP case matches
// the stated anchor even without LLM escalation.
const PUBLIC_PII_KEYWORDS = [
  'linkedin', 'profile url', 'full name', 'first name', 'last name',
  'email', 'phone', 'address', 'scrape', 'scraped', 'scraping',
  'job title', 'employer', 'company', 'career', 'resume',
];
const LARGE_VOLUME_KEYWORDS = [
  ' 500', '500 rows', '500 profiles', '500 leads', '500 connections',
  '1000', '10k', '10 000', '10,000', 'at scale', 'scrape', 'scraping',
  'batch of 5', 'bulk', 'batched',
];

/**
 * Rubric-driven risk scorer.
 * Computes risk from structured per-system data, not keyword-grepping risk descriptions.
 *
 * Inputs: per-system assessments + LLM-identified risks.
 * Each component scores 0-100, then weighted sum → overall 0-100 → severity level.
 */
export function computeRiskScore(
  systems: SystemAssessment[],
  risks: Risk[],
): RiskScore {
  const breakdown = {
    excessiveAccess: scoreExcessiveAccess(systems),
    writeRisk: scoreWriteRisk(systems),
    sensitiveData: scoreSensitiveData(systems),
    scopeCreep: scoreScopeCreep(systems),
  };

  const rawScore =
    breakdown.excessiveAccess * WEIGHTS.excessiveAccess +
    breakdown.writeRisk * WEIGHTS.writeRisk +
    breakdown.sensitiveData * WEIGHTS.sensitiveData +
    breakdown.scopeCreep * WEIGHTS.scopeCreep;

  // Escalation: if multiple HIGH-severity risks from LLM analysis, bump up.
  // AAP-88: thresholds documented in src/verification/threshold-manifest.ts.
  //   - riskScorer_escalation_highLLMRisks (count threshold = 2)
  //   - riskScorer_escalation_addPoints (bump amount = +10)
  const highOrCriticalRisks = risks.filter(r => r.severity === 'high' || r.severity === 'critical');
  const escalation = highOrCriticalRisks.length >= 2 ? 10 : 0;

  const score = Math.min(100, Math.round(rawScore + escalation));

  return {
    overall: scoreToLevel(score),
    score,
    breakdown,
  };
}

/**
 * Excessive access: ratio of excessive scopes to total requested across all systems.
 * Weighted by blast radius of each system.
 */
function scoreExcessiveAccess(systems: SystemAssessment[]): number {
  if (systems.length === 0) return 0;

  let totalWeighted = 0;
  let totalRequested = 0;

  for (const sys of systems) {
    const requested = sys.scopesRequested.length || 1;
    const excessive = sys.scopesDelta.length;
    const multiplier = BLAST_RADIUS_MULTIPLIER[sys.blastRadius] ?? 0.5;
    totalWeighted += (excessive / requested) * multiplier * 100;
    totalRequested++;
  }

  return Math.min(100, Math.round(totalWeighted / totalRequested));
}

/**
 * Write risk: based on write operations across all systems.
 * Considers reversibility, approval requirements, blast radius, and volume.
 */
function scoreWriteRisk(systems: SystemAssessment[]): number {
  if (systems.length === 0) return 0;

  let maxWriteScore = 0;

  for (const sys of systems) {
    const multiplier = BLAST_RADIUS_MULTIPLIER[sys.blastRadius] ?? 0.5;

    for (const write of sys.writeOperations) {
      // AAP-88: thresholds documented in src/verification/threshold-manifest.ts.
      //   - riskScorer_writeRisk_baseScore (40)
      //   - riskScorer_writeRisk_irreversiblePenalty (30)
      //   - riskScorer_writeRisk_noApprovalPenalty (15)
      let writeScore = 40; // base: writes exist

      if (!write.reversible) writeScore += 30;         // irreversible: +30
      if (!write.approvalRequired) writeScore += 15;    // no approval: +15
      writeScore *= multiplier;                          // scale by blast radius

      maxWriteScore = Math.max(maxWriteScore, writeScore);
    }
  }

  return Math.min(100, Math.round(maxWriteScore));
}

/**
 * Sensitive data: check dataSensitivity field for known keywords.
 * Weighted by blast radius.
 */
function scoreSensitiveData(systems: SystemAssessment[]): number {
  if (systems.length === 0) return 0;

  let maxScore = 0;

  for (const sys of systems) {
    const lower = sys.dataSensitivity.toLowerCase();
    const hitCount = SENSITIVE_KEYWORDS.filter(kw => lower.includes(kw)).length;

    if (hitCount === 0) continue;

    const multiplier = BLAST_RADIUS_MULTIPLIER[sys.blastRadius] ?? 0.5;
    // AAP-88: threshold `riskScorer_sensitivity_perKeywordPoints` = 25.
    // See src/verification/threshold-manifest.ts.
    const sensitivityScore = Math.min(100, hitCount * 25) * multiplier;
    maxScore = Math.max(maxScore, sensitivityScore);
  }

  return Math.min(100, Math.round(maxScore));
}

/**
 * Scope creep: ratio of requested scopes to needed scopes across all systems.
 */
function scoreScopeCreep(systems: SystemAssessment[]): number {
  if (systems.length === 0) return 0;

  let totalRequested = 0;
  let totalNeeded = 0;

  for (const sys of systems) {
    totalRequested += sys.scopesRequested.length;
    totalNeeded += sys.scopesNeeded.length;
  }

  // AAP-88: categorical threshold `riskScorer_scopeCreep_ratioBands` —
  // bands documented in src/verification/threshold-manifest.ts.
  if (totalNeeded === 0) return totalRequested > 0 ? 75 : 0;

  const ratio = totalRequested / totalNeeded;
  if (ratio <= 1) return 0;
  if (ratio <= 1.5) return 25;
  if (ratio <= 2) return 50;
  if (ratio <= 3) return 75;
  return 100;
}

function scoreToLevel(score: number): Severity {
  // AAP-88: severity ladder thresholds documented in
  // src/verification/threshold-manifest.ts.
  //   - riskScorer_severityLadder_lowMax (20)
  //   - riskScorer_severityLadder_mediumMax (45)
  //   - riskScorer_severityLadder_highMax (70)
  if (score <= 20) return 'low';
  if (score <= 45) return 'medium';
  if (score <= 70) return 'high';
  return 'critical';
}

// ─── Rule-based severity override (AAP-43 P0 determinism) ──────────────────

const SEVERITY_ORDER: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

export interface SeveritySignals {
  hasSensitivePII: boolean;
  hasIrreversibleWrites: boolean;
  hasExcessivePerms: boolean;
  hasOrgWideWrites: boolean;
  hasDecisionsAboutPeople: boolean;
  /**
   * AAP-43 post-merge fix (2026-04-24): public PII processed at scale
   * (>=500 records per run OR org-wide blast radius). This is the LinkedIn
   * ICP profile: names/emails/LinkedIn URLs aren't SSN-grade, but writing
   * 500 of them into a Google Sheet still activates GDPR data-minimisation
   * and least-privilege floors. Used by the access/data severity floor to
   * raise HIGH when the LLM misses it.
   */
  hasPublicPIIAtScale: boolean;
}

/**
 * Aggregate deterministic signals from structured per-system data.
 * Used to compute severity floors so per-risk labels are stable across LLM runs.
 */
export function computeSeveritySignals(
  systems: SystemAssessment[],
  makesDecisionsAboutPeople?: boolean,
): SeveritySignals {
  const hasSensitivePII = systems.some(s => {
    const text = s.dataSensitivity.toLowerCase();
    return SENSITIVE_KEYWORDS.some(k => text.includes(k));
  });

  const hasIrreversibleWrites = systems.some(s =>
    s.writeOperations.some(w => !w.reversible),
  );

  const hasExcessivePerms = systems.some(s => s.scopesDelta.length > 0);

  const hasOrgWideWrites = systems.some(s => {
    const broad = s.blastRadius === 'org-wide' || s.blastRadius === 'cross-tenant';
    return broad && s.writeOperations.length > 0;
  });

  // Public PII at scale: public personal data (LinkedIn profiles, scraped
  // contacts, etc.) combined with either an explicit large-volume marker or
  // an org-wide/cross-tenant blast radius. Either indicator alone is weak;
  // the combination is the shape reviewers called HIGH on the LinkedIn ICP
  // reference case. AAP-88: categorical threshold
  // `riskScorer_publicPII_volumeKeywords` — see
  // src/verification/threshold-manifest.ts.
  const hasPublicPIIAtScale = systems.some(s => {
    const haystack =
      `${s.dataSensitivity} ${s.frequencyAndVolume} ${s.systemId}`.toLowerCase();
    const mentionsPublicPII = PUBLIC_PII_KEYWORDS.some(k => haystack.includes(k));
    if (!mentionsPublicPII) return false;
    const mentionsScale = LARGE_VOLUME_KEYWORDS.some(k => haystack.includes(k));
    const broadBlast =
      s.blastRadius === 'org-wide' || s.blastRadius === 'cross-tenant';
    return mentionsScale || broadBlast;
  });

  return {
    hasSensitivePII,
    hasIrreversibleWrites,
    hasExcessivePerms,
    hasOrgWideWrites,
    hasDecisionsAboutPeople: Boolean(makesDecisionsAboutPeople),
    hasPublicPIIAtScale,
  };
}

type RiskKind = 'access' | 'write' | 'data' | 'decisions' | 'unknown';

function inferRiskKind(risk: Risk): RiskKind {
  const text = `${risk.title} ${risk.description}`.toLowerCase();
  if (/decision|hiring|recruit|scoring|profil|rank|select.*people|access.control/.test(text)) return 'decisions';
  if (/pii|personal|data.minim|retention|confidential|sensitive|health|financial/.test(text)) return 'data';
  if (/write|send|create|delete|update|modify|post|irrevers/.test(text)) return 'write';
  if (/scope|permission|access|oauth|excessive|over.?priv/.test(text)) return 'access';
  return 'unknown';
}

/**
 * Compute severity floor for a given risk kind, given aggregate signals.
 * Returns the minimum acceptable severity — the final severity is
 * MAX(LLM-assigned, floor) so senior-auditor insight isn't lost.
 */
function severityFloor(kind: RiskKind, signals: SeveritySignals): Severity {
  const {
    hasSensitivePII,
    hasIrreversibleWrites,
    hasExcessivePerms,
    hasOrgWideWrites,
    hasDecisionsAboutPeople,
    hasPublicPIIAtScale,
  } = signals;

  // AAP-88: categorical threshold `riskScorer_severityFloor_decisionsHigh` —
  // see src/verification/threshold-manifest.ts.
  if (kind === 'decisions' && hasDecisionsAboutPeople) return 'high';

  // Excessive permissions paired with PII of any kind at scale is HIGH.
  // Covers the LinkedIn ICP reference case where public PII + Google
  // Sheets `spreadsheets` scope must not be MEDIUM per the prompt-anchor.
  if (kind === 'access' && hasExcessivePerms && (hasSensitivePII || hasPublicPIIAtScale)) return 'high';
  if (kind === 'access' && hasExcessivePerms) return 'medium';

  if (kind === 'write' && (hasOrgWideWrites || (hasIrreversibleWrites && hasSensitivePII))) return 'high';
  if (kind === 'write' && hasIrreversibleWrites) return 'medium';

  if (kind === 'data' && hasSensitivePII && (hasIrreversibleWrites || hasExcessivePerms)) return 'high';
  if (kind === 'data' && hasSensitivePII) return 'medium';
  // Public PII at scale also raises the data-risk floor — retention,
  // minimisation, and breach-readiness are active obligations regardless
  // of sensitivity tier once volume crosses the threshold.
  if (kind === 'data' && hasPublicPIIAtScale && hasExcessivePerms) return 'high';
  if (kind === 'data' && hasPublicPIIAtScale) return 'medium';

  return 'low';
}

/**
 * Apply deterministic rule-based overrides to LLM-assigned risk severities.
 *
 * Rationale (AAP-43 P0 #1): LLMs at temperature=0 still flip severity labels
 * run-to-run because of MoE routing / float arithmetic / load-balancer hops.
 * For compliance-audit use this is unacceptable (reviewers: "determinism isn't
 * optional in audit"). We therefore compute a rule-based severity floor from
 * structured signals and take MAX(LLM, floor). LLM senior-auditor intuition
 * is preserved when it exceeds the floor; otherwise the floor holds.
 */
export function applySeverityOverrides(
  risks: Risk[],
  systems: SystemAssessment[],
  makesDecisionsAboutPeople?: boolean,
): Risk[] {
  const signals = computeSeveritySignals(systems, makesDecisionsAboutPeople);
  return risks.map(risk => {
    const kind = inferRiskKind(risk);
    const floor = severityFloor(kind, signals);
    return { ...risk, severity: maxSeverity(risk.severity, floor) };
  });
}

// ─── Verdict ↔ overallRiskLevel calibration (AAP-69) ──────────────────────
//
// The HR-persona test (`sess-20260521-091414-7453aa`) surfaced an internal
// contradiction in the published audit: `recommendation: DENY` paired with
// `overallRiskLevel: medium`. The rubric-driven `computeRiskScore` and the
// LLM-driven `recommendation` are computed independently — when the LLM
// reaches DENY through holistic reasoning (e.g. autonomous decisions about
// people with no human-in-the-loop) but the rubric only sees medium-grade
// signals, the two fields disagree.
//
// "Medium overall risk, but we DENY" reads as either a copy-paste bug or
// noise. Calibrate the two so they cannot contradict:
//
//   - DENY must coincide with HIGH or CRITICAL overall. Floor at HIGH.
//   - bare APPROVE must NOT coincide with CRITICAL overall (self-contradictory).
//     Cap at HIGH on this combination — the reviewer can still see HIGH and
//     decide to escalate. "APPROVE WITH CONDITIONS" is the catch-all and
//     does NOT get capped; "APPROVE" without conditions is the contradiction.
//
// The rubric score (numeric) is intentionally NOT mutated — it remains the
// honest computed value. Only the categorical `overall` label is bumped /
// clamped so the dashboard pill and the verdict pill stop arguing.
export function calibrateOverallRiskLevel(
  overall: Severity,
  recommendation: Recommendation | undefined,
): Severity {
  // AAP-88: categorical thresholds documented in
  // src/verification/threshold-manifest.ts.
  //   - riskScorer_calibrate_denyMinHigh
  //   - riskScorer_calibrate_approveMaxHigh
  if (recommendation === 'DENY') {
    // Floor at HIGH. Preserve CRITICAL if the rubric reached it.
    return SEVERITY_ORDER[overall] >= SEVERITY_ORDER.high ? overall : 'high';
  }
  if (recommendation === 'APPROVE' && overall === 'critical') {
    // Cap at HIGH. APPROVE on a CRITICAL-rated agent is structurally
    // self-contradictory — soften to HIGH and let the reviewer judge.
    return 'high';
  }
  return overall;
}

// ─── AAP-93 H8 — verdict-string calibration ────────────────────────────
//
// The legacy `Recommendation` enum has three values: APPROVE,
// APPROVE WITH CONDITIONS, DENY. Pre-AAP-93 the report would render
// `APPROVE WITH CONDITIONS` for ANY combination of state + findings
// that wasn't outright DENY-worthy, including the partial-verification
// + HIGH self-reported finding case. Codex review flagged that as
// rubber-stamping risky deployments — the partial-verified + high-
// finding combination needs to be visibly louder than "APPROVE WITH
// CONDITIONS".
//
// `calibrateVerdictLabel` is a renderer-side decoration: it takes the
// analyzer's recommendation, the persisted verification status, and a
// `hasHighFindings` flag (derived from `report.risks` PLUS Surface 2
// HIGH discovery findings), and produces a stronger label string when
// the combination calls for it. The original `recommendation` field on
// the report stays untouched so the JSON contract for downstream
// consumers (dashboard, CLI) doesn't change.
//
// Matrix from AAP-93 H8:
//   verified            && no HIGH findings → APPROVE
//   verified            && HIGH findings    → APPROVE WITH CONDITIONS
//   partially-verified  && no HIGH findings → PROVISIONAL — VERIFY MISSING SOURCES
//   partially-verified  && HIGH findings    → DO NOT APPROVE WITHOUT REMEDIATION
//   verification-failed                     → BLOCKED — VERIFICATION REQUIRED
//   interrogation-only  && no HIGH findings → APPROVE WITH CONDITIONS (self-report only)
//   interrogation-only  && HIGH findings    → PROVISIONAL — VERIFY HIGH FINDINGS BEFORE APPROVAL
export type CalibratedVerdictLabel =
  | 'APPROVE'
  | 'APPROVE WITH CONDITIONS'
  | 'PROVISIONAL — VERIFY MISSING SOURCES'
  | 'PROVISIONAL — VERIFY HIGH FINDINGS BEFORE APPROVAL'
  | 'DO NOT APPROVE WITHOUT REMEDIATION'
  | 'BLOCKED — VERIFICATION REQUIRED'
  | 'DENY';

export function calibrateVerdictLabel(args: {
  recommendation: Recommendation | undefined;
  verificationStatus: ReportVerificationStatus | undefined;
  hasHighFindings: boolean;
}): CalibratedVerdictLabel {
  // Explicit DENY from the analyzer always wins — analyst intent takes
  // precedence over the calibration matrix.
  if (args.recommendation === 'DENY') return 'DENY';

  switch (args.verificationStatus) {
    case 'verified':
      return args.hasHighFindings ? 'APPROVE WITH CONDITIONS' : 'APPROVE';
    case 'partially-verified':
      return args.hasHighFindings
        ? 'DO NOT APPROVE WITHOUT REMEDIATION'
        : 'PROVISIONAL — VERIFY MISSING SOURCES';
    case 'verification-failed':
      return 'BLOCKED — VERIFICATION REQUIRED';
    case 'interrogation-only':
    default:
      // Self-report only. HIGH findings stay "PROVISIONAL — verify
      // first"; clean self-report keeps the legacy "APPROVE WITH
      // CONDITIONS" guard rail (we never bare-APPROVE without
      // Surface 2 evidence).
      return args.hasHighFindings
        ? 'PROVISIONAL — VERIFY HIGH FINDINGS BEFORE APPROVAL'
        : 'APPROVE WITH CONDITIONS';
  }
}
