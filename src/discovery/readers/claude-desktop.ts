/**
 * Claude Desktop config reader — AAP-53.
 *
 * macOS: ~/Library/Application Support/Claude/claude_desktop_config.json
 * Windows: %APPDATA%\Claude\claude_desktop_config.json
 * Linux: no canonical path (Claude Desktop not packaged) — returns [].
 *
 * The reader hardcodes platform paths via process.platform. APPDATA on
 * Windows is read from env at call time so users overriding HOME for
 * tests still get reproducible behaviour.
 */

import { join } from 'node:path';

import type { AgentReader, DiscoveredMcpServer } from '../types.js';
import { parseCanonicalMcpServers } from './_shared.js';

function platformPaths(homeDir: string): string[] {
  if (process.platform === 'darwin') {
    return [join(homeDir, 'Library/Application Support/Claude/claude_desktop_config.json')];
  }
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA;
    if (appdata) return [join(appdata, 'Claude/claude_desktop_config.json')];
    return [join(homeDir, 'AppData/Roaming/Claude/claude_desktop_config.json')];
  }
  return [];
}

export const claudeDesktopReader: AgentReader = {
  runtime: 'claude-desktop',
  paths(homeDir) {
    return platformPaths(homeDir);
  },
  async parse(content): Promise<DiscoveredMcpServer[]> {
    return parseCanonicalMcpServers(content);
  },
};
