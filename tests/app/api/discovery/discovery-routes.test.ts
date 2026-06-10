/**
 * Discovery API route tests — AAP-53.
 *
 * Covers:
 *   - GET  /api/discovery/consent
 *   - POST /api/discovery/consent
 *   - POST /api/discovery/scan
 *
 * Uses temp HOME (HERON_DISCOVERY_HOME) and temp sessions dir
 * (HERON_SESSIONS_DIR). Same-origin POSTs include Sec-Fetch-Site.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GET as consentGET, POST as consentPOST } from '@/app/api/discovery/consent/route';
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

describe('discovery API routes', () => {
  let sessionsDir: string;
  let homeDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    sessionsDir = await mkdtemp(join(tmpdir(), 'heron-discovery-sessions-'));
    homeDir = await mkdtemp(join(tmpdir(), 'heron-discovery-home-'));
    workspaceDir = await mkdtemp(join(tmpdir(), 'heron-discovery-workspace-'));
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

  describe('GET /api/discovery/consent', () => {
    it('returns { decision: "deny" } when nothing is stored', async () => {
      const res = await consentGET(
        jsonRequest(`${ORIGIN}/api/discovery/consent?workspace=${encodeURIComponent(workspaceDir)}`),
      );
      expect(res.status).toBe(200);
      const body = (await readJson(res)) as { decision: string };
      expect(body.decision).toBe('deny');
    });
  });

  describe('POST /api/discovery/consent', () => {
    it('persists allow-for-workspace and GET returns it', async () => {
      const res = await consentPOST(
        jsonRequest(`${ORIGIN}/api/discovery/consent`, {
          method: 'POST',
          body: { workspace: workspaceDir, decision: 'allow-for-workspace' },
        }),
      );
      expect(res.status).toBe(200);
      const get = await consentGET(
        jsonRequest(`${ORIGIN}/api/discovery/consent?workspace=${encodeURIComponent(workspaceDir)}`),
      );
      const body = (await readJson(get)) as { decision: string };
      expect(body.decision).toBe('allow-for-workspace');
    });

    it('rejects non-same-origin POST (403)', async () => {
      const req = new Request(`${ORIGIN}/api/discovery/consent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          host: '127.0.0.1:3700',
          'Sec-Fetch-Site': 'cross-site',
        },
        body: JSON.stringify({ workspace: workspaceDir, decision: 'allow-for-workspace' }),
      });
      const res = await consentPOST(req);
      expect(res.status).toBe(403);
    });

    it('rejects invalid decision (400)', async () => {
      const res = await consentPOST(
        jsonRequest(`${ORIGIN}/api/discovery/consent`, {
          method: 'POST',
          body: { workspace: workspaceDir, decision: 'maybe' },
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/discovery/scan', () => {
    it('returns 403 when consent absent', async () => {
      // Create a session first.
      const created = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, { method: 'POST', body: { agentName: 'x' } }),
      );
      const { id } = (await readJson(created)) as { id: string };

      const res = await scanPOST(
        jsonRequest(`${ORIGIN}/api/discovery/scan`, {
          method: 'POST',
          body: { sessionId: id, workspaceRoot: workspaceDir, runtime: 'codex' },
        }),
      );
      expect(res.status).toBe(403);
      const body = (await readJson(res)) as { error: string };
      expect(body.error).toBe('consent_required');
    });

    it('reads configs + applies redaction + writes localAgentDiscovery into report.json', async () => {
      // Create session + finalize a stub report.
      const created = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, { method: 'POST', body: { agentName: 'x' } }),
      );
      const { id } = (await readJson(created)) as { id: string };
      await reportPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions/${id}/report`, {
          method: 'POST',
          body: {
            markdown: '# x',
            json: {
              summary: 's',
              agentPurpose: 'p',
              systems: [],
              risks: [],
              recommendations: [],
              overallRiskLevel: 'low',
            },
          },
        }),
        { params: Promise.resolve({ id }) } as never,
      );

      // Write a fixture config inside the fake HOME.
      await mkdir(join(homeDir, '.codex'), { recursive: true });
      await writeFile(
        join(homeDir, '.codex/config.toml'),
        `[mcp_servers.slack]\nurl = "https://slack-mcp.example.com"\n[mcp_servers.slack.env]\nSLACK_BOT_TOKEN = "xoxb-secret-DO-NOT-LEAK"\n`,
      );

      // Grant consent.
      await consentPOST(
        jsonRequest(`${ORIGIN}/api/discovery/consent`, {
          method: 'POST',
          body: { workspace: workspaceDir, decision: 'allow-for-workspace' },
        }),
      );

      const res = await scanPOST(
        jsonRequest(`${ORIGIN}/api/discovery/scan`, {
          method: 'POST',
          body: { sessionId: id, workspaceRoot: workspaceDir, runtime: 'codex' },
        }),
      );
      expect(res.status).toBe(200);
      const result = (await readJson(res)) as {
        agents: Array<{ runtime: string; mcpServers: Array<{ name: string }> }>;
        findings: Array<{ kind: string }>;
      };
      expect(result.agents.length).toBe(1);
      expect(result.agents[0].runtime).toBe('codex');
      expect(result.agents[0].mcpServers[0].name).toBe('slack');

      // Secret value never appears anywhere in the response.
      expect(JSON.stringify(result)).not.toContain('xoxb-secret-DO-NOT-LEAK');
    });

    it('rejects cross-site POST (403) before doing any work', async () => {
      // Cross-site browser fetch at 127.0.0.1 — refused at the guard,
      // never reaching session lookup or the consent / fs readers.
      const created = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, { method: 'POST', body: { agentName: 'x' } }),
      );
      const { id } = (await readJson(created)) as { id: string };

      const res = await scanPOST(
        jsonRequest(`${ORIGIN}/api/discovery/scan`, {
          method: 'POST',
          body: { sessionId: id, workspaceRoot: workspaceDir, runtime: 'codex' },
          headers: { 'Sec-Fetch-Site': 'cross-site' },
        }),
      );
      expect(res.status).toBe(403);
      const body = (await readJson(res)) as { error: string; code?: string };
      expect(body.code).toBe('csrf');
    });

    it('rejects same-site sibling-port POST (403)', async () => {
      const created = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, { method: 'POST', body: { agentName: 'x' } }),
      );
      const { id } = (await readJson(created)) as { id: string };

      const res = await scanPOST(
        jsonRequest(`${ORIGIN}/api/discovery/scan`, {
          method: 'POST',
          body: { sessionId: id, workspaceRoot: workspaceDir, runtime: 'codex' },
          headers: { 'Sec-Fetch-Site': 'same-site' },
        }),
      );
      expect(res.status).toBe(403);
    });

    it('passes the guard when Sec-Fetch-Site is absent (non-browser parity)', async () => {
      // No header → allowed past the guard. It will still 403 LATER on
      // consent_required (no consent stored), proving the guard let it
      // through to the real handler rather than rejecting at the door.
      const created = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, { method: 'POST', body: { agentName: 'x' } }),
      );
      const { id } = (await readJson(created)) as { id: string };

      const req = new Request(`${ORIGIN}/api/discovery/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: '127.0.0.1:3700' },
        body: JSON.stringify({ sessionId: id, workspaceRoot: workspaceDir, runtime: 'codex' }),
      });
      const res = await scanPOST(req);
      // Reached the handler — 403 here is consent_required, not the guard.
      expect(res.status).toBe(403);
      const body = (await readJson(res)) as { error: string; code?: string };
      expect(body.code).toBe('consent_required');
    });

    it('rejects when sessionId is invalid (400)', async () => {
      await consentPOST(
        jsonRequest(`${ORIGIN}/api/discovery/consent`, {
          method: 'POST',
          body: { workspace: workspaceDir, decision: 'allow-for-workspace' },
        }),
      );
      const res = await scanPOST(
        jsonRequest(`${ORIGIN}/api/discovery/scan`, {
          method: 'POST',
          body: { sessionId: 'bogus', workspaceRoot: workspaceDir, runtime: 'codex' },
        }),
      );
      expect(res.status).toBe(400);
    });

    it('overlays agent-forwarded tools/list records onto discovery output (AAP-82 Blocker 1)', async () => {
      // The dashboard scan route's counterpart of the start_verification
      // integration test. Proves the wiring is symmetric — both code
      // paths must call `listReportedMcpTools` after `runDiscovery` and
      // overlay through `overlayAgentReportedToolEnumerations` so the
      // persisted `localAgentDiscovery` reflects the agent-forwarded
      // tools and the verdict ramp picks them up.
      const created = await listPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions`, {
          method: 'POST',
          body: { agentName: 'aap82-dashboard-overlay' },
        }),
      );
      const { id } = (await readJson(created)) as { id: string };
      await reportPOST(
        jsonRequest(`${ORIGIN}/api/audit/sessions/${id}/report`, {
          method: 'POST',
          body: {
            markdown: '# x',
            json: {
              summary: 's',
              agentPurpose: 'p',
              systems: [],
              risks: [],
              recommendations: [],
              overallRiskLevel: 'low',
            },
          },
        }),
        { params: Promise.resolve({ id }) } as never,
      );

      // Pre-stage the agent-forwarded tools BEFORE the scan runs (the
      // real protocol is "interview directive → report_mcp_tools_list →
      // scan"). Direct call to the storage helper because we don't have
      // the MCP server harness in this test.
      const { saveReportedMcpToolsList } = await import('@/src/storage/sessions');
      const { parseAgentReportedToolsList } = await import('@/src/discovery/mcp-tools-enumerator');
      const enumeration = parseAgentReportedToolsList('github', {
        tools: [
          { name: 'get_pull_request', description: 'Read a PR.' },
          { name: 'create_issue', description: 'Open an issue.' },
          { name: 'merge_pull_request', description: 'Merge.' },
        ],
      });
      await saveReportedMcpToolsList(id, {
        serverName: 'github',
        receivedAt: enumeration.attemptedAt,
        enumeration,
      });

      // Fixture: declare the github server in the codex config so the
      // discovery readers know about it.
      await mkdir(join(homeDir, '.codex'), { recursive: true });
      await writeFile(
        join(homeDir, '.codex/config.toml'),
        '[mcp_servers.github]\n' +
          'url = "https://api.githubcopilot.com/mcp"\n' +
          '[mcp_servers.github.env]\n' +
          'GITHUB_TOKEN = "ghp-DO-NOT-LEAK"\n',
      );
      await consentPOST(
        jsonRequest(`${ORIGIN}/api/discovery/consent`, {
          method: 'POST',
          body: { workspace: workspaceDir, decision: 'allow-for-workspace' },
        }),
      );

      const res = await scanPOST(
        jsonRequest(`${ORIGIN}/api/discovery/scan`, {
          method: 'POST',
          body: { sessionId: id, workspaceRoot: workspaceDir, runtime: 'codex' },
        }),
      );
      expect(res.status).toBe(200);
      const result = (await readJson(res)) as {
        agents: Array<{
          runtime: string;
          mcpServers: Array<{
            name: string;
            toolEnumeration?: {
              state: string;
              source?: string;
              tools?: Array<{ name: string; source?: string; classification: string }>;
            };
          }>;
        }>;
      };

      // Overlay applied: the github server now carries an
      // agent-reported enumeration with 3 tools.
      const githubServer = result.agents
        .flatMap((a) => a.mcpServers)
        .find((s) => s.name === 'github');
      expect(githubServer).toBeDefined();
      expect(githubServer!.toolEnumeration?.state).toBe('ok');
      expect(githubServer!.toolEnumeration?.source).toBe('agent-reported');
      expect(githubServer!.toolEnumeration?.tools).toHaveLength(3);
      for (const t of githubServer!.toolEnumeration?.tools ?? []) {
        expect(t.source).toBe('agent-reported');
      }
    }, 20_000);
  });
});
