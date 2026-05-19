/**
 * Codex config reader — AAP-53.
 *
 * Codex stores MCP server config in TOML under `[mcp_servers.<id>]`
 * blocks. Each block carries command / url / env (sub-block) /
 * enabled_tools / disabled_tools / scopes.
 *
 * Whitelist projection mirrors the canonical reader: only schema fields
 * survive after parseToml. Everything else from the document is dropped.
 */

import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';

import type { AgentReader, DiscoveredMcpServer } from '../types.js';
import { projectServer } from './_shared.js';

type Unknown = Record<string, unknown>;

export const codexReader: AgentReader = {
  runtime: 'codex',
  paths(homeDir, workspaceDir) {
    const paths = [join(homeDir, '.codex/config.toml')];
    if (workspaceDir) paths.push(join(workspaceDir, '.codex/config.toml'));
    return paths;
  },
  async parse(content): Promise<DiscoveredMcpServer[]> {
    let doc: unknown;
    try {
      doc = parseToml(content);
    } catch {
      return [];
    }
    if (!doc || typeof doc !== 'object') return [];
    const servers = (doc as Unknown).mcp_servers;
    if (!servers || typeof servers !== 'object') return [];
    const out: DiscoveredMcpServer[] = [];
    for (const [name, config] of Object.entries(servers as Unknown)) {
      if (!config || typeof config !== 'object') continue;
      // Codex uses enabled_tools/disabled_tools instead of toolsAllowed/toolsDenied.
      out.push(
        projectServer(name, config as Unknown, {
          toolsAllowedKey: 'enabled_tools',
          toolsDeniedKey: 'disabled_tools',
        }),
      );
    }
    return out;
  },
};
