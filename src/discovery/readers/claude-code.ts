/**
 * Claude Code config reader — AAP-53.
 *
 * Reads:
 *   ~/.claude.json — canonical mcpServers map (gotcha: NOT
 *      ~/.claude/settings.json — that file only has enable/disable lists).
 *   project .mcp.json — same shape, repo-scoped.
 *   project .claude/settings.json — enable lists only, no servers.
 */

import { join } from 'node:path';

import type { AgentReader, DiscoveredMcpServer } from '../types.js';
import { parseCanonicalMcpServers } from './_shared.js';

export const claudeCodeReader: AgentReader = {
  runtime: 'claude-code',
  paths(homeDir, workspaceDir) {
    const paths = [
      join(homeDir, '.claude.json'),
      join(homeDir, '.claude/settings.json'),
    ];
    if (workspaceDir) {
      paths.push(join(workspaceDir, '.mcp.json'));
      paths.push(join(workspaceDir, '.claude/settings.json'));
    }
    return paths;
  },
  async parse(content, path): Promise<DiscoveredMcpServer[]> {
    // settings.json carries no servers — its mcpServers field is absent
    // and only enable/disable lists live there. Detect by filename so we
    // don't try to coerce a different schema into our projection.
    if (path.endsWith('settings.json')) {
      // Defensive: if a future Claude Code version moves mcpServers into
      // settings.json, the canonical parser will still pick them up.
      // Otherwise it'll return [].
      return parseCanonicalMcpServers(content);
    }
    return parseCanonicalMcpServers(content);
  },
};
