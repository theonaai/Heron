/**
 * ReportJson — the structured shape persisted to a session's `report.json`
 * file and consumed by `components/heron-v1/dashboard/ReportView.tsx`.
 *
 * Heron has two report producers today:
 *
 *   1. The interview pipeline (`src/report/generator.ts`) emits an
 *      `AuditReport` (see `src/report/types.ts`) — the historical
 *      interview-driven shape with risks, systems, recommendations,
 *      compliance flags.
 *   2. `heron scan --mcp` emits a `VerificationReport` (`src/verification/
 *      types.ts`) — tool inventory, declared-vs-actual diff entries,
 *      OAuth scope inspection results.
 *
 * Both producers now write into the SAME `AuditSession` storage and the
 * SAME `report.json` file. The dashboard's single ReportView renders
 * whatever fields are present and gracefully omits the rest.
 *
 * The interview-driven half of this file MUST stay compatible with the
 * legacy auditReportSchema (just the fields the UI consumes — TypeScript
 * structural typing handles the rest). The MCP half is brand new in
 * #33-C and pinned by `tests/llm/report-json.test.ts`.
 */

// ─── Interview-driven half (mirrors components/heron-v1/dashboard/ReportView) ──

export interface ReportJsonWriteOperation {
  operation: string;
  target: string;
  reversible: boolean;
  approvalRequired: boolean;
  volumePerDay: string;
}

export interface ReportJsonSystem {
  systemId: string;
  scopesRequested: string[];
  scopesNeeded: string[];
  scopesDelta: string[];
  dataSensitivity: string;
  blastRadius: string;
  frequencyAndVolume: string;
  writeOperations: ReportJsonWriteOperation[];
}

export interface ReportJsonRisk {
  severity: string;
  title: string;
  description: string;
  mitigation?: string;
  triggeredBy?: string[];
}

export interface ReportJsonDataQuality {
  score: number;
  uniqueAnswers: number;
  totalQuestions: number;
  fieldsProvided: string[];
  fieldsMissing: string[];
  repeatedAnswers: number;
}

// ─── MCP scan sections (new in #33-C) ──────────────────────────────────────

/** Severity vocabulary the MCP-scan path uses. Matches `DiffSeverity`
 *  upstream but uppercased to match VerificationReport-derived findings
 *  and to read as a status-pill in the UI. */
export type McpFindingSeverity = 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

export interface McpToolEntry {
  name: string;
  description?: string;
  annotations?: Record<string, unknown>;
}

export interface McpInventorySection {
  /** MCP endpoint or stdio command, display-only — credentials redacted. */
  server: string;
  /** ISO-8601 timestamp of when the inventory was captured. */
  capturedAt: string;
  /** Optional server name + version string (e.g. `sample-mcp v1.0.0`). */
  serverImpl?: string;
  tools: McpToolEntry[];
}

export interface McpDeclaredDiffEntry {
  name: string;
  severity: McpFindingSeverity;
  description?: string;
}

export interface DeclaredDiffSection {
  /** Path / label of the declared baseline source (file path, label, etc.). */
  baseline: string;
  /** Present in actual, NOT in declared (extra / shadow capability). */
  extra: McpDeclaredDiffEntry[];
  /** Present in declared, NOT in actual (declared but unfulfilled). */
  missing: McpDeclaredDiffEntry[];
}

export type OAuthVerdict = 'verified' | 'unverified' | 'failed';

export interface OAuthScopesSection {
  /** Provider identifier (e.g. 'google-workspace', 'greenhouse'). */
  provider: string;
  granted: string[];
  declared: string[];
  /** Granted but not declared (shadow scopes). */
  extra: string[];
  /** Declared but not granted (unfulfilled). */
  missing: string[];
  verdict: OAuthVerdict;
  /** Present for failed/unverified verdicts — short human-readable note. */
  reason?: string;
}

// ─── AAP-74 — L6 OAuth scope verification (dashboard wire-up) ────────────
//
// Result shape for an L6 OAuth introspection run invoked by the
// dashboard scan route. Mirrors the structural details of
// `SourceVerification` from `src/verification/types.ts` but keeps the
// public surface narrow (no `_extra`, no raw `error.cause`) so the
// dashboard can render without pulling node-only types into the bundler
// graph.
//
// Three diff kinds, mapped from the verification differ:
//  - `Verified`     — scope is in both declared and actual (no diff).
//  - `Discrepancy`  — actual carries something declared did not, OR
//                     a tool/scope was missing on the actual side.
//  - `Unverified`   — source read failed (auth, transport, parse,
//                     invalid config) so no claim either way.
//
// Per ticket AAP-74 part 1, step 6 — the report renderer surfaces this
// with diff entries per source. Per part 2, "L6" is the canonical
// name for the OAuth introspection layer (formerly "L7" in the
// pre-AAP-74 architecture doc).

export type OAuthScopeVerificationVerdict = 'verified' | 'discrepancy' | 'unverified';

export type OAuthScopeConnector = 'google-workspace' | 'bamboohr' | 'greenhouse';

export interface OAuthScopeDiffEntry {
  /** 'extra' = granted but not declared; 'missing' = declared but not granted. */
  kind: 'extra' | 'missing';
  /** Service identifier the scope belongs to (e.g. `gmail`, `greenhouse`). */
  service: string;
  /** The scope string in the service's own vocabulary. */
  scope: string;
  /** Heron severity tier the differ assigned. */
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  /** Optional human-readable note (e.g. context for an EXTRA scope). */
  details?: string;
}

export interface OAuthScopeVerificationSourceResult {
  /** Connector that produced this result. */
  connector: OAuthScopeConnector;
  verdict: OAuthScopeVerificationVerdict;
  /** Scopes the introspection endpoint actually returned. */
  actualScopes: { service: string; scope: string }[];
  /** Declared-vs-actual diff entries (empty when verdict === 'verified'). */
  diffs: OAuthScopeDiffEntry[];
  /** Set when verdict === 'unverified' (auth failure, transport error, etc.). */
  errorMessage?: string;
  /** Partial-read warnings from the connector (e.g. probe-level timeouts). */
  warnings?: string[];
}

export interface OAuthScopeVerificationSection {
  /** ISO-8601 timestamp of when the verification run completed. */
  capturedAt: string;
  /** One entry per requested oauthSource. */
  sources: OAuthScopeVerificationSourceResult[];
}

// ─── Local-machine discovery (AAP-53) ──────────────────────────────────────

/** Deterministic agent inventory from filesystem auto-discovery.
 *
 *  Whitelist contract: only the fields named in DiscoveredMcpServer ever
 *  land here. Secret-pattern env / header values are dropped entirely
 *  upstream — only the KEY NAMES survive in `redactedEnvKeys`. */
export type LocalDiscoveryTransport = 'stdio' | 'http' | 'sse' | 'streamable-http';

export interface LocalDiscoveredMcpServer {
  name: string;
  transport: LocalDiscoveryTransport;
  command?: string;
  args?: string[];
  url?: string;
  toolsAllowed?: string[];
  toolsDenied?: string[];
  hasCredentials: boolean;
  redactedEnvKeys: string[];
  /** AAP-75 — MCP `tools/list` enumeration outcome. */
  toolEnumeration?: LocalMcpToolEnumeration;
}

// ── AAP-75 — MCP tools/list enumeration shapes ──────────────────────────
//
// Mirrors of `McpToolEnumeration` / `DiscoveredMcpTool` from
// `src/discovery/types.ts`. Defined here so the dashboard / ReportView
// don't have to import node-only types into the bundler graph.

export type LocalMcpToolEnumerationState = 'ok' | 'failed' | 'skipped';

export type LocalMcpToolClassification = 'read' | 'write' | 'unknown';

export interface LocalDiscoveredMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  classification: LocalMcpToolClassification;
}

export interface LocalMcpToolEnumeration {
  state: LocalMcpToolEnumerationState;
  tools?: LocalDiscoveredMcpTool[];
  reason?: string;
  attemptedAt: string;
}

export type LocalDiscoveryRuntime =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'continue'
  | 'windsurf'
  | 'claude-desktop';

/** AAP-58 — non-MCP capability rows surfaced alongside `mcpServers`. */
export type LocalDiscoveryAuthShape = 'token' | 'apiKey' | 'oauth' | 'unknown';

export type LocalDiscoveredCapability =
  | ({ kind: 'mcp_server' } & LocalDiscoveredMcpServer /* includes toolEnumeration */)
  | {
      kind: 'plugin';
      runtime: LocalDiscoveryRuntime;
      configPath: string;
      name: string;
      enabled: boolean;
      raw?: Record<string, unknown>;
    }
  | {
      kind: 'skill';
      runtime: LocalDiscoveryRuntime;
      configPath: string;
      path: string;
      enabled: boolean;
    }
  | {
      kind: 'auth_credential';
      runtime: LocalDiscoveryRuntime;
      configPath: string;
      provider: string;
      hasValue: boolean;
      valueShape?: LocalDiscoveryAuthShape;
    };

export interface LocalDiscoveredAgent {
  runtime: LocalDiscoveryRuntime;
  configPath: string;
  mcpServers: LocalDiscoveredMcpServer[];
  /** AAP-58 — unified capability list (plugins, skills, auth keys, + mcp_servers mirror). */
  capabilities?: LocalDiscoveredCapability[];
  model?: string;
}

export type LocalDiscoveryFindingKind = 'EXTRA' | 'MISSING' | 'HIDDEN-CREDENTIALS';

export interface LocalDiscoveryFinding {
  kind: LocalDiscoveryFindingKind;
  severity: McpFindingSeverity;
  serverName: string;
  runtime: string;
  description: string;
}

export interface LocalAgentDiscoverySection {
  agents: LocalDiscoveredAgent[];
  findings: LocalDiscoveryFinding[];
  scannedAt: string;
  scannedPaths: string[];
  /** AAP-67 — L4 cross-cutting OS credentials (file-presence + names). */
  osCredentials?: LocalOsCredentialFinding[];
  /** AAP-67 — L5 per-workspace `.env*` variable NAMES (never values). */
  workspaceEnv?: LocalWorkspaceEnvFile[];
  /** AAP-67 — L3 macOS Keychain service NAMES (never passwords). */
  keychainServices?: LocalKeychainServiceFinding[];
  /** AAP-67 — warnings from L3-L5 readers (e.g. non-macOS host). */
  warnings?: string[];
}

// ─── AAP-67 — L3/L4/L5 dashboard shapes ─────────────────────────────────
//
// Mirrors of the reader shapes in `src/discovery/types.ts`. Defined here
// so the dashboard / ReportView / McpSections types don't need to import
// from `src/` (which would pull node-only deps into the bundler graph).

export type LocalOsCredentialKind =
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

export interface LocalOsCredentialFinding {
  kind: LocalOsCredentialKind;
  path: string;
  tokens: string[];
}

export interface LocalWorkspaceEnvFile {
  path: string;
  workspace: string;
  keys: string[];
}

export interface LocalKeychainServiceFinding {
  service: string;
  category: string;
}

// ─── Compliance shapes (passthrough from server) ───────────────────────────

/** ReportJson loosely mirrors the regulatoryCompliance shape consumed by
 *  ReportView. Treated as opaque here — the UI handles both legacy
 *  jurisdiction buckets and the categorized form. */
export type RegulatoryCompliancePassthrough = unknown;

// ─── Top-level shape ───────────────────────────────────────────────────────

export interface ReportJson {
  // Interview-driven (always required so the existing UI has data to render).
  summary: string;
  agentPurpose: string;
  agentTrigger?: string;
  agentOwner?: string;
  systems: ReportJsonSystem[];
  risks: ReportJsonRisk[];
  recommendations: string[];
  recommendation?: string;
  overallRiskLevel: string;
  dataQuality?: ReportJsonDataQuality;
  makesDecisionsAboutPeople?: boolean;
  decisionMakingDetails?: string;
  regulatoryCompliance?: RegulatoryCompliancePassthrough;
  metadata?: {
    date: string;
    target: string;
    interviewDuration: number;
    questionsAsked: number;
  };

  // MCP-scan extensions (#33-C). Optional — rendered only when present.
  mcpInventory?: McpInventorySection;
  declaredDiff?: DeclaredDiffSection;
  oauthScopes?: OAuthScopesSection;

  // Local-machine discovery (AAP-53). Deterministic agent inventory
  // produced by reading filesystem configs with the user's consent.
  // Strictly additive — sessions without a scan render unchanged.
  localAgentDiscovery?: LocalAgentDiscoverySection;

  // AAP-74 — L6 OAuth scope verification results (dashboard wire-up).
  // Populated by `POST /api/discovery/scan` when the request body
  // includes `oauthSources`. Strictly additive — sessions without
  // OAuth introspection still render unchanged.
  oauthScopeVerification?: OAuthScopeVerificationSection;

  // AAP-79 — report-level verification lifecycle. The dashboard
  // ReportView reads this to render the interrogation-only banner;
  // markdown templates do the same. `status` values:
  //   - 'interrogation-only' — only the LLM interview has run; banner shown.
  //   - 'verified' — discovery (L1-L5) ran cleanly; banner suppressed.
  //   - 'verification-failed' — discovery errored; failure banner shown.
  // Optional so legacy sessions persisted before AAP-79 continue to
  // deserialise without migration.
  verification?: {
    status: 'interrogation-only' | 'verified' | 'verification-failed';
    reason?: string;
    updatedAt?: string;
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Lightweight runtime guard. Used by routes that accept arbitrary JSON
 *  but want to surface "this is the legacy ReportJson shape" sanity check.
 *  Intentionally NOT a Zod schema — the shape is too forgiving for that
 *  (every dashboard-relevant field is optional in practice). */
export function isReportJson(value: unknown): value is ReportJson {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.summary !== 'string') return false;
  if (typeof obj.agentPurpose !== 'string') return false;
  if (!Array.isArray(obj.systems)) return false;
  if (!Array.isArray(obj.risks)) return false;
  if (!Array.isArray(obj.recommendations)) return false;
  if (typeof obj.overallRiskLevel !== 'string') return false;
  return true;
}

interface VerdictSummary {
  verdict: 'verified' | 'discrepancy' | 'unverified';
  findings: Array<{ severity: McpFindingSeverity | string }>;
}

/**
 * Map a VerificationReport-style verdict + finding list to a Heron risk
 * level the AuditSession meta stores. Highest severity wins; an
 * `unverified` source forces at least 'medium' so the operator notices
 * the gap when the dashboard ranks sessions.
 */
export function severityForVerdict(s: VerdictSummary): 'low' | 'medium' | 'high' | 'critical' {
  const rank: Record<string, number> = {
    INFO: 0,
    LOW: 1,
    MEDIUM: 2,
    HIGH: 3,
    CRITICAL: 4,
    info: 0,
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
  };
  let best = 0;
  for (const f of s.findings) {
    const r = rank[f.severity as string] ?? 0;
    if (r > best) best = r;
  }
  if (s.verdict === 'unverified' && best < 2) return 'medium';
  if (best >= 4) return 'critical';
  if (best >= 3) return 'high';
  if (best >= 2) return 'medium';
  return 'low';
}
