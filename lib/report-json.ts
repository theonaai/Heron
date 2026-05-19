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
}

export type LocalDiscoveryRuntime =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'continue'
  | 'windsurf'
  | 'claude-desktop';

export interface LocalDiscoveredAgent {
  runtime: LocalDiscoveryRuntime;
  configPath: string;
  mcpServers: LocalDiscoveredMcpServer[];
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
