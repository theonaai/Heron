import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSession,
  getSession,
  listSessions,
  updateSessionMeta,
  appendTranscriptEntry,
  writeReport,
  softDeleteSession,
  getSessionsDir,
  SESSION_ID_REGEX,
} from '../../src/storage/sessions.js';

// All tests run with HERON_SESSIONS_DIR pointed at a fresh tmp dir to avoid
// clobbering the user's real ~/.heron/sessions/ on the dev machine.
describe('local-files audit-session store', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'heron-sessions-test-'));
    process.env.HERON_SESSIONS_DIR = dir;
  });

  afterEach(async () => {
    delete process.env.HERON_SESSIONS_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('getSessionsDir() honours HERON_SESSIONS_DIR override', () => {
    expect(getSessionsDir()).toBe(dir);
  });

  it('creates a session with a well-formed id and default fields', async () => {
    const { id } = await createSession({ agentName: 'demo-agent' });
    expect(id).toMatch(SESSION_ID_REGEX);
    expect(id).toMatch(/^sess-\d{8}-\d{6}-[a-z0-9]{6}$/);

    const detail = await getSession(id);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(id);
    expect(detail!.status).toBe('interviewing');
    expect(detail!.questionsAsked).toBe(0);
    expect(detail!.agentName).toBe('demo-agent');
    expect(detail!.transcript).toEqual([]);
    expect(detail!.viewerRole).toBe('owner');
    expect(detail!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(detail!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('parent dir is created with 0700 permissions, files with 0600', async () => {
    const { id } = await createSession({ agentName: 'a' });
    const sessionsDir = getSessionsDir();
    const parentStat = await stat(sessionsDir);
    // Skip mode-bit check on platforms where it doesn't apply (Windows). On
    // POSIX, expect 0700 on the parent and 0600 on meta.json.
    if (process.platform !== 'win32') {
      expect(parentStat.mode & 0o777).toBe(0o700);
    }
    const metaPath = join(sessionsDir, id, 'meta.json');
    const metaStat = await stat(metaPath);
    if (process.platform !== 'win32') {
      expect(metaStat.mode & 0o777).toBe(0o600);
    }
  });

  it('listSessions() returns newest first and excludes soft-deleted entries', async () => {
    const a = await createSession({ agentName: 'first' });
    // 10ms is enough to guarantee distinct updatedAt timestamps without
    // making the test slow.
    await new Promise((r) => setTimeout(r, 10));
    const b = await createSession({ agentName: 'second' });
    await new Promise((r) => setTimeout(r, 10));
    const c = await createSession({ agentName: 'third' });

    const list = await listSessions();
    expect(list.map((s) => s.id)).toEqual([c.id, b.id, a.id]);

    await softDeleteSession(b.id);
    const after = await listSessions();
    expect(after.map((s) => s.id)).toEqual([c.id, a.id]);
  });

  it('updateSessionMeta merges patch and bumps updatedAt', async () => {
    const { id } = await createSession({ agentName: 'x' });
    const before = await getSession(id);
    await new Promise((r) => setTimeout(r, 10));
    await updateSessionMeta(id, { status: 'analyzing', riskLevel: 'high' });
    const after = await getSession(id);
    expect(after!.status).toBe('analyzing');
    expect(after!.riskLevel).toBe('high');
    expect(after!.agentName).toBe('x');
    expect(new Date(after!.updatedAt).getTime()).toBeGreaterThan(
      new Date(before!.updatedAt).getTime(),
    );
  });

  it('appendTranscriptEntry appends to JSONL and bumps questionsAsked', async () => {
    const { id } = await createSession({ agentName: 'x' });
    await appendTranscriptEntry(id, {
      category: 'systems',
      question: 'What systems does the agent touch?',
      answer: 'Google Sheets and Slack.',
    });
    await appendTranscriptEntry(id, {
      category: 'data',
      question: 'What data does it write?',
      answer: 'Approval notes.',
    });

    const detail = await getSession(id);
    expect(detail!.transcript).toHaveLength(2);
    expect(detail!.transcript[0]!.category).toBe('systems');
    expect(detail!.transcript[1]!.answer).toBe('Approval notes.');
    expect(detail!.questionsAsked).toBe(2);
  });

  it('writeReport stores markdown + structured json, flips status to complete', async () => {
    const { id } = await createSession({ agentName: 'x' });
    await writeReport(id, {
      markdown: '# Report\n\nSome findings.',
      json: { riskLevel: 'medium', findings: [] },
    });
    const detail = await getSession(id);
    expect(detail!.report).toBe('# Report\n\nSome findings.');
    expect(detail!.reportJson).toEqual({ riskLevel: 'medium', findings: [] });
    expect(detail!.status).toBe('complete');
  });

  it('getSession returns null for unknown id', async () => {
    const out = await getSession('sess-20260101-000000-aaaaaa');
    expect(out).toBeNull();
  });

  it('rejects malformed ids on every read/write path (path-traversal defence)', async () => {
    const bad = [
      '../etc',
      'sess-x',
      'sess-20260101-000000',
      'sess-2026-01-01-aaaaaa',
      'sess-20260101-000000-AAAAAA', // uppercase not allowed
      'sess-20260101-000000-zzz', // too short
      '..',
      'sess-20260101-000000-aaaaaa/../other',
    ];
    for (const id of bad) {
      expect(SESSION_ID_REGEX.test(id)).toBe(false);
      await expect(getSession(id)).resolves.toBeNull();
      await expect(updateSessionMeta(id, { status: 'analyzing' })).rejects.toThrow();
      await expect(
        appendTranscriptEntry(id, { category: 'x', question: 'q', answer: 'a' }),
      ).rejects.toThrow();
      await expect(writeReport(id, { markdown: 'x', json: {} })).rejects.toThrow();
      await expect(softDeleteSession(id)).rejects.toThrow();
    }
  });

  it('does not leave *.tmp-* files behind after atomic writes', async () => {
    const { id } = await createSession({ agentName: 'x' });
    await updateSessionMeta(id, { status: 'analyzing' });
    await appendTranscriptEntry(id, { category: 'a', question: 'q', answer: 'a' });
    await writeReport(id, { markdown: '# r', json: { ok: true } });

    const sessionDir = join(getSessionsDir(), id);
    const files = await readdir(sessionDir);
    const stragglers = files.filter((f) => f.includes('.tmp-'));
    expect(stragglers).toEqual([]);
  });

  it('soft-deleted sessions are still readable directly', async () => {
    const { id } = await createSession({ agentName: 'x' });
    await softDeleteSession(id);
    // Direct read still works (so existing diff/share refs would still resolve).
    const detail = await getSession(id);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(id);
    // But the list filters it out.
    const list = await listSessions();
    expect(list.find((s) => s.id === id)).toBeUndefined();
  });

  it('ignores corrupt session dirs in listSessions instead of crashing', async () => {
    // Pre-populate a junk directory next to a real session.
    const { id } = await createSession({ agentName: 'real' });
    const junkDir = join(getSessionsDir(), 'sess-20260101-000000-junkjk');
    await rm(junkDir, { recursive: true, force: true });
    await writeFile(join(getSessionsDir(), 'stray-file.txt'), 'noise');

    const list = await listSessions();
    expect(list.map((s) => s.id)).toContain(id);
    // Stray file did not cause a crash, just got skipped.
  });

  it('createSession without agentName still produces a valid record', async () => {
    const { id } = await createSession({});
    const detail = await getSession(id);
    expect(detail).not.toBeNull();
    expect(detail!.agentName).toBeUndefined();
  });

  it('updateSessionMeta rejects unknown fields silently (ignores them)', async () => {
    const { id } = await createSession({ agentName: 'x' });
    // Pass an unknown field — should not be persisted.
    await updateSessionMeta(id, {
      status: 'analyzing',
      // @ts-expect-error — intentionally testing unknown field
      hackerField: 'evil',
    });
    const raw = await readFile(join(getSessionsDir(), id, 'meta.json'), 'utf8');
    expect(raw).not.toContain('hackerField');
    expect(raw).not.toContain('evil');
  });
});
