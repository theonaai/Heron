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

export interface DiscoveredAgent {
  runtime: DiscoveredRuntime;
  /** Absolute path of the config file that produced this entry. */
  configPath: string;
  mcpServers: DiscoveredMcpServer[];
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
}
