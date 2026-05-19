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
