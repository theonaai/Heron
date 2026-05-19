/**
 * Args / command scrubbing for AAP-53.1 hardening.
 *
 * Layer 3 of the redaction stack: when an MCP server config carries
 * stdio invocation tokens directly in `command` / `args[]`, those tokens
 * survive whitelist projection. This layer scrubs the secret-shaped
 * arguments while preserving legitimate ones (DB names, ports, paths)
 * so the operator still sees the agent's true invocation surface.
 *
 * Heuristics:
 *
 * 1. `--token=ghp_xxx`, `--api-key=foo`, `--password=bar` style — the
 *    value is replaced with `[REDACTED]` so the FLAG NAME survives.
 * 2. Standalone secret-named flag followed by a positional argument:
 *    `--token`, `ghp_xxx` → `--token`, `[REDACTED]`. We scan in pairs
 *    and replace the next positional after a secret-named flag.
 * 3. Connection strings (`postgres://user:pass@host/db`) anywhere in
 *    args are replaced wholesale with `[REDACTED:connection-string]`.
 *
 * Anything else is kept verbatim. The Layer 4 secretlint pass will
 * still scan the result and catch token shapes we didn't anticipate.
 */

import { isConnectionString } from './redaction.js';

const SECRET_FLAG_PATTERNS = [
  /^--?(api[-_]?key|token|secret|password|passwd|auth|credential|private[-_]?key|access[-_]?token)$/i,
  /^--?(api[-_]?key|token|secret|password|passwd|auth|credential|private[-_]?key|access[-_]?token)=/i,
];

export interface TrimmedInvocation {
  command?: string;
  args: string[];
}

function isSecretFlagWithValue(arg: string): boolean {
  // `--token=xxx` style — has `=` and the prefix matches a secret flag.
  return SECRET_FLAG_PATTERNS[1].test(arg);
}

function isSecretFlagStandalone(arg: string): boolean {
  // `--token` (next positional is the secret).
  return SECRET_FLAG_PATTERNS[0].test(arg);
}

/**
 * Scrub a single command + args pair. `command` is kept (only first
 * whitespace-separated token, so `node ./agent.js --token=xxx` stored
 * as a single command string still gets split).
 */
export function trimInvocation(
  command: string | undefined,
  args: string[] | undefined,
): TrimmedInvocation {
  const out: TrimmedInvocation = { args: [] };

  if (command !== undefined && command !== '') {
    // Collapse `command` to its first whitespace-separated token, in
    // case a config stuffed args into the command field directly.
    out.command = command.split(/\s+/)[0];
  }

  if (!args || args.length === 0) return out;

  const result: string[] = [];
  let expectSecretValueNext = false;

  for (const raw of args) {
    if (typeof raw !== 'string') continue;

    if (expectSecretValueNext) {
      // Replace the positional that follows a secret-named flag.
      result.push('[REDACTED]');
      expectSecretValueNext = false;
      continue;
    }

    if (isSecretFlagWithValue(raw)) {
      // `--token=xxx` → `--token=[REDACTED]`
      const eqIdx = raw.indexOf('=');
      result.push(raw.slice(0, eqIdx + 1) + '[REDACTED]');
      continue;
    }

    if (isSecretFlagStandalone(raw)) {
      // `--token` alone → keep, mark next positional for redaction.
      result.push(raw);
      expectSecretValueNext = true;
      continue;
    }

    if (isConnectionString(raw)) {
      result.push('[REDACTED:connection-string]');
      continue;
    }

    result.push(raw);
  }

  out.args = result;
  return out;
}
