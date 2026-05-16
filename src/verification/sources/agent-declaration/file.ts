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
 *  - Round-2 HIGH fix: under CWD-only, the absolute path passes a
 *    cheap string-prefix check first, then `fs.realpath` resolves any
 *    symlinks and the result is re-checked against `cwd + sep`. A
 *    symlink whose path lives under CWD but whose target lives
 *    outside is rejected. All downstream `stat` / `readFile` calls
 *    use the realpath, not the original absolute path — otherwise a
 *    TOCTOU window between the check and the read would let a
 *    swapped symlink slip past.
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
  DeclaredAgentInfo,
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
  const pathCheck = await validatePath(args.path);
  if (!pathCheck.ok) {
    return { ok: false, error: pathCheck.error };
  }
  // `originalPath` is the path the operator supplied (post-resolve).
  // `effectivePath` is what we ACTUALLY touch on disk: under CWD-only
  // mode it is the realpath (TOCTOU-safe re-check against CWD); under
  // the default mode it is the operator's resolved path.
  // Error messages always reference `originalPath`, never the realpath,
  // so we do not disclose what a symlink resolves to.
  const originalPath = pathCheck.absPath;
  const effectivePath = pathCheck.effectivePath;

  // ─── Size cap BEFORE read ───────────────────────────────────────
  let stat;
  try {
    stat = await fs.stat(effectivePath);
  } catch (err: unknown) {
    if (isNodeFsError(err) && err.code === 'ENOENT') {
      return {
        ok: false,
        error: {
          kind: 'not_found',
          message: `declared-source file not found: ${originalPath}`,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: 'parse',
        message: `failed to stat declared-source file at ${originalPath}`,
        cause: err,
      },
    };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      error: {
        kind: 'parse',
        message: `declared-source path is not a regular file: ${originalPath}`,
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
    raw = await fs.readFile(effectivePath, 'utf-8');
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        kind: 'parse',
        // Never echo `raw` — file contents may be secret. Path only.
        message: `failed to read declared-source file at ${originalPath}`,
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
        message: `declared-source file is not valid JSON: ${originalPath}`,
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

async function validatePath(
  input: string,
): Promise<
  | { ok: true; absPath: string; effectivePath: string }
  | { ok: false; error: DeclaredSourceError }
> {
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

  // Default: no realpath resolution — read at the operator's path. The
  // realpath defence only fires under CWD-only mode because that mode is
  // the one that ADVERTISES sandboxing, and an operator who flipped that
  // switch reasonably believes a symlink inside the directory cannot
  // smuggle a read past the sandbox boundary.
  let effectivePath = absPath;

  // Opt-in CWD-only mode for hosted/sandboxed deployments.
  if (process.env.HERON_DECLARED_SOURCE_CWD_ONLY === 'true') {
    const cwd = process.cwd();
    const cwdWithSep = cwd.endsWith(sep) ? cwd : cwd + sep;

    // ── First gate: cheap string-prefix check on the lexical path.
    // Rejects `/etc/passwd` and friends without touching the FS, so a
    // hostile path cannot trigger a useful timing oracle via the
    // realpath syscall on a sensitive directory.
    if (absPath !== cwd && !absPath.startsWith(cwdWithSep)) {
      return invalid(
        `declared-source file path must be inside the current working directory when HERON_DECLARED_SOURCE_CWD_ONLY=true (cwd=${cwd})`,
      );
    }

    // ── Second gate: resolve symlinks and re-check. A symlink whose
    // own path lives under CWD but whose target lives OUTSIDE CWD
    // would slip through the prefix check but fail this one. macOS
    // `os.tmpdir()` is itself behind a symlink (`/var/folders/...`
    // resolves to `/private/var/folders/...`), so we ALSO realpath
    // the CWD to compare canonical forms.
    //
    // We use the realpath result for all downstream stat / readFile
    // calls (TOCTOU: between the check here and the stat below, the
    // symlink could be swapped to point elsewhere; reading by realpath
    // closes that window).
    let realPath: string;
    try {
      realPath = await fs.realpath(absPath);
    } catch (err: unknown) {
      if (isNodeFsError(err) && err.code === 'ENOENT') {
        // Surface as not-found at the operator's path. Do not disclose
        // any partial resolution.
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
          message: `failed to resolve declared-source file path: ${absPath}`,
          cause: err,
        },
      };
    }

    let realCwd: string;
    try {
      realCwd = await fs.realpath(cwd);
    } catch {
      // If we cannot realpath the CWD itself, fall back to the lexical
      // CWD — the prefix check above already ran against it.
      realCwd = cwd;
    }
    const realCwdWithSep = realCwd.endsWith(sep) ? realCwd : realCwd + sep;

    if (realPath !== realCwd && !realPath.startsWith(realCwdWithSep)) {
      // INTENTIONAL: error message does NOT include `realPath`. Disclosing
      // it would tell an operator (or anyone reading logs) where the
      // symlink pointed — a step toward the very fingerprint we are
      // trying to prevent. Quote only the operator's original path.
      return invalid(
        `declared-source file path resolves to a location outside the current working directory via symlink when HERON_DECLARED_SOURCE_CWD_ONLY=true (path=${absPath}, cwd=${cwd})`,
      );
    }

    effectivePath = realPath;
  }

  return { ok: true, absPath, effectivePath };
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
  //
  // Round-2 HIGH fix: emit a COUNT of unknown keys, never the literal
  // key names. The previous behaviour echoed each name (e.g. "unknown
  // top-level key 'private_key_id' — ignored"). When an operator
  // accidentally pointed the source at a gcloud service-account JSON,
  // the warning stream would list `project_id`, `private_key_id`,
  // `client_email`, etc. — fingerprinting the file type even though no
  // values were echoed. Count-only wording preserves operator
  // feedback ("something was ignored, check your file") without
  // disclosing the SHAPE of the file.
  const unknownTopKeys = Object.keys(obj).filter((k) => !KNOWN_TOP_LEVEL_KEYS.has(k));
  if (unknownTopKeys.length > 0) {
    warnings.push(
      `${unknownTopKeys.length} unknown top-level key(s) ignored`,
    );
  }

  if (!obj.agent || typeof obj.agent !== 'object' || Array.isArray(obj.agent)) {
    return parseFail('agent block must be a JSON object');
  }
  const agent = obj.agent as Record<string, unknown>;
  const unknownAgentKeys = Object.keys(agent).filter((k) => !KNOWN_AGENT_KEYS.has(k));
  if (unknownAgentKeys.length > 0) {
    warnings.push(`${unknownAgentKeys.length} unknown agent.* key(s) ignored`);
  }
  if (typeof agent.name !== 'string' || agent.name.trim().length === 0) {
    return parseFail('agent.name is required and must be a non-empty string');
  }

  // AAP-51: capture the agent metadata block onto the returned
  // inventory so the HR-pack detectors can read `purpose`,`owner`, and
  // the DPO exec summary can render `name` + `owner`. The file
  // backend was already validating this block (KNOWN_AGENT_KEYS) but
  // discarding the parsed values prior to AAP-51.
  //
  // Sanitise each field through the same chokepoint as tools/scopes
  // (`sanitiseString`: strip control chars + cap at 512). `name` is
  // already validated as non-empty above; sanitise idempotently here
  // so the inventory carries the clean form.
  const agentInfo: DeclaredAgentInfo = { name: sanitiseString(agent.name) };
  if (typeof agent.purpose === 'string') {
    const p = sanitiseString(agent.purpose);
    if (p.length > 0) agentInfo.purpose = p;
  }
  if (typeof agent.owner === 'string') {
    const o = sanitiseString(agent.owner);
    if (o.length > 0) agentInfo.owner = o;
  }
  if (typeof agent.version === 'string') {
    const v = sanitiseString(agent.version);
    if (v.length > 0) agentInfo.version = v;
  }

  let tools: DeclaredTool[] | undefined;
  let scopes: DeclaredScope[] | undefined;

  if (obj.declared !== undefined) {
    if (typeof obj.declared !== 'object' || Array.isArray(obj.declared) || obj.declared === null) {
      return parseFail('declared block must be a JSON object');
    }
    const decl = obj.declared as Record<string, unknown>;
    const unknownDeclaredKeys = Object.keys(decl).filter((k) => !KNOWN_DECLARED_KEYS.has(k));
    if (unknownDeclaredKeys.length > 0) {
      warnings.push(`${unknownDeclaredKeys.length} unknown declared.* key(s) ignored`);
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
    agent: agentInfo,
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
  // Round-2 Fix 5: reject duplicate tool names as a parse error. Diff
  // semantics on duplicates are undefined — does the second entry
  // shadow the first, append, or fail? Reject up-front so the operator
  // owns the resolution. Dedup key is the post-sanitisation name (so
  // `send_email` and `send_email<ZWSP>` collide after Fix 3 strips the
  // zero-width char).
  const seenToolNames = new Set<string>();
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
    // Round-2 Fix 4: also reject whitespace-only names. The
    // `agent.name` validation already does `.trim()` (line above the
    // tools handler); apply the same rule to tool names for symmetry
    // and so a `{"name": "   "}` entry cannot survive into the diff
    // as a blank-rendered row.
    if (name.trim().length === 0) {
      return parseFail(`declared.tools[${i}].name must contain non-whitespace characters`);
    }
    // Round-2 Fix 5: duplicate detection. Names compared post-sanitise
    // because that's the form that lands in the diff.
    if (seenToolNames.has(name)) {
      return parseFail(`declared.tools[${i}].name '${name}' is a duplicate — tool names must be unique`);
    }
    seenToolNames.add(name);
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
  // Round-2 Fix 5: dedup key is `service:scope`. A scope value like
  // `gmail.readonly` repeated on the SAME service is a real duplicate;
  // repeated across different services is NOT (e.g. a custom
  // `gmail.readonly` token on a non-Google service is a different
  // grant). Use a separator byte (`\x00`) not present in either
  // sanitised form so `a:b` + `c` cannot collide with `a` + `b:c`.
  const seenScopeKeys = new Set<string>();
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
    // Round-2 Fix 4: reject whitespace-only service.
    if (service.trim().length === 0) {
      return parseFail(`declared.scopes[${i}].service must contain non-whitespace characters`);
    }
    if (typeof s.scope !== 'string') {
      return parseFail(`declared.scopes[${i}].scope must be a string`);
    }
    const scope = sanitiseString(s.scope);
    if (scope.length === 0) {
      return parseFail(`declared.scopes[${i}].scope must be a non-empty string after sanitisation`);
    }
    // Round-2 Fix 4: reject whitespace-only scope.
    if (scope.trim().length === 0) {
      return parseFail(`declared.scopes[${i}].scope must contain non-whitespace characters`);
    }
    // Round-2 Fix 5: duplicate (service, scope) pair → parse error.
    // `\x00` is stripped by sanitiseString so it cannot appear inside
    // either side; safe as a delimiter.
    const dedupKey = `${service}\x00${scope}`;
    if (seenScopeKeys.has(dedupKey)) {
      return parseFail(`declared.scopes[${i}] '${service}:${scope}' is a duplicate — (service, scope) pairs must be unique`);
    }
    seenScopeKeys.add(dedupKey);
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
