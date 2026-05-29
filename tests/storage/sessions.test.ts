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
  writeAnalysisFailure,
  softDeleteSession,
  getSessionsDir,
  SESSION_ID_REGEX,
  setPendingQuestion,
  clearPendingQuestion,
  submitToolCallAnswer,
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

  // ─── #26 A1 — extractedAgentName stamp + lazy backfill ───────────────
  describe('extractedAgentName (#26 A1)', () => {
    // The demo-session Q1 shape: runtime agentName "Codex", but the report
    // carries the Q1 "Project/product name: MVP Edu Content Agent" answer.
    const demoReportJson = {
      agentPurpose:
        'The agent is an educational content generation and publishing pipeline that processes lesson rows.',
      transcript: [
        {
          category: 'purpose',
          question: '1. …',
          answer:
            '1. Project/product name: MVP Edu Content Agent, in workspace /tmp/x.\n2. Owner: local user.',
        },
      ],
      riskLevel: 'medium',
    };

    it('writeReport stamps the Q1-extracted name onto meta', async () => {
      const { id } = await createSession({ agentName: 'Codex' });
      await writeReport(id, { markdown: '# r', json: demoReportJson });
      const detail = await getSession(id);
      expect(detail!.extractedAgentName).toBe('MVP Edu Content Agent');
      // Runtime name is untouched — the extracted name is additive.
      expect(detail!.agentName).toBe('Codex');
      // Persisted to disk (not just computed on read).
      const meta = JSON.parse(
        await readFile(join(getSessionsDir(), id, 'meta.json'), 'utf8'),
      );
      expect(meta.extractedAgentName).toBe('MVP Edu Content Agent');
    });

    it('does NOT stamp the runtime name when extraction falls back', async () => {
      const { id } = await createSession({ agentName: 'Codex' });
      // No agentPurpose noun phrase, no Q1 name → extraction falls back.
      await writeReport(id, {
        markdown: '# r',
        json: { riskLevel: 'low', transcript: [], agentPurpose: 'does stuff' },
      });
      const detail = await getSession(id);
      expect(detail!.extractedAgentName).toBeUndefined();
    });

    it('listSessions surfaces extractedAgentName', async () => {
      const { id } = await createSession({ agentName: 'Codex' });
      await writeReport(id, { markdown: '# r', json: demoReportJson });
      const list = await listSessions();
      const row = list.find((s) => s.id === id);
      expect(row!.extractedAgentName).toBe('MVP Edu Content Agent');
    });

    it('lazily backfills sessions whose meta predates the field, WITHOUT bumping updatedAt', async () => {
      const { id } = await createSession({ agentName: 'Codex' });
      await writeReport(id, { markdown: '# r', json: demoReportJson });
      // Simulate a pre-feature session: strip extractedAgentName from meta.
      const metaPath = join(getSessionsDir(), id, 'meta.json');
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      const originalUpdatedAt = meta.updatedAt;
      delete meta.extractedAgentName;
      await writeFile(metaPath, JSON.stringify(meta, null, 2));

      // A read backfills it.
      const detail = await getSession(id);
      expect(detail!.extractedAgentName).toBe('MVP Edu Content Agent');
      const after = JSON.parse(await readFile(metaPath, 'utf8'));
      expect(after.extractedAgentName).toBe('MVP Edu Content Agent');
      // Critical: the backfill must NOT reorder the list / shift the
      // "Updated" column — updatedAt is preserved (#26 A2).
      expect(after.updatedAt).toBe(originalUpdatedAt);
    });

    it('listSessions backfill also preserves updatedAt (no list reorder)', async () => {
      const { id } = await createSession({ agentName: 'Codex' });
      await writeReport(id, { markdown: '# r', json: demoReportJson });
      const metaPath = join(getSessionsDir(), id, 'meta.json');
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      const originalUpdatedAt = meta.updatedAt;
      delete meta.extractedAgentName;
      await writeFile(metaPath, JSON.stringify(meta, null, 2));

      const list = await listSessions();
      expect(list.find((s) => s.id === id)!.extractedAgentName).toBe('MVP Edu Content Agent');
      const after = JSON.parse(await readFile(metaPath, 'utf8'));
      expect(after.updatedAt).toBe(originalUpdatedAt);
    });
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

  // ─── AAP-56 — writeAnalysisFailure ──────────────────────────────────────

  it('writeAnalysisFailure flips status to analysis_failed and stores analysisError + report.md', async () => {
    const { id } = await createSession({ agentName: 'codex.app' });
    await appendTranscriptEntry(id, { category: 'systems', question: 'Q1', answer: 'A1' });

    const occurredAt = '2026-05-20T03:34:03.123Z';
    await writeAnalysisFailure(
      id,
      {
        reason: 'llm_unreachable',
        message: '502 status code (no body)',
        attemptCount: 2,
        occurredAt,
      },
      '# Agent Access Audit — REPORT GENERATION FAILED\n\nverbatim transcript follows',
    );

    const detail = await getSession(id);
    expect(detail).not.toBeNull();
    expect(detail!.status).toBe('analysis_failed');
    expect(detail!.report).toMatch(/REPORT GENERATION FAILED/);
    expect(detail!.analysisError).toBeDefined();
    expect(detail!.analysisError!.reason).toBe('llm_unreachable');
    expect(detail!.analysisError!.message).toContain('502');
    expect(detail!.analysisError!.attemptCount).toBe(2);
    expect(detail!.analysisError!.occurredAt).toBe(occurredAt);
  });

  it('writeAnalysisFailure does NOT write report.json (no analysis to serialize)', async () => {
    const { id } = await createSession({ agentName: 'codex.app' });
    await writeAnalysisFailure(
      id,
      {
        reason: 'parse_failure',
        message: 'Unexpected token in JSON at position 0',
        attemptCount: 2,
        occurredAt: new Date().toISOString(),
      },
      '# REPORT GENERATION FAILED',
    );

    const files = await readdir(join(getSessionsDir(), id));
    expect(files).toContain('meta.json');
    expect(files).toContain('report.md');
    // Critically: no report.json on disk after writeAnalysisFailure.
    expect(files).not.toContain('report.json');
  });

  it('writeAnalysisFailure bumps updatedAt', async () => {
    const { id } = await createSession({ agentName: 'codex.app' });
    const before = await getSession(id);
    await new Promise((r) => setTimeout(r, 10));
    await writeAnalysisFailure(
      id,
      {
        reason: 'parse_failure',
        message: 'malformed JSON',
        attemptCount: 2,
        occurredAt: new Date().toISOString(),
      },
      '# REPORT GENERATION FAILED',
    );
    const after = await getSession(id);
    expect(new Date(after!.updatedAt).getTime()).toBeGreaterThan(
      new Date(before!.updatedAt).getTime(),
    );
  });

  it('writeAnalysisFailure rejects malformed session ids', async () => {
    await expect(
      writeAnalysisFailure(
        '../etc',
        {
          reason: 'parse_failure',
          message: 'x',
          attemptCount: 2,
          occurredAt: new Date().toISOString(),
        },
        '# bad',
      ),
    ).rejects.toThrow();
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

  // ─── AAP-55 — tool-call interview mode ──────────────────────────────────

  it('createSession with mode="tool-call" persists the mode flag', async () => {
    const { id } = await createSession({ agentName: 'x', mode: 'tool-call' });
    const detail = await getSession(id);
    expect(detail).not.toBeNull();
    expect(detail!.mode).toBe('tool-call');
  });

  it('createSession default mode is undefined (back-compat for sampling rows)', async () => {
    const { id } = await createSession({ agentName: 'x' });
    const detail = await getSession(id);
    expect(detail!.mode).toBeUndefined();
  });

  it('setPendingQuestion / clearPendingQuestion round-trip through getSession', async () => {
    const { id } = await createSession({ agentName: 'x', mode: 'tool-call' });

    await setPendingQuestion(id, { text: 'What do you do?', category: 'purpose', index: 0 });
    let detail = await getSession(id);
    expect(detail!.pendingQuestion).toEqual({
      text: 'What do you do?',
      category: 'purpose',
      index: 0,
    });

    await clearPendingQuestion(id);
    detail = await getSession(id);
    expect(detail!.pendingQuestion ?? null).toBeNull();
  });

  it('submitToolCallAnswer appends to transcript and clears pendingQuestion', async () => {
    const { id } = await createSession({ agentName: 'x', mode: 'tool-call' });
    await setPendingQuestion(id, { text: 'Q1', category: 'purpose', index: 0 });

    await submitToolCallAnswer(id, 'A1');

    const detail = await getSession(id);
    expect(detail!.transcript).toEqual([
      { category: 'purpose', question: 'Q1', answer: 'A1' },
    ]);
    expect(detail!.questionsAsked).toBe(1);
    expect(detail!.pendingQuestion ?? null).toBeNull();
  });

  it('submitToolCallAnswer throws when there is no pendingQuestion', async () => {
    const { id } = await createSession({ agentName: 'x', mode: 'tool-call' });
    await expect(submitToolCallAnswer(id, 'A1')).rejects.toThrow(/pending/i);
  });

  it('setPendingQuestion rejects an invalid session id without writing', async () => {
    await expect(
      setPendingQuestion('not-a-valid-id', { text: 'Q', category: 'purpose', index: 0 }),
    ).rejects.toThrow();
  });
});
