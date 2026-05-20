/**
 * Codex auth-file reader — AAP-58.
 *
 * Reads `~/.codex/auth.json` and surfaces TOP-LEVEL KEY NAMES ONLY.
 * Values are NEVER read into memory beyond a coarse shape heuristic
 * (length + charset bucket) and ARE passed through secretlint scrub
 * before any path that could return them — defense in depth in case
 * the heuristic mis-classifies a literal.
 *
 * Examples of what surfaces:
 *
 *   { "openai_api_key": "sk-...", "github": { "token": "ghp-..." } }
 *
 *      →   [{ provider: 'openai_api_key', hasValue: true, valueShape: 'apiKey' },
 *           { provider: 'github',         hasValue: true, valueShape: 'unknown' }]
 *
 * Nested values are NOT recursed into — we only emit one row per
 * top-level key, with `valueShape` reflecting the type of the value
 * when it's a string. Object/array values get `valueShape: 'unknown'`.
 *
 * Honest gap: this reader does not attempt to detect "the file exists
 * but the JSON is wrapped in a different envelope". If Codex ever
 * changes the shape, this reader will return [] — a follow-up ticket.
 */

import { join } from 'node:path';

import type { AuthCredentialCapability, AuthCredentialShape, AuthReader } from '../types.js';
import { secretlintScrubString } from '../secretlint-scrub.js';

const RUNTIME = 'codex' as const;

/** Heuristic: tag a string value as token/apiKey/oauth/unknown. */
function classifyShape(value: string): AuthCredentialShape {
  // JWTs and PEM blocks land in `secretlintScrubString` first; here we
  // pattern-classify whatever survives — these are coarse bucket labels,
  // never returned alongside the value itself.
  if (/^sk-[A-Za-z0-9_-]{16,}$/.test(value)) return 'apiKey';
  if (/^ghp_[A-Za-z0-9]{20,}$/.test(value)) return 'apiKey';
  if (/^eyJ[A-Za-z0-9_-]+\./.test(value)) return 'token';
  if (/^ya29\./.test(value)) return 'oauth';
  if (/oauth/i.test(value) && value.length > 20) return 'oauth';
  if (value.length >= 40 && /^[A-Za-z0-9_-]+$/.test(value)) return 'token';
  return 'unknown';
}

export const codexAuthReader: AuthReader = {
  runtime: RUNTIME,
  paths(homeDir) {
    return [join(homeDir, '.codex/auth.json')];
  },
  async parse(content, path): Promise<AuthCredentialCapability[]> {
    // Defense layer A: scrub the entire raw file through secretlint
    // before we look at it. If a value is a known secret shape it gets
    // `[REDACTED:<ruleId>]` substituted in-place, so the classifier
    // below never sees the literal — and any string we later return
    // simply cannot carry the original credential.
    let scrubbed: string;
    try {
      scrubbed = await secretlintScrubString(content);
    } catch {
      // Scrub failure is fatal for this reader — bail rather than risk
      // ever returning unscrubbed data.
      return [];
    }

    let doc: unknown;
    try {
      doc = JSON.parse(scrubbed);
    } catch {
      return [];
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [];

    const out: AuthCredentialCapability[] = [];
    for (const [provider, value] of Object.entries(doc as Record<string, unknown>)) {
      if (typeof provider !== 'string' || provider.length === 0) continue;
      const hasValue =
        value !== null &&
        value !== undefined &&
        !(typeof value === 'string' && value.length === 0);

      let valueShape: AuthCredentialShape | undefined;
      if (typeof value === 'string' && value.length > 0) {
        // Defense layer B: even though the file was scrubbed, run
        // each string value through the scrubber once more before
        // classifying. The classifier output is a label, not the value.
        const innerScrubbed = await secretlintScrubString(value);
        valueShape = classifyShape(innerScrubbed);
      } else if (value && typeof value === 'object') {
        valueShape = 'unknown';
      }

      out.push({
        kind: 'auth_credential',
        runtime: RUNTIME,
        configPath: path,
        provider,
        hasValue,
        ...(valueShape !== undefined ? { valueShape } : {}),
      });
    }
    return out;
  },
};
