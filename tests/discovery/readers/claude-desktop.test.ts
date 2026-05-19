/**
 * Claude Desktop config reader tests — AAP-53.
 *
 * macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
 * Windows: %APPDATA%/Claude/claude_desktop_config.json (not tested cross-platform)
 * Linux: no canonical path — reader returns empty.
 */

import { describe, expect, it } from 'vitest';

import { claudeDesktopReader } from '../../../src/discovery/readers/claude-desktop.js';

describe('claudeDesktopReader', () => {
  it('enumerates the macOS path on darwin', () => {
    const paths = claudeDesktopReader.paths('/Users/me');
    // Path resolution is platform-aware. Either macOS or Windows path
    // must appear — on Linux this may be empty. Smoke check it returns
    // a non-fatal array.
    expect(Array.isArray(paths)).toBe(true);
    if (process.platform === 'darwin') {
      expect(paths).toContain('/Users/me/Library/Application Support/Claude/claude_desktop_config.json');
    }
  });

  it('parses MCP servers from JSON', async () => {
    const content = JSON.stringify({
      mcpServers: {
        notion: {
          command: 'mcp-notion',
          env: { NOTION_API_KEY: 'secret_fake' },
        },
      },
    });
    const out = await claudeDesktopReader.parse(
      content,
      '/Users/me/Library/Application Support/Claude/claude_desktop_config.json',
    );
    expect(out.length).toBe(1);
    expect(out[0].name).toBe('notion');
    expect(out[0].command).toBe('mcp-notion');
    expect(out[0].hasCredentials).toBe(true);
    expect(out[0].redactedEnvKeys).toEqual(['NOTION_API_KEY']);
  });
});
