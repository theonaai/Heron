/**
 * Discovery orchestrator — AAP-53 + AAP-58.
 *
 * `runDiscovery(opts)` reads every candidate config file from each
 * registered reader, projects them through the whitelist, and returns
 * a single `DiscoveryResult` with the deterministic agent inventory.
 *
 * Missing files are silently skipped (try/catch around readFile).
 * Malformed files are skipped with a warning. A truly missing
 * config dir for every runtime returns `{ agents: [], findings: [],
 * scannedPaths: [...] }` — the empty array is itself useful evidence.
 *
 * AAP-58 — the per-reader scan now collects four kinds of capability:
 *   1. MCP servers via `reader.parse`         (AAP-53).
 *   2. Plugins / skills via `reader.parseCapabilities`.
 *   3. Auth-credential KEY NAMES via the sibling `AUTH_READERS` set.
 *
 * All three feed into a single `Agent.capabilities[]` so downstream
 * consumers iterate one list. `Agent.mcpServers` stays populated for
 * back-compat — the dashboard renders both surfaces until callers
 * migrate.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import { claudeCodeReader } from './readers/claude-code.js';
import { claudeCodeAuthReader } from './readers/claude-code-auth.js';
import { claudeDesktopReader } from './readers/claude-desktop.js';
import { codexReader } from './readers/codex.js';
import { codexAuthReader } from './readers/codex-auth.js';
import { continueReader } from './readers/continue.js';
import { cursorReader } from './readers/cursor.js';
import { windsurfReader } from './readers/windsurf.js';
import { readOsCredentials } from './readers/os-credentials.js';
import { readWorkspaceEnv } from './readers/workspace-env.js';
import { readKeychain, type KeychainSpawn } from './readers/keychain.js';
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

const READERS: AgentReader[] = [
  claudeCodeReader,
  codexReader,
  cursorReader,
  continueReader,
  windsurfReader,
  claudeDesktopReader,
];

/** AAP-58 — auth-file readers, run alongside the MCP/plugin readers. */
const AUTH_READERS: AuthReader[] = [codexAuthReader, claudeCodeAuthReader];

export interface DiscoveryOptions {
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
   * AAP-67 — override the host platform for L3 (Keychain). Tests inject
   * `'darwin'` to exercise the macOS path on CI Linux runners.
   */
  platform?: NodeJS.Platform;
  /**
   * AAP-67 — override `child_process.spawn` for the L3 Keychain reader.
   * Tests only; production always uses the default node spawn.
   */
  keychainSpawn?: KeychainSpawn;
  /**
   * AAP-67 — opt out of the L3 Keychain shell-out. The dashboard sets
   * this to `false` for the v1 ship because the macOS `security` tool
   * occasionally surfaces an auth prompt depending on the user's
   * keychain ACL config; the e2e tests opt in explicitly.
   */
  enableKeychain?: boolean;
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

export async function runDiscovery(opts: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const home = opts.homeDir ?? defaultHomeDir();
  const agents: DiscoveredAgent[] = [];
  const scannedPaths: string[] = [];

  for (const reader of READERS) {
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
  for (const reader of AUTH_READERS) {
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

  // ── AAP-67 — L3 + L4 + L5 readers ──────────────────────────────────────
  // These run independently of the per-runtime agent scan. They never
  // attach to a DiscoveredAgent row; instead they populate dedicated
  // top-level slots on the DiscoveryResult, so the dashboard / report
  // can render them as their own sections.
  const warnings: string[] = [];

  // L4 — cross-cutting OS credentials.
  let osCredentials: DiscoveryResult['osCredentials'];
  try {
    const result = await readOsCredentials({ home });
    osCredentials = result.findings;
    for (const p of result.scannedPaths) scannedPaths.push(p);
  } catch (e) {
    warnings.push(`os-credentials reader failed: ${(e as Error).message || String(e)}`);
  }

  // L5 — per-workspace .env*. Union of explicit `workspaceDir` (the
  // AAP-58 primary) + any `workspaceHints` supplied by the caller.
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

  // L3 — macOS Keychain. Opt-in via `enableKeychain: true` so a default
  // headless run never risks a `security` prompt. The dashboard surfaces
  // it through the same consent flow the operator already accepted for
  // local discovery (Linear ticket: "do NOT add a separate consent
  // surface — reuse the existing dashboard consent flow").
  //
  // `HERON_DISCOVERY_KEYCHAIN_DISABLE=1` (env override) forces the
  // Keychain layer off — used by the route tests so a darwin dev box
  // running `npm test` doesn't shell out to `security` for real.
  const keychainDisabledByEnv = process.env.HERON_DISCOVERY_KEYCHAIN_DISABLE === '1';
  let keychainServices: DiscoveryResult['keychainServices'];
  if (opts.enableKeychain && !keychainDisabledByEnv) {
    try {
      const result = await readKeychain({
        platform: opts.platform,
        spawn: opts.keychainSpawn,
      });
      keychainServices = result.services;
      for (const w of result.warnings) warnings.push(w);
    } catch (e) {
      warnings.push(`keychain reader failed: ${(e as Error).message || String(e)}`);
    }
  }

  return {
    agents,
    findings: [],
    scannedAt: new Date().toISOString(),
    scannedPaths,
    ...(osCredentials !== undefined ? { osCredentials } : {}),
    ...(workspaceEnv !== undefined ? { workspaceEnv } : {}),
    ...(keychainServices !== undefined ? { keychainServices } : {}),
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
