/**
 * Codex plugin reader tests — AAP-58.
 *
 * `[plugins."<id>"]` and `[[skills.config]]` blocks live in the SAME
 * config.toml as `[mcp_servers.*]`. The reader's `parseCapabilities`
 * hook surfaces them as discriminated-union rows so the aggregator can
 * mirror them into `Agent.capabilities`.
 */

import { describe, expect, it } from 'vitest';

import { codexReader } from '../../../src/discovery/readers/codex.js';

const PATH = '/home/me/.codex/config.toml';

describe('codexReader.parseCapabilities — plugins', () => {
  it('surfaces every [plugins."*"] block with default enabled=true', async () => {
    const content = `
[plugins."documents@openai-primary-runtime"]
enabled = true
[plugins."spreadsheets@openai-primary-runtime"]
enabled = true
[plugins."github@openai-curated"]
[plugins."computer-use@openai-bundled"]
enabled = false
`;
    const out = await codexReader.parseCapabilities!(content, PATH);
    const plugins = out.filter((c) => c.kind === 'plugin');
    expect(plugins.length).toBe(4);

    const docs = plugins.find((p) => p.name === 'documents@openai-primary-runtime')!;
    expect(docs.runtime).toBe('codex');
    expect(docs.configPath).toBe(PATH);
    expect(docs.enabled).toBe(true);

    // Missing `enabled =` falls back to the default (true) — these are
    // active plugins until explicitly turned off.
    const github = plugins.find((p) => p.name === 'github@openai-curated')!;
    expect(github.enabled).toBe(true);

    const cu = plugins.find((p) => p.name === 'computer-use@openai-bundled')!;
    expect(cu.enabled).toBe(false);
  });

  it('returns [] when no plugins block is present (mcp-only fallback)', async () => {
    const content = `
[mcp_servers.slack]
url = "https://slack-mcp.example.com"
`;
    const out = await codexReader.parseCapabilities!(content, PATH);
    expect(out).toEqual([]);
  });

  it('still parses MCP servers when only plugins are present', async () => {
    const content = `
[plugins."github@openai-curated"]
enabled = true
`;
    const mcp = await codexReader.parse(content, PATH);
    expect(mcp).toEqual([]);
    const caps = await codexReader.parseCapabilities!(content, PATH);
    expect(caps.length).toBe(1);
    expect(caps[0]!.kind).toBe('plugin');
  });

  it('parses real-world Codex sample with 7 plugins + 1 skill', async () => {
    // Mirrors the user-reported config that should have produced
    // EXTRA findings but didn't pre-AAP-58.
    const content = `
[plugins."documents@openai-primary-runtime"]
enabled = true
[plugins."spreadsheets@openai-primary-runtime"]
enabled = true
[plugins."presentations@openai-primary-runtime"]
enabled = true
[plugins."github@openai-curated"]
enabled = true
[plugins."browser@openai-bundled"]
enabled = true
[plugins."computer-use@openai-bundled"]
enabled = true
[plugins."linear@openai-curated"]
enabled = true
[[skills.config]]
path = "/Users/ilaivanov/.codex/skills/linkedin-outreach-sheet-sync/SKILL.md"
enabled = false
`;
    const out = await codexReader.parseCapabilities!(content, PATH);
    expect(out.filter((c) => c.kind === 'plugin').length).toBe(7);
    expect(out.filter((c) => c.kind === 'skill').length).toBe(1);
    const skill = out.find((c) => c.kind === 'skill')!;
    if (skill.kind === 'skill') {
      expect(skill.enabled).toBe(false);
      expect(skill.path).toContain('linkedin-outreach-sheet-sync');
    }
  });
});
