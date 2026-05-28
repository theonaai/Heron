'use client';

/**
 * AAP-103 — Dashboard posture indicator + Vijil-style Failure Pattern
 * cards.
 *
 * Mirrors the markdown body's posture + cards layout (see
 * `src/report/templates.ts:renderPostureSection` / `renderFindingCard`).
 * The two surfaces consume the same `VerdictSnapshot` shape persisted
 * onto report.json by the verification pipeline.
 *
 * Pattern learned from AAP-93 / AAP-96 / AAP-98: when the markdown
 * changes, the dashboard must change too — both surfaces draw the same
 * content and we keep them in lockstep via the shared
 * `src/report/finding-display.ts` helpers.
 */

import React, { useMemo, useState } from 'react';

import {
  assignFindingCodes,
  bucketForBand,
  colorForSeverity,
  countVerifiedByBucket,
  formatSeverityNumber,
  gradientPercentForSeverity,
  renderBucketCountsLine,
  renderGradientCSSValue,
  renderSeverityFormula,
  SEVERITY_BAND_LABEL,
  type CodedVerdictFinding,
} from '@/src/report/finding-display';
import { getMitigationHint } from '@/src/report/mitigation-catalog';
import type {
  EvidenceSource,
  ReportSeverityBand,
  VerdictFindingSnapshot,
  VerdictSnapshot,
} from '@/src/report/types';

const EVIDENCE_SOURCE_LABEL: Record<EvidenceSource, string> = {
  MCP: 'MCP server / tool inventory',
  OAU: 'OAuth scope introspection',
  ENV: 'Workspace .env / secret material',
  PLG: 'Plugin / skill / auth credential',
  SLF: 'Self-attested (interview only)',
};

// ─── Gradient indicator ─────────────────────────────────────────────────

/**
 * Horizontal CSS gradient bar with a triangle marker positioned at the
 * Verified-only posture (FIPS 199 high-water-mark). Counts breakdown
 * below in small grey type.
 */
export function PostureGradient({ verdict }: { verdict: VerdictSnapshot }) {
  const posture = verdict.posture ?? 0;
  const band = verdict.postureBand ?? 'informational';
  const counts = countVerifiedByBucket(
    (verdict.findings ?? []) as Array<{ evidenceSource: EvidenceSource; band: ReportSeverityBand; severityScore: number; id: string; title: string; description: string; severityComponents: { br: number; ds: number; dm: number } }>,
  );
  const countsLine = renderBucketCountsLine(counts);

  const markerPct = posture > 0 ? gradientPercentForSeverity(posture) : 0;
  const markerColor = posture > 0 ? colorForSeverity(posture) : '#cbd5e1';
  const postureText =
    posture === 0
      ? 'No Verified findings'
      : `${formatSeverityNumber(posture)} (${SEVERITY_BAND_LABEL[band]})`;

  return (
    <section
      style={{
        margin: '0 0 24px',
        padding: '20px 22px',
        background: '#ffffff',
        border: '1px solid #e5e7eb',
        borderRadius: 10,
        boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
      }}
      aria-label="Posture indicator"
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 14,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 12,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--r-ink-3)',
            }}
          >
            Posture
          </div>
          <div
            style={{
              fontSize: 28,
              fontWeight: 600,
              color: 'var(--r-ink)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {postureText}
          </div>
        </div>
        <div
          style={{
            fontSize: 13,
            color: 'var(--r-ink-2)',
            textAlign: 'right',
          }}
        >
          {countsLine}
        </div>
      </div>
      <GradientBar markerPct={markerPct} markerColor={markerColor} />
      <p
        style={{
          margin: '14px 0 0',
          fontSize: 12,
          color: 'var(--r-ink-3)',
          lineHeight: 1.6,
        }}
      >
        Posture aggregates Verified findings via the FIPS 199 high-water-mark
        rule (max severity, not average). Self-attested findings render below
        but do not move the gradient.
      </p>
    </section>
  );
}

function GradientBar({ markerPct, markerColor }: { markerPct: number; markerColor: string }) {
  const gradient = renderGradientCSSValue();
  return (
    <div
      style={{
        position: 'relative',
        height: 32,
        marginTop: 8,
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: '12px 0 12px 0',
          background: gradient,
          borderRadius: 4,
          boxShadow: 'inset 0 1px 1px rgba(15,23,42,0.06)',
        }}
        aria-hidden
      />
      {/* Tick labels for the 9 stops. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          fontSize: 9,
          color: 'var(--r-ink-3)',
          pointerEvents: 'none',
        }}
        aria-hidden
      >
        {['1', '1.5', '2', '3', '4', '4.5', '6', '9', '13.5'].map((s) => (
          <span key={s} style={{ fontVariantNumeric: 'tabular-nums' }}>
            {s}
          </span>
        ))}
      </div>
      {/* Marker triangle. */}
      <div
        style={{
          position: 'absolute',
          left: `calc(${markerPct}% - 7px)`,
          top: 0,
          width: 14,
          height: 14,
          borderLeft: '7px solid transparent',
          borderRight: '7px solid transparent',
          borderTop: `10px solid ${markerColor}`,
          filter: 'drop-shadow(0 1px 1px rgba(15,23,42,0.2))',
        }}
        aria-hidden
      />
    </div>
  );
}

// ─── Failure Pattern cards ─────────────────────────────────────────────

/**
 * Render the Verified + Self-Attested finding subsections as Vijil-style
 * Failure Pattern cards. Verified findings drive the posture indicator;
 * SLF findings live in a separate sub-section below.
 */
export function FailurePatternCards({ verdict }: { verdict: VerdictSnapshot }) {
  // Cast through the dashboard's snapshot shape — the helper only reads
  // the fields the snapshot guarantees.
  const coded = useMemo(
    () => assignFindingCodes(verdict.findings as unknown as CodedVerdictFinding[]),
    [verdict.findings],
  );

  const verified = useMemo(
    () =>
      coded
        .filter((f) => f.evidenceSource !== 'SLF')
        .slice()
        .sort((a, b) => b.severityScore - a.severityScore),
    [coded],
  );
  const selfAttested = useMemo(
    () =>
      coded
        .filter((f) => f.evidenceSource === 'SLF')
        .slice()
        .sort((a, b) => b.severityScore - a.severityScore),
    [coded],
  );

  return (
    <div className="stack-lg">
      <FindingsSubsection
        title="Verified Findings"
        helpText="Deterministic evidence: MCP server inventory, OAuth scope introspection, workspace .env scans, plugin / skill / auth credentials. These drive the posture indicator above."
        findings={verified}
        emptyState="No Verified findings — either the discovery scan has not run yet, or it ran and found no inconsistencies."
      />
      <FindingsSubsection
        title="Self-Attested Findings"
        helpText="Derived from the agent's interview answers only. Appears here for transparency but does not move the posture indicator above. Treat each as a working hypothesis until matched to deterministic evidence."
        findings={selfAttested}
        emptyState="No self-attested findings."
      />
    </div>
  );
}

function FindingsSubsection({
  title,
  helpText,
  findings,
  emptyState,
}: {
  title: string;
  helpText: string;
  findings: CodedVerdictFinding[];
  emptyState: string;
}) {
  return (
    <div>
      <h3
        style={{
          margin: '24px 0 6px',
          fontSize: 16,
          fontWeight: 600,
          color: 'var(--r-ink)',
        }}
      >
        {title}
      </h3>
      <p
        style={{
          margin: '0 0 14px',
          fontSize: 12.5,
          lineHeight: 1.55,
          color: 'var(--r-ink-3)',
        }}
      >
        {helpText}
      </p>
      {findings.length === 0 ? (
        <p
          style={{
            margin: '0 0 14px',
            padding: '12px 14px',
            background: 'var(--r-bg-muted, #f8fafc)',
            borderRadius: 6,
            border: '1px dashed #e5e7eb',
            fontSize: 12.5,
            color: 'var(--r-ink-3)',
          }}
        >
          {emptyState}
        </p>
      ) : (
        <div className="stack-md">
          {findings.map((f) => (
            <FindingCard key={f.code} finding={f} />
          ))}
        </div>
      )}
    </div>
  );
}

// AAP-104 B5 — SLF descriptions arrive from the LLM analyzer and are
// often 5+ paragraphs of dense prose. Truncate to a leading clause for
// the card view and reveal the rest behind "Show more". 320 chars
// (≈ 2 sentences) keeps cards scannable without burying the wedge
// between Verified and Self-attested.
const DESCRIPTION_TRUNCATE_LEN = 320;

function truncateAt(text: string, limit: number): { head: string; rest: string } {
  if (text.length <= limit) return { head: text, rest: '' };
  // Prefer cutting at a sentence break or whitespace under the limit so
  // the head doesn't end mid-word.
  const window = text.slice(0, limit);
  const sentenceEnd = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('? '),
    window.lastIndexOf('! '),
  );
  let cut = limit;
  if (sentenceEnd > limit * 0.6) cut = sentenceEnd + 1;
  else {
    const ws = window.lastIndexOf(' ');
    if (ws > limit * 0.6) cut = ws;
  }
  return { head: text.slice(0, cut).trimEnd() + '…', rest: text.slice(cut).trimStart() };
}

function FindingCard({ finding }: { finding: CodedVerdictFinding }) {
  const sevColor = colorForSeverity(finding.severityScore);
  const sevText = formatSeverityNumber(finding.severityScore);
  const bandLabel = SEVERITY_BAND_LABEL[finding.band as ReportSeverityBand];
  const sourceLabel = EVIDENCE_SOURCE_LABEL[finding.evidenceSource];

  const formula = renderSeverityFormula({
    severity: finding.severityScore,
    br: finding.severityComponents.br,
    ds: finding.severityComponents.ds,
    dm: finding.severityComponents.dm,
    ...(finding.severityComponents.brW !== undefined && { brW: finding.severityComponents.brW }),
    ...(finding.severityComponents.brR !== undefined && { brR: finding.severityComponents.brR }),
    ...(finding.severityComponents.brA !== undefined && { brA: finding.severityComponents.brA }),
  });

  // AAP-104 B9 — prefer the analyzer's mitigation prose when it's
  // attached to the finding (Surface 1 risks carry `analyzerNotes`
  // after the verdict pipeline preserves the LLM's actionable
  // suggestions). Falls through to the generic evidence-source
  // fallback otherwise.
  const fallbackHint = getMitigationHint({ evidenceSource: finding.evidenceSource });
  const analyzerNotes = (finding as { analyzerNotes?: string }).analyzerNotes;
  const mitigation = analyzerNotes && analyzerNotes.length > 0 ? analyzerNotes : fallbackHint;

  const implications = implicationsForFinding(finding);

  return (
    <article
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        background: '#ffffff',
        padding: '16px 18px',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          marginBottom: 8,
        }}
      >
        <span
          className="mono"
          style={{
            display: 'inline-block',
            padding: '4px 10px',
            background: '#f1f5f9',
            color: 'var(--r-ink-2)',
            border: '1px solid #e2e8f0',
            borderRadius: 4,
            fontSize: 12,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '0.02em',
            minWidth: 84,
            textAlign: 'center',
          }}
        >
          {finding.code}
        </span>
        <div style={{ flex: '1 1 auto' }}>
          <div
            style={{
              fontSize: 14.5,
              fontWeight: 600,
              color: 'var(--r-ink)',
              lineHeight: 1.45,
            }}
          >
            {finding.title}
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: 11.5,
              color: 'var(--r-ink-3)',
            }}
          >
            Source: {sourceLabel}
          </div>
        </div>
        <SeverityPill
          severity={finding.severityScore}
          band={finding.band as ReportSeverityBand}
          color={sevColor}
          label={`${sevText} ${bandLabel}`}
          formula={formula}
        />
      </header>
      {finding.description && (
        <FindingDescription text={finding.description} />
      )}
      {implications.length > 0 && (
        <div style={{ margin: '10px 0' }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--r-ink-2)',
              marginBottom: 4,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            Implications
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: 18,
              fontSize: 12.5,
              lineHeight: 1.55,
              color: 'var(--r-ink-2)',
            }}
          >
            {implications.map((it, i) => (
              <li key={i}>{it}</li>
            ))}
          </ul>
        </div>
      )}
      <MitigationCallout text={mitigation} />
    </article>
  );
}

function FindingDescription({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const { head, rest } = useMemo(() => truncateAt(text, DESCRIPTION_TRUNCATE_LEN), [text]);
  const hasMore = rest.length > 0;
  return (
    <p
      style={{
        margin: '0 0 10px',
        fontSize: 13,
        lineHeight: 1.55,
        color: 'var(--r-ink-2)',
      }}
    >
      {expanded ? text : head}
      {hasMore && (
        <>
          {' '}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: '#1d4ed8',
              fontSize: 12.5,
              fontWeight: 600,
              textDecoration: 'underline',
            }}
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        </>
      )}
    </p>
  );
}

function SeverityPill({
  severity: _severity,
  band: _band,
  color,
  label,
  formula,
}: {
  severity: number;
  band: ReportSeverityBand;
  color: string;
  label: string;
  formula: string;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      {/* AAP-104 B3 — custom `role="tooltip"` popover handles hover hint.
          The native `title` attribute was also wired up here, causing a
          dual-tooltip (the OS popover plus our custom one) when the
          severity pill was hovered. Removed `title` so only the styled
          tooltip renders. */}
      <span
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          display: 'inline-block',
          padding: '4px 10px',
          borderRadius: 4,
          background: color,
          color: '#ffffff',
          fontSize: 11.5,
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          whiteSpace: 'nowrap',
          cursor: 'help',
        }}
      >
        {label}
      </span>
      {hovered && (
        <div
          role="tooltip"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 50,
            padding: '8px 10px',
            background: 'var(--r-ink, #0f172a)',
            color: '#f8fafc',
            fontSize: 11,
            lineHeight: 1.5,
            borderRadius: 4,
            whiteSpace: 'nowrap',
            boxShadow: '0 4px 8px rgba(15,23,42,0.18)',
          }}
        >
          {formula}
        </div>
      )}
    </div>
  );
}

function MitigationCallout({ text }: { text: string }) {
  // AAP-104 B9 — analyzer-supplied mitigation prose is a semicolon-
  // joined list of suggestions ("Restrict X; rotate Y; audit Z"). The
  // pre-fix renderer dumped the whole string on one line, which made
  // multi-item lists unreadable. Detect `; ` separators and render as
  // a bullet list instead.
  const items = text.includes('; ')
    ? text.split(/;\s+/).map((s) => s.replace(/\.$/, '').trim()).filter((s) => s.length > 0)
    : null;
  return (
    <div
      style={{
        marginTop: 10,
        padding: '10px 12px',
        background: '#f0fdf4',
        border: '1px solid #bbf7d0',
        borderRadius: 6,
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: '#15803d',
          marginBottom: 4,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        Mitigations
      </div>
      {items && items.length > 1 ? (
        <ul
          style={{
            margin: 0,
            paddingLeft: 18,
            fontSize: 12.5,
            lineHeight: 1.55,
            color: '#14532d',
          }}
        >
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      ) : (
        <div style={{ fontSize: 12.5, lineHeight: 1.55, color: '#14532d' }}>{text}</div>
      )}
    </div>
  );
}

function implicationsForFinding(finding: VerdictFindingSnapshot | CodedVerdictFinding): string[] {
  const out: string[] = [];
  switch (finding.evidenceSource) {
    case 'MCP':
      out.push(
        'Tools registered at runtime that are not declared in the MCP server config expand the agent\'s effective blast radius beyond what reviewers approved.',
      );
      break;
    case 'OAU':
      out.push(
        'OAuth scopes granted at the provider exceed what the agent consumer requested, so the agent can perform actions that were not justified during scope review.',
      );
      break;
    case 'ENV':
      out.push(
        'Credentials in workspace .env files are accessible to anyone with filesystem access; this widens the credential blast radius beyond a secret manager\'s audit boundary.',
      );
      break;
    case 'PLG':
      out.push(
        'Plugin / skill / auth credential grants live outside the MCP scope contract, so the declared scope of the agent does not bound what this artefact can do.',
      );
      break;
    case 'SLF':
      // AAP-104 B4 — SLF Implications now mirrors the severity-component
      // breakdown of the self-reported claim, instead of repeating the
      // "self-reported, not verified" meta-info the SLF badge already
      // displays. Each axis explains WHY the agent's own description
      // pushed the severity score up so the reviewer can decide where
      // to direct deterministic verification effort.
      out.push(...slfImplications(finding));
      break;
  }
  return out;
}

function slfImplications(finding: VerdictFindingSnapshot | CodedVerdictFinding): string[] {
  const c = finding.severityComponents;
  const lines: string[] = [];
  if (c.brW !== undefined && c.brW >= 2) {
    lines.push(
      `Agent self-reports ${c.brW === 3 ? 'five or more' : 'two to four'} write-capable tools (BR-W=${c.brW}) — confirm by enumerating the actual MCP server tool list.`,
    );
  }
  if (c.brR !== undefined && c.brR >= 2) {
    lines.push(
      `Agent self-reports reaching ${c.brR === 3 ? 'seven or more' : 'three to six'} distinct systems (BR-R=${c.brR}) — confirm by listing OAuth scopes + per-system credentials.`,
    );
  }
  if (c.brA !== undefined && c.brA >= 2) {
    lines.push(
      `Agent self-reports ${c.brA === 3 ? 'fully autonomous' : 'partial human-in-loop'} chaining (BR-A=${c.brA}) — confirm by inspecting the orchestration code for approval gates.`,
    );
  }
  if (c.ds >= 2) {
    lines.push(
      c.ds === 3
        ? `Agent describes processing Critical-tier data (Article 9 special category, PHI, financial credentials, gov IDs — DS=${c.ds}) — confirm by inspecting the actual data flow.`
        : `Agent describes processing Sensitive PII (DS=${c.ds}) — confirm by inspecting the actual data flow.`,
    );
  }
  if (c.dm > 1) {
    lines.push(
      `Domain multiplier ${c.dm}× — agent operates in an EU AI Act Annex III or GDPR Art. 35(3) domain. Confirm DPIA coverage.`,
    );
  }
  if (lines.length === 0) {
    // Fallback for SLF findings with no elevated axis (still SLF so we
    // never silently drop the section).
    lines.push(
      'Self-reported claim. Attach deterministic evidence (config, scope grant, audit log) before relying on it.',
    );
  }
  return lines;
}

// Use `bucketForBand` in a no-op import so tree-shakers don't drop it
// from the bundle — the catalog tests import it elsewhere and we re-use
// the logic in a future refactor.
void bucketForBand;
