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

export type AuditSessionStatus = 'interviewing' | 'analyzing' | 'complete' | 'error';

export interface AuditSession {
  id: string;
  status: AuditSessionStatus;
  questionsAsked: number;
  riskLevel?: string;
  agentName?: string;
  createdAt: string;
  updatedAt: string;
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
  input: { agentName?: string } = {},
): Promise<{ id: string }> {
  await ensureSessionsDir();
  const id = generateSessionId();
  const now = nowIso();
  const meta: StoredMeta = {
    id,
    status: 'interviewing',
    questionsAsked: 0,
    createdAt: now,
    updatedAt: now,
  };
  if (input.agentName && input.agentName.length > 0) {
    meta.agentName = input.agentName;
  }
  await writeMeta(id, meta);
  return { id };
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
    updatedAt: nowIso(),
  };
  await writeMeta(id, next);
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
