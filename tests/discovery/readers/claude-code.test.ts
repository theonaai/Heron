/**
 * Claude Code config reader tests — AAP-53.
 *
 * Config layout we care about:
 *   ~/.claude.json — top-level mcpServers map (canonical).
 *   project .mcp.json — optional, same shape, repo-scoped.
 *   project .claude/settings.json — only carries enable/disable lists.
 */

import { describe, expect, it } from 'vitest';

import { claudeCodeReader } from '../../../src/discovery/readers/claude-code.js';

describe('claudeCodeReader', () => {
  it('enumerates user + workspace paths', () => {
    expect(claudeCodeReader.paths('/home/me', '/repo')).toEqual([
      '/home/me/.claude.json',
      '/home/me/.claude/settings.json',
      '/repo/.mcp.json',
      '/repo/.claude/settings.json',
    ]);
  });

  it('parses stdio + http MCP servers from .claude.json', async () => {
    const content = JSON.stringify({
      mcpServers: {
        postgres: {
          command: 'postgres-mcp',
          args: ['--db', 'main'],
          env: { POSTGRES_CONNECTION_STRING: 'postgres://u:p@h/db' },
        },
        company: {
          type: 'http',
          url: 'https://mcp.example.com/sse',
          headers: { Authorization: 'Bearer xxx' },
        },
      },
    });
    const out = await claudeCodeReader.parse(content, '/home/me/.claude.json');
    expect(out.length).toBe(2);

    const pg = out.find((s) => s.name === 'postgres')!;
    expect(pg.transport).toBe('stdio');
    expect(pg.command).toBe('postgres-mcp');
    expect(pg.args).toEqual(['--db', 'main']);
    expect(pg.hasCredentials).toBe(true);
    expect(pg.redactedEnvKeys).toEqual(['POSTGRES_CONNECTION_STRING']);

    const http = out.find((s) => s.name === 'company')!;
    expect(http.transport).toBe('http');
    expect(http.url).toBe('https://mcp.example.com/sse');
    expect(http.hasCredentials).toBe(true);
    expect(http.redactedEnvKeys).toEqual(['Authorization']);
  });

  it('returns empty array when mcpServers is absent', async () => {
    const content = JSON.stringify({ ui: { theme: 'dark' } });
    const out = await claudeCodeReader.parse(content, '/home/me/.claude.json');
    expect(out).toEqual([]);
  });

  it('ignores settings.json-only enable/disable lists', async () => {
    const content = JSON.stringify({
      enabledMcpjsonServers: ['github'],
      disabledMcpjsonServers: [],
    });
    const out = await claudeCodeReader.parse(content, '/home/me/.claude/settings.json');
    expect(out).toEqual([]);
  });
});
