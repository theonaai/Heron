/**
 * Local-files audit-session store.
 *
 * Replaces Heron_v1's Supabase-backed `audit_sessions` table with a tiny
 * filesystem-rooted store. Designed for a single-user CLI tool: no auth,
 * no concurrency control beyond atomic renames, no SQL.
 *
 * On disk under `getSessionsDir()`:
 *
 *   <sessions-dir>/
 *     sess-YYYYMMDD-HHMMSS-xxxxxx/
 *       meta.json         — AuditSession base fields + deletedAt flag
 *       transcript.jsonl  — append-only one JSON object per line
 *       report.md         — present once status === 'complete'
 *       report.json       — structured report (any JSON value)
 *
 * All writes go through `atomicWrite`: write to `*.tmp-<pid>-<rand>`, fsync,
 * rename. The parent directory is created with mode 0700, every file with
 * mode 0600. This matches the single-user-private-data threat model: the OS
 * keeps everything else out, we don't try to defend against same-user
 * processes.
 */

import { randomBytes } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
  appendFile,
  open,
  chmod,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Persisted session lifecycle states.
 *
 * AAP-55 added `awaiting_answer`: the tool-call interview path is alive
 * but waiting for the caller to invoke `submit_answer` with the next
 * answer. Different from `interviewing`, which means an MCP sampling
 * background loop is driving the questions itself.
 *
 * AAP-56 added `analysis_failed`: the interview completed but the analyzer
 * could not produce a structured report (double-parse failure or unreachable
 * LLM gateway). Surfaced loudly in the dashboard via a red banner / pill so
 * a reviewer cannot mistake a broken run for a clean audit.
 */
export type AuditSessionStatus =
  | 'interviewing'
  | 'analyzing'
  | 'complete'
  | 'analysis_failed'
  | 'error'
  | 'awaiting_answer';

/** Which interview path is driving the session. Optional for legacy rows. */
export type AuditSessionMode = 'sampling' | 'tool-call';

/**
 * AAP-55 — the question the planner is currently waiting on. Persisted
 * so the tool-call path survives a process restart between
 * `start_audit_session` and the first `submit_answer` call.
 */
export interface PendingQuestion {
  text: string;
  category: string;
  index: number;
}

/**
 * AAP-56: diagnostic envelope persisted alongside a session whose analyzer
 * step failed. Surfaced verbatim in the dashboard's "Analysis failed" banner
 * and in the failure-mode markdown report.
 */
export interface AnalysisErrorRecord {
  reason: 'parse_failure' | 'llm_unreachable' | 'unknown';
  message: string;
  responsePreview?: string;
  attemptCount: number;
  occurredAt: string;
}

export interface AuditSession {
  id: string;
  status: AuditSessionStatus;
  questionsAsked: number;
  riskLevel?: string;
  agentName?: string;
  createdAt: string;
  updatedAt: string;
  /** AAP-55 — undefined for legacy sampling rows persisted before this field existed. */
  mode?: AuditSessionMode;
  /** AAP-55 — non-null while the tool-call path is waiting for an answer. */
  pendingQuestion?: PendingQuestion | null;
  /**
   * AAP-58 — absolute workspace paths the calling MCP client advertised
   * via `_meta['x-codex-turn-metadata'].workspaces`. The dashboard's
   * "Run verification" path consults this list when no explicit
   * workspaceRoot is sent from the browser, so we no longer fall through
   * to `process.cwd()` (Heron's own checkout) for the scan target.
   * Idempotent merge — duplicate entries are deduped before write.
   */
  workspaceHints?: string[];
  /**
   * AAP-56: present when `status === 'analysis_failed'`. Null/undefined
   * otherwise. Carries the diagnostic envelope from `analyzeTranscript` so
   * UI consumers can render reason + last error + occurredAt.
   */
  analysisError?: AnalysisErrorRecord | null;
}

export interface TranscriptEntry {
  category: string;
  question: string;
  answer: string;
}

export interface AuditSessionDetail extends AuditSession {
  transcript: TranscriptEntry[];
  report?: string;
  reportJson?: unknown;
  viewerRole?: 'owner' | 'grantee';
  mode?: AuditSessionMode;
  pendingQuestion?: PendingQuestion | null;
  workspaceHints?: string[];
}

/**
 * Mutable subset of meta we accept via updateSessionMeta. Unknown fields are
 * silently dropped. We deliberately do not let callers patch `id`,
 * `createdAt`, `questionsAsked`, or `deletedAt` through this entry point.
 */
export interface SessionMetaPatch {
  status?: AuditSessionStatus;
  riskLevel?: string;
  agentName?: string;
}

interface StoredMeta extends AuditSession {
  deletedAt?: string;
  mode?: AuditSessionMode;
  pendingQuestion?: PendingQuestion | null;
  workspaceHints?: string[];
  // riskLevel inherited from AuditSession is `string | undefined`. We
  // intentionally allow re-assigning to `undefined` to wipe a stale value
  // on a re-run (e.g. writeAnalysisFailure clears it). JSON.stringify drops
  // `undefined` keys, so the field disappears from disk cleanly.
}

export const SESSION_ID_REGEX = /^sess-\d{8}-\d{6}-[a-z0-9]{6}$/;
const META_PATCH_FIELDS: Array<keyof SessionMetaPatch> = ['status', 'riskLevel', 'agentName'];

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Resolve the active sessions directory. `HERON_SESSIONS_DIR` overrides. */
export function getSessionsDir(): string {
  const override = process.env.HERON_SESSIONS_DIR;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), '.heron', 'sessions');
}

function assertValidId(id: string): void {
  if (!SESSION_ID_REGEX.test(id)) {
    throw new Error(`Invalid session id: ${id}`);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function generateSessionId(date = new Date()): string {
  const y = date.getUTCFullYear().toString().padStart(4, '0');
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  const hh = date.getUTCHours().toString().padStart(2, '0');
  const mm = date.getUTCMinutes().toString().padStart(2, '0');
  const ss = date.getUTCSeconds().toString().padStart(2, '0');
  const suffix = randomBytes(4).toString('hex').slice(0, 6);
  return `sess-${y}${m}${d}-${hh}${mm}${ss}-${suffix}`;
}

async function ensureSessionsDir(): Promise<string> {
  const dir = getSessionsDir();
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  // mkdir({ mode }) honours mode only on initial creation; chmod every time
  // to handle the "directory already existed at a wider mode" case.
  try {
    await chmod(dir, DIR_MODE);
  } catch {
    // Non-POSIX filesystems (e.g. some Windows configurations) may reject
    // chmod. Tolerate — permissions are best-effort on those platforms.
  }
  return dir;
}

async function atomicWriteFile(target: string, contents: string | Buffer): Promise<void> {
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(3).toString('hex')}`;
  // open + write + fsync + close, then rename. The rename is atomic on POSIX.
  const handle = await open(tmp, 'w', FILE_MODE);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, target);
  try {
    await chmod(target, FILE_MODE);
  } catch {
    // ignore — see ensureSessionsDir comment
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

async function writeMeta(id: string, meta: StoredMeta): Promise<void> {
  const dir = await ensureSessionsDir();
  await mkdir(join(dir, id), { recursive: true, mode: DIR_MODE });
  await atomicWriteFile(join(dir, id, 'meta.json'), JSON.stringify(meta, null, 2));
}

async function readMeta(id: string): Promise<StoredMeta | null> {
  if (!SESSION_ID_REGEX.test(id)) return null;
  const dir = getSessionsDir();
  return readJson<StoredMeta>(join(dir, id, 'meta.json'));
}

async function readTranscript(id: string): Promise<TranscriptEntry[]> {
  if (!SESSION_ID_REGEX.test(id)) return [];
  const path = join(getSessionsDir(), id, 'transcript.jsonl');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: TranscriptEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as TranscriptEntry;
      if (
        parsed &&
        typeof parsed.category === 'string' &&
        typeof parsed.question === 'string' &&
        typeof parsed.answer === 'string'
      ) {
        out.push(parsed);
      }
    } catch {
      // Corrupt line — skip rather than fail the whole session read.
    }
  }
  return out;
}

// ─── Public API ───────────────────────────────────────────────────────────

export async function createSession(
  input: {
    agentName?: string;
    mode?: AuditSessionMode;
    /** AAP-58 — absolute workspace paths the calling MCP client advertised. */
    workspaceHints?: string[];
  } = {},
): Promise<{ id: string }> {
  await ensureSessionsDir();
  const id = generateSessionId();
  const now = nowIso();
  const initialStatus: AuditSessionStatus =
    input.mode === 'tool-call' ? 'awaiting_answer' : 'interviewing';
  const meta: StoredMeta = {
    id,
    status: initialStatus,
    questionsAsked: 0,
    createdAt: now,
    updatedAt: now,
  };
  if (input.agentName && input.agentName.length > 0) {
    meta.agentName = input.agentName;
  }
  if (input.mode !== undefined) {
    meta.mode = input.mode;
  }
  const hints = sanitizeWorkspaceHints(input.workspaceHints);
  if (hints.length > 0) {
    meta.workspaceHints = hints;
  }
  await writeMeta(id, meta);
  return { id };
}

/**
 * AAP-58 — strip invalid entries and dedupe the workspace-hints list.
 *
 * Only absolute paths survive: anything that doesn't start with `/`,
 * contains `..`, or looks like a URL path is dropped on the floor.
 * Validation is intentionally permissive here — the scan API does the
 * final fs.stat existence check, and we don't want to lose a hint just
 * because the directory disappeared between session-start and scan.
 */
function sanitizeWorkspaceHints(input: string[] | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (!trimmed.startsWith('/')) continue;
    if (trimmed.includes('..')) continue;
    if (trimmed.includes('/dashboard/')) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * AAP-58 — idempotent merge of new workspace hints into an existing
 * session. Called by `submit_answer` so subsequent MCP turns can keep
 * advertising the workspaces they're operating against. Existing hints
 * are preserved; new ones are appended in order; duplicates are skipped.
 */
export async function mergeWorkspaceHints(
  id: string,
  hints: string[],
): Promise<void> {
  assertValidId(id);
  const meta = await readMeta(id);
  if (!meta) throw new Error(`Session not found: ${id}`);
  const sanitised = sanitizeWorkspaceHints(hints);
  if (sanitised.length === 0) return;
  const existing = sanitizeWorkspaceHints(meta.workspaceHints ?? []);
  const merged = sanitizeWorkspaceHints([...existing, ...sanitised]);
  // Skip the write if nothing changed.
  if (
    merged.length === existing.length &&
    merged.every((v, i) => v === existing[i])
  ) {
    return;
  }
  const next: StoredMeta = {
    ...meta,
    workspaceHints: merged,
    updatedAt: nowIso(),
  };
  await writeMeta(id, next);
}

export async function getSession(id: string): Promise<AuditSessionDetail | null> {
  const meta = await readMeta(id);
  if (!meta) return null;
  const transcript = await readTranscript(id);
  const dir = join(getSessionsDir(), id);
  const reportMd = await readFile(join(dir, 'report.md'), 'utf8').catch(() => undefined);
  const reportJson = await readJson<unknown>(join(dir, 'report.json'));
  const detail: AuditSessionDetail = {
    id: meta.id,
    status: meta.status,
    questionsAsked: meta.questionsAsked,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    transcript,
    viewerRole: 'owner',
  };
  if (meta.agentName !== undefined) detail.agentName = meta.agentName;
  if (meta.riskLevel !== undefined) detail.riskLevel = meta.riskLevel;
  if (meta.mode !== undefined) detail.mode = meta.mode;
  if (meta.pendingQuestion !== undefined) detail.pendingQuestion = meta.pendingQuestion;
  if (meta.workspaceHints !== undefined) detail.workspaceHints = meta.workspaceHints;
  if (meta.analysisError !== undefined) detail.analysisError = meta.analysisError;
  if (reportMd !== undefined) detail.report = reportMd;
  if (reportJson !== null) detail.reportJson = reportJson;
  return detail;
}

export async function listSessions(): Promise<AuditSession[]> {
  const dir = getSessionsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: AuditSession[] = [];
  for (const name of entries) {
    if (!SESSION_ID_REGEX.test(name)) continue;
    let st;
    try {
      st = await stat(join(dir, name));
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const meta = await readMeta(name);
    if (!meta) continue;
    if (meta.deletedAt) continue;
    const summary: AuditSession = {
      id: meta.id,
      status: meta.status,
      questionsAsked: meta.questionsAsked,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    };
    if (meta.agentName !== undefined) summary.agentName = meta.agentName;
    if (meta.riskLevel !== undefined) summary.riskLevel = meta.riskLevel;
    if (meta.analysisError !== undefined) summary.analysisError = meta.analysisError;
    out.push(summary);
  }
  // Newest first by updatedAt; fall back to createdAt for ties.
  out.sort((a, b) => {
    const av = a.updatedAt || a.createdAt;
    const bv = b.updatedAt || b.createdAt;
    if (av === bv) return 0;
    return av < bv ? 1 : -1;
  });
  return out;
}

export async function updateSessionMeta(id: string, patch: SessionMetaPatch): Promise<void> {
  assertValidId(id);
  const meta = await readMeta(id);
  if (!meta) throw new Error(`Session not found: ${id}`);
  const next: StoredMeta = { ...meta };
  for (const key of META_PATCH_FIELDS) {
    const val = patch[key];
    if (val !== undefined) {
      // Cast through unknown to satisfy TS: each key has a different concrete
      // type in StoredMeta but we've already restricted to the patch fields.
      (next as unknown as Record<string, unknown>)[key] = val;
    }
  }
  next.updatedAt = nowIso();
  await writeMeta(id, next);
}

export async function appendTranscriptEntry(
  id: string,
  entry: TranscriptEntry,
): Promise<void> {
  assertValidId(id);
  const meta = await readMeta(id);
  if (!meta) throw new Error(`Session not found: ${id}`);
  const dir = await ensureSessionsDir();
  await mkdir(join(dir, id), { recursive: true, mode: DIR_MODE });
  const path = join(dir, id, 'transcript.jsonl');
  // appendFile is not atomic across processes, but for a single-user CLI
  // with sequential writes the worst case is a partial line — which
  // readTranscript already tolerates by skipping unparseable lines.
  await appendFile(path, JSON.stringify(entry) + '\n', { mode: FILE_MODE });
  try {
    await chmod(path, FILE_MODE);
  } catch {
    // ignore
  }
  const next: StoredMeta = {
    ...meta,
    questionsAsked: meta.questionsAsked + 1,
    updatedAt: nowIso(),
  };
  await writeMeta(id, next);
}

export async function writeReport(
  id: string,
  payload: { markdown: string; json: unknown },
): Promise<void> {
  assertValidId(id);
  const meta = await readMeta(id);
  if (!meta) throw new Error(`Session not found: ${id}`);
  const dir = await ensureSessionsDir();
  await mkdir(join(dir, id), { recursive: true, mode: DIR_MODE });
  await atomicWriteFile(join(dir, id, 'report.md'), payload.markdown);
  await atomicWriteFile(join(dir, id, 'report.json'), JSON.stringify(payload.json, null, 2));
  const next: StoredMeta = {
    ...meta,
    status: 'complete',
    // AAP-56: clear any prior analysisError on a successful re-run. Today's
    // pipeline doesn't re-run a failed session, but writeReport's contract
    // is "this run succeeded" — leave no stale failure envelope behind.
    analysisError: null,
    updatedAt: nowIso(),
  };
  await writeMeta(id, next);
}

/**
 * AAP-56: persist an explicit analysis failure.
 *
 * Sets `session.status = 'analysis_failed'`, stores the diagnostic envelope
 * on `analysisError`, writes the failure-mode markdown to `report.md`, and
 * — critically — does NOT write `report.json`. The absence of report.json
 * tells the dashboard "there is no analysis to render"; it falls through
 * to the markdown-only path and surfaces the red "Analysis failed" banner.
 *
 * Atomic write semantics match `writeReport`: tmp-file + fsync + rename for
 * meta.json and report.md.
 */
export async function writeAnalysisFailure(
  id: string,
  error: AnalysisErrorRecord,
  failureMarkdown: string,
): Promise<void> {
  assertValidId(id);
  const meta = await readMeta(id);
  if (!meta) throw new Error(`Session not found: ${id}`);
  const dir = await ensureSessionsDir();
  await mkdir(join(dir, id), { recursive: true, mode: DIR_MODE });
  await atomicWriteFile(join(dir, id, 'report.md'), failureMarkdown);
  const next: StoredMeta = {
    ...meta,
    status: 'analysis_failed',
    analysisError: error,
    // riskLevel is meaningless when analysis didn't run — strip any stale
    // value left over from a prior partial run.
    riskLevel: undefined,
    updatedAt: nowIso(),
  };
  await writeMeta(id, next);
}

/**
 * Merge a partial payload into the session's existing report.json. Used by
 * the discovery scan route to append `localAgentDiscovery` without
 * touching markdown or other top-level fields. Returns the merged JSON.
 *
 * If report.json doesn't exist yet, the patch becomes the new file
 * verbatim. Callers should consider whether that's the intended
 * semantics (discovery scan refuses to run without a finalized report).
 */
export async function patchReportJson(
  id: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  assertValidId(id);
  const meta = await readMeta(id);
  if (!meta) throw new Error(`Session not found: ${id}`);
  const dir = await ensureSessionsDir();
  await mkdir(join(dir, id), { recursive: true, mode: DIR_MODE });
  const path = join(dir, id, 'report.json');
  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // ENOENT or malformed — treat as empty.
  }
  const merged = { ...existing, ...patch };
  await atomicWriteFile(path, JSON.stringify(merged, null, 2));
  const next: StoredMeta = { ...meta, updatedAt: nowIso() };
  await writeMeta(id, next);
  return merged;
}

/**
 * AAP-55 — record the question the tool-call planner is currently
 * waiting on. The matching `submit_answer` MCP call consumes it via
 * {@link submitToolCallAnswer}. No status flip — the session is already
 * in `awaiting_answer` (or `interviewing` if a sampling path mid-flight
 * decides to fall through, though we don't ship that combination today).
 */
export async function setPendingQuestion(
  id: string,
  question: PendingQuestion,
): Promise<void> {
  assertValidId(id);
  const meta = await readMeta(id);
  if (!meta) throw new Error(`Session not found: ${id}`);
  const next: StoredMeta = {
    ...meta,
    pendingQuestion: question,
    updatedAt: nowIso(),
  };
  await writeMeta(id, next);
}

/** Drop any pending tool-call question without otherwise altering meta. */
export async function clearPendingQuestion(id: string): Promise<void> {
  assertValidId(id);
  const meta = await readMeta(id);
  if (!meta) throw new Error(`Session not found: ${id}`);
  const next: StoredMeta = {
    ...meta,
    pendingQuestion: null,
    updatedAt: nowIso(),
  };
  await writeMeta(id, next);
}

/**
 * AAP-55 — atomic "answer the currently-pending question" helper.
 *
 * Reads pendingQuestion off meta, appends a {category, question, answer}
 * row to the transcript, clears pendingQuestion. Throws if there is no
 * pending question — callers (i.e. the `submit_answer` MCP tool) must
 * branch on that to return a clean "wrong state" error rather than
 * silently dropping the answer.
 */
export async function submitToolCallAnswer(
  id: string,
  answer: string,
): Promise<TranscriptEntry> {
  assertValidId(id);
  const meta = await readMeta(id);
  if (!meta) throw new Error(`Session not found: ${id}`);
  const pending = meta.pendingQuestion;
  if (!pending) {
    throw new Error(`No pending question for session ${id} — cannot submit answer.`);
  }
  const entry: TranscriptEntry = {
    category: pending.category,
    question: pending.text,
    answer,
  };
  // appendTranscriptEntry handles transcript.jsonl write + bumps
  // questionsAsked/updatedAt. We chain clearPendingQuestion after so
  // the cursor is observably consistent on the next getSession read.
  await appendTranscriptEntry(id, entry);
  await clearPendingQuestion(id);
  return entry;
}

export async function softDeleteSession(id: string): Promise<void> {
  assertValidId(id);
  const meta = await readMeta(id);
  if (!meta) throw new Error(`Session not found: ${id}`);
  const next: StoredMeta = {
    ...meta,
    deletedAt: nowIso(),
    updatedAt: nowIso(),
  };
  await writeMeta(id, next);
}
