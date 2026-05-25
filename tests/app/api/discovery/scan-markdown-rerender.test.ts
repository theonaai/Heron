/**
 * AAP-79 — POST /api/discovery/scan re-renders report.md on success.
 *
 * Codex review on PR #69 surfaced finding 2.2: the dashboard's
 * "Run verification" path patched `report.json` (flipping
 * `verification.status` to 'verified' and replacing `compliance`) but
 * never rewrote `report.md`. The dashboard would show `verified` while
 * the .md download still carried the interrogation-only banner and the
 * stale compliance section. The fix wires the shared
 * `persistVerifiedMarkdown` helper into the scan route immediately
 * after `persistVerdict`.
 *
 * These tests exercise the route end-to-end (same fixtures as the
 * existing `discovery-routes.test.ts`) and assert that after a
 * successful scan:
 *   - `report.md` no longer contains the UNVERIFIED stub.
 *   - `report.md` contains the "Verified" header tag the
 *     `renderVerificationStatusSection` emits when a partial / verified
 *     verdict is attached.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { POST as consentPOST } from '@/app/api/discovery/consent/route';
import { POST as scanPOST } from '@/app/api/discovery/scan/route';
import { POST as listPOST } from '@/app/api/audit/sessions/route';
import { POST as reportPOST } from '@/app/api/audit/sessions/[id]/report/route';

const ORIGIN = 'http://127.0.0.1:3700';

function jsonRequest(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    host: '127.0.0.1:3700',
    'Sec-Fetch-Site': 'same-origin',
    ...(init.headers ?? {}),
  };
  return new Request(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

describe('POST /api/discovery/scan — AAP-79 markdown re-render', () => {
  let sessionsDir: string;
  let homeDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    sessionsDir = await mkdtemp(join(tmpdir(), 'heron-aap79-scan-md-sessions-'));
    homeDir = await mkdtemp(join(tmpdir(), 'heron-aap79-scan-md-home-'));
    workspaceDir = await mkdtemp(join(tmpdir(), 'heron-aap79-scan-md-workspace-'));
    process.env.HERON_SESSIONS_DIR = sessionsDir;
    process.env.HERON_DISCOVERY_HOME = homeDir;
  });

  afterEach(async () => {
    delete process.env.HERON_SESSIONS_DIR;
    delete process.env.HERON_DISCOVERY_HOME;
    await rm(sessionsDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('rewrites report.md with the Verified header / Verification Status table after a successful scan', async () => {
    // 1. Create the session.
    const created = await listPOST(
      jsonRequest(`${ORIGIN}/api/audit/sessions`, {
        method: 'POST',
        body: { agentName: 'aap79-scan-md' },
      }),
    );
    const { id } = (await readJson(created)) as { id: string };

    // 2. Seed a renderable report.json (analyzer's required fields)
    //    AND a deliberately-interrogation-only report.md. The starting
    //    body carries the UNVERIFIED stub copy so we can prove the
    //    rewrite actually replaced it.
    const baselineJson = {
      summary: 'Demo agent that posts Slack messages.',
      agentPurpose: 'Slack reminders',
      systems: [],
      risks: [],
      recommendations: [],
      overallRiskLevel: 'low',
      transcript: [],
      metadata: {
        date: '2026-05-25',
        target: 'slack-bot',
        interviewDuration: 1000,
        questionsAsked: 0,
      },
    };
    const baselineMd =
      '# Stub\n\n## Verification Status\n\n**Verification status:** ' +
      '_UNVERIFIED — Surface 2 deterministic sources have not run yet._\n';
    await reportPOST(
      jsonRequest(`${ORIGIN}/api/audit/sessions/${id}/report`, {
        method: 'POST',
        body: { markdown: baselineMd, json: baselineJson },
      }),
      { params: Promise.resolve({ id }) } as never,
    );

    // 3. Drop a fixture MCP config inside the fake HOME so runDiscovery
    //    has something real to surface.
    await mkdir(join(homeDir, '.codex'), { recursive: true });
    await writeFile(
      join(homeDir, '.codex/config.toml'),
      `[mcp_servers.slack]\nurl = "https://slack-mcp.example.com"\n` +
        `[mcp_servers.slack.env]\nSLACK_BOT_TOKEN = "xoxb-test-DO-NOT-LEAK"\n`,
    );

    // 4. Grant consent + run the scan.
    await consentPOST(
      jsonRequest(`${ORIGIN}/api/discovery/consent`, {
        method: 'POST',
        body: { workspace: workspaceDir, decision: 'allow-for-workspace' },
      }),
    );
    const scanRes = await scanPOST(
      jsonRequest(`${ORIGIN}/api/discovery/scan`, {
        method: 'POST',
        body: { sessionId: id, workspaceRoot: workspaceDir },
      }),
    );
    expect(scanRes.status).toBe(200);

    // 5. Read report.md straight from the sessions dir. The pre-AAP-80
    //    behaviour emitted "Risk Level (Verified)" for any verdict with
    //    Surface 2 evidence; AAP-80 routes the label through
    //    `report.verification.status`, so a discovery-only scan (no
    //    OAuth introspection) produces a partial verdict ⇒
    //    `'partially-verified'` ⇒ "Risk Level (Partially Verified)".
    const mdPath = join(sessionsDir, id, 'report.md');
    const after = await readFile(mdPath, 'utf8');

    // The interrogation-only stub copy is gone.
    expect(after).not.toContain(
      'UNVERIFIED — Surface 2 deterministic sources have not run yet',
    );
    // The per-source Verification Status table is in place.
    expect(after).toContain('## Verification Status');
    expect(after).toContain('Filesystem discovery');
    // The header risk-level line now carries the Partially Verified
    // prefix (AAP-80).
    expect(after).toContain('Risk Level (Partially Verified)');
    expect(after).not.toContain('Risk Level (Verified)');
    // The amber AAP-80 banner copy renders for the partial state.
    expect(after).toContain('Partially verified.');

    // The fixture's secret VALUE never leaked into the rendered
    // markdown. Same invariant the response-shape test enforces.
    expect(after).not.toContain('xoxb-test-DO-NOT-LEAK');
  });
});
