import type { AuditReport, DataQuality, QAPair, SystemAssessment } from './types.js';
import type { InterviewSession } from '../interview/interviewer.js';
import {
  analyzeTranscript,
  type AnalyzeFailureReason,
  type FullAnalysisResult,
} from '../analysis/analyzer.js';
import {
  computeRiskScore,
  applySeverityOverrides,
} from '../analysis/risk-scorer.js';
import { renderMarkdownReport, renderAnalysisFailedReport } from './templates.js';
import { computeVerdict } from '../verification/verdict.js';
import type { LLMClient } from '../llm/client.js';
import * as logger from '../util/logger.js';
import { isProvided } from '../util/provided.js';
import {
  mapFindingsToRiskCategories,
} from '../compliance/mapper.js';

export interface GenerateReportOptions {
  target: string;
  format: 'markdown' | 'json';
}

/**
 * Generates a complete audit report from an interview session.
 * Runs LLM analysis, computes risk score, and formats the output.
 */
export interface ReportResult {
  report: string;
  reportJson: AuditReport;
}

/** AAP-56: explicit failure-mode result surfaced when analyzeTranscript fails. */
export interface ReportFailureResult {
  ok: false;
  analysisError: {
    reason: AnalyzeFailureReason;
    message: string;
    responsePreview?: string;
    attemptCount: number;
    occurredAt: string;
  };
  /** Failure-mode markdown. No risk badge, no findings, no compliance, no recommendation. */
  report: string;
}

export interface ReportSuccessResult extends ReportResult {
  ok: true;
}

/** Discriminated union: success delivers AuditReport, failure delivers analysisError. */
export type ReportOutcome = ReportSuccessResult | ReportFailureResult;

/**
 * AAP-56: analyzer-aware variant of `generateReport`. Returns a discriminated
 * outcome so the caller can branch:
 *   - `{ ok: true, report, reportJson }`  → write report + report.json,
 *                                            status='complete'
 *   - `{ ok: false, analysisError, report }` → writeAnalysisFailure,
 *                                            status='analysis_failed'
 *
 * No fake-clean AuditReport is ever constructed on the failure path.
 */
export async function generateReportOutcome(
  session: InterviewSession,
  llmClient: LLMClient,
  options: GenerateReportOptions,
): Promise<ReportOutcome> {
  const outcome = await analyzeTranscript(llmClient, session.transcript, session.id);

  if (!outcome.ok) {
    const occurredAt = new Date().toISOString();
    const analysisError = {
      reason: outcome.reason,
      message: outcome.lastErrorMessage ?? 'Unknown analyzer failure',
      ...(outcome.lastResponsePreview !== undefined
        ? { responsePreview: outcome.lastResponsePreview }
        : {}),
      attemptCount: outcome.attemptCount,
      occurredAt,
    };
    const report = renderAnalysisFailedReport(session.transcript, {
      sessionId: session.id ?? 'unknown-session',
      questionsAsked: session.questionsAsked,
      ...(options.target ? { agentName: options.target } : {}),
      analysisError,
    });
    return { ok: false, analysisError, report };
  }

  const analysis = outcome.result;
  return {
    ok: true,
    ...(await buildSuccessReport(session, analysis, options)),
  };
}

async function buildSuccessReport(
  session: InterviewSession,
  analysis: FullAnalysisResult,
  options: GenerateReportOptions,
): Promise<ReportResult> {
  // 1b. AAP-43: apply deterministic severity floor to LLM-assigned risk labels
  analysis.risks = applySeverityOverrides(
    analysis.risks,
    analysis.systems,
    analysis.makesDecisionsAboutPeople,
  );

  // 2. Compute risk score from structured per-system data
  const riskScore = computeRiskScore(analysis.systems, analysis.risks);

  // AAP-102 — `calibrateOverallRiskLevel` removed. The rubric's honest
  // `riskScore.overall` flows straight through to the report. Posture
  // computed via FIPS 199 high-water-mark in `verdict.ts` is the new
  // anchor; `overallRiskLevel` remains as a legacy field consumed by
  // the unmodified display layer (G4 cleans up).
  const calibratedOverall = riskScore.overall;

  // 3. Compute structured compliance (AAP-31: CategorizedCompliance)
  const compliance = mapFindingsToRiskCategories({
    systems: analysis.systems,
    transcript: session.transcript,
    makesDecisionsAboutPeople: analysis.makesDecisionsAboutPeople,
    decisionMakingDetails: analysis.decisionMakingDetails,
  });

  // 4. Build report object
  const report: AuditReport = {
    summary: analysis.summary,
    agentPurpose: analysis.agentPurpose,
    agentTrigger: analysis.agentTrigger,
    agentOwner: analysis.agentOwner,
    systems: analysis.systems,
    dataNeeds: analysis.dataNeeds,
    accessAssessment: analysis.accessAssessment,
    risks: analysis.risks,
    recommendations: analysis.recommendations,
    recommendation: analysis.recommendation,
    overallRiskLevel: calibratedOverall,
    transcript: session.transcript,
    dataQuality: computeDataQualityFromTranscript(session.transcript, analysis.systems),
    makesDecisionsAboutPeople: analysis.makesDecisionsAboutPeople,
    decisionMakingDetails: analysis.decisionMakingDetails,
    compliance,
    // AAP-69: writer-side alias so the dashboard's ReportView (which reads
    // `json.regulatoryCompliance`) renders the CategorizedComplianceView
    // block. Markdown templates + CLI continue reading `compliance`.
    // Both keys carry the exact same StructuredCompliance payload.
    regulatoryCompliance: compliance,
    metadata: {
      date: session.startedAt.toISOString().split('T')[0],
      target: options.target,
      interviewDuration: session.completedAt.getTime() - session.startedAt.getTime(),
      questionsAsked: session.questionsAsked,
    },
    // AAP-79: every freshly-rendered report starts in 'interrogation-only'.
    // start_verification (or the dashboard scan route) flips this to
    // 'verified' / 'verification-failed' after the L1-L3 evidence reads
    // complete. Until then, the banner in markdown + dashboard tells the
    // operator (or the calling agent) that the verdict is self-report only.
    verification: {
      status: 'interrogation-only' as const,
      updatedAt: new Date().toISOString(),
    },
  };

  // 5. Compute the AAP-63 verdict from the Surface-1-only evidence
  //    available at generation time. Surface 2 (discovery / OAuth) has
  //    not run yet — the scan route re-renders the markdown after a
  //    discovery scan completes.
  // AAP-102 — `interviewTranscriptText` removed alongside discrepancy
  // detection. The verdict no longer scrapes the transcript for ±80-char
  // denial windows; SLF findings live in their own column and reviewer
  // spots mismatches by eye.
  const initialVerdict = computeVerdict({
    interviewFindings: analysis.risks,
  });

  // 6. Format output
  const formatted = options.format === 'json'
    ? JSON.stringify(report, null, 2)
    : renderMarkdownReport(report, { verdict: initialVerdict });

  return { report: formatted, reportJson: report };
}

/**
 * Backward-compatible success-path wrapper around `generateReportOutcome`.
 *
 * Existing callers (CLI batch report, integration tests) treat the analyzer
 * as throw-on-failure. Preserve that contract: on analyzer failure, throw an
 * `AnalysisFailedError` carrying the diagnostic envelope. Callers that need
 * the explicit-outcome semantics — the MCP `start_audit_session` path — use
 * `generateReportOutcome` directly.
 */
export async function generateReport(
  session: InterviewSession,
  llmClient: LLMClient,
  options: GenerateReportOptions,
): Promise<ReportResult> {
  const outcome = await generateReportOutcome(session, llmClient, options);
  if (!outcome.ok) {
    throw new AnalysisFailedError(outcome.analysisError, outcome.report);
  }
  return { report: outcome.report, reportJson: outcome.reportJson };
}

/**
 * Thrown by the legacy throw-on-failure `generateReport` wrapper when
 * `analyzeTranscript` returns a failure outcome. Carries the diagnostic
 * envelope and the rendered failure-mode markdown so callers that catch
 * this can persist both without re-running the analyzer.
 */
export class AnalysisFailedError extends Error {
  readonly analysisError: ReportFailureResult['analysisError'];
  readonly failureMarkdown: string;
  constructor(
    analysisError: ReportFailureResult['analysisError'],
    failureMarkdown: string,
  ) {
    super(`Analysis failed (${analysisError.reason}): ${analysisError.message}`);
    this.name = 'AnalysisFailedError';
    this.analysisError = analysisError;
    this.failureMarkdown = failureMarkdown;
  }
}

// AAP-31: computeRegulatoryFlags (legacy jurisdictional projection) removed.
// All compliance logic lives in src/compliance/{frameworks,control-mappings,mapper}.ts.
// generator.ts calls mapFindingsToRiskCategories() directly and stores the
// result in AuditReport.compliance (StructuredCompliance / CategorizedCompliance).

/** Compute data quality metrics from the interview transcript (CLI path) */
function computeDataQualityFromTranscript(
  transcript: QAPair[],
  systems?: SystemAssessment[],
): DataQuality {
  const totalQuestions = transcript.length;
  const repeatedAnswers = transcript.filter(qa => qa.answer.startsWith('[REPEATED RESPONSE]')).length;
  const greetingCount = transcript.filter(qa =>
    /^hi\b|^hello\b|ready to answer|ready for questions|^i am ready/i.test(qa.answer.trim())
  ).length;
  const uniqueAnswers = totalQuestions - repeatedAnswers - greetingCount;

  const nonRepeatedText = transcript
    .filter(qa => !qa.answer.startsWith('[REPEATED RESPONSE]'))
    .map(qa => qa.answer.toLowerCase())
    .join(' ');

  const fieldChecks: Record<string, RegExp> = {
    systemId: /\b(api|oauth|sdk|via|using|rest|webhook|token)\b/i,
    scopesRequested: /\b(scope|permission|role|\.readonly|\.send|\.modify|\.admin|\.edit|\.file|spreadsheets|drive)\b/i,
    dataSensitivity: /\b(pii|sensitive|confidential|financial|personal|classified|non.?sensitive|credentials?)\b/i,
    blastRadius: /\b(single.?record|single.?user|team|org.?wide|cross.?tenant|one record|one user|affected)\b/i,
    frequencyAndVolume: /\b(\d+\s*(times?|per|\/|calls?|runs?|operations?)\s*(day|hour|minute|week|session|run)|batch|\d+\/day)\b/i,
    writeOperations: /\b(write|create|update|append|send|modify|delete|insert|post)\b/i,
    reversibility: /\b(revers|rollback|undo|irrevers|cannot be undone|can be restored|can be undone)\b/i,
  };

  const fieldsProvided: string[] = [];
  const fieldsMissing: string[] = [];
  for (const [field, pattern] of Object.entries(fieldChecks)) {
    if (pattern.test(nonRepeatedText)) {
      fieldsProvided.push(field);
    } else {
      fieldsMissing.push(field);
    }
  }

  const fieldScore = (fieldsProvided.length / Object.keys(fieldChecks).length) * 100;
  const repeatPenalty = (repeatedAnswers / Math.max(totalQuestions, 1)) * 50;

  // AAP-43 P1 #6: penalize NOT_PROVIDED fields in the extracted systems.
  // Regex-only scoring showed 100/100 even when the Systems & Access table
  // was full of "NOT PROVIDED" because keywords existed in the transcript
  // but weren't captured by the LLM. 8 points per missing compliance field,
  // capped at 50.
  const notProvidedPenalty = systems ? computeNotProvidedPenalty(systems) : 0;

  const score = Math.max(0, Math.min(100, Math.round(fieldScore - repeatPenalty - notProvidedPenalty)));

  return { score, uniqueAnswers, totalQuestions, fieldsProvided, fieldsMissing, repeatedAnswers };
}

/**
 * Count extraction gaps in SystemAssessment data and convert to a quality
 * penalty. Each unprovided compliance field costs 8 points (capped at 50).
 */
function computeNotProvidedPenalty(systems: SystemAssessment[]): number {
  let gaps = 0;
  for (const s of systems) {
    if (!isProvided(s.dataSensitivity)) gaps++;
    if (!isProvided(s.frequencyAndVolume)) gaps++;
    if (s.scopesRequested.length === 0 || !s.scopesRequested.some(isProvided)) gaps++;
    for (const w of s.writeOperations) {
      if (!isProvided(w.volumePerDay)) gaps++;
    }
  }
  return Math.min(50, gaps * 8);
}
