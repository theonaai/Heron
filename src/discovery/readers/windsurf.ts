/**
 * Windsurf config reader — AAP-53.
 *
 * Path: ~/.codeium/windsurf/mcp_config.json. Schema matches Claude
 * Desktop. ${env:VAR} / ${file:/path} interpolation templates are
 * preserved as-is in the env values — Heron never resolves them and the
 * key-name projection means the template string itself is never read
 * beyond Object.keys.
 */

import { join } from 'node:path';

import type { AgentReader, DiscoveredMcpServer } from '../types.js';
import { parseCanonicalMcpServers } from './_shared.js';

export const windsurfReader: AgentReader = {
  runtime: 'windsurf',
  paths(homeDir) {
    return [join(homeDir, '.codeium/windsurf/mcp_config.json')];
  },
  async parse(content): Promise<DiscoveredMcpServer[]> {
    return parseCanonicalMcpServers(content);
  },
};
