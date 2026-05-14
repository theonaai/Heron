/**
 * File backend for the agent-declaration source (AAP-48).
 *
 * Reads a JSON config file describing the agent's declared tools and
 * scopes. Primary v1 backend for HR pilot customers who write their
 * declared baseline as config.
 *
 * Schema (also documented in the AAP-48 PR body):
 *
 *   {
 *     "agent": {
 *       "name":    string (required),
 *       "purpose": string (optional),
 *       "owner":   string (optional),
 *       "version": string (optional)
 *     },
 *     "declared": {
 *       "tools":  [{ "name": string, "description"?: string }, ...],
 *       "scopes": [{ "service": string, "scope": string }, ...]
 *     }
 *   }
 *
 * Validation: required fields present, names/services non-empty,
 * tools/scopes bounded at 256 each, total file ≤ 1 MiB.
 *
 * Sanitisation: every owner-supplied string passes through
 * `stripControlChars` (ASCII C0/DEL/C1, U+2028, U+2029) so a hostile
 * declaration file cannot corrupt downstream Markdown rendering.
 *
 * Path safety:
 *  - Path normalised + resolved to absolute form.
 *  - `..` segments after normalisation are rejected (defensive — the
 *    JS-engine `path.resolve` already collapses them, but we reject
 *    the *input* form so a caller-supplied raw path with `..` cannot
 *    be silently rewritten to point at an unexpected location).
 *  - `HERON_DECLARED_SOURCE_CWD_ONLY=true` env opt-in restricts reads
 *    to subpaths of `process.cwd()`. Default: any readable path.
 *
 * Errors: clean, structural messages. Never echoes file contents
 * (parse errors include the path but not the bytes that failed to
 * parse — those bytes may carry pasted secrets).
 *
 * YAML support is INTENTIONALLY DEFERRED — adding a YAML parser
 * brings a parser surface with historical CVEs (js-yaml < 4 had
 * code-execution paths via `!!js/function` and friends). v1 is
 * JSON-only; the PR body documents the deferral.
 *
 * Tracking: https://linear.app/theona/issue/AAP-48
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, normalize, resolve, sep } from 'node:path';

import { stripControlChars } from '../../../util/markdown-escape.js';
import type {
  DeclaredInventory,
  DeclaredScope,
  DeclaredTool,
} from '../../types.js';
import type { DeclaredSourceError, DeclaredSourceResult } from './types.js';

/** File-size cap. JSON parser is not invoked on anything larger. */
export const MAX_FILE_SIZE_BYTES = 1024 * 1024;

/** Hard caps on declared inventory cardinality. */
export const MAX_TOOLS = 256;
export const MAX_SCOPES = 256;

/** Per-string length cap applied AFTER stripControlChars. */
const MAX_STRING_LEN = 512;

const KNOWN_TOP_LEVEL_KEYS = new Set(['agent', 'declared']);
const KNOWN_AGENT_KEYS = new Set(['name', 'purpose', 'owner', 'version']);
const KNOWN_DECLARED_KEYS = new Set(['tools', 'scopes']);

export interface ReadFileBackendArgs {
  path: string;
}

/**
 * Read and validate a declared-inventory file.
 *
 * Returns a `DeclaredSourceResult`. Never throws — every failure
 * mode (path violation, ENOENT, size, parse, schema) becomes a
 * typed `DeclaredSourceError`.
 */
export async function readDeclaredFromFile(
  args: ReadFileBackendArgs,
): Promise<DeclaredSourceResult> {
  // ─── Path safety ────────────────────────────────────────────────
  const pathCheck = validatePath(args.path);
  if (!pathCheck.ok) {
    return { ok: false, error: pathCheck.error };
  }
  const absPath = pathCheck.absPath;

  // ─── Size cap BEFORE read ───────────────────────────────────────
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch (err: unknown) {
    if (isNodeFsError(err) && err.code === 'ENOENT') {
      return {
        ok: false,
        error: {
          kind: 'not_found',
          message: `declared-source file not found: ${absPath}`,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: 'parse',
        message: `failed to stat declared-source file at ${absPath}`,
        cause: err,
      },
    };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      error: {
        kind: 'parse',
        message: `declared-source path is not a regular file: ${absPath}`,
      },
    };
  }
  if (stat.size > MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      error: {
        kind: 'parse',
        message: `declared-source file too large: ${stat.size} bytes exceeds 1 MiB size limit`,
      },
    };
  }

  // ─── Read + parse ───────────────────────────────────────────────
  let raw: string;
  try {
    raw = await fs.readFile(absPath, 'utf-8');
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        kind: 'parse',
        // Never echo `raw` — file contents may be secret. Path only.
        message: `failed to read declared-source file at ${absPath}`,
        cause: err,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // INTENTIONAL: do not echo the parse error's `position` substring
    // because some Node versions inline a snippet of the surrounding
    // bytes — which may contain pasted secrets.
    return {
      ok: false,
      error: {
        kind: 'parse',
        message: `declared-source file is not valid JSON: ${absPath}`,
      },
    };
  }

  // ─── Schema validation ──────────────────────────────────────────
  const validated = validateSchema(parsed);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  return {
    ok: true,
    inventory: validated.inventory,
    ...(validated.warnings.length > 0 ? { warnings: validated.warnings } : {}),
  };
}

// ─── Path validation ──────────────────────────────────────────────

function validatePath(
  input: string,
): { ok: true; absPath: string } | { ok: false; error: DeclaredSourceError } {
  if (typeof input !== 'string' || input.length === 0) {
    return invalid('declared-source file path must be a non-empty string');
  }

  // Reject `..` in any segment of the INPUT (defensive). `path.normalize`
  // collapses `..` segments — if we did not reject up-front, a caller
  // supplying `./safe/../../../etc/passwd` would silently resolve to
  // `/etc/passwd` with no warning. Surfacing the rejection lets a CLI
  // user fix the typo / spot the smuggle attempt.
  //
  // We check the INPUT segments (raw, before normalisation) rather
  // than the post-normalise form: `path.normalize('a/sub/../b')`
  // returns `a/b` on POSIX, so the `..` is gone by the time we'd
  // see it. The raw-input check is what catches the smuggle.
  // Split on either `/` or the platform `sep` so a caller using
  // POSIX-style paths on Windows is still gated.
  const rawSegments = input.split(/[/\\]/);
  if (rawSegments.includes('..')) {
    return invalid('declared-source file path must not contain ".." segments after normalization');
  }

  const normalised = normalize(input);
  const absPath = isAbsolute(normalised) ? normalised : resolve(normalised);

  // Opt-in CWD-only mode for hosted/sandboxed deployments.
  if (process.env.HERON_DECLARED_SOURCE_CWD_ONLY === 'true') {
    const cwd = process.cwd();
    const rel = resolve(absPath);
    // Pure prefix check is good enough — both sides are resolved to
    // absolute form, and `sep` is the platform separator.
    const cwdWithSep = cwd.endsWith(sep) ? cwd : cwd + sep;
    if (rel !== cwd && !rel.startsWith(cwdWithSep)) {
      return invalid(
        `declared-source file path must be inside the current working directory when HERON_DECLARED_SOURCE_CWD_ONLY=true (cwd=${cwd})`,
      );
    }
  }

  return { ok: true, absPath };
}

// ─── Schema validation ────────────────────────────────────────────

function validateSchema(
  value: unknown,
):
  | { ok: true; inventory: DeclaredInventory; warnings: string[] }
  | { ok: false; error: DeclaredSourceError } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return parseFail('top-level value must be a JSON object');
  }

  const obj = value as Record<string, unknown>;
  const warnings: string[] = [];

  // Lenient: unknown top-level keys → warning, NOT failure. Same for
  // unknown agent.* and declared.* sub-keys. Real customers will add
  // ad-hoc metadata fields ("team", "linear_ticket") and we don't
  // want to break their files.
  for (const k of Object.keys(obj)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(k)) {
      warnings.push(`unknown top-level key '${truncateForWarning(k)}' — ignored`);
    }
  }

  if (!obj.agent || typeof obj.agent !== 'object' || Array.isArray(obj.agent)) {
    return parseFail('agent block must be a JSON object');
  }
  const agent = obj.agent as Record<string, unknown>;
  for (const k of Object.keys(agent)) {
    if (!KNOWN_AGENT_KEYS.has(k)) {
      warnings.push(`unknown agent.${truncateForWarning(k)} key — ignored`);
    }
  }
  if (typeof agent.name !== 'string' || agent.name.trim().length === 0) {
    return parseFail('agent.name is required and must be a non-empty string');
  }

  let tools: DeclaredTool[] | undefined;
  let scopes: DeclaredScope[] | undefined;

  if (obj.declared !== undefined) {
    if (typeof obj.declared !== 'object' || Array.isArray(obj.declared) || obj.declared === null) {
      return parseFail('declared block must be a JSON object');
    }
    const decl = obj.declared as Record<string, unknown>;
    for (const k of Object.keys(decl)) {
      if (!KNOWN_DECLARED_KEYS.has(k)) {
        warnings.push(`unknown declared.${truncateForWarning(k)} key — ignored`);
      }
    }
    if (decl.tools !== undefined) {
      const r = validateTools(decl.tools);
      if (!r.ok) return r;
      tools = r.value;
    }
    if (decl.scopes !== undefined) {
      const r = validateScopes(decl.scopes);
      if (!r.ok) return r;
      scopes = r.value;
    }
  }

  const inventory: DeclaredInventory = {
    source: 'agent-declaration',
    capturedAt: new Date().toISOString(),
  };
  if (tools !== undefined) inventory.tools = tools;
  if (scopes !== undefined) inventory.scopes = scopes;

  return { ok: true, inventory, warnings };
}

function validateTools(
  value: unknown,
): { ok: true; value: DeclaredTool[] } | { ok: false; error: DeclaredSourceError } {
  if (!Array.isArray(value)) {
    return parseFail('declared.tools must be an array');
  }
  if (value.length > MAX_TOOLS) {
    return parseFail(`declared.tools array length ${value.length} exceeds limit of ${MAX_TOOLS}`);
  }
  const out: DeclaredTool[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return parseFail(`declared.tools[${i}] must be an object`);
    }
    const t = entry as Record<string, unknown>;
    if (typeof t.name !== 'string') {
      return parseFail(`declared.tools[${i}].name must be a string`);
    }
    const name = sanitiseString(t.name);
    if (name.length === 0) {
      return parseFail(`declared.tools[${i}].name must be a non-empty string after sanitisation`);
    }
    const tool: DeclaredTool = { name };
    if (t.description !== undefined) {
      if (typeof t.description !== 'string') {
        return parseFail(`declared.tools[${i}].description must be a string when present`);
      }
      tool.description = sanitiseString(t.description);
    }
    out.push(tool);
  }
  return { ok: true, value: out };
}

function validateScopes(
  value: unknown,
): { ok: true; value: DeclaredScope[] } | { ok: false; error: DeclaredSourceError } {
  if (!Array.isArray(value)) {
    return parseFail('declared.scopes must be an array');
  }
  if (value.length > MAX_SCOPES) {
    return parseFail(`declared.scopes array length ${value.length} exceeds limit of ${MAX_SCOPES}`);
  }
  const out: DeclaredScope[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return parseFail(`declared.scopes[${i}] must be an object`);
    }
    const s = entry as Record<string, unknown>;
    if (typeof s.service !== 'string') {
      return parseFail(`declared.scopes[${i}].service must be a string`);
    }
    const service = sanitiseString(s.service);
    if (service.length === 0) {
      return parseFail(`declared.scopes[${i}].service must be a non-empty string after sanitisation`);
    }
    if (typeof s.scope !== 'string') {
      return parseFail(`declared.scopes[${i}].scope must be a string`);
    }
    const scope = sanitiseString(s.scope);
    if (scope.length === 0) {
      return parseFail(`declared.scopes[${i}].scope must be a non-empty string after sanitisation`);
    }
    out.push({ service, scope });
  }
  return { ok: true, value: out };
}

/**
 * Owner-supplied string chokepoint. Same control-char strip set used
 * by the actual side (`stripControlChars`) so the declared inventory
 * carries the same hygiene guarantees as `ActualInventory`. Truncate
 * to `MAX_STRING_LEN` so a hostile file cannot push multi-MB strings
 * through the renderer.
 */
function sanitiseString(value: string): string {
  const stripped = stripControlChars(value);
  return stripped.length <= MAX_STRING_LEN ? stripped : stripped.slice(0, MAX_STRING_LEN);
}

/**
 * Cap a warning-payload string so an unknown key with a multi-MB
 * name (extreme malformed JSON) cannot blow up the rendered warning
 * list.
 */
function truncateForWarning(value: string): string {
  const stripped = stripControlChars(value);
  return stripped.length <= 64 ? stripped : stripped.slice(0, 64) + '...';
}

function invalid(message: string): { ok: false; error: DeclaredSourceError } {
  return { ok: false, error: { kind: 'invalid_config', message } };
}

function parseFail(message: string): { ok: false; error: DeclaredSourceError } {
  return { ok: false, error: { kind: 'parse', message } };
}

interface NodeFsError extends Error {
  code?: string;
}

function isNodeFsError(err: unknown): err is NodeFsError {
  return err instanceof Error && typeof (err as NodeFsError).code === 'string';
}
