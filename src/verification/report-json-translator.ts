/**
 * Translate a VerificationReport into the ReportJson shape consumed by
 * the browser dashboard (`components/heron-v1/dashboard/ReportView.tsx`).
 *
 * #33-C (AAP-64): the unified-storage model says `heron scan --mcp` now
 * writes an AuditSession to `~/.heron/sessions/<id>/` so the dashboard
 * lists MCP scans next to interview audits. Both producers share one
 * `report.json` shape; this translator maps the structured
 * VerificationReport (tool inventory + declared diffs + OAuth scope
 * verdicts) into the optional MCP sections of ReportJson.
 *
 * The interview-driven half of ReportJson stays mostly empty for MCP
 * scans — the UI gracefully skips unrendered sections.
 */

import type {
  DiffEntry,
  SourceVerification,
  VerificationReport,
} from './types.js';
import type {
  DeclaredDiffSection,
  McpFindingSeverity,
  McpInventorySection,
  OAuthScopesSection,
  OAuthVerdict,
  ReportJson,
} from '../../lib/report-json.js';
import { severityForVerdict } from '../../lib/report-json.js';

/** Map verification severities (lowercase) → display severity (uppercase). */
function severityToDisplay(s: string): McpFindingSeverity {
  const lower = s.toLowerCase();
  if (lower === 'critical' || lower === 'high') return 'HIGH';
  if (lower === 'medium') return 'MEDIUM';
  if (lower === 'low') return 'LOW';
  return 'INFO';
}

/** Pull tool diffs out of a SourceVerification and bucket them into extra/missing. */
function diffsToDeclaredEntries(
  diffs: DiffEntry[],
  dimension: 'tool' | 'scope',
): {
  extra: { name: string; severity: McpFindingSeverity; description?: string }[];
  missing: { name: string; severity: McpFindingSeverity; description?: string }[];
} {
  const extra: { name: string; severity: McpFindingSeverity; description?: string }[] = [];
  const missing: { name: string; severity: McpFindingSeverity; description?: string }[] = [];
  for (const d of diffs) {
    if (d.dimension !== dimension) continue;
    if (d.kind === 'extra') {
      const actual = d.actual as { name?: string; scope?: string; description?: string };
      const name = (dimension === 'tool' ? actual.name : actual.scope) ?? '<unknown>';
      const entry: { name: string; severity: McpFindingSeverity; description?: string } = {
        name,
        severity: severityToDisplay(d.severity),
      };
      const desc = actual.description ?? d.details;
      if (desc) entry.description = desc;
      extra.push(entry);
    } else if (d.kind === 'missing') {
      const declared = d.declared as { name?: string; scope?: string; description?: string };
      const name = (dimension === 'tool' ? declared.name : declared.scope) ?? '<unknown>';
      const entry: { name: string; severity: McpFindingSeverity; description?: string } = {
        name,
        severity: severityToDisplay(d.severity),
      };
      const desc = declared.description ?? d.details;
      if (desc) entry.description = desc;
      missing.push(entry);
    }
    // 'mismatch' kind is rare for the MCP path; surface as an extra so it
    // shows up rather than disappearing silently.
    else if (d.kind === 'mismatch') {
      const actual = d.actual as { name?: string; scope?: string };
      const name = (dimension === 'tool' ? actual.name : actual.scope) ?? '<unknown>';
      const entry: { name: string; severity: McpFindingSeverity; description?: string } = {
        name,
        severity: severityToDisplay(d.severity),
      };
      if (d.details) entry.description = d.details;
      extra.push(entry);
    }
  }
  return { extra, missing };
}

/** Heron severity tier from a SourceVerification — drives the overall risk level. */
function findingsFromSource(s: SourceVerification): Array<{ severity: string }> {
  return (s.diffs ?? []).map((d) => ({ severity: severityToDisplay(d.severity) }));
}

function mcpVerdictToOAuth(v: SourceVerification['verdict']): OAuthVerdict {
  if (v === 'verified') return 'verified';
  if (v === 'unverified') return 'unverified';
  // 'discrepancy' — granted-vs-declared mismatch is a "verified read but
  // diffs found" path, which from the OAuth UX is closer to 'verified'
  // with extras flagged. The diffs themselves carry the severity.
  return 'verified';
}

/** Top-level translator. */
export function verificationToReportJson(args: {
  report: VerificationReport;
  /** Sanitised server label (already redacted via describeConfig). */
  serverLabel: string;
  /** What baseline label to attach to the declaredDiff. */
  declaredBaseline?: string;
  /** Tool-inventory record from the MCP source (raw). */
  inventory: {
    tools: { name: string; description?: string; annotations?: Record<string, unknown> }[];
    serverInfo?: { name?: string; version?: string };
  };
}): ReportJson {
  const { report, serverLabel, inventory, declaredBaseline } = args;

  const mcpInventory: McpInventorySection = {
    server: serverLabel,
    capturedAt: report.capturedAt,
    tools: inventory.tools.map((t) => {
      const entry: McpInventorySection['tools'][number] = { name: t.name };
      if (t.description) entry.description = t.description;
      if (t.annotations && Object.keys(t.annotations).length > 0) {
        entry.annotations = t.annotations;
      }
      return entry;
    }),
  };
  if (inventory.serverInfo?.name) {
    mcpInventory.serverImpl = inventory.serverInfo.version
      ? `${inventory.serverInfo.name} v${inventory.serverInfo.version}`
      : inventory.serverInfo.name;
  }

  // ─── Declared diff (tool-dimension) ──────────────────────────────────
  let declaredDiff: DeclaredDiffSection | undefined;
  const mcpSource = report.sources.find((s) => s.sourceId === 'mcp-tools');
  const declaredInventories = report.declared ?? [];
  const hasDeclaredTools = declaredInventories.some(
    (d) => Array.isArray(d.tools) && d.tools.length > 0,
  );
  if (mcpSource && hasDeclaredTools) {
    const { extra, missing } = diffsToDeclaredEntries(mcpSource.diffs, 'tool');
    declaredDiff = {
      baseline: declaredBaseline ?? declaredInventories[0]?.source ?? 'declared',
      extra,
      missing,
    };
  }

  // ─── OAuth scopes (first oauth-scopes source wins; pick the most useful) ──
  let oauthScopes: OAuthScopesSection | undefined;
  const oauthSource = report.sources.find((s) => s.sourceId === 'oauth-scopes');
  if (oauthSource) {
    const declaredScopes: string[] = [];
    for (const d of declaredInventories) {
      for (const s of d.scopes ?? []) declaredScopes.push(s.scope);
    }
    const grantedScopes: string[] = [];
    for (const s of oauthSource.inventory?.scopes ?? []) grantedScopes.push(s.scope);

    const declaredSet = new Set(declaredScopes);
    const grantedSet = new Set(grantedScopes);
    const extra = grantedScopes.filter((s) => !declaredSet.has(s));
    const missing = declaredScopes.filter((s) => !grantedSet.has(s));

    // The provider is recoverable from the source error message OR from
    // a declared scope's service field. Default to a generic label
    // rather than guess wrong.
    let provider = 'oauth-scopes';
    for (const d of declaredInventories) {
      const first = d.scopes?.[0]?.service;
      if (first) {
        provider = first;
        break;
      }
    }

    const section: OAuthScopesSection = {
      provider,
      granted: grantedScopes,
      declared: declaredScopes,
      extra,
      missing,
      verdict: mcpVerdictToOAuth(oauthSource.verdict),
    };
    if (oauthSource.verdict === 'unverified' && oauthSource.error?.message) {
      section.reason = oauthSource.error.message;
      section.verdict = 'unverified';
    }
    oauthScopes = section;
  }

  // ─── Overall risk level ──────────────────────────────────────────────
  const allFindings = report.sources.flatMap(findingsFromSource);
  const worstSource = report.sources.reduce<{
    verdict: SourceVerification['verdict'];
  }>((acc, s) => (s.verdict === 'unverified' ? { verdict: 'unverified' } : acc),
    { verdict: report.sources.some((s) => s.diffs.length > 0) ? 'discrepancy' : 'verified' });

  const overallRiskLevel = severityForVerdict({
    verdict: worstSource.verdict,
    findings: allFindings,
  });

  const json: ReportJson = {
    summary: report.sources.length === 0
      ? `MCP tool inventory captured for ${report.agentLabel} (${inventory.tools.length} tools).`
      : `MCP scan of ${report.agentLabel}: ${allFindings.length} finding(s) across ${report.sources.length} source(s).`,
    agentPurpose: report.agentLabel,
    systems: [],
    risks: [],
    recommendations: [],
    overallRiskLevel,
    mcpInventory,
  };
  if (declaredDiff) json.declaredDiff = declaredDiff;
  if (oauthScopes) json.oauthScopes = oauthScopes;
  return json;
}
