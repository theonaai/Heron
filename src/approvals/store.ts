/**
 * File-backed approval store (AAP-48 — pilot deliverable #5).
 *
 * One JSON file per agent at `<baseDir>/<agentId>.json`. Default
 * `baseDir` is `<cwd>/.heron/approvals`, overridable via the
 * `HERON_APPROVALS_DIR` env or an explicit argument to the store
 * functions. The CLI surface (`heron approve`, `heron approvals
 * show`, `heron approvals verify`) wraps these primitives.
 *
 * Discipline (mirrors `verification/sources/agent-declaration/file.ts`):
 *  - Raw `..` / `/` / `\\` / `\0` check on agentId BEFORE any
 *    filesystem touch.
 *  - agentId regex `/^[A-Za-z0-9_.-]{1,128}$/` enforced.
 *  - `fs.realpath` re-check on the resolved chain path against the
 *    realpath of the baseDir, so a symlink that lives inside the
 *    approvals dir but points OUTSIDE the dir is rejected.
 *  - File size cap: 256 KiB. Reads larger than that fail before
 *    invoking the JSON parser.
 *  - Chain entry cap: 256. Append past that fails with
 *    `invalid_config`; load past that fails with `parse`.
 *  - Append is ATOMIC: write the new chain to a sibling `.tmp` file,
 *    then `fs.rename` over the final path. A crash mid-write leaves
 *    the prior chain intact; the .tmp file is best-effort cleaned up
 *    on a subsequent successful append.
 *  - Parse errors NEVER echo file bytes. Path-bearing messages quote
 *    only the operator-visible path (not realpath).
 *  - Unknown JSON keys at any level produce a COUNT-only warning
 *    (matches PR #19 fingerprint-prevention discipline) — never an
 *    echo of the unknown key name.
 *
 * Tamper-evidence:
 *  - Each entry past the first carries `prevHash = sha256(canonical(prev))`.
 *  - On read, the chain integrity is computed and a broken chain is
 *    surfaced as a warning (chain still returned so the operator
 *    can inspect what was tampered).
 *  - Hash chain is defence-in-depth on top of filesystem ACLs; it
 *    catches point edits, NOT a from-scratch rewrite by someone
 *    holding write permission. This trade-off is documented in
 *    `types.ts` and re-stated in the PR body.
 *
 * AIUC-1 mapping: E004 (assigned accountability) lives in
 * `entry.actor`; E015 (system activity logging) lives in the
 * append-only chain itself plus the hash chain that detects
 * point tampering on the APPROVAL lifecycle.
 *
 * Tracking: https://linear.app/theona/issue/AAP-48
 */

import { promises as fs } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { stripControlChars, stripControlCharsKeepWordBoundary } from '../util/markdown-escape.js';

import { canonicalize, hashEntry } from './canonical.js';
import type {
  ApprovalAction,
  ApprovalActor,
  ApprovalChain,
  ApprovalChainResult,
  ApprovalEntry,
  ApprovalStoreError,
  ChainIntegrityResult,
} from './types.js';

// ─── Caps & shapes ────────────────────────────────────────────────────

/** Cap on chain entries per agent. */
export const MAX_CHAIN_ENTRIES = 256;

/** Cap on file size (bytes). Reads larger than this fail before parse. */
export const MAX_CHAIN_FILE_BYTES = 256 * 1024;

/** Cap on evidenceRefs per entry. */
export const MAX_EVIDENCE_REFS = 32;

/** Cap on each evidenceRef string length (post-sanitise). */
export const MAX_EVIDENCE_REF_LEN = 256;

/** Cap on comment length (post-sanitise). */
export const MAX_COMMENT_LEN = 1024;

/** Cap on actor name / role / email length (post-sanitise). */
const MAX_ACTOR_STRING_LEN = 256;

/** Cap on agentLabel length (post-sanitise). */
const MAX_AGENT_LABEL_LEN = 256;

/**
 * agentId regex — alphanumeric + `_.-`, length 1..128. Matches the
 * path-safe character set used elsewhere in the codebase for
 * caller-supplied identifiers.
 */
const AGENT_ID_REGEX = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * Permitted lifecycle actions. Source of truth for action validation;
 * the type is in `types.ts` but the value-level enumeration lives here
 * so the validator can iterate it.
 */
const VALID_ACTIONS: ReadonlySet<ApprovalAction> = new Set([
  'declared',
  'reviewed',
  'approved',
  'revoked',
]);

/**
 * Strict email validator applied to the RAW input BEFORE
 * `stripControlChars` runs. Limits to the safe ASCII subset
 * commonly accepted by transport agents: alnum + `._%+-` in the
 * local-part, alnum + `.-` in the domain, and a TLD of two or
 * more letters.
 *
 * Round-2 (M1): the prior `[^\s@]+@[^\s@]+\.[^\s@]+` ran AFTER
 * sanitisation, so the operator could smuggle a tag through:
 * `a@b.c\n<script>` survived `stripControlChars` as `a@b.c<script>`,
 * which passed the lax regex because `<>` are non-whitespace
 * non-`@`. The strict class below explicitly excludes `<>[]\"'`
 * and anything outside the safe set; together with a control-char
 * pre-check (`stripControlChars(raw) !== raw`) it rejects the
 * smuggle on the raw form, so the sanitiser never converts a
 * hostile payload into a passing one.
 */
const EMAIL_REGEX = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

/**
 * Bracket / quote / backslash characters explicitly excluded from
 * the email validator. Listed separately from the regex so the
 * rejection path can give an operator a pointed error and so the
 * test suite has a fixed reference of disallowed characters.
 */
const EMAIL_DISALLOWED_CHARS = /[<>\[\]\\"'`]/;

/**
 * ISO-8601 timestamp must include an explicit timezone designator
 * (either `Z` or `±HH:MM`). Naive timestamps would silently shift
 * meaning when the operator's machine timezone changes; rejecting
 * up-front avoids that class of corruption.
 *
 * We do not try to fully parse the timestamp ourselves — `new Date(ts)`
 * does the heavy lifting. We only enforce the TZ-designator presence
 * via a regex check.
 */
const TZ_TAIL_REGEX = /(Z|[+-]\d{2}:\d{2})$/;

const TMP_SUFFIX = '.tmp';

const KNOWN_CHAIN_KEYS = new Set(['agentId', 'agentLabel', 'createdAt', 'entries']);
const KNOWN_ENTRY_KEYS = new Set([
  'action',
  'actor',
  'timestamp',
  'evidenceRefs',
  'comment',
  'prevHash',
]);
const KNOWN_ACTOR_KEYS = new Set(['name', 'role', 'email']);

// ─── Public helpers ───────────────────────────────────────────────────

/**
 * Resolve the approvals directory for an agent.
 *
 * Order of precedence:
 *  1. Explicit `baseDir` argument (used by tests + the
 *     `--approvals-dir` CLI flag).
 *  2. `HERON_APPROVALS_DIR` env var.
 *  3. Default: `<cwd>/.heron/approvals`.
 */
export function resolveApprovalsDir(baseDir?: string): string {
  if (baseDir && baseDir.length > 0) return resolve(baseDir);
  const envDir = process.env.HERON_APPROVALS_DIR;
  if (envDir && envDir.length > 0) return resolve(envDir);
  return resolve(process.cwd(), '.heron', 'approvals');
}

/**
 * Read the chain for `agentId`. Returns a typed result envelope —
 * never throws. Computes integrity on the way back; if any prevHash
 * is broken, returns the chain anyway with a warning so the CLI /
 * renderer can surface what was tampered.
 */
export async function readChain(
  agentId: string,
  baseDir?: string,
): Promise<ApprovalChainResult> {
  const idCheck = validateAgentId(agentId);
  if (!idCheck.ok) return { ok: false, error: idCheck.error };

  const dir = resolveApprovalsDir(baseDir);
  const filePath = join(dir, `${agentId}.json`);

  // ── Path realpath check — only when the file (and dir) exist.
  let effectivePath: string;
  try {
    effectivePath = await fs.realpath(filePath);
  } catch (err: unknown) {
    if (isNodeFsError(err) && err.code === 'ENOENT') {
      return {
        ok: false,
        error: {
          kind: 'not_found',
          message: `approval chain not found for agentId '${agentId}'`,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: 'io',
        message: `failed to resolve approval chain path for agentId '${agentId}'`,
        cause: err,
      },
    };
  }

  // Re-check the realpath is still inside the approvals dir's realpath.
  let realDir: string;
  try {
    realDir = await fs.realpath(dir);
  } catch {
    realDir = dir;
  }
  const realDirWithSep = realDir.endsWith(sep) ? realDir : realDir + sep;
  if (!effectivePath.startsWith(realDirWithSep)) {
    return invalid(
      `approval chain for agentId '${agentId}' resolves outside the approvals directory via symlink`,
    );
  }

  // ── Size cap before parse.
  let stat;
  try {
    stat = await fs.stat(effectivePath);
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        kind: 'io',
        message: `failed to stat approval chain for agentId '${agentId}'`,
        cause: err,
      },
    };
  }
  if (!stat.isFile()) {
    return parseError(`approval chain path for agentId '${agentId}' is not a regular file`);
  }
  if (stat.size > MAX_CHAIN_FILE_BYTES) {
    return parseError(
      `approval chain for agentId '${agentId}' is ${stat.size} bytes, exceeds ${MAX_CHAIN_FILE_BYTES}-byte cap (256 KiB)`,
    );
  }

  // ── Read + parse.
  let raw: string;
  try {
    raw = await fs.readFile(effectivePath, 'utf-8');
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        kind: 'io',
        message: `failed to read approval chain for agentId '${agentId}'`,
        cause: err,
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // INTENTIONAL: do not echo `raw` — operator-pasted bytes may
    // contain secrets.
    return parseError(`approval chain for agentId '${agentId}' is not valid JSON`);
  }

  const validated = validateChainShape(parsed, agentId);
  if (!validated.ok) return { ok: false, error: validated.error };

  // ── Integrity check.
  const integrity = verifyChainIntegrity(validated.chain);
  const warnings: string[] = [];
  if (!integrity.ok) {
    warnings.push(
      `chain integrity broken at entry ${integrity.brokenAt} — ${integrity.reason}`,
    );
  }
  if (validated.warnings.length > 0) warnings.push(...validated.warnings);

  return warnings.length > 0
    ? { ok: true, chain: validated.chain, warnings }
    : { ok: true, chain: validated.chain };
}

/**
 * Append a new entry to the chain. Creates the chain file if it does
 * not exist. Computes `prevHash` from the canonical form of the prior
 * entry (or omits the field when this is the first entry).
 *
 * Atomicity:
 *  - Write the FULL new chain to `<file>.tmp`.
 *  - `fs.rename(<file>.tmp, <file>)` — atomic on POSIX.
 *  - If the rename throws, attempt to unlink the .tmp file; ignore
 *    cleanup failures.
 */
export async function appendEntry(
  agentId: string,
  entry: Omit<ApprovalEntry, 'prevHash'>,
  baseDir?: string,
): Promise<ApprovalChainResult> {
  const idCheck = validateAgentId(agentId);
  if (!idCheck.ok) return { ok: false, error: idCheck.error };

  const entryCheck = validateAndSanitiseEntry(entry);
  if (!entryCheck.ok) return { ok: false, error: entryCheck.error };
  const cleanEntry = entryCheck.entry;

  const dir = resolveApprovalsDir(baseDir);
  await fs.mkdir(dir, { recursive: true });

  // Load existing chain (if any). Avoid `readChain` here so we don't
  // pay for a full integrity check on every append; we re-validate
  // shape, but defer broken-chain detection to the explicit
  // `heron approvals verify` path.
  const filePath = join(dir, `${agentId}.json`);
  let existing: ApprovalChain | null = null;
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    if (raw.length > MAX_CHAIN_FILE_BYTES) {
      return parseError(
        `approval chain for agentId '${agentId}' exceeds ${MAX_CHAIN_FILE_BYTES}-byte cap (256 KiB); refuse to append`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return parseError(`approval chain for agentId '${agentId}' is not valid JSON; refuse to append`);
    }
    const validated = validateChainShape(parsed, agentId);
    if (!validated.ok) return { ok: false, error: validated.error };
    existing = validated.chain;
  } catch (err: unknown) {
    if (!(isNodeFsError(err) && err.code === 'ENOENT')) {
      return {
        ok: false,
        error: {
          kind: 'io',
          message: `failed to read existing approval chain for agentId '${agentId}'`,
          cause: err,
        },
      };
    }
  }

  // Cap check.
  const currentLen = existing?.entries.length ?? 0;
  if (currentLen >= MAX_CHAIN_ENTRIES) {
    return invalid(
      `approval chain for agentId '${agentId}' already has ${currentLen} entries (cap is ${MAX_CHAIN_ENTRIES}); refuse to append`,
    );
  }

  // Compute prevHash from the LAST existing entry's canonical form
  // (which strips its own prevHash). First-entry → omit.
  if (existing && existing.entries.length > 0) {
    const last = existing.entries[existing.entries.length - 1];
    cleanEntry.prevHash = hashEntry(last);
  }

  const newChain: ApprovalChain = existing
    ? {
        ...existing,
        entries: [...existing.entries, cleanEntry],
      }
    : {
        agentId,
        ...(cleanEntry.actor && cleanEntry.actor.name && cleanEntry.actor.role
          ? {}
          : {}),
        createdAt: cleanEntry.timestamp,
        entries: [cleanEntry],
      };

  // Atomic write: temp → rename.
  const tmpPath = `${filePath}${TMP_SUFFIX}`;
  const payload = JSON.stringify(newChain, null, 2);
  try {
    await fs.writeFile(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        kind: 'io',
        message: `failed to write temp file for approval chain '${agentId}'`,
        cause: err,
      },
    };
  }
  try {
    await fs.rename(tmpPath, filePath);
  } catch (err: unknown) {
    // Best-effort cleanup so we do not leave a `.tmp` artefact behind.
    try {
      await fs.unlink(tmpPath);
    } catch {
      // Ignore; the next successful append will overwrite.
    }
    return {
      ok: false,
      error: {
        kind: 'io',
        message: `failed to atomically rename approval chain '${agentId}'`,
        cause: err,
      },
    };
  }

  return { ok: true, chain: newChain };
}

/**
 * Walk the chain and verify every `prevHash` matches the canonical
 * SHA-256 of the prior entry. Returns the first broken index (and a
 * human-readable reason), or `ok: true` if the chain is intact.
 *
 * Empty chains and single-entry chains are trivially ok.
 */
export function verifyChainIntegrity(chain: ApprovalChain): ChainIntegrityResult {
  for (let i = 1; i < chain.entries.length; i++) {
    const prev = chain.entries[i - 1];
    const cur = chain.entries[i];
    const expected = hashEntry(prev);
    if (!cur.prevHash) {
      return {
        ok: false,
        brokenAt: i,
        reason: `entry ${i} is missing prevHash; expected ${expected}`,
      };
    }
    if (cur.prevHash !== expected) {
      return {
        ok: false,
        brokenAt: i,
        reason: `entry ${i} prevHash does not match canonical hash of entry ${i - 1}`,
      };
    }
  }
  // First entry must NOT carry a prevHash. A first entry with a
  // prevHash is suspicious — most likely the operator deleted entry 0
  // by hand without recomputing the rest.
  if (chain.entries.length > 0 && chain.entries[0].prevHash) {
    return {
      ok: false,
      brokenAt: 0,
      reason: 'first entry must not have a prevHash field',
    };
  }
  return { ok: true };
}

// ─── Validators ───────────────────────────────────────────────────────

function validateAgentId(
  agentId: unknown,
): { ok: true } | { ok: false; error: ApprovalStoreError } {
  if (typeof agentId !== 'string') {
    return invalid('agentId must be a string');
  }
  if (agentId.length === 0) {
    return invalid('agentId must be non-empty');
  }
  // Raw-form check: catch the smuggle BEFORE regex (the regex would
  // already reject `..` but failing here gives the operator a more
  // pointed error).
  if (
    agentId.includes('..') ||
    agentId.includes('/') ||
    agentId.includes('\\') ||
    agentId.includes('\0')
  ) {
    return invalid(
      `agentId must not contain '..', '/', '\\\\', or null bytes (got '${agentId}')`,
    );
  }
  if (!AGENT_ID_REGEX.test(agentId)) {
    return invalid(
      `agentId must match ${AGENT_ID_REGEX} (got '${agentId}')`,
    );
  }
  return { ok: true };
}

function validateAndSanitiseEntry(
  raw: Omit<ApprovalEntry, 'prevHash'>,
):
  | { ok: true; entry: ApprovalEntry }
  | { ok: false; error: ApprovalStoreError } {
  if (!raw || typeof raw !== 'object') {
    return invalid('entry must be an object');
  }

  // action
  if (typeof raw.action !== 'string') {
    return invalid('entry.action must be a string');
  }
  if (!VALID_ACTIONS.has(raw.action as ApprovalAction)) {
    return invalid(
      `entry.action must be one of: ${[...VALID_ACTIONS].join(', ')} (got '${raw.action}')`,
    );
  }
  const action = raw.action as ApprovalAction;

  // actor
  const actorCheck = validateAndSanitiseActor(raw.actor);
  if (!actorCheck.ok) return { ok: false, error: actorCheck.error };

  // timestamp
  if (typeof raw.timestamp !== 'string') {
    return invalid('entry.timestamp must be a string');
  }
  if (!TZ_TAIL_REGEX.test(raw.timestamp)) {
    return invalid(
      `entry.timestamp must include a timezone designator ('Z' or '±HH:MM'); got '${raw.timestamp}'`,
    );
  }
  const parsed = new Date(raw.timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return invalid(`entry.timestamp is not a valid ISO-8601 date (got '${raw.timestamp}')`);
  }
  const timestamp = raw.timestamp;

  // evidenceRefs (optional)
  let evidenceRefs: string[] | undefined;
  if (raw.evidenceRefs !== undefined) {
    if (!Array.isArray(raw.evidenceRefs)) {
      return invalid('entry.evidenceRefs must be an array of strings');
    }
    if (raw.evidenceRefs.length > MAX_EVIDENCE_REFS) {
      return invalid(
        `entry.evidenceRefs has ${raw.evidenceRefs.length} entries; cap is ${MAX_EVIDENCE_REFS}`,
      );
    }
    const out: string[] = [];
    for (let i = 0; i < raw.evidenceRefs.length; i++) {
      const r = raw.evidenceRefs[i];
      if (typeof r !== 'string') {
        return invalid(`entry.evidenceRefs[${i}] must be a string`);
      }
      // Round-2 Fix 3: evidence refs are long-form, multi-token
      // fields — preserve word boundaries so `report\nlink` becomes
      // `report link`, not `reportlink`.
      const sanitised = stripControlCharsKeepWordBoundary(r);
      if (sanitised.length === 0) {
        return invalid(`entry.evidenceRefs[${i}] is empty after sanitisation`);
      }
      if (sanitised.length > MAX_EVIDENCE_REF_LEN) {
        return invalid(
          `entry.evidenceRefs[${i}] has ${sanitised.length} chars; cap is ${MAX_EVIDENCE_REF_LEN}`,
        );
      }
      out.push(sanitised);
    }
    evidenceRefs = out;
  }

  // comment (optional)
  let comment: string | undefined;
  if (raw.comment !== undefined) {
    if (typeof raw.comment !== 'string') {
      return invalid('entry.comment must be a string when present');
    }
    // Round-2 Fix 3: comments are long-form prose — preserve word
    // boundaries so a `Hello\nworld` paste stays readable as
    // `Hello world` rather than silently joining to `Helloworld`.
    const sanitised = stripControlCharsKeepWordBoundary(raw.comment);
    if (sanitised.length > MAX_COMMENT_LEN) {
      return invalid(
        `entry.comment has ${sanitised.length} chars; cap is ${MAX_COMMENT_LEN}`,
      );
    }
    comment = sanitised;
  }

  const entry: ApprovalEntry = {
    action,
    actor: actorCheck.actor,
    timestamp,
  };
  if (evidenceRefs !== undefined) entry.evidenceRefs = evidenceRefs;
  if (comment !== undefined) entry.comment = comment;

  return { ok: true, entry };
}

function validateAndSanitiseActor(
  raw: unknown,
): { ok: true; actor: ApprovalActor } | { ok: false; error: ApprovalStoreError } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return invalid('entry.actor must be an object');
  }
  const actor = raw as Record<string, unknown>;
  if (typeof actor.name !== 'string') {
    return invalid('entry.actor.name must be a string');
  }
  if (typeof actor.role !== 'string') {
    return invalid('entry.actor.role must be a string');
  }
  const name = sanitiseShortString(actor.name);
  if (name.length === 0 || name.trim().length === 0) {
    return invalid('entry.actor.name must be non-empty after sanitisation');
  }
  const role = sanitiseShortString(actor.role);
  if (role.length === 0 || role.trim().length === 0) {
    return invalid('entry.actor.role must be non-empty after sanitisation');
  }

  const out: ApprovalActor = { name, role };
  if (actor.email !== undefined) {
    if (typeof actor.email !== 'string') {
      return invalid('entry.actor.email must be a string when present');
    }
    // ── Round-2 (M1): validate the RAW form FIRST.
    //
    // Reject if the raw input contains any control char or Unicode
    // line separator from the `stripControlChars` strip set — a
    // newline could otherwise carry an injected `<script>` past the
    // lax regex once stripped. Then reject any of the explicitly
    // disallowed punctuation (`<>[]\\"'`) on the raw form too,
    // since `stripControlChars` does NOT touch those and they have
    // no business being inside an email address.
    const raw = actor.email;
    if (raw.length === 0) {
      return invalid('entry.actor.email must be non-empty when present');
    }
    if (raw.length > MAX_ACTOR_STRING_LEN) {
      return invalid(
        `entry.actor.email has ${raw.length} chars; cap is ${MAX_ACTOR_STRING_LEN}`,
      );
    }
    if (stripControlChars(raw) !== raw) {
      return invalid(
        "entry.actor.email contains a control character or line separator; refusing to sanitise",
      );
    }
    if (EMAIL_DISALLOWED_CHARS.test(raw)) {
      return invalid(
        "entry.actor.email contains a disallowed character (one of <>[]\\\\\"'`); refusing",
      );
    }
    if (!EMAIL_REGEX.test(raw)) {
      return invalid(`entry.actor.email does not look like an email address (got '${raw}')`);
    }
    // Strict regex above already excludes whitespace and the disallowed
    // class, so sanitisation is a no-op safety net.
    out.email = sanitiseShortString(raw);
  }
  return { ok: true, actor: out };
}

/**
 * Validate the on-disk shape after `JSON.parse`. Returns the
 * sanitised `ApprovalChain` plus any non-fatal warnings (unknown-key
 * counts).
 */
function validateChainShape(
  parsed: unknown,
  agentId: string,
):
  | { ok: true; chain: ApprovalChain; warnings: string[] }
  | { ok: false; error: ApprovalStoreError } {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parseError(`approval chain for agentId '${agentId}' must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const warnings: string[] = [];

  const unknownTop = Object.keys(obj).filter(k => !KNOWN_CHAIN_KEYS.has(k));
  if (unknownTop.length > 0) {
    // Count-only — never echo the key names.
    warnings.push(`${unknownTop.length} unknown top-level key(s) ignored`);
  }

  if (typeof obj.agentId !== 'string') {
    return parseError(`approval chain for agentId '${agentId}': agentId field must be a string`);
  }
  if (obj.agentId !== agentId) {
    return parseError(
      `approval chain file for '${agentId}' contains a different agentId field; refusing to read`,
    );
  }
  if (typeof obj.createdAt !== 'string') {
    return parseError(`approval chain for agentId '${agentId}': createdAt must be a string`);
  }
  if (!Array.isArray(obj.entries)) {
    return parseError(`approval chain for agentId '${agentId}': entries must be an array`);
  }
  if (obj.entries.length > MAX_CHAIN_ENTRIES) {
    return parseError(
      `approval chain for agentId '${agentId}' has ${obj.entries.length} entries; cap is ${MAX_CHAIN_ENTRIES}`,
    );
  }

  let agentLabel: string | undefined;
  if (obj.agentLabel !== undefined) {
    if (typeof obj.agentLabel !== 'string') {
      return parseError(
        `approval chain for agentId '${agentId}': agentLabel must be a string when present`,
      );
    }
    const sanitised = stripControlChars(obj.agentLabel);
    if (sanitised.length > MAX_AGENT_LABEL_LEN) {
      return parseError(
        `approval chain for agentId '${agentId}': agentLabel exceeds ${MAX_AGENT_LABEL_LEN}-char cap`,
      );
    }
    agentLabel = sanitised;
  }

  // Validate each entry.
  const entries: ApprovalEntry[] = [];
  for (let i = 0; i < obj.entries.length; i++) {
    const rawEntry = obj.entries[i];
    const check = validateEntryShape(rawEntry, i, agentId);
    if (!check.ok) return { ok: false, error: check.error };
    if (check.warnings.length > 0) warnings.push(...check.warnings);
    entries.push(check.entry);
  }

  const chain: ApprovalChain = {
    agentId,
    createdAt: obj.createdAt,
    entries,
  };
  if (agentLabel !== undefined) chain.agentLabel = agentLabel;

  return { ok: true, chain, warnings };
}

function validateEntryShape(
  raw: unknown,
  index: number,
  agentId: string,
):
  | { ok: true; entry: ApprovalEntry; warnings: string[] }
  | { ok: false; error: ApprovalStoreError } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return parseError(
      `approval chain for agentId '${agentId}': entries[${index}] must be an object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const warnings: string[] = [];

  const unknownEntryKeys = Object.keys(obj).filter(k => !KNOWN_ENTRY_KEYS.has(k));
  if (unknownEntryKeys.length > 0) {
    warnings.push(`${unknownEntryKeys.length} unknown entry key(s) at entries[${index}] ignored`);
  }
  if (obj.actor && typeof obj.actor === 'object' && !Array.isArray(obj.actor)) {
    const unknownActorKeys = Object.keys(obj.actor as Record<string, unknown>).filter(
      k => !KNOWN_ACTOR_KEYS.has(k),
    );
    if (unknownActorKeys.length > 0) {
      warnings.push(
        `${unknownActorKeys.length} unknown actor key(s) at entries[${index}] ignored`,
      );
    }
  }

  // Sanitise via the same validator used on the append path. The
  // append-path validator returns `invalid_config` on schema failure;
  // for a load path we want `parse` so callers branch correctly.
  // Translate the kind here.
  const partial: Omit<ApprovalEntry, 'prevHash'> = {
    action: obj.action as ApprovalAction,
    actor: obj.actor as ApprovalActor,
    timestamp: obj.timestamp as string,
    ...(obj.evidenceRefs !== undefined ? { evidenceRefs: obj.evidenceRefs as string[] } : {}),
    ...(obj.comment !== undefined ? { comment: obj.comment as string } : {}),
  };
  const sanity = validateAndSanitiseEntry(partial);
  if (!sanity.ok) {
    return parseError(
      `approval chain for agentId '${agentId}': entries[${index}] ${sanity.error.message}`,
    );
  }
  const entry = sanity.entry;
  if (obj.prevHash !== undefined) {
    if (typeof obj.prevHash !== 'string' || !/^[0-9a-f]{64}$/.test(obj.prevHash)) {
      return parseError(
        `approval chain for agentId '${agentId}': entries[${index}].prevHash must be 64 lowercase hex chars`,
      );
    }
    entry.prevHash = obj.prevHash;
  }
  return { ok: true, entry, warnings };
}

// ─── Internal helpers ─────────────────────────────────────────────────

function sanitiseShortString(value: string): string {
  const stripped = stripControlChars(value);
  return stripped.length <= MAX_ACTOR_STRING_LEN
    ? stripped
    : stripped.slice(0, MAX_ACTOR_STRING_LEN);
}

function invalid(message: string): { ok: false; error: ApprovalStoreError } {
  return { ok: false, error: { kind: 'invalid_config', message } };
}

function parseError(message: string): { ok: false; error: ApprovalStoreError } {
  return { ok: false, error: { kind: 'parse', message } };
}

interface NodeFsError extends Error {
  code?: string;
}

function isNodeFsError(err: unknown): err is NodeFsError {
  return err instanceof Error && typeof (err as NodeFsError).code === 'string';
}

// Exported only for tests; not part of the public CLI surface.
export const __INTERNAL = {
  canonicalize,
  hashEntry,
  AGENT_ID_REGEX,
  VALID_ACTIONS,
  TZ_TAIL_REGEX,
  EMAIL_REGEX,
};

// Re-export local helper for callers that need the dirname-of-file shape.
export const _tmpPathFor = (file: string): string => `${file}${TMP_SUFFIX}`;
export const _dirnameOf = (file: string): string => dirname(file);
