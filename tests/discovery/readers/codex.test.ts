/**
 * Codex config reader tests — AAP-53.
 *
 * Codex uses TOML. `[mcp_servers.<id>]` blocks with command / url / env /
 * enabled_tools / disabled_tools / scopes.
 */

import { describe, expect, it } from 'vitest';

import { codexReader } from '../../../src/discovery/readers/codex.js';

describe('codexReader', () => {
  it('enumerates user + workspace paths', () => {
    expect(codexReader.paths('/home/me', '/repo')).toEqual([
      '/home/me/.codex/config.toml',
      '/repo/.codex/config.toml',
    ]);
  });

  it('parses stdio + http MCP servers from TOML', async () => {
    const content = `
[mcp_servers.slack]
url = "https://slack-mcp.example.com"
enabled_tools = ["post_message"]

[mcp_servers.slack.env]
SLACK_BOT_TOKEN = "xoxb-fake"

[mcp_servers.local]
command = "uvx"
args = ["mcp-server-fs"]
disabled_tools = ["delete"]
`;
    const out = await codexReader.parse(content, '/home/me/.codex/config.toml');
    expect(out.length).toBe(2);

    const slack = out.find((s) => s.name === 'slack')!;
    expect(slack.transport).toBe('http');
    expect(slack.url).toBe('https://slack-mcp.example.com');
    expect(slack.toolsAllowed).toEqual(['post_message']);
    expect(slack.hasCredentials).toBe(true);
    expect(slack.redactedEnvKeys).toEqual(['SLACK_BOT_TOKEN']);

    const local = out.find((s) => s.name === 'local')!;
    expect(local.transport).toBe('stdio');
    expect(local.command).toBe('uvx');
    expect(local.args).toEqual(['mcp-server-fs']);
    expect(local.toolsDenied).toEqual(['delete']);
    expect(local.hasCredentials).toBe(false);
    expect(local.redactedEnvKeys).toEqual([]);
  });

  it('returns empty array when no mcp_servers blocks present', async () => {
    const content = `[model]\nname = "gpt-5"\n`;
    const out = await codexReader.parse(content, '/home/me/.codex/config.toml');
    expect(out).toEqual([]);
  });
});
