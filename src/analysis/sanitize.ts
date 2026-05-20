/**
 * AAP-65: post-LLM sanitization pass.
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
 * The order is significant: source-ref extraction runs FIRST (it walks every
 * string field), then per-field reshaping runs SECOND (so the prose still
 * contains its semantic content but without inline refs).
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

/**
 * Top-level entry point. Walks the parsed analyzer JSON and reshapes it
 * to the AAP-65 schema. Mutates in place. Safe to call on shapes that
 * already conform.
 */
export function sanitizeAnalyzerOutput(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const obj = raw as Record<string, unknown>;

  // Pull source refs out of every nested string first — this avoids them
  // leaking into the systemId slug or polluting the frequency notes.
  if (Array.isArray(obj.systems)) {
    for (const sys of obj.systems) {
      if (sys && typeof sys === 'object') {
        extractInlineSourceRefs(sys as Record<string, unknown>);
      }
    }
  }

  if (Array.isArray(obj.systems)) {
    for (const sysRaw of obj.systems) {
      if (!sysRaw || typeof sysRaw !== 'object') continue;
      const sys = sysRaw as Record<string, unknown>;

      // 0. Truncate over-long fields inside writeOperations[] so schema
      //    validation does not reject the whole system. AAP-65: in real
      //    LLM output, operation/target/volumePerDay regularly carry prose
      //    + source refs that exceed the 80 / 40-char caps. Strip refs
      //    first (extractInlineSourceRefs ran above), then truncate.
      if (Array.isArray(sys.writeOperations)) {
        for (const woRaw of sys.writeOperations) {
          if (!woRaw || typeof woRaw !== 'object') continue;
          const wo = woRaw as Record<string, unknown>;
          for (const [key, max] of [
            ['operation', 80],
            ['target', 80],
            ['volumePerDay', 40],
          ] as const) {
            const v = wo[key];
            if (typeof v === 'string') {
              // Drop orphan trailing punctuation from upstream source-ref stripping.
              let cleaned = v.replace(/\s*[.,;]+\s*$/, '').trim();
              if (cleaned.length > max) {
                cleaned = cleaned.slice(0, max - 1).replace(/[\s.,;]+$/, '') + '…';
              }
              wo[key] = cleaned;
            }
          }
        }
      }

      // 1. systemId reshape — kebab-case + spill prose into systemDescription.
      const id = typeof sys.systemId === 'string' ? sys.systemId : '';
      if (id && !SYSTEM_ID_REGEX.test(id) || id.length > MAX_SYSTEM_ID_LEN) {
        const shortId = toShortSystemId(id);
        // Preserve the full prose in systemDescription if not already populated.
        if (!sys.systemDescription || typeof sys.systemDescription !== 'string' || (sys.systemDescription as string).trim().length === 0) {
          sys.systemDescription = id;
        }
        sys.systemId = shortId;
      }

      // 2. scopesDelta + scopesNeeded + scopesRequested: strip lead-ins,
      //    then truncate to the 80-char cap (defensive — pre-AAP-65 data
      //    on disk can carry sentence-shaped "scopes" we have to fit).
      for (const key of ['scopesDelta', 'scopesNeeded', 'scopesRequested'] as const) {
        const arr = sys[key];
        if (Array.isArray(arr)) {
          sys[key] = arr
            .map((s) => {
              if (typeof s !== 'string') return s;
              let cleaned = stripScopeLeadIn(s);
              if (cleaned.length > 80) {
                cleaned = cleaned.slice(0, 79).replace(/[\s.,;]+$/, '') + '…';
              }
              return cleaned;
            })
            .filter((s) => s !== '');
        }
      }

      // 3. frequency: parse prose into structured shape if absent.
      if (!sys.frequency || typeof sys.frequency !== 'object') {
        const prose =
          typeof sys.frequencyAndVolume === 'string' && sys.frequencyAndVolume.trim().length > 0
            ? sys.frequencyAndVolume
            : '';
        if (prose && isProvided(prose)) {
          const parsed = parseFrequencyProse(prose);
          // Only attach if we extracted *something* — pure "NOT PROVIDED"
          // shouldn't materialize as an empty object.
          const hasContent =
            parsed.runsLastWeek !== undefined ||
            parsed.callsPerRun !== undefined ||
            parsed.batchSize !== undefined ||
            parsed.concurrency !== undefined ||
            (parsed.notes !== undefined && parsed.notes.length > 0);
          if (hasContent) sys.frequency = parsed;
        }
      }
    }
  }

  // 4. Merge near-duplicate risks.
  if (Array.isArray(obj.risks)) {
    obj.risks = mergeDuplicateRisks(
      obj.risks.filter(
        (r): r is { severity: string; title: string; description: string; mitigation?: string } =>
          !!r && typeof r === 'object' && typeof (r as Record<string, unknown>).title === 'string',
      ),
    );
  }

  // 5. Cap recommendations array length defensively.
  if (Array.isArray(obj.recommendations) && obj.recommendations.length > 20) {
    obj.recommendations = obj.recommendations.slice(0, 20);
  }
  // Truncate over-long recommendations entries (≤400 chars each).
  if (Array.isArray(obj.recommendations)) {
    obj.recommendations = obj.recommendations.map((r) =>
      typeof r === 'string' && r.length > 400
        ? r.slice(0, 399).replace(/[\s.,;]+$/, '') + '…'
        : r,
    );
  }

  // 6. Truncate over-long top-level prose fields defensively.
  const topLevelCaps: Array<readonly [string, number]> = [
    ['summary', 800],
    ['agentPurpose', 600],
    ['agentTrigger', 200],
    ['agentOwner', 200],
    ['decisionMakingDetails', 800],
  ];
  for (const [key, max] of topLevelCaps) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > max) {
      obj[key] = v.slice(0, max - 1).replace(/[\s.,;]+$/, '') + '…';
    }
  }
}
