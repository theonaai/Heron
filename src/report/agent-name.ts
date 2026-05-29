/**
 * AAP-105 C1 / #26 A1 — shared agent display-name extraction.
 *
 * The runtime "Codex desktop agent in /path" name is uninformative —
 * every Codex audit ends up with the same header / sidebar / overview
 * label. We extract the project name the deployment actually answered in
 * Q1 (and the LLM-distilled `agentPurpose`) so all three surfaces — the
 * report CARD, the dashboard OVERVIEW row, and the left SIDEBAR — show the
 * same name.
 *
 * This logic used to live inline in
 * `components/heron-v1/dashboard/MinimalReportView.tsx` (client-only). It
 * is lifted here into a pure, environment-agnostic module (no React, no
 * `window`) so the Node storage layer can stamp the extracted name onto
 * `meta.extractedAgentName` at report-write time — giving every surface a
 * single field to read instead of each re-deriving (or, as before, the
 * overview/sidebar silently falling back to the runtime name).
 *
 * Sources, in order of reliability:
 *
 *   1. `agentPurpose` (LLM-distilled summary on report.json) — the
 *      analyzer already picked the canonical pipeline / product name from
 *      Q1 + Q26-Q28 answers. The noun phrase before the first comma /
 *      "for" / "that" is almost always the right answer.
 *   2. Q1 transcript answer — structured "1. Project/product name: <X>"
 *      block. The Codex desktop probe stuffs runtime metadata into the
 *      first line ("…whose repository is `mvp-edu-content-agent`"), so we
 *      also look for a backticked repo identifier as a secondary signal
 *      and humanize it (`mvp-edu-content-agent` → "MVP Edu Content
 *      Agent"). The "1. … name: …" lookup is the last structured
 *      fallback.
 *   3. Runtime metadata (fallback only) — `isFallback: true` so the
 *      caller can surface a "fallback name" badge.
 */

export interface TranscriptEntryLike {
  category?: string;
  question?: string;
  answer?: string;
}

const NAME_NOISE_PHRASES = [
  /codex desktop( gpt-?5)?( coding)? agent/i,
  /coding agent/i,
  /local workspace/i,
  /the agent/i,
];

export function isUsefulName(name: string): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length < 3 || trimmed.length > 80) return false;
  for (const noise of NAME_NOISE_PHRASES) {
    if (noise.test(trimmed)) return false;
  }
  return true;
}

export function humanizeKebab(s: string): string {
  return s
    .split(/[-_]/)
    .filter((p) => p.length > 0)
    .map((p) => {
      // Keep common short uppercase tokens as-is (MVP, API, AI, OCR, etc.).
      if (/^[a-z]{2,4}$/.test(p) && /^(mvp|api|ai|ml|llm|ui|ux|sdk|crm|cms|cli|aws|gcp|qa)$/i.test(p)) {
        return p.toUpperCase();
      }
      // Title-case other words; map known abbreviations.
      if (p.toLowerCase() === 'edu') return 'Educational';
      return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
    })
    .join(' ');
}

export function titleCasePhrase(s: string): string {
  const stopwords = new Set([
    'a', 'an', 'and', 'or', 'of', 'for', 'in', 'on', 'the', 'to', 'with', 'by',
  ]);
  return s
    .split(/\s+/)
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (i > 0 && stopwords.has(lower)) return lower;
      // Preserve internal capitalization (MVP, GPT-5, API, etc.) if already
      // present, otherwise title-case.
      if (/^[A-Z]{2,}$/.test(w)) return w;
      if (/^[A-Z][a-z0-9]+$/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ')
    .trim();
}

/**
 * Extract a project name from `agentPurpose` prose. Looks for the standout
 * noun phrase the LLM almost always emits: the lead clause describing the
 * pipeline / agent / product.
 */
export function extractFromAgentPurpose(purpose: string): string | null {
  if (!purpose) return null;
  const text = purpose.trim();

  // Pattern A: "<a|an|the> <X> <noun>" where noun ∈ pipeline / system /
  // platform / service / agent / orchestrator / workflow / app. Anchored
  // on a leading article so we pick the OUTERMOST noun phrase rather than a
  // sub-phrase.
  const articlePattern = /\b(?:a|an|the)\s+([A-Za-z][\w-]*(?:\s+(?!for\b|that\b|which\b|to\b|in\b|on\b|and\b)[\w-]+){0,7})\s+(pipeline|system|platform|service|orchestrator|workflow|app|backend|product|application)\b/i;
  const m1 = text.match(articlePattern);
  if (m1 && m1[1]) {
    const titled = titleCasePhrase(`${m1[1]} ${m1[2]}`);
    if (isUsefulName(titled)) return titled;
  }

  // Pattern B: agent-specific — "the X agent" but only when X is at least 2
  // tokens (avoid matching "the agent edits").
  const agentPattern = /\b(?:a|an|the)\s+([A-Z][\w-]+(?:\s+[\w-]+){1,5})\s+agent\b/;
  const m2 = text.match(agentPattern);
  if (m2 && m2[1]) {
    const titled = titleCasePhrase(`${m2[1]} agent`);
    if (isUsefulName(titled)) return titled;
  }

  // Pattern C: "for <X>" lead-in for short prose lacking the article
  // anchor. Last-resort heuristic.
  const forMatch = text.match(/\bfor\s+(?:a|an|the)\s+([A-Z][A-Za-z0-9 -]{4,60})\b/);
  if (forMatch && forMatch[1] && isUsefulName(forMatch[1])) {
    return titleCasePhrase(forMatch[1].trim());
  }

  return null;
}

/**
 * Resolve the agent display name from the report's transcript +
 * agentPurpose, falling back to the runtime name. Pure — safe to call from
 * both the React client and the Node storage layer.
 */
export function extractProjectName(
  transcript: TranscriptEntryLike[] | undefined,
  fallback: string | undefined,
  agentPurpose: string | undefined,
): { name: string; isFallback: boolean } {
  // Source #1: agentPurpose (LLM-distilled, highest signal).
  if (agentPurpose) {
    const fromPurpose = extractFromAgentPurpose(agentPurpose);
    if (fromPurpose && isUsefulName(fromPurpose)) {
      return { name: fromPurpose, isFallback: false };
    }
  }

  // Source #2: Q1 transcript answer ("1. Project/product name: ...").
  if (transcript && transcript.length > 0) {
    const candidates = transcript
      .slice(0, 3)
      .filter((t) => (t.category || '').toLowerCase() === 'purpose');

    for (const c of candidates) {
      const a = (c.answer || '').trim();
      if (!a) continue;

      // Sub-pattern 2a: backticked repo identifier (Codex desktop probe pattern).
      // "whose repository is `mvp-edu-content-agent`" → "MVP Edu Content Agent"
      const repoMatch = a.match(/repositor(?:y|ies)\s+(?:is|are|named|called)\s+`([a-z0-9_-]{3,60})`/i);
      if (repoMatch && repoMatch[1]) {
        const humanized = humanizeKebab(repoMatch[1]);
        if (isUsefulName(humanized)) {
          return { name: humanized, isFallback: false };
        }
      }

      // Sub-pattern 2b: structured "1. Project/product name: <X>" header.
      const m1 = a.match(/(?:project\/product name|project name|product name)\s*[:\-]\s*([^\n.]+)/i);
      if (m1 && m1[1]) {
        let name = m1[1].trim().replace(/[`*]/g, '');
        // Strip trailing "operating in workspace …" / "running in the local …".
        name = name.split(/\s+(?:operating|running|deployed|hosted|located)\s+in\b/i)[0]!.trim();
        // "Codex3 workspace for MVP Edu Content Agent (mvp-edu-content-agent)"
        const forMatch = name.match(/for\s+([A-Z][^()]+?)(?:\s*\(|\s*,|\s*\.|$)/);
        if (forMatch && forMatch[1]) {
          name = forMatch[1].trim();
        } else {
          name = name.split(/[,;]/)[0]!.trim().split('(')[0]!.trim();
        }
        name = name.replace(/[.,;]+$/, '').trim();
        if (isUsefulName(name)) {
          return { name, isFallback: false };
        }
      }
    }
  }

  // Source #3: runtime metadata (last resort).
  return { name: fallback || 'Unnamed agent', isFallback: true };
}
