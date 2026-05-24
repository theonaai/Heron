/**
 * Claude Code config reader — AAP-53 + AAP-58 + AAP-76.
 *
 * Reads:
 *   ~/.claude.json — canonical config. Two MCP-server locations:
 *      1. `projects.<workspace_path>.mcpServers` (per-workspace, current).
 *      2. Top-level `mcpServers` (legacy / global, back-compat).
 *   ~/.claude/settings.json — user settings. Holds `enabledPlugins` as a
 *      map `{ "<plugin>@<source>": boolean }` (AAP-76). NOT MCP servers.
 *   project .mcp.json — same canonical mcpServers shape, repo-scoped.
 *   project .claude/settings.json — workspace settings; same enabledPlugins
 *      surface as the user-level one.
 *
 * AAP-76 — fix for the silently-empty Claude Code scan. Before this
 * change the reader looked only at the top-level `mcpServers` key, which
 * real Claude Code installs leave empty. Per-project servers now flow
 * through with their workspace path attached; dedup runs on `name +
 * workspace` so a server that appears in both surfaces is emitted once.
 *
 * AAP-58 — capability surface beyond MCP servers. `parseCapabilities`
 * now emits one `PluginCapability` per entry in `settings.json`'s
 * `enabledPlugins` map (AAP-76) and still surfaces any obvious
 * `connectors` block from `~/.claude.json` for forward-compat.
 *
 * Auth credentials live in `~/.claude/.credentials.json` (different
 * file) and are handled by the sibling `claude-code-auth.ts` reader.
 */

import { join } from 'node:path';

import type {
  AgentReader,
  DiscoveredMcpServer,
  PluginCapability,
  SkillCapability,
} from '../types.js';
import { projectServer } from './_shared.js';

const RUNTIME = 'claude-code' as const;

export const claudeCodeReader: AgentReader = {
  runtime: RUNTIME,
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
    // settings.json never carries MCP servers — its server-bearing
    // siblings are `~/.claude.json` and project `.mcp.json`. Skip parsing
    // so we don't coerce its different schema.
    if (path.endsWith('settings.json')) return [];
    return parseClaudeJsonServers(content);
  },
  async parseCapabilities(
    content,
    path,
  ): Promise<Array<PluginCapability | SkillCapability>> {
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      return [];
    }
    if (!json || typeof json !== 'object') return [];
    const root = json as Record<string, unknown>;

    const out: Array<PluginCapability | SkillCapability> = [];

    // AAP-76 — `enabledPlugins` lives in `~/.claude/settings.json` (and
    // its workspace twin). Observed shape: `{ "<name>@<source>": bool }`.
    // We also accept an array form `["name@source", ...]` defensively —
    // older / future Claude Code releases have used both shapes.
    for (const plugin of parseEnabledPlugins(root.enabledPlugins, path)) {
      out.push(plugin);
    }

    // Best-effort: surface any top-level `connectors` block (forward-compat
    // for future Claude Code releases that mirror hosted connectors to disk).
    const connectors = root.connectors;
    if (connectors && typeof connectors === 'object' && !Array.isArray(connectors)) {
      for (const [name, raw] of Object.entries(connectors as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') continue;
        const enabled = readBool((raw as Record<string, unknown>).enabled, true);
        out.push({
          kind: 'plugin',
          runtime: RUNTIME,
          configPath: path,
          name,
          enabled,
        });
      }
    }

    return out;
  },
};

/**
 * AAP-76 — extract MCP servers from `~/.claude.json` (or project
 * `.mcp.json`), honouring BOTH the top-level `mcpServers` key and the
 * per-project `projects.<workspace>.mcpServers` map. Per-project servers
 * carry their workspace path on the projection; top-level entries do
 * not. Deduplicated by `name + workspace` so a server present in both
 * surfaces appears once.
 */
function parseClaudeJsonServers(content: string): DiscoveredMcpServer[] {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return [];
  }
  if (!json || typeof json !== 'object') return [];
  const root = json as Record<string, unknown>;

  // Key = `${workspace ?? ''}::${name}` — guarantees per-workspace
  // uniqueness without colliding workspace-scoped and top-level entries
  // that happen to share a name.
  const seen = new Map<string, DiscoveredMcpServer>();

  // Per-project servers first — they are the canonical source on
  // current Claude Code installs.
  const projects = root.projects;
  if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
    for (const [workspace, projectRaw] of Object.entries(
      projects as Record<string, unknown>,
    )) {
      if (!projectRaw || typeof projectRaw !== 'object') continue;
      const servers = (projectRaw as Record<string, unknown>).mcpServers;
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;
      for (const [name, config] of Object.entries(servers as Record<string, unknown>)) {
        if (!config || typeof config !== 'object') continue;
        const projected = projectServer(name, config as Record<string, unknown>);
        projected.workspace = workspace;
        seen.set(`${workspace}::${name}`, projected);
      }
    }
  }

  // Top-level `mcpServers` — kept for back-compat. A same-named global
  // server alongside a workspace-scoped one is a DISTINCT configuration
  // (different scope), so it's preserved under its own key.
  const topServers = root.mcpServers;
  if (topServers && typeof topServers === 'object' && !Array.isArray(topServers)) {
    for (const [name, config] of Object.entries(topServers as Record<string, unknown>)) {
      if (!config || typeof config !== 'object') continue;
      const key = `::${name}`;
      if (seen.has(key)) continue;
      seen.set(key, projectServer(name, config as Record<string, unknown>));
    }
  }

  return Array.from(seen.values());
}

/**
 * AAP-76 — extract `enabledPlugins` entries from a Claude Code settings
 * blob. Tolerant of both observed shapes:
 *   - `{ "name@source": true, "name@source": false }` (current)
 *   - `["name@source", ...]` (legacy / defensive)
 * Emits one `PluginCapability` per entry. The plugin identifier is kept
 * verbatim (e.g. `superpowers@superpowers-dev`).
 */
function parseEnabledPlugins(
  raw: unknown,
  path: string,
): PluginCapability[] {
  if (!raw) return [];
  const out: PluginCapability[] = [];

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'string' || entry.length === 0) continue;
      out.push({
        kind: 'plugin',
        runtime: RUNTIME,
        configPath: path,
        name: entry,
        enabled: true,
      });
    }
    return out;
  }

  if (typeof raw === 'object') {
    for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof name !== 'string' || name.length === 0) continue;
      // Boolean `true` → enabled; `false` → emit but mark disabled (the
      // user explicitly opted out, and downstream still needs to see it).
      const enabled = readBool(val, true);
      out.push({
        kind: 'plugin',
        runtime: RUNTIME,
        configPath: path,
        name,
        enabled,
      });
    }
  }

  return out;
}

function readBool(v: unknown, defaultValue: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === undefined || v === null) return defaultValue;
  return defaultValue;
}
