/**
 * Discovery orchestrator — AAP-53 + AAP-58 + AAP-100.
 *
 * `runDiscovery({ runtime, ... })` reads only the evidence directories
 * that belong to the audited runtime, projects them through the
 * whitelist, and returns a single `DiscoveryResult` with the
 * deterministic agent inventory.
 *
 * AAP-100 — `runtime` is required. Heron used to scan all six runtimes
 * host-wide on every audit, which meant a Codex audit surfaced Claude
 * Code findings (and vice versa). The simplification scope locks
 * discovery to the audited runtime: when auditing Codex, only
 * `~/.codex/*` is read; `~/.claude/*`, `~/.cursor/*`, etc. are not
 * touched.
 *
 * Missing files are silently skipped (try/catch around readFile).
 * Malformed files are skipped with a warning. A truly missing config
 * dir for the audited runtime returns `{ agents: [], findings: [],
 * scannedPaths: [...] }` — the empty array is itself useful evidence.
 *
 * AAP-58 — each per-reader scan collects three kinds of capability:
 *   1. MCP servers via `reader.parse`         (AAP-53).
 *   2. Plugins / skills via `reader.parseCapabilities`.
 *   3. Auth-credential KEY NAMES via the sibling `AUTH_READERS` set.
 *
 * All three feed into a single `Agent.capabilities[]` so downstream
 * consumers iterate one list. `Agent.mcpServers` stays populated for
 * back-compat — the dashboard renders both surfaces until callers
 * migrate.
 *
 * AAP-100 — L3 (macOS Keychain) and L4 (cross-cutting OS credentials)
 * readers were deleted. Both layers audited the dev box (e.g.
 * `~/.aws/credentials`, the user's Keychain) rather than the deployed
 * agent — security gatekeepers do not pay to verify someone's laptop.
 * The remaining layers are L1 (MCP configs), L2 (plugins/skills/auth),
 * L5 (workspace .env, renumbered to L3 in docs), and L6 (OAuth, owned
 * by a separate orchestrator).
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import { RUNTIME_REGISTRY } from './registry.js';
import { readWorkspaceEnv } from './readers/workspace-env.js';
import {
  enumerateAllServers,
  type EnumerateOptions,
} from './mcp-tools-enumerator.js';
import type {
  AgentReader,
  AuthReader,
  AuthCredentialCapability,
  DiscoveredAgent,
  DiscoveredCapability,
  DiscoveredRuntime,
  DiscoveryResult,
  PluginCapability,
  SkillCapability,
} from './types.js';

// AAP-105 (G8a) — the reader sets are now derived from the declarative
// `RUNTIME_REGISTRY` rather than hand-maintained literal arrays. Order is
// preserved from the registry, which preserves the pre-G8a scan order
// (claude-code, then codex). Adding/removing a runtime is a single edit
// in `registry.ts` — no more four-place enum drift.
const READERS: AgentReader[] = RUNTIME_REGISTRY.map((r) => r.reader);

/** AAP-58 — auth-file readers, run alongside the MCP/plugin readers. */
const AUTH_READERS: AuthReader[] = RUNTIME_REGISTRY.map((r) => r.auth);

export interface DiscoveryOptions {
  /**
   * AAP-100 — runtime under audit. Only readers whose `runtime` matches
   * this value run; all other runtimes' evidence directories are left
   * untouched. This closes drift entry #8 (host-wide vs per-runtime)
   * from `miro-vs-code-drift.md`.
   */
  runtime: DiscoveredRuntime;
  /** Override $HOME for testing. Defaults to os.homedir(). */
  homeDir?: string;
  /** Optional workspace path scanned in addition to user-level paths. */
  workspaceDir?: string;
  /**
   * AAP-67 — additional workspace hints for L5 .env scanning. The primary
   * `workspaceDir` is also scanned automatically; this lets the caller
   * surface multiple `session.workspaceHints` (the MCP `_meta` channel)
   * in one pass.
   */
  workspaceHints?: string[];
  /**
   * AAP-75 — when true, after L1 discovery the aggregator opens an MCP
   * connection to each declared server and calls `tools/list` (the
   * standard MCP enumeration RPC, which is read-only). The classified
   * inventory is attached to each `DiscoveredMcpServer.toolEnumeration`.
   *
   * Disabled by default because enumeration spawns subprocesses (stdio
   * transport) and makes outbound HTTP calls (http transport), neither
   * of which a unit-style `runDiscovery()` call expects. The dashboard
   * scan route opts in; the CLI path leaves it off until AAP-76.
   */
  enableMcpToolEnumeration?: boolean;
  /**
   * AAP-75 — overrides for the enumerator. Tests inject a `clientFactory`
   * (to bypass the real MCP transport) and a `now()` clock.
   */
  mcpToolEnumeration?: EnumerateOptions;
}

function defaultHomeDir(): string {
  const override = process.env.HERON_DISCOVERY_HOME?.trim();
  return override || homedir();
}

/** Find or create the Agent entry for a (runtime, configPath) pair. */
function upsertAgent(
  agents: DiscoveredAgent[],
  runtime: DiscoveredRuntime,
  configPath: string,
): DiscoveredAgent {
  for (const agent of agents) {
    if (agent.runtime === runtime && agent.configPath === configPath) return agent;
  }
  const fresh: DiscoveredAgent = {
    runtime,
    configPath,
    mcpServers: [],
    capabilities: [],
  };
  agents.push(fresh);
  return fresh;
}

export async function runDiscovery(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  const home = opts.homeDir ?? defaultHomeDir();
  const agents: DiscoveredAgent[] = [];
  const scannedPaths: string[] = [];

  // AAP-100 — filter readers to the audited runtime. Each reader self-
  // declares its `runtime`; only matching readers (L1 MCP + L2 auth)
  // touch the filesystem.
  const activeReaders = READERS.filter((r) => r.runtime === opts.runtime);
  const activeAuthReaders = AUTH_READERS.filter((r) => r.runtime === opts.runtime);

  for (const reader of activeReaders) {
    const candidates = reader.paths(home, opts.workspaceDir);
    for (const path of candidates) {
      scannedPaths.push(path);
      let content: string;
      try {
        content = await readFile(path, 'utf8');
      } catch {
        // Missing or unreadable — skip silently.
        continue;
      }

      // Servers (existing AAP-53 path).
      let servers: ReturnType<AgentReader['parse']> extends Promise<infer R> ? R : never;
      try {
        servers = (await reader.parse(content, path)) as typeof servers;
      } catch {
        // Malformed config — skip this file entirely; don't half-emit.
        continue;
      }

      // Plugins / skills (AAP-58, optional).
      let extras: Array<PluginCapability | SkillCapability> = [];
      if (reader.parseCapabilities) {
        try {
          extras = await reader.parseCapabilities(content, path);
        } catch {
          extras = [];
        }
      }

      if (servers.length === 0 && extras.length === 0) continue;

      const agent = upsertAgent(agents, reader.runtime, path);
      for (const s of servers) {
        agent.mcpServers.push(s);
        // Mirror into the unified capabilities list. Spread first so
        // `kind: 'mcp_server'` takes precedence over any conflicting
        // field from the server projection (there are none today).
        agent.capabilities!.push({ ...s, kind: 'mcp_server' });
      }
      for (const cap of extras) agent.capabilities!.push(cap);
    }
  }

  // Auth-credential readers run last — their output attaches to the
  // existing Agent row for the same runtime when one exists, otherwise
  // it creates a fresh row keyed on the credentials file path.
  for (const reader of activeAuthReaders) {
    const candidates = reader.paths(home, opts.workspaceDir);
    for (const path of candidates) {
      scannedPaths.push(path);
      let content: string;
      try {
        content = await readFile(path, 'utf8');
      } catch {
        continue;
      }

      let creds: AuthCredentialCapability[];
      try {
        creds = await reader.parse(content, path);
      } catch {
        continue;
      }
      if (creds.length === 0) continue;

      // Attach to the first agent of the same runtime if any — keeps
      // the per-runtime block in the report whole. Otherwise create a
      // new agent row keyed on the credentials file's path.
      let host: DiscoveredAgent | undefined = agents.find((a) => a.runtime === reader.runtime);
      if (!host) {
        host = upsertAgent(agents, reader.runtime, path);
      } else {
        // Ensure capabilities[] exists for legacy rows. New rows always have it.
        if (!host.capabilities) host.capabilities = [];
      }
      for (const c of creds) host.capabilities!.push(c);
    }
  }

  // ── AAP-67 — workspace .env reader (renumbered to L3 in docs) ──────────
  // Runs independently of the per-runtime agent scan: workspace .env
  // files are cwd-local, not bound to a runtime. The reader populates
  // a dedicated top-level slot on `DiscoveryResult` so the dashboard /
  // report renders it as its own section.
  const warnings: string[] = [];

  const workspaceList: string[] = [];
  if (opts.workspaceDir) workspaceList.push(opts.workspaceDir);
  if (opts.workspaceHints) for (const h of opts.workspaceHints) workspaceList.push(h);
  let workspaceEnv: DiscoveryResult['workspaceEnv'];
  if (workspaceList.length > 0) {
    try {
      const result = await readWorkspaceEnv({ workspaces: workspaceList });
      workspaceEnv = result.files;
      for (const p of result.scannedPaths) scannedPaths.push(p);
    } catch (e) {
      warnings.push(`workspace-env reader failed: ${(e as Error).message || String(e)}`);
    }
  }

  // ── AAP-75 — MCP tools/list enumeration ────────────────────────────────
  // Opt-in via `enableMcpToolEnumeration: true`. Mutates each agent's
  // `mcpServers[]` in-place, attaching a `toolEnumeration` field to
  // each DiscoveredMcpServer. Failures (timeout, auth, connect) are
  // surfaced as per-server `state: 'failed' | 'skipped'`, never thrown —
  // a hung MCP server cannot crash the scan.
  //
  // Capability-list sync: each `mcp_server` entry on `agent.capabilities`
  // was constructed via spread above (a fresh object), so mutating
  // `agent.mcpServers[]` does NOT propagate. After enumeration we
  // re-sync the capability mirror so downstream readers see the same
  // toolEnumeration through either view.
  if (opts.enableMcpToolEnumeration) {
    try {
      await enumerateAllServers(agents, opts.mcpToolEnumeration ?? {});
      for (const agent of agents) {
        if (!agent.capabilities) continue;
        for (let i = 0; i < agent.capabilities.length; i++) {
          const cap = agent.capabilities[i];
          if (cap.kind !== 'mcp_server') continue;
          // Find the matching server on mcpServers[] (same name + transport)
          // and re-spread so the toolEnumeration field carries across.
          const match = agent.mcpServers.find(
            (s) => s.name === cap.name && s.transport === cap.transport,
          );
          if (match) {
            agent.capabilities[i] = { ...match, kind: 'mcp_server' };
          }
        }
      }
    } catch (e) {
      // Safety net only — enumerateAllServers itself is non-throwing,
      // but if a future refactor regresses we never want it to break
      // discovery as a whole.
      warnings.push(`mcp tool enumeration failed: ${(e as Error).message || String(e)}`);
    }
  }

  return {
    agents,
    findings: [],
    scannedAt: new Date().toISOString(),
    scannedPaths,
    ...(workspaceEnv !== undefined ? { workspaceEnv } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export { READERS };

// Re-export the capability-union surface so downstream importers
// (`@/src/discovery/index`) have one stop for the discovery API.
export type {
  DiscoveredAgent,
  DiscoveredCapability,
  DiscoveryResult,
};
