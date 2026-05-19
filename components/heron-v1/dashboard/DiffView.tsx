'use client';

import type {
  DiffJson,
  DiffSystemChanged,
  DiffSystemRephrased,
  VersionDiff,
} from '@/lib/api';
import { diffMarkdownToHtml } from './diffMarkdown';

// Render the Compare tab. Two paths:
//   - structured (preferred): diff.diffJson is present → tables + summary
//   - markdown fallback:      diff.diffJson is null → render diff.diffMarkdown
//     via the legacy parser (kept for sessions diffed before the JSON path).

export default function DiffView({ diff }: { diff: VersionDiff }) {
  const generatedAt = new Date(diff.diffGeneratedAt).toLocaleString();
  // Backend column previous_session_id is `text NULL`, so a stale or
  // legacy row can serve a diff with no recorded predecessor. Don't
  // crash the whole tab on `.replace` of null — fall back to a generic
  // label so the user still sees the comparison body.
  const prevShort = diff.previousSessionId
    ? diff.previousSessionId.replace('sess_', '').slice(0, 12)
    : 'previous';

  if (diff.diffJson) {
    return (
      <article className="report diff-report">
        <div className="diff-meta">
          Compared against the previous audit ({prevShort}). Generated {generatedAt}.
          {diff.diffJson.enriched ? '' : ' (basic comparison — narrative unavailable)'}
        </div>
        <StructuredDiff diffJson={diff.diffJson} />
      </article>
    );
  }

  if (diff.diffMarkdown) {
    return (
      <article className="report diff-report">
        <div className="diff-meta">
          Compared against the previous audit ({prevShort}). Generated {generatedAt}.
        </div>
        <div
          className="diff-md"
          dangerouslySetInnerHTML={{ __html: diffMarkdownToHtml(diff.diffMarkdown) }}
        />
      </article>
    );
  }

  return (
    <article className="report diff-report">
      <div className="diff-meta">No comparison data available.</div>
    </article>
  );
}

function StructuredDiff({ diffJson }: { diffJson: DiffJson }) {
  const systemsRephrased = diffJson.systems.rephrased ?? [];
  const noChanges =
    diffJson.counts.findingsAdded === 0 &&
    diffJson.counts.findingsResolved === 0 &&
    diffJson.counts.findingsSeverityChanged === 0 &&
    diffJson.counts.findingsRephrased === 0 &&
    diffJson.counts.systemsAdded === 0 &&
    diffJson.counts.systemsRemoved === 0 &&
    diffJson.counts.systemsChanged === 0 &&
    systemsRephrased.length === 0;

  return (
    <div className="diff-structured">
      <SummaryCard diffJson={diffJson} />

      {noChanges && (
        <div className="diff-section">
          <div className="diff-empty">
            No structural changes between these two audits.
          </div>
        </div>
      )}

      {diffJson.findings.added.length > 0 ||
      diffJson.findings.resolved.length > 0 ||
      diffJson.findings.severityChanged.length > 0 ||
      diffJson.findings.rephrased.length > 0 ? (
        <FindingsSection diffJson={diffJson} />
      ) : null}

      {diffJson.systems.added.length > 0 ||
      diffJson.systems.removed.length > 0 ||
      diffJson.systems.changed.length > 0 ||
      systemsRephrased.length > 0 ? (
        <SystemsSection diffJson={diffJson} />
      ) : null}

      {diffJson.compliance &&
      (diffJson.compliance.frameworksAdded.length > 0 ||
        diffJson.compliance.frameworksRemoved.length > 0 ||
        diffJson.compliance.euAiActClassificationChange ||
        diffJson.compliance.flagsCountFrom !== diffJson.compliance.flagsCountTo) ? (
        <ComplianceSection diffJson={diffJson} />
      ) : null}
    </div>
  );
}

function SummaryCard({ diffJson }: { diffJson: DiffJson }) {
  const directionLabel = {
    improved: 'Improved',
    worsened: 'Worsened',
    unchanged: 'Unchanged',
  }[diffJson.riskDirection];

  return (
    <section className="diff-section">
      <h2 className="diff-section-title">Summary</h2>

      <div className="diff-summary-grid">
        <SummaryStat label="Risk" value={
          <span className="diff-risk-flow">
            <RiskBadge level={diffJson.oldRiskLevel} />
            <span className={`diff-arrow diff-arrow-${diffJson.riskDirection}`} aria-hidden="true">→</span>
            <RiskBadge level={diffJson.newRiskLevel} />
            <span className={`diff-direction diff-direction-${diffJson.riskDirection}`}>
              {directionLabel}
            </span>
          </span>
        } />
        <SummaryStat label="Findings added" value={diffJson.counts.findingsAdded} accent={diffJson.counts.findingsAdded > 0 ? 'bad' : 'neutral'} />
        <SummaryStat label="Findings resolved" value={diffJson.counts.findingsResolved} accent={diffJson.counts.findingsResolved > 0 ? 'good' : 'neutral'} />
        <SummaryStat label="Severity changes" value={diffJson.counts.findingsSeverityChanged} />
        <SummaryStat label="Rephrased" value={diffJson.counts.findingsRephrased} />
        <SummaryStat
          label="Systems"
          value={<SystemsStatBreakdown counts={diffJson.counts} />}
        />
      </div>

      {diffJson.narrative && (
        <p className="diff-narrative">{diffJson.narrative}</p>
      )}

      {diffJson.dataQuality && diffJson.dataQuality.scoreFrom !== null && diffJson.dataQuality.scoreTo !== null && (
        <div className="diff-data-quality">
          Data quality score: {Math.round(diffJson.dataQuality.scoreFrom ?? 0)}% →{' '}
          {Math.round(diffJson.dataQuality.scoreTo ?? 0)}%
          {diffJson.dataQuality.direction !== 'unchanged' && (
            <span className={`diff-direction diff-direction-${diffJson.dataQuality.direction === 'up' ? 'improved' : 'worsened'}`}>
              {' '}({diffJson.dataQuality.direction === 'up' ? '↑' : '↓'})
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function FindingsSection({ diffJson }: { diffJson: DiffJson }) {
  const rows: Array<{
    status: 'added' | 'resolved' | 'severity_up' | 'severity_down' | 'rephrased';
    title: string;
    severityFrom?: string;
    severityTo?: string;
  }> = [];

  for (const f of diffJson.findings.added) {
    rows.push({ status: 'added', title: f.title, severityTo: f.severity });
  }
  for (const f of diffJson.findings.resolved) {
    rows.push({ status: 'resolved', title: f.title, severityFrom: f.severity });
  }
  for (const f of diffJson.findings.severityChanged) {
    rows.push({
      status: f.direction === 'up' ? 'severity_up' : 'severity_down',
      title: f.title,
      severityFrom: f.severityFrom,
      severityTo: f.severityTo,
    });
  }
  for (const f of diffJson.findings.rephrased) {
    rows.push({
      status: 'rephrased',
      title: `${f.oldTitle}  →  ${f.newTitle}`,
      severityFrom: f.severityFrom,
      severityTo: f.severityTo,
    });
  }

  // Order: added, severity_up, rephrased, severity_down, resolved.
  // Worst-first so reviewer sees what got worse before what got better.
  const order: Record<string, number> = {
    added: 0,
    severity_up: 1,
    rephrased: 2,
    severity_down: 3,
    resolved: 4,
  };
  rows.sort((a, b) => order[a.status] - order[b.status]);

  return (
    <section className="diff-section">
      <h2 className="diff-section-title">Findings</h2>
      <div className="diff-table-wrap">
        <table className="diff-table diff-findings">
          <thead>
            <tr>
              <th style={{ width: '14ch' }}>Status</th>
              <th>Title</th>
              <th style={{ width: '22ch', whiteSpace: 'nowrap' }}>Severity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={`diff-row diff-row-${row.status}`}>
                <td>
                  <FindingStatusBadge status={row.status} />
                </td>
                <td>{row.title}</td>
                <td>
                  <SeverityCell from={row.severityFrom} to={row.severityTo} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {diffJson.findings.unchangedCount > 0 && (
        <div className="diff-footnote">
          {diffJson.findings.unchangedCount} unchanged finding
          {diffJson.findings.unchangedCount === 1 ? '' : 's'} hidden.
        </div>
      )}
    </section>
  );
}

// Backend stores `systemId` as a long human-readable description joined
// with ad-hoc separators by the LLM: em-dash ("—"), en-dash ("–"), or
// right-arrow ("→"). Examples observed in production:
//   "LinkedIn (via Apify LinkedIn Scraper) — Web scraping / REST API
//    — API key authentication (Apify token, managed by Theona platform)"
//   "LinkedIn (via Apify LinkedIn Scraper) → Web scraping / REST API
//    → Apify API token + operator's LinkedIn session cookie"
// Older audits in the same diff often used a different separator, so we
// match all three. Render first segment as name (bold), rest as muted
// metadata — each entry then reads as a stacked card, not a paragraph.
function splitSystemId(raw: string): { name: string; meta: string[] } {
  const parts = String(raw || '')
    .split(/\s+[—–→]\s+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return { name: raw || '', meta: [] };
  return { name: parts[0], meta: parts.slice(1) };
}

function SystemNameWithMeta({ raw }: { raw: string }) {
  const { name, meta } = splitSystemId(raw);
  return (
    <>
      <strong>{name}</strong>
      {meta.length > 0 && (
        <span className="diff-system-meta">
          {meta.map((m, i) => (
            <span key={i} className="diff-system-meta-part">
              {m}
            </span>
          ))}
        </span>
      )}
    </>
  );
}

function SystemsSection({ diffJson }: { diffJson: DiffJson }) {
  const rephrased: DiffSystemRephrased[] = diffJson.systems.rephrased ?? [];
  return (
    <section className="diff-section">
      <h2 className="diff-section-title">Systems</h2>

      {rephrased.length > 0 && (
        <div className="diff-subsection">
          <h3 className="diff-subsection-title">Reworded</h3>
          <div className="diff-footnote-inline">
            Same underlying service described with different wording.
          </div>
          <ul className="diff-system-list">
            {rephrased.map((s, i) => (
              <li key={i}>
                <SystemNameWithMeta raw={s.newSystemId} />
                <div className="diff-system-detail">
                  <span className="diff-system-detail-label">Was:</span>{' '}
                  <span className="diff-muted">{s.oldSystemId}</span>
                </div>
                {s.scopesNeeded && s.scopesNeeded.length > 0 && (
                  <div className="diff-system-detail">
                    <span className="diff-system-detail-label">Scopes:</span>{' '}
                    {s.scopesNeeded.map((sc, j) => (
                      <code key={j} className="diff-scope">{sc}</code>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {diffJson.systems.added.length > 0 && (
        <div className="diff-subsection">
          <h3 className="diff-subsection-title">Added</h3>
          <ul className="diff-system-list">
            {diffJson.systems.added.map((s, i) => (
              <li key={i}>
                <SystemNameWithMeta raw={s.systemId} />
                {s.scopesNeeded && s.scopesNeeded.length > 0 && (
                  <div className="diff-system-detail">
                    <span className="diff-system-detail-label">Scopes:</span>{' '}
                    {s.scopesNeeded.map((sc, j) => (
                      <code key={j} className="diff-scope">{sc}</code>
                    ))}
                  </div>
                )}
                {s.dataSensitivity && (
                  <div className="diff-system-detail">
                    <span className="diff-system-detail-label">Sensitivity:</span>{' '}
                    <em>{s.dataSensitivity}</em>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {diffJson.systems.removed.length > 0 && (
        <div className="diff-subsection">
          <h3 className="diff-subsection-title">Removed</h3>
          <ul className="diff-system-list">
            {diffJson.systems.removed.map((s, i) => (
              <li key={i}><SystemNameWithMeta raw={s.systemId} /></li>
            ))}
          </ul>
        </div>
      )}

      {diffJson.systems.changed.length > 0 && (
        <div className="diff-subsection">
          <h3 className="diff-subsection-title">Changed</h3>
          <div className="diff-table-wrap">
            <table className="diff-table diff-systems">
              <thead>
                <tr>
                  <th>System</th>
                  <th>Scopes added</th>
                  <th>Scopes removed</th>
                  <th>Other changes</th>
                </tr>
              </thead>
              <tbody>
                {diffJson.systems.changed.map((c, i) => (
                  <tr key={i}>
                    <td><SystemNameWithMeta raw={c.systemId} /></td>
                    <td>
                      {c.scopesAdded.length === 0 ? (
                        <span className="diff-muted">—</span>
                      ) : (
                        c.scopesAdded.map((s, j) => <code key={j} className="diff-scope diff-scope-added">{s}</code>)
                      )}
                    </td>
                    <td>
                      {c.scopesRemoved.length === 0 ? (
                        <span className="diff-muted">—</span>
                      ) : (
                        c.scopesRemoved.map((s, j) => <code key={j} className="diff-scope diff-scope-removed">{s}</code>)
                      )}
                    </td>
                    <td><OtherSystemChanges entry={c} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {diffJson.systems.unchangedCount > 0 && (
        <div className="diff-footnote">
          {diffJson.systems.unchangedCount} unchanged system
          {diffJson.systems.unchangedCount === 1 ? '' : 's'} hidden.
        </div>
      )}
    </section>
  );
}

// Render one before/after block for a prose-y system field. Uses the same
// red-add / green-remove palette as the Scopes columns so the cell reads as
// a diff at a glance instead of a wall of grey text. Both "from" and "to"
// always render — even when one is empty — so the reader sees direction.
function ChangeBlock({
  label,
  from,
  to,
}: {
  label: string;
  from: string;
  to: string;
}) {
  return (
    <div className="diff-change-block">
      <div className="diff-change-label">{label}</div>
      <div className="diff-change-from">{from || <span className="diff-muted">(empty)</span>}</div>
      <div className="diff-change-to">{to || <span className="diff-muted">(empty)</span>}</div>
    </div>
  );
}

function OtherSystemChanges({ entry }: { entry: DiffSystemChanged }) {
  const blocks: React.ReactNode[] = [];
  if (entry.systemIdChanged) {
    blocks.push(
      <ChangeBlock
        key="desc"
        label="Description"
        from={entry.systemIdChanged.from}
        to={entry.systemIdChanged.to}
      />,
    );
  }
  if (entry.dataSensitivityChanged) {
    blocks.push(
      <ChangeBlock
        key="sens"
        label="Sensitivity"
        from={entry.dataSensitivityChanged.from}
        to={entry.dataSensitivityChanged.to}
      />,
    );
  }
  if (entry.blastRadiusChanged) {
    blocks.push(
      <ChangeBlock
        key="blast"
        label="Blast radius"
        from={entry.blastRadiusChanged.from}
        to={entry.blastRadiusChanged.to}
      />,
    );
  }
  if (entry.frequencyChanged) {
    blocks.push(
      <ChangeBlock
        key="freq"
        label="Frequency"
        from={entry.frequencyChanged.from}
        to={entry.frequencyChanged.to}
      />,
    );
  }
  if (blocks.length === 0) {
    return <span className="diff-muted">—</span>;
  }
  return <div className="diff-other-changes">{blocks}</div>;
}

function ComplianceSection({ diffJson }: { diffJson: DiffJson }) {
  const c = diffJson.compliance;
  if (!c) return null;
  return (
    <section className="diff-section">
      <h2 className="diff-section-title">Compliance</h2>
      <ul className="diff-compliance-list">
        {c.frameworksAdded.length > 0 && (
          <li>
            <strong>Frameworks now activated:</strong>{' '}
            {c.frameworksAdded.map((f, i) => <code key={i} className="diff-framework-chip">{f}</code>)}
          </li>
        )}
        {c.frameworksRemoved.length > 0 && (
          <li>
            <strong>Frameworks no longer activated:</strong>{' '}
            {c.frameworksRemoved.map((f, i) => <code key={i} className="diff-framework-chip">{f}</code>)}
          </li>
        )}
        {c.euAiActClassificationChange && (
          <li>
            <strong>EU AI Act classification:</strong>{' '}
            <em>{c.euAiActClassificationChange.from}</em> →{' '}
            <em>{c.euAiActClassificationChange.to}</em>
          </li>
        )}
        {c.flagsCountFrom !== c.flagsCountTo && (
          <li>
            <strong>Compliance flags:</strong> {c.flagsCountFrom} → {c.flagsCountTo}
            {c.flagsCountTo > c.flagsCountFrom && (
              <span className="diff-direction diff-direction-worsened"> (+{c.flagsCountTo - c.flagsCountFrom})</span>
            )}
            {c.flagsCountTo < c.flagsCountFrom && (
              <span className="diff-direction diff-direction-improved"> (−{c.flagsCountFrom - c.flagsCountTo})</span>
            )}
          </li>
        )}
      </ul>
    </section>
  );
}

function SummaryStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  accent?: 'good' | 'bad' | 'neutral';
}) {
  return (
    <div className={`diff-stat${accent ? ` diff-stat-${accent}` : ''}`}>
      <div className="diff-stat-label">{label}</div>
      <div className="diff-stat-value">{value}</div>
    </div>
  );
}

// Vertical breakdown for the Systems summary card. A single horizontal
// "+1 / −0 / 2 changed" line wrapped at the ~150px column width and was
// also cryptic ("what does ~ vs ≈ mean?"). Stack the components instead —
// each line gets a plain word, and rows that are zero collapse out.
function SystemsStatBreakdown({
  counts,
}: {
  counts: DiffJson['counts'];
}) {
  const rows: Array<[string, number]> = (
    [
      ['added', counts.systemsAdded],
      ['removed', counts.systemsRemoved],
      ['changed', counts.systemsChanged],
      ['reworded', counts.systemsRephrased ?? 0],
    ] as Array<[string, number]>
  ).filter(([, n]) => n > 0);

  // All-zero (rare — section is hidden then anyway) → keep an explicit "—".
  if (rows.length === 0) {
    return <span className="diff-muted">—</span>;
  }

  return (
    <div className="diff-stat-breakdown">
      {rows.map(([label, n]) => (
        <div key={label} className="diff-stat-breakdown-row">
          <span className="diff-stat-breakdown-num">{n}</span>
          <span className="diff-stat-breakdown-label">{label}</span>
        </div>
      ))}
    </div>
  );
}

function RiskBadge({ level }: { level: string | null }) {
  if (!level) return <span className="diff-muted">—</span>;
  return <span className={`sev sev-${level.toLowerCase()}`}>{level.toUpperCase()}</span>;
}

function FindingStatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = {
    added: '+ Added',
    resolved: '✓ Resolved',
    severity_up: '↑ Severity up',
    severity_down: '↓ Severity down',
    rephrased: '~ Reworded',
  };
  return (
    <span className={`diff-status diff-status-${status}`}>{labels[status] || status}</span>
  );
}

function SeverityCell({ from, to }: { from?: string; to?: string }) {
  if (from && to) {
    return (
      <span className="diff-sev-flow">
        <SeverityChip s={from} />
        <span className="diff-arrow" aria-hidden="true">→</span>
        <SeverityChip s={to} />
      </span>
    );
  }
  if (to) return <SeverityChip s={to} />;
  if (from) return <SeverityChip s={from} />;
  return <span className="diff-muted">—</span>;
}

function SeverityChip({ s }: { s: string }) {
  const norm = String(s || '').toLowerCase();
  return <span className={`sev sev-${norm}`}>{(s || '').toUpperCase()}</span>;
}
