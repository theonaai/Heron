/**
 * Discovery end-to-end integration test — AAP-53.
 *
 * Spins up a temp $HOME, writes three fixture configs (codex, cursor,
 * claude-code), runs the full discovery + diff pipeline, and asserts:
 *
 *   1. Three DiscoveredAgent entries, one per runtime.
 *   2. Redacted env-key NAMES survive; their VALUES never appear
 *      anywhere in the serialized result (deep-grep).
 *   3. EXTRA findings fire for the servers not mentioned in the
 *      transcript (slack + postgres). github is mentioned, so it
 *      gets a HIDDEN-CREDENTIALS finding instead (credentials
 *      configured, never discussed).
 *
 * The grep assertion is the load-bearing one: if any reader breaks
 * its whitelist contract, this test catches the leak immediately.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDiscovery } from '../../src/discovery/index.js';
import { diffAgainstTranscript } from '../../src/discovery/diff.js';

const SECRET_VALUES = ['xoxb-fake', 'ghp-fake', 'postgres://u:p@h/db'];

describe('discovery e2e — fixture HOME with secret redaction grep', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'heron-e2e-home-'));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('reads fixture configs, redacts secrets, diffs against transcript', async () => {
    // 1. Codex (TOML) — slack with credentials, NOT in transcript.
    await mkdir(join(homeDir, '.codex'), { recursive: true });
    await writeFile(
      join(homeDir, '.codex/config.toml'),
      `[mcp_servers.slack]
url = "https://slack-mcp.example.com"

[mcp_servers.slack.env]
SLACK_BOT_TOKEN = "xoxb-fake"
`,
    );

    // 2. Cursor (JSON) — github with credentials, MENTIONED in transcript.
    await mkdir(join(homeDir, '.cursor'), { recursive: true });
    await writeFile(
      join(homeDir, '.cursor/mcp.json'),
      JSON.stringify({
        mcpServers: {
          github: {
            command: 'uvx',
            args: ['mcp-server-github'],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp-fake' },
          },
        },
      }),
    );

    // 3. Claude Code (~/.claude.json) — postgres with credentials, NOT in transcript.
    await writeFile(
      join(homeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          postgres: {
            command: 'postgres-mcp',
            env: { POSTGRES_CONNECTION_STRING: 'postgres://u:p@h/db' },
          },
        },
      }),
    );

    const result = await runDiscovery({ homeDir });

    // ── Shape assertions ────────────────────────────────────────
    expect(result.agents.length).toBe(3);
    const runtimes = result.agents.map((a) => a.runtime).sort();
    expect(runtimes).toEqual(['claude-code', 'codex', 'cursor']);

    const allServers = result.agents.flatMap((a) => a.mcpServers);
    const slack = allServers.find((s) => s.name === 'slack')!;
    expect(slack.hasCredentials).toBe(true);
    expect(slack.redactedEnvKeys).toEqual(['SLACK_BOT_TOKEN']);

    const github = allServers.find((s) => s.name === 'github')!;
    expect(github.hasCredentials).toBe(true);
    expect(github.redactedEnvKeys).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN']);

    const postgres = allServers.find((s) => s.name === 'postgres')!;
    expect(postgres.hasCredentials).toBe(true);
    expect(postgres.redactedEnvKeys).toEqual(['POSTGRES_CONNECTION_STRING']);

    // ── Deep-grep secret check (the load-bearing assertion) ────
    const serialized = JSON.stringify(result);
    for (const secret of SECRET_VALUES) {
      expect(serialized.includes(secret)).toBe(false);
    }

    // ── Diff against transcript ────────────────────────────────
    const transcript = [
      {
        category: 'tools',
        question: 'Which integrations does the agent use?',
        answer: 'I use github for code review.',
      },
    ];
    const findings = diffAgainstTranscript(result.agents, transcript);

    const extras = findings.filter((f) => f.kind === 'EXTRA');
    expect(extras.map((f) => f.serverName).sort()).toEqual(['postgres', 'slack']);
    expect(extras.every((f) => f.severity === 'HIGH')).toBe(true);

    // github IS mentioned → not EXTRA. But transcript never says
    // "credentials" / "token" → HIDDEN-CREDENTIALS fires for github only.
    const hidden = findings.filter((f) => f.kind === 'HIDDEN-CREDENTIALS');
    expect(hidden.map((f) => f.serverName)).toEqual(['github']);

    // No MISSING — github was both mentioned AND discovered.
    const missing = findings.filter((f) => f.kind === 'MISSING');
    expect(missing).toEqual([]);

    // ── Final grep across findings JSON too ────────────────────
    const findingsJson = JSON.stringify(findings);
    for (const secret of SECRET_VALUES) {
      expect(findingsJson.includes(secret)).toBe(false);
    }
  });
});
