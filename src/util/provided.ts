/**
 * Helpers for detecting and scrubbing the "NOT PROVIDED" sentinel used by
 * the analyzer when the LLM could not extract a field from the transcript.
 *
 * Two sources produce this sentinel:
 *   1. Zod `.default('NOT PROVIDED')` on fields the LLM returned as null/undefined
 *   2. The LLM itself returning the literal string "NOT PROVIDED"
 *
 * Either way it must not leak into customer-facing output as plain text —
 * reviewers (AAP-43) flagged this as the renderer "losing data between the
 * transcript and the summary table". Fields that are genuinely unknown should
 * be surfaced as an explicit "Unknown — ask deployer" marker instead.
 */

export const UNKNOWN_PLACEHOLDER = 'Unknown — ask deployer';

/**
 * Returns true if the value contains actual content (not missing, empty, or
 * one of the known "no data" sentinels).
 */
export function isProvided(value: string | null | undefined): value is string {
  if (value === null || value === undefined) return false;
  const trimmed = value.trim();
  if (trimmed === '') return false;
  const upper = trimmed.toUpperCase();
  if (upper === 'NOT PROVIDED') return false;
  if (upper === 'NOT_PROVIDED') return false;
  if (upper === 'N/A') return false;
  if (upper === 'UNKNOWN') return false;
  return true;
}

/**
 * Returns the input if it is provided, otherwise returns undefined.
 * Useful for post-processing LLM JSON output where "NOT PROVIDED" may appear
 * as a literal string even when the transcript contained the answer.
 */
export function scrubUnprovided(value: string | null | undefined): string | undefined {
  return isProvided(value) ? value.trim() : undefined;
}

/**
 * Render a string field for customer-facing output. If not provided, renders
 * the UNKNOWN_PLACEHOLDER so the reader sees an explicit prompt rather than
 * a silent gap or the leaked sentinel.
 */
export function renderFieldOrUnknown(value: string | null | undefined): string {
  return isProvided(value) ? value : UNKNOWN_PLACEHOLDER;
}

/**
 * Detect a "negative-content" string in a `scopesDelta`/excessive-permission
 * field — i.e. a value that describes a CONSTRAINT or absence rather than an
 * actual revokable scope.
 *
 * Reviewer feedback (2026-04-25): the LinkedIn ICP report rendered
 *   "Excessive (can be revoked):
 *     - read-only access to public LinkedIn profile data
 *     - No write access to LinkedIn
 *     - Scoped to profile scraping only"
 * — those are constraints the agent was describing as already-narrow, not
 * permissions to revoke. The LLM extracted them into `scopesDelta` because
 * the source question was "what could be safely removed?" and the agent
 * answered "nothing — I'm already scoped to X". We drop these post-hoc so
 * they never reach the customer-facing permissions-delta block.
 */
export function isNegativeScope(value: string): boolean {
  const t = value.trim().toLowerCase();
  if (t.length === 0) return true;
  // Leading negation keywords ("no write access", "none", "no permissions...")
  if (/^(no\b|none\b|nothing\b|n\/a\b|not\s+applicable\b)/.test(t)) return true;
  // Phrases that describe a positive constraint, not an excessive scope
  if (/\b(read.only|scoped\s+to|limited\s+to|restricted\s+to|bound(ed)?\s+to|only\s+(read|access)|cannot\b|does\s+not\s+(have|grant)|no\s+(write|delete|access|scope))/i.test(t)) return true;
  // Pure descriptive sentences: "the agent has no excessive permissions"
  if (/\b(no\s+excessive|no\s+unused|already\s+(narrow|minim)|least.privilege)/i.test(t)) return true;
  return false;
}
