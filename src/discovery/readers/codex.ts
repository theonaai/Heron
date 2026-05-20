/**
 * Codex config reader — AAP-53 + AAP-58.
 *
 * Codex stores capability config in TOML. Three sections matter:
 *
 *   [mcp_servers.<id>]          — classic MCP servers (AAP-53).
 *   [plugins."<id>"]            — first-class Codex plugins (AAP-58).
 *                                 Section key carries `runtime@registry`
 *                                 shape, e.g. `documents@openai-primary-runtime`.
 *                                 The plugin is enabled unless `enabled = false`
 *                                 is present in the block.
 *   [[skills.config]]           — array-of-tables of skills with explicit
 *                                 path + enabled fields.
 *
 * The whitelist contract from AAP-53 holds across all three: only the
 * declared fields survive after parseToml. Everything else is dropped.
 *
 * Secrets policy: VALUES from any of these sections are never read or
 * returned — the public surface is name + enabled flag (+ paths for
 * skills, which are absolute filesystem paths, not credentials).
 */

import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';

import type {
  AgentReader,
  DiscoveredMcpServer,
  PluginCapability,
  SkillCapability,
} from '../types.js';
import { projectServer } from './_shared.js';

type Unknown = Record<string, unknown>;

const RUNTIME = 'codex' as const;

export const codexReader: AgentReader = {
  runtime: RUNTIME,
  paths(homeDir, workspaceDir) {
    const paths = [join(homeDir, '.codex/config.toml')];
    if (workspaceDir) paths.push(join(workspaceDir, '.codex/config.toml'));
    return paths;
  },
  async parse(content): Promise<DiscoveredMcpServer[]> {
    const doc = parseCodex(content);
    if (!doc) return [];
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
  async parseCapabilities(
    content,
    path,
  ): Promise<Array<PluginCapability | SkillCapability>> {
    const doc = parseCodex(content);
    if (!doc) return [];
    const out: Array<PluginCapability | SkillCapability> = [];

    // [plugins."<id>"] — record => boolean-ish `enabled` (default true).
    const plugins = (doc as Unknown).plugins;
    if (plugins && typeof plugins === 'object') {
      for (const [name, raw] of Object.entries(plugins as Unknown)) {
        if (!raw || typeof raw !== 'object') continue;
        const enabled = toBool((raw as Unknown).enabled, true);
        out.push({
          kind: 'plugin',
          runtime: RUNTIME,
          configPath: path,
          name,
          enabled,
        });
      }
    }

    // [[skills.config]] — array of { path, enabled }.
    const skillsRoot = (doc as Unknown).skills;
    if (skillsRoot && typeof skillsRoot === 'object') {
      const configList = (skillsRoot as Unknown).config;
      if (Array.isArray(configList)) {
        for (const entry of configList) {
          if (!entry || typeof entry !== 'object') continue;
          const skillPath = (entry as Unknown).path;
          if (typeof skillPath !== 'string' || skillPath.length === 0) continue;
          const enabled = toBool((entry as Unknown).enabled, true);
          out.push({
            kind: 'skill',
            runtime: RUNTIME,
            configPath: path,
            path: skillPath,
            enabled,
          });
        }
      }
    }

    return out;
  },
};

function parseCodex(content: string): unknown {
  try {
    const doc = parseToml(content);
    if (!doc || typeof doc !== 'object') return null;
    return doc;
  } catch {
    return null;
  }
}

function toBool(v: unknown, defaultValue: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === undefined || v === null) return defaultValue;
  // Strict: anything that isn't a real bool counts as "default" — refuses
  // to silently truthy-coerce `"false"`, `0`, etc.
  return defaultValue;
}
