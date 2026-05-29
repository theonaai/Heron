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

/**
 * AAP-63 — per-session deterministic verification status.
 *
 *   - `unverified`: only the LLM interview ran. Risk is self-report only.
 *   - `partial`:    at least one Surface 2 source ran (e.g. filesystem
 *                   discovery) but not all of them (OAuth introspection
 *                   is not wired into the dashboard flow yet — AAP-64).
 *   - `verified`:   every applicable Surface 2 source ran successfully
 *                   and produced clean evidence.
 *
 * Strategy v3.0 §3 anchor: "Every claim about an AI agent should be
 * verifiable from a deterministic source of truth." The dashboard
 * pill renders `deterministicRiskLevel` whenever `verificationStatus
 * !== 'unverified'`; `interviewRiskLevel` is a secondary signal.
 */
export type VerificationStatus = 'unverified' | 'partial' | 'verified';

/** Risk-level vocabulary shared with the verdict module + report renderer. */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface AuditSession {
  id: string;
  status: AuditSessionStatus;
  questionsAsked: number;
  /**
   * Legacy dashboard-facing risk level. AAP-63: this field is now an
   * alias of `primaryRiskLevel` — kept so external consumers (markdown
   * report download, comparison exports) keep working unchanged. New
   * code should consume `deterministicRiskLevel` / `interviewRiskLevel`
   * directly. Removal is a phase-2 cleanup tracked separately.
   */
  riskLevel?: string;
  agentName?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * AAP-63 — per-session Surface 2 status. Defaults to `undefined`
   * (treated as `'unverified'` by the dashboard) on session create;
   * set by the audit pipeline after `runDiscovery` / OAuth
   * introspection runs. Older sessions persisted before AAP-63 lack
   * this field; readers must tolerate `undefined`.
   */
  verificationStatus?: VerificationStatus;
  /** AAP-63 — risk level derived purely from Surface 2 evidence. */
  deterministicRiskLevel?: RiskLevel;
  /** AAP-63 — risk level derived purely from Surface 1 (LLM analyzer). */
  interviewRiskLevel?: RiskLevel;
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
  /** AAP-63 — Surface 2 verification status. */
  verificationStatus?: VerificationStatus;
  /** AAP-63 — Surface 2 risk level. */
  deterministicRiskLevel?: RiskLevel;
  /** AAP-63 — Surface 1 (interview LLM) risk level. */
  interviewRiskLevel?: RiskLevel;
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
const META_PATCH_FIELDS: Array<keyof SessionMetaPatch> = [
  'status',
  'riskLevel',
  'agentName',
  // AAP-63 — surface-2 verdict fields.
  'verificationStatus',
  'deterministicRiskLevel',
  'interviewRiskLevel',
];

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

/**
 * AAP-105 A2 — map the report.json `verification.status` vocabulary
 * onto the meta-level `verificationStatus` enum. The two stores use
 * different terms historically (`partially-verified` vs `partial`,
 * `interrogation-only`/`verification-failed` vs `unverified`), and
 * collapsing them here lets `getSession()` treat report.json as the
 * canonical source without leaking the report vocabulary into every
 * consumer of `AuditSessionDetail.verificationStatus`.
 */
function mapReportVerificationToMeta(status: unknown): VerificationStatus | undefined {
  if (typeof status !== 'string') return undefined;
  if (status === 'verified') return 'verified';
  if (status === 'partially-verified') return 'partial';
  if (status === 'interrogation-only') return 'unverified';
  if (status === 'verification-failed') return 'unverified';
  return undefined;
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
  // AAP-63 — surface 2 verdict fields.
  if (meta.verificationStatus !== undefined) detail.verificationStatus = meta.verificationStatus;
  if (meta.deterministicRiskLevel !== undefined) {
    detail.deterministicRiskLevel = meta.deterministicRiskLevel;
  }
  if (meta.interviewRiskLevel !== undefined) detail.interviewRiskLevel = meta.interviewRiskLevel;
  if (reportMd !== undefined) detail.report = reportMd;
  if (reportJson !== null) detail.reportJson = reportJson;

  // AAP-105 A2 — `report.json:verification.status` is the canonical
  // verification record (strategy v3.0 §3: "verifiable from a
  // deterministic source of truth"). `meta.verificationStatus` is a
  // denormalised cache that the sidebar / list path consults for
  // performance. The two are written by separate code paths
  // (`patchReportJson` writes report.json, `persistVerdict` writes
  // meta) — a transient race window during the verification flow can
  // leave them disagreeing for the duration of a fsync + rename. When
  // the detail view detects disagreement, prefer the report value so
  // operators do not see stale "unverified" state in the dashboard
  // while the audit artefact already shows `partially-verified`.
  // listSessions() intentionally does NOT do this — the sidebar tier
  // is cache-only and tolerates short drift.
  const reportVerificationStatus =
    reportJson !== null &&
    typeof reportJson === 'object' &&
    'verification' in (reportJson as Record<string, unknown>)
      ? (reportJson as { verification?: { status?: unknown } }).verification?.status
      : undefined;
  const mappedFromReport = mapReportVerificationToMeta(reportVerificationStatus);
  if (mappedFromReport !== undefined) {
    detail.verificationStatus = mappedFromReport;
  }

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
    // AAP-63 — list rows surface verification status so the sidebar can
    // render the new dual-pill / "VERIFICATION REQUIRED" badge.
    if (meta.verificationStatus !== undefined) {
      summary.verificationStatus = meta.verificationStatus;
    }
    if (meta.deterministicRiskLevel !== undefined) {
      summary.deterministicRiskLevel = meta.deterministicRiskLevel;
    }
    if (meta.interviewRiskLevel !== undefined) {
      summary.interviewRiskLevel = meta.interviewRiskLevel;
    }
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
 * AAP-105 A2 — atomic "patch report.json + update meta verdict fields"
 * helper. Replaces the prior pattern of calling `patchReportJson` and
 * then `persistVerdict` back-to-back, which left an observable race
 * window where `report.json:verification.status` had already flipped
 * to `partially-verified` while `meta.verificationStatus` still read
 * `unverified`. In production this race was observed to persist for
 * up to 51 seconds.
 *
 * Ordering contract:
 *   1. Read existing report.json + meta (single sync point).
 *   2. atomicWriteFile(report.json) — rename commits first.
 *   3. writeMeta — rename commits second.
 *
 * If a reader hits between step 2 and step 3, it observes fresh
 * report.json (canonical) and stale meta (cache). `getSession()`
 * defensively prefers report.json when both are present, so the
 * dashboard detail view will render the fresh value either way.
 * `listSessions()` reads only meta and tolerates the brief lag.
 *
 * Returns the merged report.json (callers like the dashboard scan
 * route consume it to re-render the .md artefact).
 */
export async function patchReportAndMeta(
  id: string,
  args: {
    reportPatch: Record<string, unknown>;
    metaPatch: SessionMetaPatch;
  },
): Promise<Record<string, unknown>> {
  assertValidId(id);
  const meta = await readMeta(id);
  if (!meta) throw new Error(`Session not found: ${id}`);
  const dir = await ensureSessionsDir();
  await mkdir(join(dir, id), { recursive: true, mode: DIR_MODE });
  const reportPath = join(dir, id, 'report.json');
  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(reportPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // ENOENT or malformed — treat as empty.
  }
  const merged = { ...existing, ...args.reportPatch };
  // STEP 1: commit report.json first. This is the canonical record.
  await atomicWriteFile(reportPath, JSON.stringify(merged, null, 2));

  // STEP 2: build + commit the new meta. Use the original meta we
  // already read above as the base (no second readMeta call — avoids
  // a TOCTOU window where an unrelated meta write between read and
  // write would be silently clobbered).
  const next: StoredMeta = { ...meta };
  for (const key of META_PATCH_FIELDS) {
    const val = args.metaPatch[key];
    if (val !== undefined) {
      (next as unknown as Record<string, unknown>)[key] = val;
    }
  }
  next.updatedAt = nowIso();
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

// ─── AAP-82 — agent-reported MCP `tools/list` storage ────────────────────

/**
 * AAP-82 Blocker 3 (Codex post-review): hard cap on the cumulative tool
 * count we keep per session across all forwarded servers. The per-call
 * Zod cap (200 tools per single forward, see `mcp-server.ts`) prevents a
 * single payload from being huge; this cap stops an agent from issuing
 * many smaller forwards to grow the session bag unbounded. 1000 covers
 * the worst real-world inventories with room to spare and keeps the
 * on-disk record bounded.
 */
export const REPORTED_MCP_TOOLS_PER_SESSION_CAP = 1000;

/**
 * AAP-82 — one server's `tools/list` response as forwarded by the audited
 * agent via the `report_mcp_tools_list` MCP tool. Persisted per session
 * under `<session>/reported-mcp-tools.json` keyed by `serverName`. Last
 * write wins (per AAP-82 spec edge case: "Multiple report_mcp_tools_list
 * for same server -> last write wins, log warning").
 *
 * Privacy contract (Codex post-review, Blocker 2 Option A): the cached
 * `enumeration` is the ONLY payload persisted. The agent-forwarded raw
 * JSON-RPC body is intentionally NOT stored on disk — it can carry
 * `inputSchema` fragments, vendor `_meta`, and other fields that the
 * interview directive does not promise to retain. The parser
 * (`parseAgentReportedToolsList`) extracts only `name` + `description` +
 * the classifier verdict before returning, and that projection is what
 * lands here. Dashboard / verdict readers consume `enumeration` only.
 */
export interface ReportedMcpToolsRecord {
  /** Server name the agent attributed the response to. */
  serverName: string;
  /** ISO-8601 timestamp of when Heron received the forward. */
  receivedAt: string;
  /** Projected enumeration (parsed + classified). Names + descriptions only. */
  enumeration: import('../discovery/types.js').McpToolEnumeration;
  /** True when this write replaced an earlier record for the same serverName. */
  replacedPrevious?: boolean;
}

/**
 * Error thrown by `saveReportedMcpToolsList` when accepting the new
 * record would exceed `REPORTED_MCP_TOOLS_PER_SESSION_CAP`. Exported so
 * the MCP handler can convert it to a `tool_failure` with a clear
 * reason.
 */
export class ReportedMcpToolsPerSessionCapExceeded extends Error {
  constructor(
    public readonly totalTools: number,
    public readonly cap: number,
    public readonly serverName: string,
  ) {
    super(
      `report_mcp_tools_list: persisting "${serverName}" would push the per-session tool count to ${totalTools}, above the ${cap} cap`,
    );
    this.name = 'ReportedMcpToolsPerSessionCapExceeded';
  }
}

/**
 * Persist one agent-forwarded `tools/list` projection. Subsequent writes
 * for the same `serverName` REPLACE the earlier record — the spec's
 * "last write wins" semantics. Returns the freshly stored record so the
 * caller (the `report_mcp_tools_list` handler) can echo the projection
 * counts back to the agent.
 */
export async function saveReportedMcpToolsList(
  id: string,
  record: Omit<ReportedMcpToolsRecord, 'replacedPrevious'>,
): Promise<ReportedMcpToolsRecord> {
  assertValidId(id);
  const meta = await readMeta(id);
  if (!meta) throw new Error(`Session not found: ${id}`);
  const dir = await ensureSessionsDir();
  await mkdir(join(dir, id), { recursive: true, mode: DIR_MODE });
  const path = join(dir, id, 'reported-mcp-tools.json');
  // Read existing index (tolerate missing / malformed file by treating as empty).
  let existing: Record<string, ReportedMcpToolsRecord> = {};
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, ReportedMcpToolsRecord>;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // SyntaxError / read error — fall through to fresh write, don't
      // crash the audit loop because of a single corrupt cache file.
    }
  }

  // AAP-82 Blocker 3 (Codex post-review): enforce per-session cumulative
  // tool cap BEFORE writing. The cap counts the projected tools across
  // every server, accounting for last-write-wins (the incoming record
  // replaces an earlier one for the same serverName).
  const incomingToolCount = record.enumeration.tools?.length ?? 0;
  let priorTotal = 0;
  for (const [name, existingRecord] of Object.entries(existing)) {
    if (name === record.serverName) continue;
    priorTotal += existingRecord.enumeration?.tools?.length ?? 0;
  }
  const projectedTotal = priorTotal + incomingToolCount;
  if (projectedTotal > REPORTED_MCP_TOOLS_PER_SESSION_CAP) {
    throw new ReportedMcpToolsPerSessionCapExceeded(
      projectedTotal,
      REPORTED_MCP_TOOLS_PER_SESSION_CAP,
      record.serverName,
    );
  }

  const replacedPrevious = Object.prototype.hasOwnProperty.call(existing, record.serverName);
  const stored: ReportedMcpToolsRecord = { ...record, replacedPrevious };
  existing[record.serverName] = stored;
  await atomicWriteFile(path, JSON.stringify(existing, null, 2));
  const next: StoredMeta = { ...meta, updatedAt: nowIso() };
  await writeMeta(id, next);
  return stored;
}

/**
 * Read every reported `tools/list` record persisted for this session.
 * Returns `[]` when the session has no `reported-mcp-tools.json` yet
 * (no agent ever called `report_mcp_tools_list`). Order is insertion
 * order of the JSON object — readers must not rely on it.
 */
export async function listReportedMcpTools(
  id: string,
): Promise<ReportedMcpToolsRecord[]> {
  if (!SESSION_ID_REGEX.test(id)) return [];
  const path = join(getSessionsDir(), id, 'reported-mcp-tools.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const out: ReportedMcpToolsRecord[] = [];
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as ReportedMcpToolsRecord).serverName === 'string'
    ) {
      out.push(value as ReportedMcpToolsRecord);
    }
  }
  return out;
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
