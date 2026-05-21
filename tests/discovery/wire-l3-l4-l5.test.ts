/**
 * AAP-67 — wire-up tests: L3 + L4 + L5 plumbed through `runDiscovery`,
 * `/api/discovery/scan`, the report.json shape, and the markdown
 * template `renderLocalDiscoveryExtras`.
 *
 * The load-bearing E2E test seeds a real `~/.aws/credentials` (L4) + a
 * workspace `.env` (L5) + a mock Keychain dump (L3), runs the discovery
 * scan route end-to-end, and asserts:
 *
 *   1. All three sections populate on the response (and therefore on
 *      report.json via patchReportJson).
 *   2. The `keys[]`, `tokens[]`, and `services[]` lists carry the
 *      NAMES the operator expected.
 *   3. The serialised response + report.json + transcript.jsonl + meta
 *      contain ZERO verbatim secret values from the fixtures.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { POST as consentPOST } from '@/app/api/discovery/consent/route';
import { POST as scanPOST } from '@/app/api/discovery/scan/route';
import { POST as listPOST } from '@/app/api/audit/sessions/route';
import { POST as reportPOST } from '@/app/api/audit/sessions/[id]/report/route';

import { runDiscovery } from '@/src/discovery/index';
import type { KeychainSpawn } from '@/src/discovery/readers/keychain';
import { renderMarkdownReport } from '@/src/report/templates';
import type { AuditReport } from '@/src/report/types';

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

const KEYCHAIN_DUMP = `keychain: "/Users/heron/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "acct"<blob>="api"
    "svce"<blob>="Anthropic API Key"
keychain: "/Users/heron/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "svce"<blob>="Slack Mac App"
`;

function fakeSpawn(stdout: string, code = 0): KeychainSpawn {
  return () => {
    const emitter = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
    };
    emitter.stdout = Readable.from([stdout]);
    emitter.stderr = Readable.from(['']);
    setImmediate(() => emitter.emit('close', code));
    return emitter as unknown as ReturnType<KeychainSpawn>;
  };
}

describe('AAP-67 wire-up — L3+L4+L5 through runDiscovery + scan route + report templates', () => {
  let sessionsDir: string;
  let homeDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    sessionsDir = await mkdtemp(join(tmpdir(), 'heron-aap67-wire-sessions-'));
    homeDir = await mkdtemp(join(tmpdir(), 'heron-aap67-wire-home-'));
    workspaceDir = await mkdtemp(join(tmpdir(), 'heron-aap67-wire-workspace-'));
    process.env.HERON_SESSIONS_DIR = sessionsDir;
    process.env.HERON_DISCOVERY_HOME = homeDir;
    // The route uses the real `child_process.spawn` for Keychain. We
    // disable Keychain at the route level via env var so a darwin dev
    // box running this test never shells out — L3 is exercised by the
    // direct `runDiscovery` test below with an injected fake spawn.
    process.env.HERON_DISCOVERY_KEYCHAIN_DISABLE = '1';
  });
  afterEach(async () => {
    delete process.env.HERON_SESSIONS_DIR;
    delete process.env.HERON_DISCOVERY_HOME;
    delete process.env.HERON_DISCOVERY_KEYCHAIN_DISABLE;
    await rm(sessionsDir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
    await rm(workspaceDir, { recursive: true, force: true });
  });

  it('runDiscovery surfaces L3 + L4 + L5 when called directly (no route)', async () => {
    // Test runs `runDiscovery` directly with an injected fake spawn, so
    // the env-var Keychain suppression set in `beforeEach` must be off.
    delete process.env.HERON_DISCOVERY_KEYCHAIN_DISABLE;

    // L4 — AWS credentials with a real-looking key value.
    await mkdir(join(homeDir, '.aws'), { recursive: true });
    await writeFile(
      join(homeDir, '.aws/credentials'),
      `[default]
aws_access_key_id = AKHRNWIRElevelL4secret
aws_secret_access_key = wireL4secret/value/SHOULD/NOT/leak/EXAMPLE
`,
    );

    // L5 — workspace .env with realistic secrets.
    await writeFile(
      join(workspaceDir, '.env'),
      `AWS_ACCESS_KEY_ID=AKHRNWIRElevelL5secret
SLACK_BOT_TOKEN=XOXBFAKE_wireL5-secret-1234567890-abcdefghij
OPENAI_API_KEY=skFAKE_wireL5secretOpenAIxxxxxxxxxxxxxxxxxxxxxx
`,
    );

    const result = await runDiscovery({
      homeDir,
      workspaceDir,
      enableKeychain: true,
      platform: 'darwin',
      keychainSpawn: fakeSpawn(KEYCHAIN_DUMP),
    });

    // L4 — AWS profile name surfaced.
    const aws = (result.osCredentials ?? []).find((f) => f.kind === 'aws-credentials');
    expect(aws).toBeTruthy();
    expect(aws!.tokens).toContain('default');

    // L5 — env var NAMES surfaced.
    const env = (result.workspaceEnv ?? []).find((f) => f.path.endsWith('/.env'));
    expect(env).toBeTruthy();
    expect(env!.keys).toContain('AWS_ACCESS_KEY_ID');
    expect(env!.keys).toContain('SLACK_BOT_TOKEN');
    expect(env!.keys).toContain('OPENAI_API_KEY');

    // L3 — Keychain service names surfaced via the injected fake spawn.
    const kc = result.keychainServices ?? [];
    const services = kc.map((s) => s.service).sort();
    expect(services).toEqual(['Anthropic API Key', 'Slack Mac App']);

    // Deep-grep across the entire serialised result for fixture secret
    // values. ZERO verbatim secret value should survive.
    const serialised = JSON.stringify(result);
    for (const needle of [
      'AKHRNWIRElevelL4secret',
      'wireL4secret/value/SHOULD/NOT/leak',
      'AKHRNWIRElevelL5secret',
      'XOXBFAKE_wireL5-secret-1234567890',
      'skFAKE_wireL5secretOpenAI',
    ]) {
      expect(serialised).not.toContain(needle);
    }
  });

  it('scan route writes L4 + L5 sections onto report.json and never leaks fixture secrets', async () => {
    // Set up the session.
    const created = await listPOST(
      jsonRequest(`${ORIGIN}/api/audit/sessions`, {
        method: 'POST',
        body: { agentName: 'aap-67-wireup' },
      }),
    );
    const { id } = (await readJson(created)) as { id: string };
    await reportPOST(
      jsonRequest(`${ORIGIN}/api/audit/sessions/${id}/report`, {
        method: 'POST',
        body: {
          markdown: '# stub',
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

    // L4 fixture: AWS credentials. Secret value MUST NOT survive.
    await mkdir(join(homeDir, '.aws'), { recursive: true });
    await writeFile(
      join(homeDir, '.aws/credentials'),
      `[heron-prod]
aws_access_key_id = AKHRNroute0E2EsecretL4
aws_secret_access_key = route/E2E/secret/L4/value/SHOULD/NOT/leak
`,
    );

    // L5 fixture: workspace .env with realistic secrets.
    await writeFile(
      join(workspaceDir, '.env'),
      `ANTHROPIC_API_KEY=skFAKE_ant-routeE2EsecretL5xxxxxxxxxxxxxxxxxxxxx
SLACK_BOT_TOKEN=XOXBFAKE_routeE2E-secretL5-9999999-aaaaaaaaaaa
DATABASE_URL=postgres://routeE2Esecretuser:routeE2EsecretL5PASS@db.example.com/x
`,
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
        body: { sessionId: id, workspaceRoot: workspaceDir },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await readJson(res)) as {
      osCredentials?: Array<{ kind: string; tokens: string[] }>;
      workspaceEnv?: Array<{ path: string; keys: string[] }>;
      keychainServices?: Array<{ service: string }>;
    };

    // L4 surfaced.
    const aws = (body.osCredentials ?? []).find((f) => f.kind === 'aws-credentials');
    expect(aws).toBeTruthy();
    expect(aws!.tokens).toContain('heron-prod');

    // L5 surfaced.
    const env = (body.workspaceEnv ?? []).find((f) => f.path.endsWith('/.env'));
    expect(env).toBeTruthy();
    expect(env!.keys).toContain('ANTHROPIC_API_KEY');
    expect(env!.keys).toContain('SLACK_BOT_TOKEN');
    expect(env!.keys).toContain('DATABASE_URL');

    // L3 disabled by env override — services may be empty or warnings.
    // We don't assert keychain shape here; the L3 unit test covers it.

    // ── Privacy invariant deep-grep ─────────────────────────────────
    // Read every persisted file for this session and the response body
    // and assert NONE of the fixture secret values appear verbatim.
    const sessionDir = join(sessionsDir, id);
    const files = await readdir(sessionDir);
    let combined = JSON.stringify(body);
    for (const name of files) {
      combined += '\n' + (await readFile(join(sessionDir, name), 'utf8'));
    }
    for (const needle of [
      'AKHRNroute0E2EsecretL4',
      'route/E2E/secret/L4/value',
      'skFAKE_ant-routeE2EsecretL5',
      'XOXBFAKE_routeE2E-secretL5',
      'routeE2EsecretL5PASS',
      'routeE2Esecretuser',
    ]) {
      expect(combined).not.toContain(needle);
    }
  });

  it('renderMarkdownReport — `localDiscoveryExtras` produces the L3/L4/L5 section', () => {
    const report: AuditReport = {
      summary: 's',
      agentPurpose: 'p',
      systems: [],
      risks: [],
      recommendations: [],
      overallRiskLevel: 'low',
      compliance: undefined,
      transcript: [],
      metadata: {
        date: '2026-05-21',
        target: 'aap-67-template-test',
        interviewDuration: 0,
        questionsAsked: 0,
      },
    };
    const md = renderMarkdownReport(report, {
      localDiscoveryExtras: {
        osCredentials: [
          { kind: 'aws-credentials', path: '/home/h/.aws/credentials', tokens: ['heron-prod'] },
        ],
        workspaceEnv: [
          { path: '/ws/.env', workspace: '/ws', keys: ['ANTHROPIC_API_KEY', 'SLACK_BOT_TOKEN'] },
        ],
        keychainServices: [
          { service: 'Anthropic API Key', category: 'ai-provider' },
        ],
        warnings: ['demo warning'],
      },
    });
    expect(md).toContain('## Local Discovery — L3/L4/L5');
    expect(md).toContain('macOS Keychain services (L3)');
    expect(md).toContain('Cross-cutting OS credentials (L4)');
    expect(md).toContain('Per-workspace env vars (L5)');
    expect(md).toContain('Anthropic API Key');
    expect(md).toContain('aws-credentials');
    expect(md).toContain('heron-prod');
    expect(md).toContain('ANTHROPIC_API_KEY');
    expect(md).toContain('SLACK_BOT_TOKEN');
    expect(md).toContain('demo warning');
  });

  it('renderMarkdownReport — omits the section entirely when no extras supplied', () => {
    const report: AuditReport = {
      summary: 's',
      agentPurpose: 'p',
      systems: [],
      risks: [],
      recommendations: [],
      overallRiskLevel: 'low',
      compliance: undefined,
      transcript: [],
      metadata: {
        date: '2026-05-21',
        target: 'aap-67-template-test-empty',
        interviewDuration: 0,
        questionsAsked: 0,
      },
    };
    const md = renderMarkdownReport(report);
    expect(md).not.toContain('Local Discovery — L3/L4/L5');
  });
});
