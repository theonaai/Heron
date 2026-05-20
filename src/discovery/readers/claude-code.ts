/**
 * Claude Code config reader — AAP-53 + AAP-58.
 *
 * Reads:
 *   ~/.claude.json — canonical mcpServers map (gotcha: NOT
 *      ~/.claude/settings.json — that file only has enable/disable lists).
 *   project .mcp.json — same shape, repo-scoped.
 *   project .claude/settings.json — enable lists only, no servers.
 *
 * AAP-58 — capability surface beyond MCP servers.
 *
 * Today Claude Code does NOT ship a Codex-style `[plugins.*]` block in
 * `~/.claude.json`. The closest moral equivalent is the `connectors`
 * block that hosted Claude.ai uses, which Claude Code itself does not
 * currently mirror to disk. Until it does, `parseCapabilities` reads any
 * obvious connector-shape blocks if present (best-effort, schema-tolerant)
 * and otherwise returns an empty list. This keeps the function pluggable
 * for the day Claude Code surfaces local plugin metadata — no follow-up
 * type-system change required.
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
import { parseCanonicalMcpServers } from './_shared.js';

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
  async parseCapabilities(
    content,
    path,
  ): Promise<Array<PluginCapability | SkillCapability>> {
    // Pluggable hook (AAP-58). Today Claude Code's ~/.claude.json does
    // not advertise plugins/skills in a stable shape; if/when it does,
    // the parsing logic plugs in here without touching the aggregator.
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      return [];
    }
    if (!json || typeof json !== 'object') return [];
    const root = json as Record<string, unknown>;

    const out: Array<PluginCapability | SkillCapability> = [];

    // Best-effort: if a top-level `connectors` block is present and
    // shaped like `{ <name>: { enabled?: bool } }`, surface each entry
    // as a plugin capability. Unknown shapes are ignored — we never
    // synthesise capabilities we can't verify against the source.
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

function readBool(v: unknown, defaultValue: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === undefined || v === null) return defaultValue;
  return defaultValue;
}
