/**
 * Local-machine filesystem auto-discovery (AAP-53).
 *
 * Deterministic agent inventory: with explicit user consent, Heron reads
 * the actual config files of known AI agents on the workstation, applies
 * a strict whitelist projection, and diffs the result against the
 * agent's own interview transcript. Closes the verification gap that
 * sampling-based interrogation (AAP-52) leaves open — every interview
 * answer is now anchored by an objective file read.
 *
 * Whitelist contract: only the fields explicitly named in
 * `DiscoveredMcpServer` / `DiscoveredAgent` ever land in memory. Every
 * other field encountered while parsing is dropped after the projection.
 * Secret-pattern env / header VALUES are dropped entirely; only the KEY
 * NAMES are retained, so the operator can see "this server has a
 * SLACK_BOT_TOKEN configured" without the token itself ever being read,
 * logged, or transmitted.
 */

/** MCP transport vocabulary that maps onto every runtime Heron reads. */
export type DiscoveredTransport = 'stdio' | 'http' | 'sse' | 'streamable-http';

export interface DiscoveredMcpServer {
  name: string;
  transport: DiscoveredTransport;
  /** Present for stdio. */
  command?: string;
  args?: string[];
  /** Present for http / sse / streamable-http. */
  url?: string;
  toolsAllowed?: string[];
  toolsDenied?: string[];
  /** True if any secret-pattern env key or header was present. */
  hasCredentials: boolean;
  /** Names of env/header keys that matched secret patterns. Values discarded. */
  redactedEnvKeys: string[];
}

export type DiscoveredRuntime =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'continue'
  | 'windsurf'
  | 'claude-desktop';

/**
 * AAP-58 — discovered capability union.
 *
 * The original AAP-53 discovery layer only surfaced MCP servers. Codex
 * (and progressively other runtimes) also ship first-class plugins,
 * skills, and auth-credential files in the SAME config blob — these
 * are real capabilities the agent has access to, and missing them
 * undercuts Heron's "deterministic source of truth" claim.
 *
 * Each variant carries `kind` so downstream code can pattern-match
 * cleanly; `runtime` + `configPath` are present on every variant so
 * findings always have a file-level provenance trail. Auth credentials
 * record only the top-level KEY NAME (`provider`) plus a coarse SHAPE
 * heuristic — values are never read, never logged, never returned.
 */
export type PluginCapability = {
  kind: 'plugin';
  runtime: DiscoveredRuntime;
  configPath: string;
  /** Plugin identifier from the config (e.g. `documents@openai-primary-runtime`). */
  name: string;
  enabled: boolean;
  /** Optional raw fields beyond `enabled` — kept narrow on purpose. */
  raw?: Record<string, unknown>;
};

export type SkillCapability = {
  kind: 'skill';
  runtime: DiscoveredRuntime;
  configPath: string;
  /** Absolute path to the SKILL.md (or analogous) file. */
  path: string;
  enabled: boolean;
};

export type AuthCredentialShape = 'token' | 'apiKey' | 'oauth' | 'unknown';

export type AuthCredentialCapability = {
  kind: 'auth_credential';
  runtime: DiscoveredRuntime;
  configPath: string;
  /** Top-level key NAME (e.g. `openai_api_key`). Values are NEVER stored. */
  provider: string;
  hasValue: boolean;
  valueShape?: AuthCredentialShape;
};

export type McpServerCapability = { kind: 'mcp_server' } & DiscoveredMcpServer;

export type DiscoveredCapability =
  | McpServerCapability
  | PluginCapability
  | SkillCapability
  | AuthCredentialCapability;

export interface DiscoveredAgent {
  runtime: DiscoveredRuntime;
  /** Absolute path of the config file that produced this entry. */
  configPath: string;
  mcpServers: DiscoveredMcpServer[];
  /**
   * AAP-58 — unified capability list. Includes every `mcpServers`
   * entry (re-emitted with `kind: 'mcp_server'`) plus plugins, skills,
   * and auth-credential key names. Optional so legacy report.json blobs
   * persisted before AAP-58 keep deserialising cleanly.
   */
  capabilities?: DiscoveredCapability[];
  model?: string;
}

export type DiscoveryFindingKind = 'EXTRA' | 'MISSING' | 'HIDDEN-CREDENTIALS';

/** Mirrors `McpFindingSeverity` from `lib/report-json` so the UI can
 *  render discovery findings with the same severity pills. */
export type DiscoveryFindingSeverity = 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface DiscoveryFinding {
  kind: DiscoveryFindingKind;
  severity: DiscoveryFindingSeverity;
  serverName: string;
  runtime: string;
  description: string;
}

export interface DiscoveryResult {
  agents: DiscoveredAgent[];
  findings: DiscoveryFinding[];
  /** ISO-8601. */
  scannedAt: string;
  /** Every absolute path attempted, in order — for UI transparency. */
  scannedPaths: string[];
}

export interface AgentReader {
  runtime: DiscoveredRuntime;
  /** Candidate config paths. Missing files are NOT errors. */
  paths(homeDir: string, workspaceDir?: string): string[];
  /**
   * Parse a single config blob. Returns the projected MCP-server list.
   * Throwing means the file existed but was malformed — the caller
   * decides whether to surface that or skip silently.
   */
  parse(content: string, path: string): Promise<DiscoveredMcpServer[]>;
  /**
   * AAP-58 — optional non-MCP capabilities (plugins, skills) parsed
   * from the same config file. Readers that don't surface non-MCP
   * capabilities omit this field; the aggregator treats absence as an
   * empty list. Auth-credential capabilities are produced by sibling
   * `*-auth` readers (see `codex-auth.ts`, `claude-code-auth.ts`).
   */
  parseCapabilities?(
    content: string,
    path: string,
  ): Promise<Array<PluginCapability | SkillCapability>>;
}

/**
 * AAP-58 — dedicated reader for credential files (e.g. `~/.codex/auth.json`).
 * Same shape as `AgentReader` but the parse method emits only
 * `AuthCredentialCapability` rows. Keeping it separate from `AgentReader`
 * documents the "we read different files for different purposes" intent
 * and forces each call site to opt in.
 */
export interface AuthReader {
  runtime: DiscoveredRuntime;
  paths(homeDir: string, workspaceDir?: string): string[];
  parse(content: string, path: string): Promise<AuthCredentialCapability[]>;
}
