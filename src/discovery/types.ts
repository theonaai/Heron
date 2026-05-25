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
  /**
   * AAP-76 — workspace path the server is scoped to. Present for Claude
   * Code per-project entries (`~/.claude.json.projects.<workspace>.mcpServers`).
   * Absent for top-level / global server definitions. Used as the
   * deduplication key alongside `name`.
   */
  workspace?: string;
  /**
   * AAP-75 — tool inventory captured from `tools/list`. Optional because
   * enumeration is opt-in (a real network/spawn cost) and many readers
   * never run it. When present, `toolEnumeration.state` reports whether
   * the call succeeded; `toolEnumeration.tools[]` is the projected
   * inventory.
   */
  toolEnumeration?: McpToolEnumeration;
}

/**
 * AAP-75 — enumeration status + per-tool classification for one MCP server.
 *
 * `state` discriminates the three outcomes the route handles:
 *   - `ok`      — `tools/list` succeeded; `tools[]` populated.
 *   - `failed`  — connect or `tools/list` errored; `reason` carries a
 *                 short human-readable note. The server itself is still
 *                 emitted as discovered — failure here doesn't invalidate
 *                 the L1 declaration.
 *   - `skipped` — enumeration was intentionally not attempted (e.g. HTTP
 *                 transport with no credential we could safely reuse).
 *                 `reason` explains why.
 *
 * AAP-82 — `source` records who produced the enumeration. Defaults to
 * `connector` (Heron called `tools/list` itself); `agent-reported`
 * marks rows the audited agent forwarded via the
 * `report_mcp_tools_list` MCP tool.
 */
export type McpToolEnumerationState = 'ok' | 'failed' | 'skipped';

/**
 * AAP-82 — provenance of a `DiscoveredMcpTool`. Two values today:
 *
 *   - `connector`      — Heron opened the MCP connection itself
 *                        (stdio spawn, or HTTP with a credential the
 *                        enumerator was handed) and called `tools/list`.
 *                        This is the AAP-75 baseline.
 *   - `agent-reported` — the audited agent called `tools/list` against
 *                        its own MCP server using credentials Heron
 *                        never sees, and forwarded the raw response via
 *                        the `report_mcp_tools_list` MCP tool. Trust
 *                        model: same as any other self-report — an
 *                        honest agent gives Heron a complete inventory;
 *                        an adversarial agent can omit or rewrite
 *                        entries. The verdict ramp + classification do
 *                        not branch on `source`; downstream code that
 *                        wants to mark agent-reported rows in the UI
 *                        keys off this field.
 *
 * Optional + defaulted-to-`connector` in callers so legacy report.json
 * blobs persisted before AAP-82 keep deserialising cleanly.
 */
export type DiscoveredMcpToolSource = 'connector' | 'agent-reported';

export interface DiscoveredMcpTool {
  /** Tool name as advertised by `tools/list`. */
  name: string;
  /** Optional description string (whatever the server provided). */
  description?: string;
  /** Optional inputSchema. Captured verbatim — opaque to Heron. */
  inputSchema?: Record<string, unknown>;
  /** Optional MCP behavior hints (`readOnlyHint`, `destructiveHint`, …). */
  annotations?: Record<string, unknown>;
  /**
   * AAP-75 classification — `read` (idempotent get-shape), `write`
   * (mutates state), or `unknown` (ambiguous). See
   * `src/discovery/tool-classifier.ts` for the resolution rules.
   */
  classification: 'read' | 'write' | 'unknown';
  /**
   * AAP-82 — where this tool entry came from. Optional for backward
   * compatibility; absence means `connector`.
   */
  source?: DiscoveredMcpToolSource;
}

export interface McpToolEnumeration {
  state: McpToolEnumerationState;
  /** Populated on `state === 'ok'`. */
  tools?: DiscoveredMcpTool[];
  /** Populated on `state === 'failed' | 'skipped'`. */
  reason?: string;
  /** ISO-8601 timestamp of when the enumeration attempt completed. */
  attemptedAt: string;
  /**
   * AAP-82 — who produced this enumeration. Optional for backward
   * compatibility; absence means `connector` (Heron called `tools/list`
   * itself). `agent-reported` marks responses the audited agent
   * forwarded via the `report_mcp_tools_list` MCP tool.
   */
  source?: DiscoveredMcpToolSource;
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
  /** AAP-67 — L4 cross-cutting OS credentials (file-presence only). */
  osCredentials?: OsCredentialFinding[];
  /** AAP-67 — L5 per-workspace `.env*` variable NAMES (never values). */
  workspaceEnv?: WorkspaceEnvFile[];
  /** AAP-67 — L3 macOS Keychain service NAMES (never passwords). */
  keychainServices?: KeychainServiceFinding[];
  /** AAP-67 — warnings emitted by L3-L5 readers (e.g. non-macOS host for Keychain). */
  warnings?: string[];
}

// ─── AAP-67 — L3/L4/L5 finding shapes ────────────────────────────────────
//
// Three new layers extend the existing L1/L2 inventory. Every shape obeys
// the same names-not-values contract: the reader returns identifying
// tokens (profile names, registry hosts, variable names, service names)
// and NEVER credential values. Tests assert this invariant by deep-grep
// across the serialized output for known fixture secret patterns.

/**
 * L4 — cross-cutting OS credential file. `path` is the absolute path that
 * was probed (e.g. `~/.aws/credentials`). `tokens` is the parsed
 * identifying tokens: profile names for `.aws/credentials`, cluster +
 * context names for `~/.kube/config`, registry hosts for
 * `~/.docker/config.json` etc. Empty `tokens[]` means "file exists but
 * we found nothing parseable" — still useful evidence.
 */
export type OsCredentialKind =
  | 'aws-credentials'
  | 'aws-config'
  | 'gcloud-adc'
  | 'kube-config'
  | 'docker-config'
  | 'npmrc'
  | 'pypirc'
  | 'netrc'
  | 'gitconfig'
  | 'ssh-config';

export interface OsCredentialFinding {
  kind: OsCredentialKind;
  /** Absolute path of the file Heron read. */
  path: string;
  /**
   * Identifying tokens parsed out of the file. NEVER credential values.
   * Examples: AWS profile names, kube cluster names, Docker registry hosts,
   * npm registry hosts, pypi index URLs, netrc machine names, gitconfig
   * credential helpers, ssh Host names.
   */
  tokens: string[];
}

/**
 * L5 — one workspace `.env*` file. `keys[]` is the variable NAMES only.
 * Values are dropped at parse time; the file content is also passed
 * through secretlint before the reader returns, so even a malformed line
 * cannot leak a literal value.
 */
export interface WorkspaceEnvFile {
  /** Absolute path of the env file Heron read. */
  path: string;
  /** Workspace directory the file lived inside. */
  workspace: string;
  /** Variable NAMES from the file. Values NEVER stored. */
  keys: string[];
}

/**
 * L3 — one macOS Keychain service entry. `service` is the Keychain item
 * `svce` field (e.g. `com.slack.Slack`). NEVER includes the password.
 * Heron only ever runs `security dump-keychain` (the listing form); it
 * NEVER runs `security find-generic-password -w` (which would prompt
 * the user for their Keychain password).
 */
export interface KeychainServiceFinding {
  /** Keychain item service name. */
  service: string;
  /** Coarse category label inferred from the service-name allowlist match. */
  category: string;
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
