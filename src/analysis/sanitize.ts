/**
 * AAP-65 — post-LLM sanitization pass.
 * AAP-87 — Phase A decomposition: orchestration split into eight purpose-
 * named helpers with explicit ordering. ZERO behavior change vs the
 * pre-decomposition implementation (locked down by
 * `tests/analysis/sanitizer-golden.test.ts`).
 *
 * The LLM's analyzer output frequently violates the tightened
 * `analysisResultSchema` shape (e.g. it dumps a 297-character sentence into
 * `systemId`, prefixes each `scopesDelta` entry with "Unused in this audit
 * task so far:", or emits `frequencyAndVolume` as a wall-of-text paragraph
 * instead of structured fields).
 *
 * Two reasons to reshape rather than reject:
 *
 *   1. Re-prompting the LLM is expensive and not always deterministic.
 *   2. Old session files on disk (pre-AAP-65) still need to load — the
 *      report viewer cannot break on historical data.
 *
 * This module is invoked from `analyzer.tryParse` between `JSON.parse` and
 * `analysisResultSchema.parse`. It walks the parsed object in place and
 * normalizes:
 *
 *   - systemId → short kebab-case identifier (long prose → systemDescription)
 *   - scopesDelta entries → bare permission tokens (strip "Unused in this..." lead-ins)
 *   - sources → pulled out of inline `(A3, A4)` markers across all string fields
 *   - frequencyAndVolume prose → structured `frequency` object
 *   - risks[] near-duplicates → merged into one with higher severity
 *
 * # AAP-87 — per-rule audit matrix (4-bucket classification)
 *
 * Each rule below is classified into one of four buckets. The bucket
 * determines whether the rule belongs here long-term (Phase B / AAP-90
 * leaves it alone) or is a candidate for migration to prompt /
 * structured-output enforcement (Phase B / AAP-90 targets it).
 *
 * | # | Rule                                             | Helper                  | Bucket                       |
 * |---|--------------------------------------------------|-------------------------|------------------------------|
 * | 1 | inline `(A3, A4)` source-ref extraction          | sanitizeSystemSources   | semantic normalization       |
 * | 2 | writeOperations field truncation (80/80/40)      | sanitizeWriteOperations | schema enforcement           |
 * | 3 | writeOperations trailing-punct cleanup           | sanitizeWriteOperations | semantic normalization       |
 * | 4 | systemId prose → kebab-case slug                 | sanitizeSystemIdentity  | semantic normalization       |
 * | 5 | systemDescription spill from long prose systemId | sanitizeSystemIdentity  | legacy compatibility         |
 * | 6 | scope-array lead-in stripping ("Unused in...")   | sanitizeScopeArrays     | semantic normalization       |
 * | 7 | scope-array per-entry 80-char truncation         | sanitizeScopeArrays     | schema enforcement           |
 * | 8 | scope-array empty-string compaction              | sanitizeScopeArrays     | schema enforcement           |
 * | 9 | frequencyAndVolume prose → structured frequency  | backfillFrequency       | model-quality compensation* + legacy compatibility† |
 * |10 | malformed-risk filtering (null / no title)       | sanitizeRisks           | schema enforcement           |
 * |11 | near-duplicate risk merging                      | sanitizeRisks           | model-quality compensation*  |
 * |12 | recommendations cap (≤ 20 entries)               | sanitizeRecommendations | schema enforcement           |
 * |13 | recommendations per-entry truncation (≤ 400)     | sanitizeRecommendations | schema enforcement           |
 * |14 | top-level prose caps (summary/purpose/…)         | sanitizeTopLevelText    | schema enforcement           |
 *
 * Buckets:
 *
 *   - **schema enforcement**       — caps, enums, parseability. Stays as
 *     post-processing forever; low migration value. Deterministic, cheap.
 *   - **legacy compatibility**     — supports pre-AAP-65 persisted data on
 *     disk. Stays; removing it breaks already-saved sessions.
 *   - **semantic normalization**   — deterministic transformations (system
 *     IDs, scope lead-ins, source refs). Stays; the prompt cannot guarantee
 *     these shapes byte-for-byte across providers.
 *   - **model-quality compensation** — Phase B (AAP-90) candidates only.
 *     Rules marked with `*` above patch LLM behavior the prompt or
 *     structured-output schema *should* constrain.
 *
 *   † Rule 9 is dual-bucket: primary classification is model-quality
 *     compensation (counted in that total), but it ALSO carries a legacy
 *     compatibility load — `frequencyAndVolume` is the pre-AAP-65 on-disk
 *     shape (see `src/report/types.ts` lines 68-72, 103-106), so even if
 *     Phase B (AAP-90) constrains NEW LLM outputs to emit `frequency`
 *     directly, the `backfillFrequency` helper STAYS to load pre-AAP-65
 *     sessions from disk. Phase B target for rule 9 is "stop new LLM
 *     outputs needing this", not "delete the helper".
 *
 * # Bucket totals
 *
 *   - schema enforcement: 7 rules (2, 7, 8, 10, 12, 13, 14)
 *   - semantic normalization: 4 rules (1, 3, 4, 6)
 *   - legacy compatibility: 1 rule (5); rule 9 is dual-bucket (see † above)
 *   - model-quality compensation (Phase B / AAP-90 targets): 2 rules (9, 11)
 *
 * Total unique rules: 14. Rule 9 is counted once (under model-quality
 * compensation, its primary bucket) but is cross-referenced from legacy
 * compatibility via the † footnote.
 *
 * # Phase B candidates (for migration to prompt / structured output)
 *
 *   - **Rule 9** — `frequencyAndVolume` prose-parse → structured `frequency`.
 *     Phase B target: stop NEW LLM outputs needing this (prompt /
 *     structured-output schema requires `frequency` directly). Helper STAYS
 *     for legacy pre-AAP-65 session input loaded from disk.
 *   - **Rule 11** — near-duplicate risk merge. Phase B target: removable IF
 *     structured-output / prompt evals prove stable dedup across providers
 *     (no cross-provider regressions on the risk-dedup corpus). Until then
 *     the helper STAYS.
 *
 * # Ordering
 *
 * Ordering matters and is asserted by
 * `tests/analysis/sanitize-ordering.test.ts`. In particular:
 *
 *   1. `sanitizeSystemSources` MUST run first. It walks every string field
 *      on every system and pulls inline `(A3, A4)` refs into a
 *      sibling `sources[]` array. If it ran after `sanitizeSystemIdentity`
 *      the refs would already have been baked into a slug; if it ran after
 *      `backfillFrequency` the refs would already have been embedded in
 *      `frequency.notes`.
 *   2. `sanitizeWriteOperations` runs after step 1 so the truncation logic
 *      operates on already-deref'd strings.
 *   3. `sanitizeSystemIdentity` runs after step 1 for the same reason.
 *   4. `sanitizeScopeArrays` runs after step 1 so the trailing `(A11).`
 *      pattern has already been stripped from array entries — the lead-in
 *      regex stack then operates on clean tokens.
 *   5. `backfillFrequency` runs after step 1 so the parsed `notes` field
 *      no longer contains inline refs.
 *   6. `sanitizeRisks` runs at the top level (not per-system) and is
 *      independent of steps 1–5.
 *   7. `sanitizeRecommendations` runs at the top level, independent.
 *   8. `sanitizeTopLevelText` runs LAST so the cap operates on whatever
 *      shape the previous helpers produced.
 *
 * # Invariants the implementer MUST NOT touch (AAP-65 load-bearing)
 *
 *   - `sanitizeAnalyzerOutput` runs BEFORE Zod parse, mutates the input
 *     object IN PLACE. Each helper preserves this — none of them return
 *     new objects.
 *   - The shape must support pre-AAP-65 sessions on disk (the report
 *     viewer cannot break on historical data).
 */

import { isProvided } from '../util/provided.js';

const MAX_SYSTEM_ID_LEN = 50;
const SYSTEM_ID_REGEX = /^[a-z][a-z0-9_-]*$/;
const SOURCE_REF_REGEX = /\(\s*((?:A\d+\s*,\s*)*A\d+)\s*\)/g;
const SOURCE_REF_BARE_REGEX = /\bA\d+\b/g;

const SCOPE_LEAD_IN_REGEXES: RegExp[] = [
  // "Unused in this audit task so far:" / "Unused in this task so far:"
  /^\s*Unused in this(?:\s+(?:audit\s+task|task))?\s+so\s+far\s*:?\s*/i,
  // "Unused in this audit task:" / "Unused in this task:" / "Unused audit task:"
  /^\s*Unused (?:in this )?(?:audit )?task(?:\s+so\s+far)?\s*:?\s*/i,
];

/**
 * Convert a free-form prose label into a short kebab-case identifier.
 *
 * Strategy: take the first " -> " / " → " segment or first sentence, then
 * lowercase, collapse non-alphanumerics to "-", cap at 50 chars.
 *
 * Examples (from real session data):
 *   "Codex desktop app local agent session -> OpenAI-hosted Codex/ChatGPT
 *    backend for model inference; …(A3, A4)."
 *     → "codex-desktop-app-local-agent-session"
 *   "Google Workspace, Gmail API via OAuth2"
 *     → "google-workspace-gmail"
 */
export function toShortSystemId(prose: string): string {
  // Strip source refs first so they don't bleed into the slug.
  let head = prose.replace(SOURCE_REF_REGEX, ' ');
  // Take the first arrow segment if any.
  const arrowIdx = head.search(/\s*(?:->|→)\s*/);
  if (arrowIdx > 0) head = head.slice(0, arrowIdx);
  // Take first sentence if any (period followed by space or end).
  const sentenceMatch = head.match(/^[^.;]+/);
  if (sentenceMatch) head = sentenceMatch[0];
  // Take first comma-clause to keep it tight.
  const commaIdx = head.indexOf(',');
  if (commaIdx > 0) head = head.slice(0, commaIdx);

  const slug = head
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Ensure the slug starts with a letter (the Zod regex requires this).
  let final = slug.replace(/^[^a-z]+/, '');
  if (final.length === 0) final = 'system';
  if (final.length > MAX_SYSTEM_ID_LEN) final = final.slice(0, MAX_SYSTEM_ID_LEN).replace(/-+$/, '');
  return final;
}

/**
 * Strip the "Unused in this audit task so far:" / "Unused in this task:"
 * prefix from a single scope-delta string. Returns the cleaned token.
 *
 * Extends the AAP-62 round-3 regex stack — same patterns, lifted out of the
 * markdown renderer and React dashboard so the analyzer fixes the shape
 * once instead of every consumer paying for it.
 */
export function stripScopeLeadIn(raw: string): string {
  let s = raw;
  for (const pattern of SCOPE_LEAD_IN_REGEXES) {
    s = s.replace(pattern, '');
  }
  // Also strip trailing source refs like " (A11)." that don't belong in a
  // permission token. We do this even though `extractInlineSourceRefs` runs
  // first — defensive, so a direct caller still gets a clean token.
  s = s.replace(/\s*\(A\d+\)\s*\.?\s*$/i, '');
  // Drop orphan trailing punctuation left by the upstream extraction.
  s = s.replace(/\s*[.,;]+\s*$/, '');
  return s.trim();
}

/**
 * Recursively walk an object/array and pull inline `(A1, A2, ...)` source
 * refs out of every string field into a sibling top-level `sources` array
 * on the containing object. Mutates in place.
 *
 * Only operates on objects that ALREADY have a `sources` array slot (or
 * accept one) — we add refs to a top-level `sources` if the object looks
 * like a SystemAssessment.
 */
export function extractInlineSourceRefs(obj: Record<string, unknown>): void {
  if (!obj || typeof obj !== 'object') return;

  // Walk every string-valued field and collect refs.
  const collected = new Set<string>();
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      // Match parenthesized groups first (cheapest signal that refs are
      // intentional). Bare "A3" mentions inside narrative prose are left
      // in place to avoid false positives like "GA3" or "A3-04".
      let cleaned = value;
      const matches = value.matchAll(SOURCE_REF_REGEX);
      let hadMatch = false;
      for (const m of matches) {
        hadMatch = true;
        const inner = m[1] ?? '';
        for (const ref of inner.split(/\s*,\s*/)) {
          const trimmed = ref.trim();
          if (/^A\d+$/.test(trimmed)) collected.add(trimmed);
        }
      }
      if (hadMatch) {
        cleaned = value.replace(SOURCE_REF_REGEX, '').replace(/\s+/g, ' ').replace(/\s*\.\s*$/, '.').trim();
        (obj as Record<string, unknown>)[key] = cleaned;
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (typeof item === 'string') {
          let cleaned = item;
          let hadMatch = false;
          for (const m of item.matchAll(SOURCE_REF_REGEX)) {
            hadMatch = true;
            const inner = m[1] ?? '';
            for (const ref of inner.split(/\s*,\s*/)) {
              const trimmed = ref.trim();
              if (/^A\d+$/.test(trimmed)) collected.add(trimmed);
            }
          }
          // Also strip a trailing bare "(A11)." pattern
          const trailingBare = item.match(/\s*\(A\d+\)\s*\.?\s*$/);
          if (trailingBare) {
            hadMatch = true;
            const inner = trailingBare[0].match(SOURCE_REF_BARE_REGEX);
            if (inner) for (const r of inner) collected.add(r);
          }
          if (hadMatch) {
            cleaned = item
              .replace(SOURCE_REF_REGEX, '')
              .replace(/\s*\(A\d+\)\s*\.?\s*$/i, '')
              .replace(/\s+/g, ' ')
              // Drop any orphan trailing punctuation left after stripping
              // the parenthesised ref (e.g. "shell-exec ." → "shell-exec").
              .replace(/\s*[.,;]+\s*$/, '')
              .trim();
            value[i] = cleaned;
          }
        } else if (item && typeof item === 'object') {
          extractInlineSourceRefs(item as Record<string, unknown>);
        }
      }
    } else if (value && typeof value === 'object') {
      extractInlineSourceRefs(value as Record<string, unknown>);
    }
  }

  if (collected.size > 0) {
    const existing = Array.isArray(obj.sources) ? (obj.sources as unknown[]) : [];
    const merged = new Set<string>([
      ...existing.filter((x): x is string => typeof x === 'string' && /^A\d+$/.test(x)),
      ...collected,
    ]);
    // Only attach if the object has a systemId field — i.e. it's a SystemAssessment.
    if ('systemId' in obj) {
      obj.sources = Array.from(merged).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    }
  }
}

/**
 * Parse a prose `frequencyAndVolume` string into a structured `frequency`
 * object using regex heuristics. Returns the structured shape; anything
 * unparseable lands in `notes`.
 *
 * This is best-effort — the goal is to get a usable structured view of
 * pre-AAP-65 prose, NOT to be a perfect parser.
 */
export function parseFrequencyProse(prose: string): {
  runsLastWeek?: number | null;
  callsPerRun?: string;
  batchSize?: number | string;
  concurrency?: 'sequential' | 'parallel' | 'mixed' | 'unknown';
  notes?: string;
} {
  const out: ReturnType<typeof parseFrequencyProse> = {};
  if (!prose || prose.trim().length === 0) return out;

  // Runs in the last week — "N runs in the last week" / "historical runs ... were not observable"
  const runsMatch = prose.match(/(\d+)\s*runs?\s*(?:in|per|\/)\s*(?:the\s+)?(?:last\s+)?week/i);
  if (runsMatch) {
    out.runsLastWeek = Number.parseInt(runsMatch[1] ?? '0', 10);
  } else if (/historical\s+runs?\s+(?:in\s+the\s+)?(?:last\s+)?week\s+were\s+not\s+observable/i.test(prose)) {
    out.runsLastWeek = null;
  }

  // Calls per run — "10-15 tool calls" / "~100 calls per run" / "1 audit run"
  const callRange = prose.match(/(\d+\s*[-–]\s*\d+)\s*(?:tool\s+)?calls?/i);
  const callSingle = prose.match(/(~?\d+)\s*calls?\s+per\s+run/i);
  const callAbout = prose.match(/about\s+(\d+(?:\s*[-–]\s*\d+)?)\s+(?:tool\s+)?calls?/i);
  if (callRange) {
    out.callsPerRun = callRange[1]?.replace(/\s+/g, '') ?? undefined;
  } else if (callSingle) {
    out.callsPerRun = callSingle[1] ?? undefined;
  } else if (callAbout) {
    out.callsPerRun = callAbout[1]?.replace(/\s+/g, '') ?? undefined;
  }

  // Batch size — "batch size N" / "batch of N" / "usually 1 ... per ..."
  const batchN = prose.match(/batch\s*(?:size|of)\s*(?:usually\s+)?(\d+)/i);
  if (batchN) {
    const n = Number.parseInt(batchN[1] ?? '0', 10);
    if (n > 0) out.batchSize = n;
  }

  // Concurrency — keyword scan
  const isSequential = /\b(?:one[\s-]?at[\s-]?a[\s-]?time|sequential|serially|one\s+by\s+one)\b/i.test(prose);
  const isParallel = /\b(?:parallel|concurrent|simultaneously)\b/i.test(prose);
  if (isSequential && isParallel) out.concurrency = 'mixed';
  else if (isSequential) out.concurrency = 'sequential';
  else if (isParallel) out.concurrency = 'parallel';

  // Notes — keep a shortened version of the original prose for context.
  const trimmedProse = prose.trim();
  if (trimmedProse.length <= 400) {
    out.notes = trimmedProse;
  } else {
    out.notes = `${trimmedProse.slice(0, 397)}...`;
  }

  return out;
}

/**
 * Word-set similarity (Jaccard on lowercased word tokens). Returns 0..1.
 * Used to detect near-duplicate risk titles for merging.
 */
function titleSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let common = 0;
  for (const w of ta) if (tb.has(w)) common++;
  return common / (ta.size + tb.size - common);
}

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Merge near-duplicate risks. Two risks are duplicates when:
 *   - title similarity > 0.7, OR
 *   - same first-30-char title prefix, OR
 *   - same severity AND ≥3 common keyword tokens
 *
 * Higher severity wins; recommendations and mitigation strings are merged
 * (deduplicated, joined with "; ").
 */
export function mergeDuplicateRisks<R extends { severity: string; title: string; description: string; mitigation?: string }>(
  risks: R[],
): R[] {
  if (risks.length < 2) return risks;

  const result: R[] = [];
  for (const risk of risks) {
    const dupIdx = result.findIndex((existing) => {
      const sim = titleSimilarity(existing.title, risk.title);
      if (sim > 0.7) return true;
      const prefixA = existing.title.slice(0, 30).toLowerCase();
      const prefixB = risk.title.slice(0, 30).toLowerCase();
      if (prefixA && prefixA === prefixB) return true;
      // Same-severity + shared-keyword fallback.
      if (existing.severity === risk.severity) {
        const tokA = new Set(
          (existing.title + ' ' + existing.description)
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter((w) => w.length > 3),
        );
        const tokB = (risk.title + ' ' + risk.description)
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter((w) => w.length > 3);
        let common = 0;
        for (const w of tokB) if (tokA.has(w)) common++;
        if (common >= 3) return true;
      }
      return false;
    });

    if (dupIdx === -1) {
      result.push({ ...risk });
      continue;
    }

    const existing = result[dupIdx]!;
    // Keep higher severity.
    const aRank = SEVERITY_RANK[existing.severity.toLowerCase()] ?? 0;
    const bRank = SEVERITY_RANK[risk.severity.toLowerCase()] ?? 0;
    if (bRank > aRank) existing.severity = risk.severity;

    // Concatenate descriptions (dedup).
    if (existing.description !== risk.description && !existing.description.includes(risk.description)) {
      existing.description = `${existing.description} ${risk.description}`.trim();
    }
    // Concatenate mitigations (dedup).
    const eMit = existing.mitigation ?? '';
    const rMit = risk.mitigation ?? '';
    if (eMit && rMit && eMit !== rMit && !eMit.includes(rMit)) {
      existing.mitigation = `${eMit}; ${rMit}`;
    } else if (!eMit && rMit) {
      existing.mitigation = rMit;
    }
    result[dupIdx] = existing;
  }
  return result;
}

// ─── AAP-87 — eight purpose-named helpers ────────────────────────────────
//
// Each helper mutates its target IN PLACE. None of them allocate or return
// a new top-level object — the AAP-65 invariant (sanitize runs BEFORE Zod
// against the parsed JSON value the caller holds) requires it.
//
// Helpers that operate per-system (1–5) all take the parsed analyzer
// `systems[]` array element and mutate it in place. Helpers 6–8 operate on
// the top-level analyzer object.

const WRITE_OP_FIELD_CAPS: ReadonlyArray<readonly [string, number]> = [
  ['operation', 80],
  ['target', 80],
  ['volumePerDay', 40],
];

const SCOPE_ARRAY_KEYS = ['scopesDelta', 'scopesNeeded', 'scopesRequested'] as const;
const SCOPE_ENTRY_MAX_LEN = 80;
const RECOMMENDATIONS_MAX_COUNT = 20;
const RECOMMENDATION_ENTRY_MAX_LEN = 400;

const TOP_LEVEL_PROSE_CAPS: ReadonlyArray<readonly [string, number]> = [
  ['summary', 800],
  ['agentPurpose', 600],
  ['agentTrigger', 200],
  ['agentOwner', 200],
  ['decisionMakingDetails', 800],
];

/**
 * Truncate `s` to at most `max` chars by replacing the tail with `…`.
 * Drops orphan trailing whitespace / punctuation that would otherwise
 * butt up against the ellipsis.
 */
function truncateWithEllipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).replace(/[\s.,;]+$/, '') + '…';
}

/**
 * Helper 1 — `sanitizeSystemSources`.
 *
 * Walks every string field on every system and pulls inline `(A3, A4)`
 * source-ref markers into a sibling `sources[]` array on the system.
 *
 * MUST run before {@link sanitizeWriteOperations}, {@link sanitizeSystemIdentity},
 * {@link sanitizeScopeArrays}, and {@link backfillFrequency} — those helpers
 * operate on the ALREADY-DEREF'D strings.
 *
 * Bucket: semantic normalization.
 */
export function sanitizeSystemSources(systems: unknown[]): void {
  for (const sys of systems) {
    if (sys && typeof sys === 'object') {
      extractInlineSourceRefs(sys as Record<string, unknown>);
    }
  }
}

/**
 * Helper 2 — `sanitizeWriteOperations`.
 *
 * Per-system: caps each `writeOperations[].operation` / `.target` to 80
 * chars and `.volumePerDay` to 40, replacing the tail with `…`. Strips
 * trailing punctuation left over from {@link sanitizeSystemSources}'s
 * source-ref extraction (e.g. "endpoint ." → "endpoint").
 *
 * Buckets: schema enforcement (caps) + semantic normalization
 * (trailing-punct cleanup).
 */
export function sanitizeWriteOperations(sys: Record<string, unknown>): void {
  if (!Array.isArray(sys.writeOperations)) return;
  for (const woRaw of sys.writeOperations) {
    if (!woRaw || typeof woRaw !== 'object') continue;
    const wo = woRaw as Record<string, unknown>;
    for (const [key, max] of WRITE_OP_FIELD_CAPS) {
      const v = wo[key];
      if (typeof v === 'string') {
        // Drop orphan trailing punctuation from upstream source-ref stripping.
        const cleaned = v.replace(/\s*[.,;]+\s*$/, '').trim();
        wo[key] = truncateWithEllipsis(cleaned, max);
      }
    }
  }
}

/**
 * Helper 3 — `sanitizeSystemIdentity`.
 *
 * Per-system: if `systemId` is not a valid kebab-case slug (or is too
 * long), reshape it into one and spill the original prose into
 * `systemDescription` (when not already populated). Preserves AAP-65's
 * "long prose ⇒ description" contract — pre-AAP-65 sessions on disk
 * remain renderable.
 *
 * Buckets: semantic normalization (slug reshape) + legacy compatibility
 * (description spill).
 */
export function sanitizeSystemIdentity(sys: Record<string, unknown>): void {
  const id = typeof sys.systemId === 'string' ? sys.systemId : '';
  // NB: parenthesization matches the pre-AAP-87 expression exactly. The
  // intended condition reads "(id is non-empty AND id is malformed) OR id
  // is too long". Phase A must preserve this byte-for-byte even though
  // refactoring opportunity exists — see AAP-90.
  if (id && !SYSTEM_ID_REGEX.test(id) || id.length > MAX_SYSTEM_ID_LEN) {
    const shortId = toShortSystemId(id);
    // Preserve the full prose in systemDescription if not already populated.
    if (
      !sys.systemDescription ||
      typeof sys.systemDescription !== 'string' ||
      (sys.systemDescription as string).trim().length === 0
    ) {
      sys.systemDescription = id;
    }
    sys.systemId = shortId;
  }
}

/**
 * Helper 4 — `sanitizeScopeArrays`.
 *
 * Per-system: for each of `scopesDelta`, `scopesNeeded`, `scopesRequested`:
 *   1. strip the "Unused in this audit task so far:" lead-in
 *   2. truncate each entry to ≤ 80 chars
 *   3. drop empty strings (compaction)
 *
 * Buckets: semantic normalization (lead-in strip) + schema enforcement
 * (cap + empty-string drop).
 */
export function sanitizeScopeArrays(sys: Record<string, unknown>): void {
  for (const key of SCOPE_ARRAY_KEYS) {
    const arr = sys[key];
    if (Array.isArray(arr)) {
      sys[key] = arr
        .map((s) => {
          if (typeof s !== 'string') return s;
          const cleaned = stripScopeLeadIn(s);
          return truncateWithEllipsis(cleaned, SCOPE_ENTRY_MAX_LEN);
        })
        .filter((s) => s !== '');
    }
  }
}

/**
 * Helper 5 — `backfillFrequency`.
 *
 * Per-system: if `frequency` is absent (or not an object), and
 * `frequencyAndVolume` is a provided non-empty string, parse the prose
 * into the structured `frequency` shape. If parsing yields nothing
 * meaningful, leave `frequency` unset.
 *
 * Buckets: model-quality compensation + legacy compatibility.
 * **Phase B (AAP-90) target: stop NEW LLM outputs needing this** — the
 * prompt or structured-output schema should require the model to emit
 * `frequency` directly. The helper itself STAYS regardless: pre-AAP-65
 * sessions persisted to disk only have the prose `frequencyAndVolume`
 * field (see `src/report/types.ts` lines 68-72, 103-106), so the report
 * viewer needs `backfillFrequency` to keep loading historical data.
 */
export function backfillFrequency(sys: Record<string, unknown>): void {
  if (sys.frequency && typeof sys.frequency === 'object') return;
  const prose =
    typeof sys.frequencyAndVolume === 'string' && sys.frequencyAndVolume.trim().length > 0
      ? sys.frequencyAndVolume
      : '';
  if (!prose || !isProvided(prose)) return;
  const parsed = parseFrequencyProse(prose);
  const hasContent =
    parsed.runsLastWeek !== undefined ||
    parsed.callsPerRun !== undefined ||
    parsed.batchSize !== undefined ||
    parsed.concurrency !== undefined ||
    (parsed.notes !== undefined && parsed.notes.length > 0);
  if (hasContent) sys.frequency = parsed;
}

/**
 * Helper 5b — `sanitizeFrequencyFields`.
 *
 * Truncates LLM-emitted `frequency` object string fields to fit the Zod
 * schema caps (`src/report/types.ts` frequencyShapeSchema):
 *   - `callsPerRun` ≤ 40 chars
 *   - `batchSize` (when string) ≤ 20 chars
 *   - `notes` ≤ 400 chars
 *
 * Also caps `sys.sources` at 20 entries (sources max length per
 * systemAssessmentSchema).
 *
 * AAP-95: side-effect of AAP-94 — richer Codex deployment-task answers
 * produce more detailed per-system frequency descriptions that exceed
 * the schema caps, causing Zod to reject and `analyzeTranscript` to
 * fail with "String must contain at most N character(s)" errors. This
 * helper truncates BEFORE Zod validation so the audit completes
 * gracefully on long but legitimate operational metrics.
 *
 * Bucket: schema enforcement.
 */
export function sanitizeFrequencyFields(sys: Record<string, unknown>): void {
  if (sys.frequency && typeof sys.frequency === 'object') {
    const freq = sys.frequency as Record<string, unknown>;
    if (typeof freq.callsPerRun === 'string' && freq.callsPerRun.length > 40) {
      freq.callsPerRun = truncateWithEllipsis(freq.callsPerRun, 40);
    }
    if (typeof freq.batchSize === 'string' && freq.batchSize.length > 20) {
      freq.batchSize = truncateWithEllipsis(freq.batchSize, 20);
    }
    if (typeof freq.notes === 'string' && freq.notes.length > 400) {
      freq.notes = truncateWithEllipsis(freq.notes, 400);
    }
  }
  if (Array.isArray(sys.sources) && sys.sources.length > 20) {
    sys.sources = sys.sources.slice(0, 20);
  }
}

/**
 * Helper 6 — `sanitizeRisks`.
 *
 * Top-level: filter the `risks[]` array to well-shaped entries (object
 * with a string `title`), then merge near-duplicates via
 * {@link mergeDuplicateRisks}.
 *
 * Buckets: schema enforcement (malformed filter) + model-quality
 * compensation (near-duplicate merge — **Phase B (AAP-90) candidate**:
 * removable IF structured-output / prompt evals prove stable dedup across
 * providers. Until then the helper STAYS — the prompt cannot yet
 * guarantee the model won't emit dupes).
 */
export function sanitizeRisks(obj: Record<string, unknown>): void {
  if (!Array.isArray(obj.risks)) return;
  obj.risks = mergeDuplicateRisks(
    obj.risks.filter(
      (r): r is { severity: string; title: string; description: string; mitigation?: string } =>
        !!r && typeof r === 'object' && typeof (r as Record<string, unknown>).title === 'string',
    ),
  );
}

/**
 * Helper 7 — `sanitizeRecommendations`.
 *
 * Top-level: cap the `recommendations[]` array to 20 entries, then
 * truncate each string entry to 400 chars.
 *
 * Bucket: schema enforcement.
 */
export function sanitizeRecommendations(obj: Record<string, unknown>): void {
  if (!Array.isArray(obj.recommendations)) return;
  // Snapshot into a local so TS keeps the narrowed `unknown[]` shape across
  // the in-place reassignment to `obj.recommendations` below.
  let recs: unknown[] = obj.recommendations;
  if (recs.length > RECOMMENDATIONS_MAX_COUNT) {
    recs = recs.slice(0, RECOMMENDATIONS_MAX_COUNT);
  }
  obj.recommendations = recs.map((r) =>
    typeof r === 'string' && r.length > RECOMMENDATION_ENTRY_MAX_LEN
      ? truncateWithEllipsis(r, RECOMMENDATION_ENTRY_MAX_LEN)
      : r,
  );
}

/**
 * Helper 8 — `sanitizeTopLevelText`.
 *
 * Top-level: cap each prose field at its per-field schema limit.
 * Currently covers `summary` (800), `agentPurpose` (600), `agentTrigger`
 * (200), `agentOwner` (200), `decisionMakingDetails` (800).
 *
 * Bucket: schema enforcement.
 */
export function sanitizeTopLevelText(obj: Record<string, unknown>): void {
  for (const [key, max] of TOP_LEVEL_PROSE_CAPS) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > max) {
      obj[key] = truncateWithEllipsis(v, max);
    }
  }
}

/**
 * Top-level entry point. Walks the parsed analyzer JSON and reshapes it
 * to the AAP-65 schema. Mutates in place. Safe to call on shapes that
 * already conform.
 *
 * AAP-87 — thin orchestrator. See the helper docs above for ordering
 * rationale. The sequence below is asserted by
 * `tests/analysis/sanitize-ordering.test.ts`.
 */
export function sanitizeAnalyzerOutput(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const obj = raw as Record<string, unknown>;

  // 1. Source-ref extraction MUST run first (sets up clean strings for
  //    every downstream per-system helper).
  if (Array.isArray(obj.systems)) {
    sanitizeSystemSources(obj.systems);
  }

  // 2–5. Per-system helpers operate on already-deref'd strings.
  if (Array.isArray(obj.systems)) {
    for (const sysRaw of obj.systems) {
      if (!sysRaw || typeof sysRaw !== 'object') continue;
      const sys = sysRaw as Record<string, unknown>;
      sanitizeWriteOperations(sys);
      sanitizeSystemIdentity(sys);
      sanitizeScopeArrays(sys);
      backfillFrequency(sys);
      sanitizeFrequencyFields(sys);
    }
  }

  // 6–8. Top-level helpers.
  sanitizeRisks(obj);
  sanitizeRecommendations(obj);
  sanitizeTopLevelText(obj);
}
