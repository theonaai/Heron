/**
 * Cursor config reader — AAP-53.
 *
 * Cursor stores its MCP config at ~/.cursor/mcp.json (user-level) and
 * project-level .cursor/mcp.json. Schema matches Claude Desktop's
 * canonical `mcpServers` map.
 */

import { join } from 'node:path';

import type { AgentReader, DiscoveredMcpServer } from '../types.js';
import { parseCanonicalMcpServers } from './_shared.js';

export const cursorReader: AgentReader = {
  runtime: 'cursor',
  paths(homeDir, workspaceDir) {
    const paths = [join(homeDir, '.cursor/mcp.json')];
    if (workspaceDir) paths.push(join(workspaceDir, '.cursor/mcp.json'));
    return paths;
  },
  async parse(content): Promise<DiscoveredMcpServer[]> {
    return parseCanonicalMcpServers(content);
  },
};
