/**
 * Discovery aggregator — `Agent.capabilities` population test (AAP-58).
 *
 * Boundary conditions covered:
 *   - MCP servers are mirrored into capabilities with `kind: 'mcp_server'`.
 *   - Plugins / skills land alongside them.
 *   - Auth-credential rows attach to the same Agent block when there's
 *     a prior reader entry for that runtime.
 *   - Auth-only runtimes (config.toml absent but auth.json present)
 *     still produce an Agent row keyed on the credentials file path.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runDiscovery } from '../../src/discovery/index.js';

describe('runDiscovery — capabilities mirror (AAP-58)', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'heron-aap58-'));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('mirrors mcp servers + plugins + skills + auth creds into capabilities[]', async () => {
    await mkdir(join(homeDir, '.codex'), { recursive: true });
    await writeFile(
      join(homeDir, '.codex/config.toml'),
      `
[mcp_servers.slack]
url = "https://slack-mcp.example.com"

[plugins."documents@openai-primary-runtime"]
enabled = true
[plugins."github@openai-curated"]
enabled = true
[plugins."computer-use@openai-bundled"]
enabled = false

[[skills.config]]
path = "/abs/path/SKILL.md"
enabled = false
`,
    );
    await writeFile(
      join(homeDir, '.codex/auth.json'),
      JSON.stringify({ openai_api_key: 'sk-fake1234567890abcdef' }),
    );

    const result = await runDiscovery({ runtime: 'codex', homeDir });
    expect(result.agents.length).toBe(1);
    const codex = result.agents[0]!;
    expect(codex.runtime).toBe('codex');
    expect(codex.mcpServers.length).toBe(1);

    expect(codex.capabilities).toBeDefined();
    const caps = codex.capabilities!;
    const byKind = (k: string) => caps.filter((c) => c.kind === k);
    expect(byKind('mcp_server').length).toBe(1);
    expect(byKind('plugin').length).toBe(3);
    expect(byKind('skill').length).toBe(1);
    expect(byKind('auth_credential').length).toBe(1);

    const auth = byKind('auth_credential')[0]!;
    if (auth.kind !== 'auth_credential') throw new Error('expected auth_credential');
    expect(auth.provider).toBe('openai_api_key');
    expect(auth.hasValue).toBe(true);
  });

  it('emits an auth-only agent row when only auth.json exists', async () => {
    await mkdir(join(homeDir, '.codex'), { recursive: true });
    await writeFile(
      join(homeDir, '.codex/auth.json'),
      JSON.stringify({ some_provider: 'token-but-not-classified-as-secret' }),
    );
    const result = await runDiscovery({ runtime: 'codex', homeDir });
    expect(result.agents.length).toBe(1);
    const codex = result.agents[0]!;
    expect(codex.runtime).toBe('codex');
    expect(codex.mcpServers).toEqual([]);
    expect(codex.capabilities?.filter((c) => c.kind === 'auth_credential').length).toBe(1);
    expect(codex.configPath).toContain('.codex/auth.json');
  });

  it('never leaks credential VALUES into the result', async () => {
    await mkdir(join(homeDir, '.codex'), { recursive: true });
    await writeFile(
      join(homeDir, '.codex/auth.json'),
      JSON.stringify({ openai_api_key: 'sk-DO-NOT-LEAK-mePLEASE12345678' }),
    );
    const result = await runDiscovery({ runtime: 'codex', homeDir });
    expect(JSON.stringify(result)).not.toContain('sk-DO-NOT-LEAK-mePLEASE12345678');
  });

  it('AAP-100 — per-runtime scope: a Codex audit does not surface Claude Code findings', async () => {
    // Seed BOTH ~/.codex/* and ~/.claude.json with MCP servers.
    await mkdir(join(homeDir, '.codex'), { recursive: true });
    await writeFile(
      join(homeDir, '.codex/config.toml'),
      `
[mcp_servers.slack]
url = "https://slack-mcp.example.com"
`,
    );
    await writeFile(
      join(homeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          postgres: { command: 'postgres-mcp' },
        },
      }),
    );

    const result = await runDiscovery({ runtime: 'codex', homeDir });

    // Only the Codex agent should be present.
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.runtime).toBe('codex');
    const names = result.agents[0]!.mcpServers.map((s) => s.name);
    expect(names).toContain('slack');
    expect(names).not.toContain('postgres');

    // None of the scanned paths should touch ~/.claude.json.
    const claudePaths = result.scannedPaths.filter((p) => p.includes('.claude'));
    expect(claudePaths).toEqual([]);
  });

  it('AAP-100 — per-runtime scope: a Claude Code audit does not surface Codex findings', async () => {
    await mkdir(join(homeDir, '.codex'), { recursive: true });
    await writeFile(
      join(homeDir, '.codex/config.toml'),
      `
[mcp_servers.slack]
url = "https://slack-mcp.example.com"
`,
    );
    await writeFile(
      join(homeDir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          postgres: { command: 'postgres-mcp' },
        },
      }),
    );

    const result = await runDiscovery({ runtime: 'claude-code', homeDir });

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.runtime).toBe('claude-code');
    const names = result.agents[0]!.mcpServers.map((s) => s.name);
    expect(names).toContain('postgres');
    expect(names).not.toContain('slack');

    const codexPaths = result.scannedPaths.filter((p) => p.includes('.codex'));
    expect(codexPaths).toEqual([]);
  });
});
