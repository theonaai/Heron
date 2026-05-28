import type { LLMClient } from '../llm/client.js';
import { seedFromSessionId } from '../llm/client.js';
import type { QAPair, AccessAssessment, DataNeed } from '../report/types.js';
import { analysisResultSchema, type AnalysisResult } from '../report/types.js';
import { ANALYSIS_SYSTEM_PROMPT, buildAnalysisPrompt } from '../llm/prompts.js';
import * as logger from '../util/logger.js';
import { scrubUnprovided, isNegativeScope } from '../util/provided.js';
import { sanitizeAnalyzerOutput } from './sanitize.js';

// Extended result that includes both new per-system data and legacy flat fields
export interface FullAnalysisResult extends AnalysisResult {
  dataNeeds: DataNeed[];
  accessAssessment: AccessAssessment;
}

/**
 * Reason the analyzer returned a failure outcome.
 *
 * - `parse_failure`  — the LLM responded, but the body failed JSON.parse or
 *                      Zod validation on both attempts (e.g. truncated JSON,
 *                      schema drift, prose preface the regex couldn't strip).
 * - `llm_unreachable`— `llmClient.chat` itself threw on both attempts
 *                      (network / 502 / timeout / aborted gateway).
 * - `unknown`        — defensive fallback. Should not happen in practice.
 */
export type AnalyzeFailureReason = 'parse_failure' | 'llm_unreachable' | 'unknown';

/**
 * Result of `analyzeTranscript`.
 *
 * AAP-56: previously this function always returned `FullAnalysisResult` and
 * silently fabricated a clean-looking fallback on double failure (LOW risk,
 * "APPROVE WITH CONDITIONS", empty risks, empty systems). That misled
 * reviewers into mistaking a broken LLM gateway for a clean audit. Heron
 * strategy v3.0 — no self-attestation without verification — requires the
 * analyzer to fail loudly. The caller is now responsible for surfacing the
 * failure (red banner, `status: 'analysis_failed'`).
 */
export type AnalyzeOutcome =
  | { ok: true; result: FullAnalysisResult }
  | {
      ok: false;
      reason: AnalyzeFailureReason;
      /** Last error message captured across both attempts. */
      lastErrorMessage?: string;
      /** Bounded preview (≤400 chars) of the raw LLM response, when one was received. */
      lastResponsePreview?: string;
      /** Number of attempts the analyzer made before giving up. Always 2 on failure today. */
      attemptCount: number;
    };

/**
 * Uses LLM to analyze the interview transcript and produce a structured audit.
 *
 * Returns an `AnalyzeOutcome`:
 *   - On success: `{ ok: true, result }` — caller renders the normal report.
 *   - On failure: `{ ok: false, reason, ... }` — caller renders the
 *     analysis-failed report and flips the session status. No "best-effort"
 *     fake-clean result is ever produced (AAP-56).
 *
 * Retries once on first attempt failure. Distinguishes between LLM-throw
 * (network) and parse/validation errors via per-attempt failure kind.
 */
export async function analyzeTranscript(
  llmClient: LLMClient,
  transcript: QAPair[],
  sessionId?: string,
): Promise<AnalyzeOutcome> {
  // Note: caller shows "⏳ Analyzing transcript..." already

  const prompt = buildAnalysisPrompt(transcript);
  const seed = sessionId ? seedFromSessionId(sessionId) : undefined;

  // Attempt 1
  let attempt = await tryParse(llmClient, prompt, seed);

  // Attempt 2 (retry) if first attempt failed
  if (!attempt.ok) {
    logger.warn('First analysis attempt failed, retrying...');
    attempt = await tryParse(llmClient, prompt, seed);
  }

  // Double failure — surface as explicit AnalyzeOutcome failure. Do NOT
  // fabricate a clean-looking report (AAP-56).
  if (!attempt.ok) {
    logger.warn(
      `Analysis failed after 2 attempts (kind=${attempt.failureKind}): ${attempt.errorMessage}`,
    );
    const reason: AnalyzeFailureReason =
      attempt.failureKind === 'llm_throw' ? 'llm_unreachable' : 'parse_failure';
    const out: AnalyzeOutcome = {
      ok: false,
      reason,
      lastErrorMessage: attempt.errorMessage,
      attemptCount: 2,
    };
    if (attempt.responsePreview !== undefined) {
      out.lastResponsePreview = attempt.responsePreview;
    }
    return out;
  }

  // Note: caller shows the final summary with computed risk level

  // Derive legacy flat fields from per-system data
  return { ok: true, result: enrichWithLegacyFields(attempt.result) };
}

const ORCHESTRATION_ONLY_PATTERN =
  /\b(local\s*(filesystem|file.?system|disk|storage|log|sqlite|database|db|cache|store)|\.env\b|env(ironment)?\s*(var|variable|file)|idempotency|secrets?\s*manager)\b/i;

const SCOPE_CREEP_RISK_PATTERN = /\b(scope|permission|oauth|excessive|over.?priv|least.?privilege|access.?control)/i;

/**
 * Return true when a risk is scoped only to orchestration components
 * (e.g. "Local filesystem log has excessive scope") and mentions no real
 * business system. Used to drop "template pollution" risks.
 */
function isRiskAboutOrchestrationOnly(
  risk: { title: string; description: string },
  businessSystemIds: Set<string>,
): boolean {
  const text = `${risk.title} ${risk.description}`.toLowerCase();
  const mentionsOrchestration = ORCHESTRATION_ONLY_PATTERN.test(text);
  if (!mentionsOrchestration) return false;
  const mentionsBusinessSystem = Array.from(businessSystemIds).some((id) =>
    id.length > 3 && text.includes(id),
  );
  if (mentionsBusinessSystem) return false;
  // Only drop scope-creep/access risks; keep e.g. secrets-handling recommendations
  return SCOPE_CREEP_RISK_PATTERN.test(text);
}

/**
 * Recursively walk a parsed JSON object and normalize any "NOT PROVIDED"-style
 * string values to `undefined`. Leaves other types untouched. Mutates in place.
 *
 * For arrays of strings (e.g. `systems[].scopesRequested`) the scrubbed
 * elements are *removed* (compacted), not left as `undefined` in place — Zod
 * rejects `[undefined]` against `z.array(z.string())` even when the array
 * itself has a `.default([])`. Compacting `["NOT PROVIDED"]` → `[]` lets the
 * default fire correctly.
 *
 * AAP-43 post-merge fix (2026-04-25): the original implementation set
 * `value[i] = undefined`, which produced the regression observed on copy-
 * prod — Zod parse failed with `invalid_type expected string received
 * undefined` and the analyzer fell back to "Automated analysis failed".
 */
function scrubNotProvidedInPlace(value: unknown): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      if (typeof item === 'string') {
        if (scrubUnprovided(item) === undefined) value[i] = undefined;
      } else if (item && typeof item === 'object') {
        scrubNotProvidedInPlace(item);
      }
    }
    // Compact: drop `undefined` entries we just produced from scrubbed
    // strings. Walk back-to-front so splicing doesn't shift unvisited
    // indices. We never produce `undefined` from object recursion, only
    // from string scrub, so this only affects string arrays.
    for (let i = value.length - 1; i >= 0; i--) {
      if (value[i] === undefined) value.splice(i, 1);
    }
    return;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (typeof v === 'string') {
        if (scrubUnprovided(v) === undefined) obj[key] = undefined;
      } else if (v && typeof v === 'object') {
        scrubNotProvidedInPlace(v);
      }
    }
  }
}

type TryParseResult =
  | { ok: true; result: AnalysisResult }
  | { ok: false; failureKind: 'llm_throw' | 'parse_error'; errorMessage: string; responsePreview?: string };

async function tryParse(
  llmClient: LLMClient,
  prompt: string,
  deterministicSeed?: number,
): Promise<TryParseResult> {
  let response: string | undefined;
  let stage: 'llm' | 'parse' = 'llm';
  try {
    // AAP-43 regression fix (2026-04-24): request JSON-mode so OpenAI and
    // Gemini return a syntactically-valid JSON payload instead of a free-form
    // string that sometimes truncates or emits prose before the `{`. This
    // combined with the provider-side `max_tokens` bump in client.ts resolves
    // the "Automated analysis failed" fallback observed on 18-question
    // transcripts in the copy-prod deploy.
    response = await llmClient.chat(ANALYSIS_SYSTEM_PROMPT, prompt, {
      deterministicSeed,
      jsonMode: true,
    });

    // From this point on, any throw is a parse / Zod problem rather than an
    // LLM-unreachable problem — we got a response, we just couldn't make
    // sense of it.
    stage = 'parse';

    // Strip markdown fences if present
    let jsonStr = response.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    // Try to extract JSON if mixed with text
    if (!jsonStr.startsWith('{')) {
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }
    }

    const raw = JSON.parse(jsonStr);

    // AAP-43 P0 #2: scrub "NOT PROVIDED" sentinel from LLM output before Zod
    // default substitution. This distinguishes "LLM explicitly wrote NOT
    // PROVIDED" from "field was absent" — both are normalized to undefined so
    // Zod's .default() applies uniformly and the renderer can surface an
    // explicit "Unknown — ask deployer" placeholder instead of leaking the
    // string.
    scrubNotProvidedInPlace(raw);

    // AAP-65: reshape LLM output to fit the tightened schema:
    //   - prose-shaped `systemId` → short kebab-case + `systemDescription`
    //   - `scopesDelta` lead-ins stripped ("Unused in this audit task so far:")
    //   - inline source refs `(A3, A4)` pulled out into `sources[]`
    //   - `frequencyAndVolume` prose → structured `frequency` object
    //   - near-duplicate risks merged
    // This runs BEFORE Zod parse so the schema's `.max()` + `.regex()`
    // constraints see clean input instead of failing on LLM prose.
    sanitizeAnalyzerOutput(raw);

    // Zod validation — parse with defaults and coercion
    const result = analysisResultSchema.parse(raw);

    // AAP-102 — recommendations[] is no longer LLM-generated. Strategy v3.0
    // violation: the prior 20-entry advisory array was generic LLM output
    // ("improve risk management posture"). The schema field stays for back-
    // compat with the report JSON contract, but the value is always [].
    // The prompt still asks the LLM for recommendations (G4 will rewrite
    // the prompt to drop them); we discard whatever it returns here.
    result.recommendations = [];

    // AAP-43 P2 #8: drop scope-creep / excessive-access risks that reference
    // only internal/orchestration components (local filesystem, SQLite, env
    // vars, etc.). The prompt tells the LLM not to do this, but some models
    // still emit them — this is the belt-and-braces guarantee.
    // AAP-102: per-system categorisation removed; treat every system as a
    // business system for the orchestration-only filter. The
    // `ORCHESTRATION_ONLY_PATTERN` already keys off vocabulary in the risk
    // text, not the system category — the previous `isBusinessSystem`
    // filter only narrowed which systemIds we cross-checked against. With
    // categorisation gone, we cross-check against every declared systemId.
    const declaredSystemIds = new Set(
      result.systems.map((s) => s.systemId.toLowerCase()),
    );
    result.risks = result.risks.filter((r) => !isRiskAboutOrchestrationOnly(r, declaredSystemIds));

    // AAP-102 — stamp evidenceSource = 'SLF' on every LLM-derived risk.
    // The analyzer reads the interview transcript only; every finding it
    // mints is by definition self-attested. Verified findings come from
    // typed detectors (router-adapter / discovery-detectors) which stamp
    // MCP / OAU / ENV / PLG themselves.
    result.risks = result.risks.map((r) => ({ ...r, evidenceSource: 'SLF' as const }));

    // Reviewer-feedback fix (2026-04-25): drop "negative" content from
    // scopesDelta (and scopesNeeded) where the LLM put a constraint
    // ("read-only access", "scoped to profile scraping", "no write access")
    // instead of an actual revokable permission. Without this filter the
    // Permissions Delta block in the report ends up listing those constraints
    // under "Excessive (can be revoked):" — auditor-hostile inversion.
    for (const sys of result.systems) {
      sys.scopesDelta = sys.scopesDelta.filter((s) => !isNegativeScope(s));
      sys.scopesNeeded = sys.scopesNeeded.filter((s) => !isNegativeScope(s));
      // AAP-97 — a scope cannot logically be both NEEDED and EXCESSIVE.
      // The analyzer LLM occasionally emits the same string in both
      // `scopesNeeded` and `scopesDelta` (e.g. for `google-drive` it put
      // `https://www.googleapis.com/auth/drive` in both, producing a
      // self-contradicting "you need this AND can revoke this" pair in
      // the Systems table). Strip the overlap by post-processing
      // `scopesDelta` against `scopesNeeded`. This runs after the
      // negative-scope filter so neither stage leaks into the other.
      const neededSet = new Set(sys.scopesNeeded);
      sys.scopesDelta = sys.scopesDelta.filter((s) => !neededSet.has(s));
    }

    return { ok: true, result };
  } catch (e) {
    // AAP-43 regression fix (2026-04-24): log a bounded preview of the raw
    // LLM response so the next operator can tell truncation apart from
    // schema mismatch. Previously the warn line only carried the exception
    // message, which leaves the "Automated analysis failed" report without
    // a diagnostic trail.
    const errMsg = e instanceof Error ? e.message : String(e);
    const preview = response === undefined
      ? '(no response — LLM call threw)'
      : `${response.slice(0, 400)}${response.length > 400 ? `…[+${response.length - 400} chars]` : ''}`;
    logger.warn(`Parse attempt failed: ${errMsg} | response preview: ${preview}`);
    // AAP-56: split the failure kind so the caller can surface
    // "LLM unreachable" vs "parse failure" distinctly in the failure-mode
    // report. `stage === 'llm'` means llmClient.chat itself threw before
    // we ever had a response to parse.
    const out: TryParseResult = {
      ok: false,
      failureKind: stage === 'llm' ? 'llm_throw' : 'parse_error',
      errorMessage: errMsg,
    };
    if (response !== undefined) {
      out.responsePreview = preview;
    }
    return out;
  }
}

/**
 * Derive legacy flat AccessAssessment and DataNeed[] from per-system data.
 * This keeps backward compatibility with report templates and risk scorer.
 */
function enrichWithLegacyFields(parsed: AnalysisResult): FullAnalysisResult {
  const dataNeeds: DataNeed[] = [];
  const claimed: { resource: string; accessLevel: string; justification: string }[] = [];
  const actuallyNeeded: typeof claimed = [];
  const excessive: typeof claimed = [];
  const missing: typeof claimed = [];

  for (const sys of parsed.systems) {
    // DataNeeds from dataSensitivity
    dataNeeds.push({
      dataType: sys.dataSensitivity,
      system: sys.systemId,
      justification: sys.frequencyAndVolume,
    });

    // Claimed access
    for (const scope of sys.scopesRequested) {
      claimed.push({
        resource: sys.systemId,
        accessLevel: scope,
        justification: 'Requested by agent',
      });
    }

    // Actually needed
    for (const scope of sys.scopesNeeded) {
      actuallyNeeded.push({
        resource: sys.systemId,
        accessLevel: scope,
        justification: 'Minimum needed for stated tasks',
      });
    }

    // Excessive (delta)
    for (const scope of sys.scopesDelta) {
      excessive.push({
        resource: sys.systemId,
        accessLevel: scope,
        justification: 'Not needed for stated tasks',
      });
    }
  }

  return {
    ...parsed,
    dataNeeds,
    accessAssessment: { claimed, actuallyNeeded, excessive, missing },
  };
}

// AAP-56: `buildFallbackAnalysis` was DELETED. It used to fabricate a
// clean-looking FullAnalysisResult (`overallRiskLevel: 'medium'`,
// `recommendation: 'APPROVE WITH CONDITIONS'`, empty findings) when both
// LLM analysis attempts failed. That produced misleading reports where a
// 502 from the LLM gateway rendered identically to a clean audit. The
// transcript is preserved verbatim in `transcript.jsonl`; the failure
// outcome is now surfaced via `AnalyzeOutcome { ok: false }` and the
// caller emits a dedicated `renderAnalysisFailedReport` instead.
