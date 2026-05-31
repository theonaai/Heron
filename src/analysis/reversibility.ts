/**
 * AAP-109: reversibility normalization for write operations.
 *
 * The interview analyzer asks agents whether each write is reversible. Agents
 * frequently answer with nuance: "Partly reversible manually/API; the script
 * does not implement rollback", "no automatic rollback", "publications are not
 * fully reversible", "no transaction or bulk rollback workflow". The LLM
 * extraction step tended to round these up to `reversible: true`, which erased
 * the irreversibility signal that the risk model depends on
 * (risk-scorer.ts: `!write.reversible` adds +30 to the write-risk component and
 * drives `hasIrreversibleWrites`).
 *
 * This module provides a small, pure, deterministic pass that runs over the
 * structured `writeOperations[]` BEFORE Zod validation. It downgrades
 * `reversible` to `false` whenever the operation's own text says the write is
 * only partly reversible or lacks an automatic/bulk rollback, and it preserves
 * the original phrasing in `reversibilityNote` so reviewers keep the nuance. A
 * genuinely fully-reversible write (no partial/no-rollback wording) is left
 * untouched.
 *
 * Why a boolean + note, not a tri-state: every consumer of this field — the
 * rubric scorer, the `hasIrreversibleWrites` severity floor, the compliance
 * mapper, the dashboard IRREVERSIBLE chip and the markdown report — treats
 * reversibility as binary via `!reversible`. For blast-radius purposes a write
 * with no rollback is simply not safely reversible, so "partial" belongs on the
 * `false` side. Keeping the boolean and adding a free-text note is the minimal
 * change that stops the data loss without churning ~10 call sites.
 */

/** Phrases that indicate a write is NOT fully reversible. */
const NOT_FULLY_REVERSIBLE_PATTERNS: RegExp[] = [
  /\bpartly\s+reversible\b/i,
  /\bpartial(?:ly)?\s+revers/i,
  /\bnot\s+(?:fully|always|automatically|easily|readily)\s+reversible\b/i,
  /\bnot\s+reversible\b/i,
  /\birreversible\b/i,
  /\bno\s+(?:automatic|auto|bulk|transactional|transaction|built-?in|programmatic)\s+roll\s?back\b/i,
  /\bno\s+roll\s?back\b/i,
  /\bwithout\s+roll\s?back\b/i,
  /\b(?:lacks?|missing|does\s+not\s+(?:have|implement|support)|doesn'?t\s+(?:have|implement|support))\b[^.]*\broll\s?back\b/i,
  /\bcannot\s+be\s+(?:undone|rolled\s?back|reverted)\b/i,
  /\bno\s+(?:transaction|bulk)\b[^.]*\broll\s?back\b/i,
];

/**
 * The free-text fields on a write operation that may carry the agent's
 * reversibility phrasing. We scan all of them because the LLM is inconsistent
 * about where it puts the nuance (operation description, an explicit note, or
 * the volume blurb).
 */
function reversibilityText(write: Record<string, unknown>): string {
  const parts = [
    write.reversibilityNote,
    write.operation,
    write.target,
    write.volumePerDay,
    write.notes,
  ];
  return parts.filter((p): p is string => typeof p === 'string').join(' — ');
}

/** True when the text asserts the write is not fully reversible / has no rollback. */
export function indicatesNotFullyReversible(text: string | null | undefined): boolean {
  if (!text) return false;
  return NOT_FULLY_REVERSIBLE_PATTERNS.some((re) => re.test(text));
}

/**
 * Pick a human-readable note describing why the write was downgraded. Prefers
 * the field that actually carried the partial/no-rollback signal.
 */
function firstMatchingPhrase(write: Record<string, unknown>): string | undefined {
  for (const field of ['reversibilityNote', 'operation', 'volumePerDay', 'notes', 'target'] as const) {
    const value = write[field];
    if (typeof value === 'string' && indicatesNotFullyReversible(value)) {
      return value;
    }
  }
  return undefined;
}

/**
 * Normalize a single write operation's reversibility. Returns a new object;
 * never mutates the input.
 *
 * Rules:
 *  - If any text field signals partial / no-rollback -> `reversible: false`,
 *    and capture the phrasing into `reversibilityNote` (if not already set).
 *  - Otherwise leave the write as-is (schema default handles a missing flag).
 */
export function normalizeWriteReversibility<T extends Record<string, unknown>>(write: T): T {
  if (!write || typeof write !== 'object') return write;

  const text = reversibilityText(write);
  if (!indicatesNotFullyReversible(text)) {
    return write;
  }

  const existingNote =
    typeof write.reversibilityNote === 'string' && write.reversibilityNote.trim().length > 0
      ? write.reversibilityNote
      : firstMatchingPhrase(write);

  return {
    ...write,
    reversible: false,
    ...(existingNote ? { reversibilityNote: existingNote } : {}),
  };
}

/**
 * Normalize reversibility across an entire structured analysis payload, in a
 * place-free fashion. Tolerant of malformed input (returns it unchanged) since
 * it runs before schema validation.
 */
export function normalizeReversibilityInPayload<T extends Record<string, any>>(payload: T): T {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.systems)) {
    return payload;
  }

  const systems = payload.systems.map((sys: any) => {
    if (!sys || typeof sys !== 'object' || !Array.isArray(sys.writeOperations)) {
      return sys;
    }
    return {
      ...sys,
      writeOperations: sys.writeOperations.map((w: any) => normalizeWriteReversibility(w)),
    };
  });

  return { ...payload, systems };
}
