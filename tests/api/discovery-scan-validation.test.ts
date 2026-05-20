/**
 * Discovery scan workspaceRoot validation tests — AAP-58.
 *
 * Pre-AAP-58 the route accepted ANY string as workspaceRoot, including
 * the bogus URL-path values the dashboard was sending
 * (`window.location.pathname` = `/dashboard/sessions/sess-…`). This
 * suite locks in the four rejections + the fallback chain:
 *
 *   1. `/dashboard/...`         → 400 invalid_workspace_root
 *   2. relative path            → 400 invalid_workspace_root
 *   3. `..` traversal           → 400 invalid_workspace_root
 *   4. non-existent absolute    → 400 invalid_workspace_root
 *   5. omitted + no hints       → falls back to process.cwd()
 *   6. omitted + hints present  → uses session.workspaceHints[0]
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { POST as scanPOST } from '@/app/api/discovery/scan/route';
import { POST as consentPOST } from '@/app/api/discovery/consent/route';
import { POST as reportPOST } from '@/app/api/audit/sessions/[id]/report/route';
import { createSession } from '@/src/storage/sessions';

const ORIGIN = 'http://127.0.0.1:3700';

function jsonRequest(
  url: string,
  body: unknown,
  init: { method?: string; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    host: '127.0.0.1:3700',
    'Sec-Fetch-Site': 'same-origin',
    ...(init.headers ?? {}),
  };
  return new Request(url, {
    method: init.method ?? 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('POST /api/discovery/scan — workspaceRoot validation (AAP-58)', () => {
  let sessionsDir: string;
  let homeDir: string;
  let workspaceDir: string;
  let sessionId: string;

  beforeEach(async () => {
    sessionsDir = await mkdtemp(join(tmpdir(), 'heron-scan-val-sessions-'));
    homeDir = await mkdtemp(join(tmpdir(), 'heron-scan-val-home-'));
    workspaceDir = await mkdtemp(join(tmpdir(), 'heron-scan-val-ws-'));
    process.env.HERON_SESSIONS_DIR = sessionsDir;
    process.env.HERON_DISCOVERY_HOME = homeDir;

    const created = await createSession({});
    sessionId = created.id;
    // Seed a stub report so the scan route has something to patch.
    await reportPOST(
      jsonRequest(`${ORIGIN}/api/audit/sessions/${sessionId}/report`, {
        markdown: '# x',
        json: {
          summary: 's',
          agentPurpose: 'p',
          systems: [],
          risks: [],
          recommendations: [],
          overallRiskLevel: 'low',
        },
      }),
      { params: Promise.resolve({ id: sessionId }) } as never,
    );
  });

  afterEach(async () => {
    delete process.env.HERON_SESSIONS_DIR;
    delete process.env.HERON_DISCOVERY_HOME;
    await rm(sessionsDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('rejects workspaceRoot that contains /dashboard/ (the original bug)', async () => {
    const res = await scanPOST(
      jsonRequest(`${ORIGIN}/api/discovery/scan`, {
        sessionId,
        workspaceRoot: '/dashboard/sessions/sess-12345678-abcdef-abcdef',
      }),
    );
    expect(res.status).toBe(400);
    const body = await readJson<{ error: string; code?: string }>(res);
    expect(body.code).toBe('invalid_workspace_root');
  });

  it('rejects a relative path', async () => {
    const res = await scanPOST(
      jsonRequest(`${ORIGIN}/api/discovery/scan`, {
        sessionId,
        workspaceRoot: 'some/relative/path',
      }),
    );
    expect(res.status).toBe(400);
    const body = await readJson<{ error: string; code?: string }>(res);
    expect(body.code).toBe('invalid_workspace_root');
  });

  it('rejects `..` traversal segments', async () => {
    const res = await scanPOST(
      jsonRequest(`${ORIGIN}/api/discovery/scan`, {
        sessionId,
        workspaceRoot: '/tmp/../etc/passwd',
      }),
    );
    expect(res.status).toBe(400);
    const body = await readJson<{ error: string; code?: string }>(res);
    expect(body.code).toBe('invalid_workspace_root');
  });

  it('rejects a non-existent absolute path', async () => {
    const res = await scanPOST(
      jsonRequest(`${ORIGIN}/api/discovery/scan`, {
        sessionId,
        workspaceRoot: '/this/path/definitely/does/not/exist/anywhere',
      }),
    );
    expect(res.status).toBe(400);
    const body = await readJson<{ error: string; code?: string }>(res);
    expect(body.code).toBe('invalid_workspace_root');
  });

  it('falls back to process.cwd() when workspaceRoot is omitted (and consent there)', async () => {
    // Grant consent on the cwd so the scan can run. We don't care about
    // the discovery output — only that we did not 400.
    await consentPOST(
      jsonRequest(`${ORIGIN}/api/discovery/consent`, {
        workspace: process.cwd(),
        decision: 'allow-once',
      }),
    );
    const res = await scanPOST(
      jsonRequest(`${ORIGIN}/api/discovery/scan`, {
        sessionId,
      }),
    );
    // 200 OR 403 (consent_required) — never a 400 from a missing
    // workspaceRoot, which is the bug we're locking out.
    expect([200, 403]).toContain(res.status);
  });

  it('uses session.workspaceHints[0] when workspaceRoot is omitted', async () => {
    // Re-create the session with a workspaceHint pointing to our
    // temp workspaceDir, then grant consent against THAT path so the
    // scan must have used the hint to satisfy consent.
    const created = await createSession({ workspaceHints: [workspaceDir] });
    await reportPOST(
      jsonRequest(`${ORIGIN}/api/audit/sessions/${created.id}/report`, {
        markdown: '# x',
        json: {
          summary: 's',
          agentPurpose: 'p',
          systems: [],
          risks: [],
          recommendations: [],
          overallRiskLevel: 'low',
        },
      }),
      { params: Promise.resolve({ id: created.id }) } as never,
    );
    await consentPOST(
      jsonRequest(`${ORIGIN}/api/discovery/consent`, {
        workspace: workspaceDir,
        decision: 'allow-for-workspace',
      }),
    );
    const res = await scanPOST(
      jsonRequest(`${ORIGIN}/api/discovery/scan`, {
        sessionId: created.id,
      }),
    );
    expect(res.status).toBe(200);
  });
});
