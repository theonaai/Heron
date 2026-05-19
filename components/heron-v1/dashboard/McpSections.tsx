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
