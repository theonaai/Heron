/**
 * Continue config reader — AAP-53.
 *
 * Continue stores its main config at ~/.continue/config.yaml with a
 * top-level `mcpServers:` LIST (not a map). Each item has its own
 * `name:` plus the same field shape as the canonical reader uses.
 */

import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { AgentReader, DiscoveredMcpServer } from '../types.js';
import { projectServer } from './_shared.js';

type Unknown = Record<string, unknown>;

export const continueReader: AgentReader = {
  runtime: 'continue',
  paths(homeDir, workspaceDir) {
    const paths = [join(homeDir, '.continue/config.yaml')];
    if (workspaceDir) paths.push(join(workspaceDir, '.continue/config.yaml'));
    return paths;
  },
  async parse(content): Promise<DiscoveredMcpServer[]> {
    let doc: unknown;
    try {
      doc = parseYaml(content);
    } catch {
      return [];
    }
    if (!doc || typeof doc !== 'object') return [];
    const root = doc as Unknown;
    const list = root.mcpServers;
    if (!Array.isArray(list)) return [];
    const out: DiscoveredMcpServer[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      const config = entry as Unknown;
      const name = typeof config.name === 'string' ? config.name : '';
      if (!name) continue;
      out.push(projectServer(name, config));
    }
    return out;
  },
};
