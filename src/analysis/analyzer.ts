import type { LLMClient } from '../llm/client.js';
import { seedFromSessionId } from '../llm/client.js';
import type { QAPair, AccessAssessment, DataNeed, Risk, SystemAssessment } from '../report/types.js';
import { analysisResultSchema, type AnalysisResult, type Recommendation } from '../report/types.js';
import { ANALYSIS_SYSTEM_PROMPT, buildAnalysisPrompt } from '../llm/prompts.js';
import * as logger from '../util/logger.js';
import { scrubUnprovided } from '../util/provided.js';
import { isBusinessSystem } from '../util/systems.js';

// Extended result that includes both new per-system data and legacy flat fields
export interface FullAnalysisResult extends AnalysisResult {
  dataNeeds: DataNeed[];
  accessAssessment: AccessAssessment;
}

/**
 * Uses LLM to analyze the interview transcript and produce a structured audit.
 * Validates output with Zod schema. Retries once on parse failure.
 * Falls back to partial report on double failure.
 */
export async function analyzeTranscript(
  llmClient: LLMClient,
  transcript: QAPair[],
  sessionId?: string,
): Promise<FullAnalysisResult> {
  // Note: caller shows "⏳ Analyzing transcript..." already

  const prompt = buildAnalysisPrompt(transcript);
  const seed = sessionId ? seedFromSessionId(sessionId) : undefined;

  // Attempt 1
  let parsed = await tryParse(llmClient, prompt, seed);

  // Attempt 2 (retry) if first attempt failed
  if (!parsed) {
    logger.warn('First analysis attempt failed, retrying...');
    parsed = await tryParse(llmClient, prompt, seed);
  }

  // Double failure — partial report fallback
  if (!parsed) {
    logger.warn('Double parse failure, using partial report fallback');
    return buildFallbackAnalysis(transcript);
  }

  // Note: caller shows the final summary with computed risk level

  // Derive legacy flat fields from per-system data
  return enrichWithLegacyFields(parsed);
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

async function tryParse(
  llmClient: LLMClient,
  prompt: string,
  deterministicSeed?: number,
): Promise<AnalysisResult | null> {
  let response: string | undefined;
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
    // explicit "Unknown — ask deployer" marker instead of leaking the string.
    scrubNotProvidedInPlace(raw);

    // Zod validation — parse with defaults and coercion
    const result = analysisResultSchema.parse(raw);

    // AAP-43 P2 #8: drop scope-creep / excessive-access risks that reference
    // only internal/orchestration components (local filesystem, SQLite, env
    // vars, etc.). The prompt tells the LLM not to do this, but some models
    // still emit them — this is the belt-and-braces guarantee.
    const businessSystemIds = new Set(
      result.systems.filter(isBusinessSystem).map((s) => s.systemId.toLowerCase()),
    );
    result.risks = result.risks.filter((r) => !isRiskAboutOrchestrationOnly(r, businessSystemIds));

    return result;
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
    return null;
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

function buildFallbackAnalysis(transcript: QAPair[]): FullAnalysisResult {
  // Extract useful data directly from transcript
  const nonRepeated = transcript.filter(qa => !qa.answer.startsWith('[REPEATED RESPONSE]'));
  const purposeAnswers = nonRepeated
    .filter(qa => qa.category === 'purpose')
    .map(qa => qa.answer)
    .join(' ');
  const allAnswers = nonRepeated.map(qa => qa.answer).join(' ');

  // Try to build a useful summary from actual answers
  const summary = nonRepeated.length > 0
    ? `Automated analysis failed. The agent provided ${nonRepeated.length} substantive answers out of ${transcript.length} questions. Review the transcript below for details.`
    : 'Automated analysis failed and the agent did not provide substantive answers. Manual review required.';

  return {
    summary,
    agentPurpose: purposeAnswers.slice(0, 500) || 'Could not determine — see transcript',
    systems: [], // Don't show fake systems
    risks: [],
    recommendations: ['Automated analysis was unable to process the transcript. Review the interview answers manually.'],
    recommendation: 'APPROVE WITH CONDITIONS',
    overallRiskLevel: 'medium',
    dataNeeds: [],
    accessAssessment: {
      claimed: [],
      actuallyNeeded: [],
      excessive: [],
      missing: [],
    },
  };
}
