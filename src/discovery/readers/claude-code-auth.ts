/**
 * Claude Code auth-file reader — AAP-58.
 *
 * Reads `~/.claude/.credentials.json` if it exists. Mirrors
 * `codex-auth.ts`: only top-level KEY NAMES are surfaced, every value
 * is scrubbed through secretlint twice (once on the whole file, once
 * per string field before shape classification).
 *
 * Claude Code's credentials file shape varies across versions and
 * subscription tiers; we treat the JSON as opaque and emit one row per
 * top-level key. Nested objects get `valueShape: 'unknown'` — recursion
 * would tempt the reader to surface values it shouldn't see at all.
 */

import { join } from 'node:path';

import type { AuthCredentialCapability, AuthCredentialShape, AuthReader } from '../types.js';
import { secretlintScrubString } from '../secretlint-scrub.js';

const RUNTIME = 'claude-code' as const;

function classifyShape(value: string): AuthCredentialShape {
  if (/^sk-[A-Za-z0-9_-]{16,}$/.test(value)) return 'apiKey';
  if (/^ghp_[A-Za-z0-9]{20,}$/.test(value)) return 'apiKey';
  if (/^eyJ[A-Za-z0-9_-]+\./.test(value)) return 'token';
  if (/^ya29\./.test(value)) return 'oauth';
  if (/oauth/i.test(value) && value.length > 20) return 'oauth';
  if (value.length >= 40 && /^[A-Za-z0-9_-]+$/.test(value)) return 'token';
  return 'unknown';
}

export const claudeCodeAuthReader: AuthReader = {
  runtime: RUNTIME,
  paths(homeDir) {
    return [join(homeDir, '.claude/.credentials.json')];
  },
  async parse(content, path): Promise<AuthCredentialCapability[]> {
    let scrubbed: string;
    try {
      scrubbed = await secretlintScrubString(content);
    } catch {
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
