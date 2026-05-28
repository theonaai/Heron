/**
 * MCP-scan ReportView sections (#33-C / AAP-64).
 *
 * Three collapsible blocks rendered inside ReportView when the matching
 * field is present on reportJson:
 *
 *   1. McpInventorySection    — table of declared tools (name | description |
 *                                annotation badges).
 *   2. DeclaredDiffSection    — Extra and Missing tool sub-tables with
 *                                severity pills using the existing severity
 *                                palette in report.css.
 *   3. OAuthScopesSection     — verdict pill + Granted / Declared lists +
 *                                diff highlights (Extra red-bg, Missing
 *                                amber-bg).
 *
 * Extracted into a separate file from ReportView for two reasons:
 *  - keeps the 1700-line ReportView readable.
 *  - lets the test suite renderToString these in isolation without
 *    pulling the whole ReportView wiring (anchor rail, intersection
 *    observer, etc).
 */
import type {
  McpInventorySection as McpInventoryData,
  DeclaredDiffSection as DeclaredDiffData,
  OAuthScopesSection as OAuthScopesData,
  McpFindingSeverity,
  LocalAgentDiscoverySection as LocalDiscoveryData,
  LocalDiscoveryFinding,
  LocalDiscoveredCapability,
  LocalDiscoveredMcpTool,
  LocalMcpToolEnumeration,
  LocalWorkspaceEnvFile,
  OAuthScopeConnector,
  OAuthScopeDiffEntry,
  OAuthScopeVerificationSection as OAuthScopeVerificationData,
  OAuthScopeVerificationSourceResult,
  OAuthScopeVerificationVerdict,
} from '@/lib/report-json';

function severityToCssClass(s: McpFindingSeverity): string {
  switch (s) {
    case 'HIGH':
      return 'sev-high';
    case 'MEDIUM':
      return 'sev-medium';
    case 'LOW':
      return 'sev-low';
    case 'INFO':
    default:
      return 'sev-info';
  }
}

function formatAnnotation(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

export function McpInventorySection({ inventory }: { inventory: McpInventoryData }) {
  return (
    <div id="sec-mcp-inventory">
      <div className="h-section">
        <span className="num">M1</span>
        <span className="label">MCP Tool Inventory</span>
        <span className="meta">
          {inventory.tools.length} {inventory.tools.length === 1 ? 'tool' : 'tools'} ·{' '}
          {inventory.serverImpl ?? inventory.server}
        </span>
      </div>
      <dl className="kv" style={{ marginBottom: 14 }}>
        <dt>Server</dt>
        <dd className="mono" style={{ wordBreak: 'break-word' }}>{inventory.server}</dd>
        <dt>Captured</dt>
        <dd className="mono">{inventory.capturedAt}</dd>
        {inventory.serverImpl && (
          <>
            <dt>Implementation</dt>
            <dd className="mono">{inventory.serverImpl}</dd>
          </>
        )}
      </dl>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 200 }}>Tool</th>
              <th>Description</th>
              <th style={{ width: 260 }}>Annotations</th>
            </tr>
          </thead>
          <tbody>
            {inventory.tools.length === 0 && (
              <tr>
                <td colSpan={3} className="muted" style={{ fontStyle: 'italic' }}>
                  Server declared no tools.
                </td>
              </tr>
            )}
            {inventory.tools.map((tool) => (
              <tr key={tool.name}>
                <td className="mono" style={{ fontSize: 12, color: 'var(--r-ink-2)' }}>
                  {tool.name}
                </td>
                <td style={{ color: 'var(--r-ink-2)', fontSize: 12.5, lineHeight: 1.55 }}>
                  {tool.description || <span className="muted">—</span>}
                </td>
                <td>
                  {tool.annotations && Object.keys(tool.annotations).length > 0 ? (
                    <div className="row-tight" style={{ gap: 4, flexWrap: 'wrap' }}>
                      {Object.entries(tool.annotations).map(([k, v]) => (
                        <span key={k} className="scope-chip" style={{ fontSize: 11 }}>
                          {k}={formatAnnotation(v)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DiffTable({
  title,
  rows,
  emptyMessage,
}: {
  title: string;
  rows: { name: string; severity: McpFindingSeverity; description?: string }[];
  emptyMessage: string;
}) {
  if (rows.length === 0) {
    return (
      <div>
        <div className="tier-label">
          <span>{title}</span>
          <span className="tier-count">0</span>
        </div>
        <p className="muted" style={{ fontSize: 12.5, fontStyle: 'italic' }}>
          {emptyMessage}
        </p>
      </div>
    );
  }
  return (
    <div>
      <div className="tier-label">
        <span>{title}</span>
        <span className="tier-count">{rows.length}</span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 200 }}>Name</th>
              <th style={{ width: 100 }}>Severity</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={`${row.name}-${idx}`}>
                <td className="mono" style={{ fontSize: 12, color: 'var(--r-ink-2)' }}>
                  {row.name}
                </td>
                <td>
                  <span className={`sev ${severityToCssClass(row.severity)}`}>
                    {row.severity.toLowerCase()}
                  </span>
                </td>
                <td style={{ color: 'var(--r-ink-2)', fontSize: 12.5, lineHeight: 1.55 }}>
                  {row.description || <span className="muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function DeclaredDiffSection({ diff }: { diff: DeclaredDiffData }) {
  return (
    <div id="sec-declared-diff">
      <div className="h-section">
        <span className="num">M2</span>
        <span className="label">Declared Diff</span>
        <span className="meta">
          baseline: <span className="mono">{diff.baseline}</span>
        </span>
      </div>
      <div className="stack-lg">
        <DiffTable
          title="Extra (declared but not present in the actual)"
          rows={diff.extra}
          emptyMessage="No extra capabilities found beyond the declared baseline."
        />
        <DiffTable
          title="Missing (declared but absent from the actual)"
          rows={diff.missing}
          emptyMessage="All declared capabilities are present in the actual inventory."
        />
      </div>
    </div>
  );
}

function verdictPillClass(v: OAuthScopesData['verdict']): string {
  if (v === 'verified') return 'sev-low';
  if (v === 'unverified') return 'sev-medium';
  return 'sev-high';
}

export function OAuthScopesSection({ scopes }: { scopes: OAuthScopesData }) {
  const extraSet = new Set(scopes.extra);
  const missingSet = new Set(scopes.missing);
  return (
    <div id="sec-oauth-scopes">
      <div className="h-section">
        <span className="num">M3</span>
        <span className="label">OAuth Scopes</span>
        <span className="meta">
          <span className={`sev ${verdictPillClass(scopes.verdict)}`} style={{ marginRight: 8 }}>
            {scopes.verdict}
          </span>
          provider: <span className="mono">{scopes.provider}</span>
        </span>
      </div>
      {scopes.reason && (
        <p
          style={{
            margin: '0 0 12px',
            color: 'var(--r-ink-2)',
            fontSize: 12.5,
            lineHeight: 1.55,
          }}
        >
          <span className="field-label">Reason</span>
          {scopes.reason}
        </p>
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 16,
        }}
      >
        <div>
          <div className="field-label">Granted ({scopes.granted.length})</div>
          {scopes.granted.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5, fontStyle: 'italic' }}>None.</p>
          ) : (
            <div className="row-tight" style={{ gap: 6, flexWrap: 'wrap' }}>
              {scopes.granted.map((s) => (
                <span
                  key={s}
                  className={`scope-chip ${extraSet.has(s) ? 'excess' : ''}`}
                  data-scope-class={extraSet.has(s) ? 'extra' : 'granted'}
                >
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="field-label">Declared ({scopes.declared.length})</div>
          {scopes.declared.length === 0 ? (
            <p className="muted" style={{ fontSize: 12.5, fontStyle: 'italic' }}>None.</p>
          ) : (
            <div className="row-tight" style={{ gap: 6, flexWrap: 'wrap' }}>
              {scopes.declared.map((s) => (
                <span
                  key={s}
                  className={`scope-chip ${missingSet.has(s) ? 'required' : ''}`}
                  data-scope-class={missingSet.has(s) ? 'missing' : 'declared'}
                >
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Local discovery section (AAP-53) ────────────────────────────────────
   Deterministic agent inventory: every MCP server Heron found on disk
   with the user's consent, plus diff findings against the interview
   transcript. Severity pills reuse the existing palette so the section
   reads consistently with MCP-scan findings above. */
function severityForKind(f: LocalDiscoveryFinding): McpFindingSeverity {
  return f.severity;
}

export function LocalDiscoverySection({ discovery }: { discovery: LocalDiscoveryData }) {
  // Filter scannedPaths to those that actually produced an entry so the
  // subtitle stays useful — listing 30 attempted-but-missing paths
  // drowns out the few that mattered.
  const readPaths = new Set<string>(discovery.agents.map((a) => a.configPath));

  return (
    <div id="sec-discovery">
      <div className="h-section">
        <span className="num">D1</span>
        <span className="label">Local agent discovery — deterministic evidence</span>
        <span className="meta">
          {discovery.agents.length} {discovery.agents.length === 1 ? 'agent' : 'agents'} ·{' '}
          {discovery.findings.length} {discovery.findings.length === 1 ? 'finding' : 'findings'}
        </span>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--r-ink-3)', margin: '0 0 14px', lineHeight: 1.55 }}>
        Read from the following files with your consent:
      </p>
      {readPaths.size === 0 ? (
        <p className="muted" style={{ fontSize: 12.5, fontStyle: 'italic', marginBottom: 14 }}>
          No agent config files found on this machine.
        </p>
      ) : (
        <ul style={{ margin: '0 0 14px 18px', padding: 0, fontSize: 12 }}>
          {Array.from(readPaths).map((p) => (
            <li key={p} className="mono" style={{ color: 'var(--r-ink-2)' }}>
              {p}
            </li>
          ))}
        </ul>
      )}

      {/* Servers table */}
      <div className="tier-label">
        <span>Discovered MCP servers</span>
        <span className="tier-count">
          {discovery.agents.reduce((n, a) => n + a.mcpServers.length, 0)}
        </span>
      </div>
      <div className="tbl-wrap" style={{ marginBottom: 18 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 110 }}>Runtime</th>
              <th style={{ width: 200 }}>Config path</th>
              <th style={{ width: 140 }}>Server</th>
              <th style={{ width: 90 }}>Transport</th>
              <th>URL / command</th>
              <th style={{ width: 140 }}>Tools allowed</th>
              <th style={{ width: 90 }}>Credentials</th>
              <th style={{ width: 180 }}>Redacted env keys</th>
            </tr>
          </thead>
          <tbody>
            {discovery.agents.flatMap((agent) =>
              agent.mcpServers.map((s, idx) => (
                <tr key={`${agent.configPath}::${s.name}::${idx}`}>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    {agent.runtime}
                  </td>
                  <td
                    className="mono"
                    style={{ fontSize: 11, color: 'var(--r-ink-3)', wordBreak: 'break-all' }}
                    title={agent.configPath}
                    onClick={() => {
                      if (typeof navigator !== 'undefined' && navigator.clipboard) {
                        navigator.clipboard.writeText(agent.configPath).catch(() => undefined);
                      }
                    }}
                  >
                    {agent.configPath}
                  </td>
                  <td style={{ fontWeight: 500, fontSize: 12.5 }}>{s.name}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    {s.transport}
                  </td>
                  <td
                    className="mono"
                    style={{ fontSize: 11.5, color: 'var(--r-ink-2)', wordBreak: 'break-all' }}
                  >
                    {s.url
                      ? s.url
                      : [s.command, ...(s.args ?? [])].filter(Boolean).join(' ') || (
                          <span className="muted">—</span>
                        )}
                  </td>
                  <td>
                    {s.toolsAllowed && s.toolsAllowed.length > 0 ? (
                      <div className="row-tight" style={{ gap: 4, flexWrap: 'wrap' }}>
                        {s.toolsAllowed.map((t) => (
                          <span key={t} className="scope-chip" style={{ fontSize: 11 }}>
                            {t}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <span className={`sev ${s.hasCredentials ? 'sev-high' : 'sev-info'}`}>
                      {s.hasCredentials ? 'yes' : 'no'}
                    </span>
                  </td>
                  <td>
                    {s.redactedEnvKeys.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      <div className="row-tight" style={{ gap: 4, flexWrap: 'wrap' }}>
                        {s.redactedEnvKeys.map((k) => (
                          <span
                            key={k}
                            className="mono"
                            style={{
                              fontSize: 10.5,
                              padding: '2px 6px',
                              background: 'var(--r-panel-muted, #f1f5f9)',
                              borderRadius: 3,
                            }}
                            title="Key name only — value never read"
                          >
                            {k}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              )),
            )}
            {discovery.agents.length === 0 && (
              <tr>
                <td colSpan={8} className="muted" style={{ fontStyle: 'italic' }}>
                  No MCP servers discovered.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* AAP-75 — MCP tool enumeration (read/write split) */}
      <McpToolEnumerationTable discovery={discovery} />

      {/* AAP-58 — Plugins / skills table */}
      <PluginsSkillsTable discovery={discovery} />

      {/* AAP-58 — Detected credential keys table */}
      <AuthCredentialsTable discovery={discovery} />

      {/* AAP-67 — per-workspace .env (renumbered to L3 in docs after AAP-100) */}
      <WorkspaceEnvTable discovery={discovery} />

      {/* AAP-67 — reader warnings */}
      <DiscoveryWarnings discovery={discovery} />

      {/* Findings table */}
      <div className="tier-label">
        <span>Findings — interview vs filesystem</span>
        <span className="tier-count">{discovery.findings.length}</span>
      </div>
      {discovery.findings.length === 0 ? (
        <p className="muted" style={{ fontSize: 12.5, fontStyle: 'italic' }}>
          The interview transcript matched what was discovered on disk.
        </p>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 100 }}>Severity</th>
                <th style={{ width: 170 }}>Kind</th>
                <th style={{ width: 160 }}>Server</th>
                <th style={{ width: 120 }}>Runtime</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {discovery.findings.map((f, idx) => (
                <tr key={`${f.kind}-${f.serverName}-${idx}`}>
                  <td>
                    <span className={`sev ${severityToCssClass(severityForKind(f))}`}>
                      {f.severity}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    {f.kind}
                  </td>
                  <td style={{ fontWeight: 500 }}>{f.serverName}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    {f.runtime}
                  </td>
                  <td style={{ color: 'var(--r-ink-2)', fontSize: 12.5, lineHeight: 1.55 }}>
                    {f.description}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── AAP-75 — MCP tool enumeration sub-table ────────────────────────────
   Renders one row per (server, tool) pair when at least one server has
   a `toolEnumeration.state === 'ok'` result. Servers whose enumeration
   failed or was skipped surface as a single status row with the reason,
   so the operator can see "we tried and X happened" rather than the
   enumeration silently being absent.

   Read/write classification renders as a colored chip; `unknown` reads
   muted on purpose — the operator should resolve those manually before
   the verdict can claim full confidence. */
function classificationChipClass(c: LocalDiscoveredMcpTool['classification']): string {
  if (c === 'write') return 'sev sev-high';
  if (c === 'read') return 'sev sev-info';
  return 'sev sev-low';
}

function McpToolEnumerationTable({ discovery }: { discovery: LocalDiscoveryData }) {
  // Find servers that have an enumeration result attached.
  type Row =
    | {
        kind: 'tool';
        runtime: string;
        serverName: string;
        tool: LocalDiscoveredMcpTool;
        attemptedAt: string;
      }
    | {
        kind: 'status';
        runtime: string;
        serverName: string;
        state: 'failed' | 'skipped';
        reason?: string;
        attemptedAt: string;
      };
  const rows: Row[] = [];
  let writeCount = 0;
  let readCount = 0;
  let unknownCount = 0;
  let anyAttempted = false;

  for (const agent of discovery.agents) {
    for (const server of agent.mcpServers) {
      const enumeration: LocalMcpToolEnumeration | undefined = server.toolEnumeration;
      if (!enumeration) continue;
      anyAttempted = true;
      if (enumeration.state === 'ok' && enumeration.tools && enumeration.tools.length > 0) {
        for (const tool of enumeration.tools) {
          rows.push({
            kind: 'tool',
            runtime: agent.runtime,
            serverName: server.name,
            tool,
            attemptedAt: enumeration.attemptedAt,
          });
          if (tool.classification === 'write') writeCount += 1;
          else if (tool.classification === 'read') readCount += 1;
          else unknownCount += 1;
        }
      } else if (enumeration.state === 'ok') {
        rows.push({
          kind: 'status',
          runtime: agent.runtime,
          serverName: server.name,
          state: 'skipped',
          reason: 'server advertised 0 tools',
          attemptedAt: enumeration.attemptedAt,
        });
      } else {
        rows.push({
          kind: 'status',
          runtime: agent.runtime,
          serverName: server.name,
          state: enumeration.state,
          ...(enumeration.reason ? { reason: enumeration.reason } : {}),
          attemptedAt: enumeration.attemptedAt,
        });
      }
    }
  }

  if (!anyAttempted) return null;

  return (
    <>
      <div className="tier-label">
        <span>MCP tool inventory — read / write split</span>
        <span className="tier-count">
          {writeCount + readCount + unknownCount} ·{' '}
          <span style={{ color: 'var(--r-ink-3)' }}>
            {writeCount}w / {readCount}r / {unknownCount}?
          </span>
        </span>
      </div>
      <div className="tbl-wrap" style={{ marginBottom: 18 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 110 }}>Runtime</th>
              <th style={{ width: 140 }}>Server</th>
              <th style={{ width: 200 }}>Tool</th>
              <th style={{ width: 80 }}>Class</th>
              <th>Description / status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => {
              if (row.kind === 'tool') {
                return (
                  <tr key={`tool-${row.serverName}-${row.tool.name}-${idx}`}>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {row.runtime}
                    </td>
                    <td style={{ fontWeight: 500, fontSize: 12.5 }}>{row.serverName}</td>
                    <td className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>
                      {row.tool.name}
                    </td>
                    <td>
                      <span className={classificationChipClass(row.tool.classification)}>
                        {row.tool.classification}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--r-ink-2)' }}>
                      {row.tool.description ?? <span className="muted">—</span>}
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={`status-${row.serverName}-${idx}`}>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    {row.runtime}
                  </td>
                  <td style={{ fontWeight: 500, fontSize: 12.5 }}>{row.serverName}</td>
                  <td className="mono" style={{ fontSize: 12, color: 'var(--r-ink-3)' }}>
                    —
                  </td>
                  <td>
                    <span className={`sev ${row.state === 'failed' ? 'sev-high' : 'sev-low'}`}>
                      {row.state}
                    </span>
                  </td>
                  <td
                    className="mono"
                    style={{ fontSize: 11.5, color: 'var(--r-ink-3)', wordBreak: 'break-all' }}
                  >
                    {row.reason ?? <span className="muted">no reason given</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── AAP-58 — Plugins / skills + auth-credential sub-tables ─────────────────
   Rendered as siblings of the existing MCP servers table inside
   LocalDiscoverySection. Empty when the capability list is empty so
   sessions with only MCP servers (or no discovery at all) render
   unchanged from the AAP-53 baseline. */
function collectCapabilities(
  discovery: LocalDiscoveryData,
): LocalDiscoveredCapability[] {
  const out: LocalDiscoveredCapability[] = [];
  for (const a of discovery.agents) {
    if (!a.capabilities) continue;
    for (const c of a.capabilities) out.push(c);
  }
  return out;
}

function PluginsSkillsTable({ discovery }: { discovery: LocalDiscoveryData }) {
  const caps = collectCapabilities(discovery).filter(
    (c) => c.kind === 'plugin' || c.kind === 'skill',
  );
  if (caps.length === 0) return null;
  return (
    <>
      <div className="tier-label">
        <span>Discovered plugins / skills</span>
        <span className="tier-count">{caps.length}</span>
      </div>
      <div className="tbl-wrap" style={{ marginBottom: 18 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 110 }}>Runtime</th>
              <th style={{ width: 220 }}>Config path</th>
              <th style={{ width: 80 }}>Type</th>
              <th>Name</th>
              <th style={{ width: 90 }}>Enabled</th>
            </tr>
          </thead>
          <tbody>
            {caps.map((c, idx) => {
              const display = c.kind === 'plugin' ? c.name : c.path;
              return (
                <tr key={`${c.kind}-${c.configPath}-${idx}`}>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    {c.runtime}
                  </td>
                  <td
                    className="mono"
                    style={{ fontSize: 11, color: 'var(--r-ink-3)', wordBreak: 'break-all' }}
                    title={c.configPath}
                  >
                    {c.configPath}
                  </td>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    {c.kind}
                  </td>
                  <td
                    className="mono"
                    style={{ fontSize: 12, wordBreak: 'break-all' }}
                    title={display}
                  >
                    {display}
                  </td>
                  <td>
                    <span className={`sev ${c.enabled ? 'sev-info' : 'sev-low'}`}>
                      {c.enabled ? 'yes' : 'no'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function AuthCredentialsTable({ discovery }: { discovery: LocalDiscoveryData }) {
  const creds = collectCapabilities(discovery).filter(
    (c): c is Extract<LocalDiscoveredCapability, { kind: 'auth_credential' }> =>
      c.kind === 'auth_credential',
  );
  if (creds.length === 0) return null;
  return (
    <>
      <div className="tier-label">
        <span>Detected credential keys — names only, never values</span>
        <span className="tier-count">{creds.length}</span>
      </div>
      <div className="tbl-wrap" style={{ marginBottom: 18 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 110 }}>Runtime</th>
              <th style={{ width: 220 }}>Config path</th>
              <th>Key name</th>
              <th style={{ width: 110 }}>Shape</th>
            </tr>
          </thead>
          <tbody>
            {creds.map((c, idx) => (
              <tr key={`auth-${c.configPath}-${c.provider}-${idx}`}>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {c.runtime}
                </td>
                <td
                  className="mono"
                  style={{ fontSize: 11, color: 'var(--r-ink-3)', wordBreak: 'break-all' }}
                  title={c.configPath}
                >
                  {c.configPath}
                </td>
                <td
                  className="mono"
                  style={{ fontSize: 12, wordBreak: 'break-all' }}
                  title={c.provider}
                >
                  {c.provider}
                </td>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {c.valueShape ?? (c.hasValue ? 'unknown' : '—')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── Workspace .env sub-table (AAP-67) ──────────────────────────────────
   Renders only when the section is populated, so sessions scanned
   without workspace .env evidence render unchanged. Every row carries
   an inline "Names only — value never read" affordance because the
   names-not-values invariant is the load-bearing contract.

   AAP-100 — the L3 (macOS Keychain) and L4 (cross-cutting OS credentials)
   tables that lived here were removed alongside their readers. */

function WorkspaceEnvTable({ discovery }: { discovery: LocalDiscoveryData }) {
  const rows: LocalWorkspaceEnvFile[] = discovery.workspaceEnv ?? [];
  if (rows.length === 0) return null;
  return (
    <>
      <div className="tier-label">
        <span>Workspace env vars — variable names only, never values</span>
        <span className="tier-count">
          {rows.reduce((n, r) => n + r.keys.length, 0)}
        </span>
      </div>
      <div className="tbl-wrap" style={{ marginBottom: 18 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 280 }}>File</th>
              <th>Variable names</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f, idx) => (
              <tr key={`env-${f.path}-${idx}`}>
                <td
                  className="mono"
                  style={{ fontSize: 11, color: 'var(--r-ink-3)', wordBreak: 'break-all' }}
                  title={f.path}
                >
                  {f.path}
                </td>
                <td>
                  {f.keys.length === 0 ? (
                    <span className="muted">— (file exists, no parseable keys)</span>
                  ) : (
                    <div className="row-tight" style={{ gap: 4, flexWrap: 'wrap' }}>
                      {f.keys.map((k) => (
                        <span
                          key={k}
                          className="mono"
                          style={{
                            fontSize: 10.5,
                            padding: '2px 6px',
                            background: 'var(--r-panel-muted, #f1f5f9)',
                            borderRadius: 3,
                          }}
                          title="Name only — value never read"
                        >
                          {k}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function DiscoveryWarnings({ discovery }: { discovery: LocalDiscoveryData }) {
  const warnings = discovery.warnings ?? [];
  if (warnings.length === 0) return null;
  return (
    <>
      <div className="tier-label">
        <span>Reader warnings</span>
        <span className="tier-count">{warnings.length}</span>
      </div>
      <ul style={{ margin: '0 0 14px 18px', padding: 0, fontSize: 12 }}>
        {warnings.map((w, idx) => (
          <li key={`warn-${idx}`} style={{ color: 'var(--r-ink-2)' }}>
            {w}
          </li>
        ))}
      </ul>
    </>
  );
}

/* ── L6 OAuth scope verification (AAP-74) ─────────────────────────────
   Renders the result of `POST /api/discovery/scan { oauthSources: [...] }`.
   One sub-card per requested source, each carrying:
     - verdict pill (Verified / Discrepancy / Unverified)
     - connector label (Google Workspace, BambooHR, Greenhouse)
     - actual scope list returned by the introspection endpoint
     - diff entries (Extra / Missing) with severity pills
     - warnings + error reason when partial / unverified

   Verdict semantics mirror the CLI orchestrator:
     - Verified    — read succeeded, zero diffs vs declared baseline.
     - Discrepancy — read succeeded, at least one extra / missing scope.
     - Unverified  — read failed (auth, transport, parse). The error
                     message is rendered as a separate "Reason" row.

   Per the AAP-74 ticket, this is the section that closes the
   "deterministic verdict on the dashboard" gap for HR-vertical demos:
   Theona-hosted agents have no L1-L5 evidence, so the L6 introspection
   result is the only Surface 2 signal the dashboard can render. */
const CONNECTOR_LABELS: Record<OAuthScopeConnector, string> = {
  'google-workspace': 'Google Workspace',
  bamboohr: 'BambooHR',
  greenhouse: 'Greenhouse',
};

function oauthVerdictPillClass(v: OAuthScopeVerificationVerdict): string {
  if (v === 'verified') return 'sev-low';
  if (v === 'unverified') return 'sev-medium';
  // 'discrepancy' — at least one extra/missing scope. Severity of the
  // individual diff drives the per-row pill; the source-level pill
  // stays neutral-warn rather than escalating off-screen.
  return 'sev-medium';
}

function diffSeverityClass(s: OAuthScopeDiffEntry['severity']): string {
  switch (s) {
    case 'critical':
      return 'sev-critical';
    case 'high':
      return 'sev-high';
    case 'medium':
      return 'sev-medium';
    case 'low':
      return 'sev-low';
    case 'info':
    default:
      return 'sev-info';
  }
}

function OAuthScopeSourceCard({ source }: { source: OAuthScopeVerificationSourceResult }) {
  const label = CONNECTOR_LABELS[source.connector] ?? source.connector;
  const verdictClass = oauthVerdictPillClass(source.verdict);
  const extras = source.diffs.filter((d) => d.kind === 'extra');
  const missing = source.diffs.filter((d) => d.kind === 'missing');
  return (
    <div className="panel panel-pad" style={{ marginBottom: 14 }}>
      <div className="row-tight" style={{ marginBottom: 8 }}>
        <span className={`sev ${verdictClass}`} style={{ marginRight: 8 }}>
          {source.verdict}
        </span>
        <span style={{ fontWeight: 600, color: 'var(--r-ink)' }}>{label}</span>
        <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
          {source.actualScopes.length} {source.actualScopes.length === 1 ? 'scope' : 'scopes'}
          {source.diffs.length > 0 && (
            <>
              {' · '}
              {source.diffs.length} {source.diffs.length === 1 ? 'diff' : 'diffs'}
            </>
          )}
        </span>
      </div>
      {source.errorMessage && (
        <p
          style={{
            margin: '0 0 10px',
            fontSize: 12.5,
            color: 'var(--r-ink-2)',
            lineHeight: 1.55,
          }}
        >
          <span className="field-label">Reason</span>
          {source.errorMessage}
        </p>
      )}
      {source.warnings && source.warnings.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div className="field-label">Warnings</div>
          <ul style={{ margin: '0 0 0 18px', padding: 0, fontSize: 12, color: 'var(--r-ink-2)' }}>
            {source.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {source.actualScopes.length > 0 && (
        <div style={{ marginBottom: extras.length === 0 && missing.length === 0 ? 0 : 12 }}>
          <div className="field-label">
            Actual scopes ({source.actualScopes.length})
          </div>
          <div className="row-tight" style={{ gap: 6, flexWrap: 'wrap' }}>
            {source.actualScopes.map((s, i) => (
              <span
                key={`${s.service}:${s.scope}:${i}`}
                className="scope-chip"
                title={s.service}
              >
                {s.scope}
              </span>
            ))}
          </div>
        </div>
      )}
      {extras.length > 0 && (
        <div style={{ marginBottom: missing.length === 0 ? 0 : 12 }}>
          <div className="field-label">
            Extra — granted but not declared ({extras.length})
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 100 }}>Severity</th>
                <th style={{ width: 160 }}>Service</th>
                <th>Scope</th>
              </tr>
            </thead>
            <tbody>
              {extras.map((d, i) => (
                <tr key={`extra-${i}`}>
                  <td>
                    <span className={`sev ${diffSeverityClass(d.severity)}`}>{d.severity}</span>
                  </td>
                  <td className="mono" style={{ fontSize: 12, color: 'var(--r-ink-2)' }}>
                    {d.service}
                  </td>
                  <td className="mono" style={{ fontSize: 12, color: 'var(--r-ink)' }}>
                    {d.scope}
                    {d.details && (
                      <span
                        style={{
                          display: 'block',
                          marginTop: 4,
                          fontFamily: 'inherit',
                          color: 'var(--r-ink-3)',
                          fontSize: 12,
                        }}
                      >
                        {d.details}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {missing.length > 0 && (
        <div>
          <div className="field-label">
            Missing — declared but not granted ({missing.length})
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 100 }}>Severity</th>
                <th style={{ width: 160 }}>Service</th>
                <th>Scope</th>
              </tr>
            </thead>
            <tbody>
              {missing.map((d, i) => (
                <tr key={`missing-${i}`}>
                  <td>
                    <span className={`sev ${diffSeverityClass(d.severity)}`}>{d.severity}</span>
                  </td>
                  <td className="mono" style={{ fontSize: 12, color: 'var(--r-ink-2)' }}>
                    {d.service}
                  </td>
                  <td className="mono" style={{ fontSize: 12, color: 'var(--r-ink)' }}>
                    {d.scope}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function OAuthScopeVerificationSection({
  verification,
}: {
  verification: OAuthScopeVerificationData;
}) {
  return (
    <div id="sec-oauth-scope-verification">
      <div className="h-section">
        <span className="num">L6</span>
        <span className="label">OAuth scope verification</span>
        <span className="meta">
          {verification.sources.length}{' '}
          {verification.sources.length === 1 ? 'source' : 'sources'} ·{' '}
          <span className="mono">{verification.capturedAt}</span>
        </span>
      </div>
      <p
        style={{
          margin: '0 0 14px',
          fontSize: 12.5,
          color: 'var(--r-ink-2)',
          lineHeight: 1.55,
        }}
      >
        Live introspection of OAuth tokens against each provider&apos;s scope
        endpoint. Verified = read succeeded with no diff vs declared
        baseline; Discrepancy = scope granted that was not declared, or
        declared scope not granted; Unverified = the source read failed.
      </p>
      {verification.sources.length === 0 ? (
        <p className="muted" style={{ fontStyle: 'italic', fontSize: 12.5 }}>
          No OAuth sources submitted with this scan.
        </p>
      ) : (
        verification.sources.map((s, i) => (
          <OAuthScopeSourceCard key={`oauth-${s.connector}-${i}`} source={s} />
        ))
      )}
    </div>
  );
}
