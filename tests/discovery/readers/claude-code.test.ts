/**
 * Claude Code config reader tests — AAP-53 + AAP-76.
 *
 * Config layout we care about:
 *   ~/.claude.json — TWO server locations:
 *     - top-level `mcpServers` map (legacy / global, back-compat).
 *     - `projects.<workspace>.mcpServers` (per-workspace, current).
 *   project .mcp.json — optional, same canonical shape, repo-scoped.
 *   project .claude/settings.json — enable/disable + enabledPlugins.
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

  it('parses stdio + http MCP servers from top-level mcpServers', async () => {
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
    // Top-level entries are NOT workspace-scoped.
    expect(pg.workspace).toBeUndefined();

    const http = out.find((s) => s.name === 'company')!;
    expect(http.transport).toBe('http');
    expect(http.url).toBe('https://mcp.example.com/sse');
    expect(http.hasCredentials).toBe(true);
    expect(http.redactedEnvKeys).toEqual(['Authorization']);
    expect(http.workspace).toBeUndefined();
  });

  it('returns empty array when no mcpServers and no projects are present', async () => {
    const content = JSON.stringify({ ui: { theme: 'dark' } });
    const out = await claudeCodeReader.parse(content, '/home/me/.claude.json');
    expect(out).toEqual([]);
  });

  it('skips settings.json — that file carries enable lists, not servers', async () => {
    const content = JSON.stringify({
      enabledMcpjsonServers: ['github'],
      disabledMcpjsonServers: [],
      mcpServers: {
        // Even if a future Claude Code version puts servers here, the
        // reader skips them — settings.json is plugins-only by contract.
        ghost: { command: 'should-not-appear' },
      },
    });
    const out = await claudeCodeReader.parse(content, '/home/me/.claude/settings.json');
    expect(out).toEqual([]);
  });

  // ── AAP-76 — projects.*.mcpServers parsing ──────────────────────────

  it('parses servers from projects.<workspace>.mcpServers with workspace tag', async () => {
    const content = JSON.stringify({
      mcpServers: {},
      projects: {
        '/Users/me/repo-a': {
          mcpServers: {
            theona: {
              type: 'http',
              url: 'https://theona.example/mcp',
              headers: { Authorization: 'Bearer xxx' },
            },
            postgres: {
              command: 'postgres-mcp',
              args: ['--db', 'a'],
            },
          },
        },
      },
    });
    const out = await claudeCodeReader.parse(content, '/home/me/.claude.json');
    expect(out.length).toBe(2);

    const theona = out.find((s) => s.name === 'theona')!;
    expect(theona).toBeDefined();
    expect(theona.workspace).toBe('/Users/me/repo-a');
    expect(theona.transport).toBe('http');
    expect(theona.url).toBe('https://theona.example/mcp');

    const pg = out.find((s) => s.name === 'postgres')!;
    expect(pg.workspace).toBe('/Users/me/repo-a');
    expect(pg.transport).toBe('stdio');
  });

  it('emits servers from multiple workspaces independently', async () => {
    const content = JSON.stringify({
      projects: {
        '/ws/a': { mcpServers: { shared: { command: 'a-cmd' } } },
        '/ws/b': { mcpServers: { shared: { command: 'b-cmd' } } },
      },
    });
    const out = await claudeCodeReader.parse(content, '/home/me/.claude.json');
    expect(out.length).toBe(2);
    const fromA = out.find((s) => s.workspace === '/ws/a')!;
    const fromB = out.find((s) => s.workspace === '/ws/b')!;
    expect(fromA.name).toBe('shared');
    expect(fromA.command).toBe('a-cmd');
    expect(fromB.name).toBe('shared');
    expect(fromB.command).toBe('b-cmd');
  });

  it('keeps top-level mcpServers as back-compat fallback', async () => {
    const content = JSON.stringify({
      mcpServers: {
        global: { command: 'global-cmd' },
      },
      // No projects block at all.
    });
    const out = await claudeCodeReader.parse(content, '/home/me/.claude.json');
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe('global');
    expect(out[0]!.workspace).toBeUndefined();
  });

  it('preserves top-level + workspace entries with same name (different scope)', async () => {
    const content = JSON.stringify({
      mcpServers: {
        github: { command: 'global-github' },
      },
      projects: {
        '/ws/a': {
          mcpServers: {
            github: { command: 'workspace-github' },
          },
        },
      },
    });
    const out = await claudeCodeReader.parse(content, '/home/me/.claude.json');
    // Same name, different scope → both kept.
    expect(out.length).toBe(2);
    const global = out.find((s) => s.workspace === undefined)!;
    const scoped = out.find((s) => s.workspace === '/ws/a')!;
    expect(global.command).toBe('global-github');
    expect(scoped.command).toBe('workspace-github');
  });

  it('skips projects entries without an mcpServers block', async () => {
    const content = JSON.stringify({
      projects: {
        '/ws/a': { history: [] },
        '/ws/b': { mcpServers: { only: { command: 'only-cmd' } } },
        '/ws/c': { mcpServers: [] }, // wrong shape → skipped
      },
    });
    const out = await claudeCodeReader.parse(content, '/home/me/.claude.json');
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe('only');
    expect(out[0]!.workspace).toBe('/ws/b');
  });
});
