/**
 * GET /api/audit/sessions/:id/diff?against=<otherId> — deterministic
 * structural diff between two audit-session reports (#33-C / AAP-64).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GET as diffGET } from '@/app/api/audit/sessions/[id]/diff/route';
import { createSession, writeReport } from '@/src/storage/sessions';

function makeRequest(id: string, against: string | null): Request {
  const url =
    against === null
      ? `http://127.0.0.1:3700/api/audit/sessions/${id}/diff`
      : `http://127.0.0.1:3700/api/audit/sessions/${id}/diff?against=${against}`;
  return new Request(url);
}

describe('GET /api/audit/sessions/:id/diff', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'heron-diff-route-'));
    process.env.HERON_SESSIONS_DIR = dir;
  });

  afterEach(() => {
    delete process.env.HERON_SESSIONS_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('400 when against= is missing', async () => {
    const fakeId = 'sess-20260519-100000-aaaaaa';
    const res = await diffGET(makeRequest(fakeId, null), {
      params: Promise.resolve({ id: fakeId }),
    });
    expect(res.status).toBe(400);
  });

  it('400 when ids do not match SESSION_ID_REGEX', async () => {
    const badId = 'not-a-session-id';
    const res = await diffGET(
      makeRequest(badId, 'sess-20260519-100000-aaaaaa'),
      { params: Promise.resolve({ id: badId }) },
    );
    expect(res.status).toBe(400);
  });

  it('404 when one of the sessions is missing', async () => {
    const { id: real } = await createSession({ agentName: 'a' });
    await writeReport(real, { markdown: '# x', json: { systems: [] } });
    const missing = 'sess-20260519-100000-zzzzzz';
    const res = await diffGET(makeRequest(real, missing), {
      params: Promise.resolve({ id: real }),
    });
    expect(res.status).toBe(404);
  });

  it('returns a diffJson with adds/removes when reports differ', async () => {
    const old = await createSession({ agentName: 'old' });
    await writeReport(old.id, {
      markdown: '# old',
      json: {
        risks: [
          { title: 'leaked PII', severity: 'high', description: '' },
          { title: 'low risk thing', severity: 'low' },
        ],
        systems: [
          { systemId: 'gmail', scopesRequested: ['readonly'] },
        ],
        overallRiskLevel: 'high',
      },
    });
    const newer = await createSession({ agentName: 'new' });
    await writeReport(newer.id, {
      markdown: '# new',
      json: {
        risks: [
          { title: 'leaked PII', severity: 'medium', description: '' },
          { title: 'new finding', severity: 'critical' },
        ],
        systems: [
          { systemId: 'gmail', scopesRequested: ['readonly', 'send'] },
          { systemId: 'calendar', scopesRequested: ['read'] },
        ],
        overallRiskLevel: 'critical',
      },
    });
    const res = await diffGET(makeRequest(newer.id, old.id), {
      params: Promise.resolve({ id: newer.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      previousSessionId: string;
      diffJson: {
        findings: { added: { title: string }[]; resolved: { title: string }[]; severityChanged: unknown[] };
        systems: { added: { systemId: string }[]; changed: { systemId: string; scopesAdded: string[] }[] };
        riskDirection: string;
      };
    };
    expect(body.previousSessionId).toBe(old.id);
    expect(body.diffJson.findings.added.map((f) => f.title)).toContain('new finding');
    expect(body.diffJson.findings.resolved.map((f) => f.title)).toContain('low risk thing');
    expect(body.diffJson.findings.severityChanged.length).toBeGreaterThan(0);
    expect(body.diffJson.systems.added.map((s) => s.systemId)).toContain('calendar');
    expect(body.diffJson.systems.changed[0]?.systemId).toBe('gmail');
    expect(body.diffJson.systems.changed[0]?.scopesAdded).toContain('send');
    expect(body.diffJson.riskDirection).toBe('worsened');
  });
});
