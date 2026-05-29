/**
 * Discovery end-to-end integration test — AAP-53 / AAP-100 / AAP-105.
 *
 * Spins up a temp $HOME, writes fixture configs for the two supported
 * runtimes (codex, claude-code), and runs `runDiscovery` once per
 * runtime. (AAP-105/G8a cut the cursor/continue/windsurf/claude-desktop
 * readers; fixtures that lived under cursor folded into claude-code,
 * which reads the same canonical `mcpServers` JSON shape.) Asserts:
 *
 *   1. Each per-runtime call surfaces only that runtime's agent.
 *   2. Redacted env-key NAMES survive; their VALUES never appear
 *      anywhere in the serialized result (deep-grep).
 *   3. EXTRA findings fire for the servers not mentioned in the
 *      transcript (slack + postgres). github is mentioned, so it
 *      gets a HIDDEN-CREDENTIALS finding instead (credentials
 *      configured, never discussed).
 *
 * The grep assertion is the load-bearing one: if any reader breaks
 * its whitelist contract, this test catches the leak immediately.
 *
 * AAP-100 — `runDiscovery` is no longer host-wide. Discovery scopes
 * to the audited runtime's evidence directories only. The test
 * exercises the three runtimes independently to match the new
 * contract.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDiscovery } from '../../src/discovery/index.js';
import { diffAgainstTranscript } from '../../src/discovery/diff.js';
import { secretlintScrub } from '../../src/discovery/secretlint-scrub.js';
import type { DiscoveredAgent } from '../../src/discovery/types.js';

const SECRET_VALUES = ['xoxb-fake', 'ghp-fake', 'postgres://u:p@h/db'];

// AAP-53.1 — inline secrets that survive whitelist projection but must
// be caught by Layer 2 (URL scrub) / Layer 3 (args trim) / Layer 4 (secretlint).
const INLINE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.fake_signature_value';
const INLINE_GHP = 'ghp_abcdef1234567890ABCDEF1234567890abcdef';
// Concatenated to bypass GitHub push-protection regex on the source file —
// the *runtime* fixture is the full URL.
const INLINE_SLACK_WEBHOOK =
  'https://hooks.slack.com/' + 'services/T00000000/B00000000/' + 'XXXXXXXXXXXXXXXXXXXXXXXX';
const INLINE_AWS_SIGNATURE = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';
const INLINE_RSA_BEGIN = '-----BEGIN RSA PRIVATE KEY-----';
const INLINE_BASIC_AUTH = 'admin:hunter2';

describe('discovery e2e — fixture HOME with secret redaction grep', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'heron-e2e-home-'));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('reads fixture configs per-runtime, redacts secrets, diffs against transcript', async () => {
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

    // 2. Claude Code (~/.claude.json) — github (MENTIONED in transcript)
    //    + postgres (NOT mentioned), both with credentials.
    //    AAP-105 (G8a) — github used to live in a separate `cursor`
    //    fixture; cursor was cut, so it folds into the claude-code config
    //    here. The reader path is the same canonical top-level
    //    `mcpServers` shape, so coverage is unchanged.
    await writeFile(
      join(homeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          github: {
            command: 'uvx',
            args: ['mcp-server-github'],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp-fake' },
          },
          postgres: {
            command: 'postgres-mcp',
            env: { POSTGRES_CONNECTION_STRING: 'postgres://u:p@h/db' },
          },
        },
      }),
    );

    // AAP-100 — run discovery once per runtime under audit. Each call
    // only reads that runtime's config directory.
    const codexResult = await runDiscovery({ runtime: 'codex', homeDir });
    const claudeResult = await runDiscovery({ runtime: 'claude-code', homeDir });

    // ── Per-runtime scope: each call surfaces only its own runtime ─
    expect(codexResult.agents.map((a) => a.runtime)).toEqual(['codex']);
    expect(claudeResult.agents.map((a) => a.runtime)).toEqual(['claude-code']);

    // Cross-runtime isolation: scannedPaths never touch the other runtime's dir.
    expect(codexResult.scannedPaths.some((p) => p.includes('.claude'))).toBe(false);
    expect(claudeResult.scannedPaths.some((p) => p.includes('.codex'))).toBe(false);

    // ── Combine the two results for the shared assertions below ─
    const allAgents: DiscoveredAgent[] = [
      ...codexResult.agents,
      ...claudeResult.agents,
    ];
    const allServers = allAgents.flatMap((a) => a.mcpServers);
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
    for (const result of [codexResult, claudeResult]) {
      const serialized = JSON.stringify(result);
      for (const secret of SECRET_VALUES) {
        expect(serialized.includes(secret)).toBe(false);
      }
    }

    // ── Diff against transcript (combined inventory) ──────────
    const transcript = [
      {
        category: 'tools',
        question: 'Which integrations does the agent use?',
        answer: 'I use github for code review.',
      },
    ];
    const findings = diffAgainstTranscript(allAgents, transcript);

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

  it('AAP-53.1 — Layer 2/3/4 catch inline tokens in url/args/command fields', async () => {
    // Codex (TOML) — inline credentials in URL (Slack webhook) + AWS pre-signed.
    await mkdir(join(homeDir, '.codex'), { recursive: true });
    await writeFile(
      join(homeDir, '.codex/config.toml'),
      `[mcp_servers.slack-webhook-mcp]
url = "${INLINE_SLACK_WEBHOOK}"

[mcp_servers.aws-presigned]
url = "https://bucket.s3.amazonaws.com/file?X-Amz-Signature=${INLINE_AWS_SIGNATURE}&X-Amz-Credential=AKIAfake"

[mcp_servers.basic-auth-mcp]
url = "https://${INLINE_BASIC_AUTH}@private-mcp.example.com/mcp"
`,
    );

    // Claude Code (~/.claude.json) — exercises every redaction layer:
    //   - inline --token=ghp_xxx in args (Layer 3 args-trim)
    //   - standalone --token <secret> positional (Layer 3 args-trim)
    //   - inline RSA block in a command string (Layer 4 secretlint)
    //   - inline JWT in an http url (Layer 2 url-scrub + Layer 4)
    // AAP-105 (G8a) — the two `--token` servers used to live in a
    // separate `cursor` fixture; cursor was cut, so they fold into the
    // claude-code config (same canonical `mcpServers` JSON shape, so the
    // args-trim coverage is identical).
    await writeFile(
      join(homeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          'inline-token': {
            command: 'uvx',
            args: ['mcp-server-github', `--token=${INLINE_GHP}`],
          },
          'standalone-token': {
            command: 'mcp',
            args: ['--token', INLINE_GHP, '--workspace', './foo'],
          },
          'rsa-in-command': {
            command: `bash -c "echo ${INLINE_RSA_BEGIN}"`,
          },
          'jwt-in-url': {
            type: 'http',
            url: `https://api.example.com/mcp?token=${INLINE_JWT}`,
          },
        },
      }),
    );

    // AAP-100 — combine per-runtime calls so the grep assertion runs
    // over the unioned scrubbed inventory.
    const codex = await runDiscovery({ runtime: 'codex', homeDir });
    const claude = await runDiscovery({ runtime: 'claude-code', homeDir });

    // Pass through Layer 4 (secretlint) — same path the API route uses.
    const scrubbed = [
      ...(await secretlintScrub(codex.agents)),
      ...(await secretlintScrub(claude.agents)),
    ];
    const json = JSON.stringify(scrubbed);

    // ── Deep-grep every inline secret category ─────────────────
    expect(json).not.toContain(INLINE_JWT);
    expect(json).not.toContain(INLINE_GHP);
    expect(json).not.toContain('hooks.slack.com/services/T00000000');
    expect(json).not.toContain(INLINE_AWS_SIGNATURE);
    expect(json).not.toContain('admin:hunter2');
    expect(json).not.toContain(INLINE_RSA_BEGIN);

    // ── Structural shape survives ─────────────────────────────
    const allServers = scrubbed.flatMap((a) => a.mcpServers);
    // Server names are preserved (not secret).
    const names = allServers.map((s) => s.name);
    expect(names).toContain('slack-webhook-mcp');
    expect(names).toContain('aws-presigned');
    expect(names).toContain('basic-auth-mcp');
    expect(names).toContain('inline-token');
    expect(names).toContain('standalone-token');

    // Basic-auth stripped, URL still recognisable.
    const basicAuth = allServers.find((s) => s.name === 'basic-auth-mcp')!;
    expect(basicAuth.url).toBe('https://private-mcp.example.com/mcp');

    // Inline --token=xxx → --token=[REDACTED] in args.
    const inlineToken = allServers.find((s) => s.name === 'inline-token')!;
    expect(inlineToken.args).toEqual(['mcp-server-github', '--token=[REDACTED]']);

    // Standalone --token <secret> → next positional becomes [REDACTED].
    const standalone = allServers.find((s) => s.name === 'standalone-token')!;
    expect(standalone.args).toEqual(['--token', '[REDACTED]', '--workspace', './foo']);
  });
});
