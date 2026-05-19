/**
 * Cursor config reader tests — AAP-53.
 *
 * Schema matches Claude Desktop's `mcpServers` map. JSON only.
 */

import { describe, expect, it } from 'vitest';

import { cursorReader } from '../../../src/discovery/readers/cursor.js';

describe('cursorReader', () => {
  it('enumerates user + workspace paths', () => {
    expect(cursorReader.paths('/home/me', '/repo')).toEqual([
      '/home/me/.cursor/mcp.json',
      '/repo/.cursor/mcp.json',
    ]);
  });

  it('parses MCP servers from JSON', async () => {
    const content = JSON.stringify({
      mcpServers: {
        github: {
          command: 'uvx',
          args: ['mcp-server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp-fake' },
        },
      },
    });
    const out = await cursorReader.parse(content, '/home/me/.cursor/mcp.json');
    expect(out.length).toBe(1);

    const gh = out[0];
    expect(gh.name).toBe('github');
    expect(gh.transport).toBe('stdio');
    expect(gh.command).toBe('uvx');
    expect(gh.args).toEqual(['mcp-server-github']);
    expect(gh.hasCredentials).toBe(true);
    expect(gh.redactedEnvKeys).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN']);
  });
});
