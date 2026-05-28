'use client';

/**
 * G7 PROTOTYPE — Minimal Report Layout (feature branch only, not for merge).
 *
 * Side-by-side with the current ReportView. 5 blocks:
 *   1. Header (always visible) — agent name, posture indicator, sources, timestamp
 *   2. What it does (always visible, 1-2 line + Details ▸)
 *   3. Systems & access (compact table, no Property/Value)
 *   4. Findings (Verified expanded, Self-attested collapsed by count)
 *   5. Compliance lens (collapsed; expands per-framework summary)
 *
 * All data already lives in reportJson — this is purely a display restructuring.
 *
 * Active when the page URL carries `?layout=minimal`.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  assignFindingCodes,
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
  VerdictSnapshot,
} from '@/src/report/types';

// ─── Minimal types we read from reportJson ──────────────────────────────

interface FrequencyShape {
  runsLastWeek?: number | null;
  callsPerRun?: string;
  batchSize?: number | string;
  concurrency?: 'sequential' | 'parallel' | 'mixed' | 'unknown';
  notes?: string;
}

interface WriteOperation {
  operation: string;
  target: string;
  reversible: boolean;
  approvalRequired: boolean;
  volumePerDay: string;
}

interface SystemAssessment {
  systemId: string;
  systemDescription?: string;
  scopesRequested: string[];
  scopesNeeded: string[];
  scopesDelta: string[];
  dataSensitivity: string;
  blastRadius: string;
  frequency?: FrequencyShape;
  frequencyAndVolume: string;
  writeOperations: WriteOperation[];
}

interface MinimalReportJson {
  summary?: string;
  agentPurpose?: string;
  agentTrigger?: string;
  agentOwner?: string;
  systems?: SystemAssessment[];
  metadata?: {
    date?: string;
    target?: string;
    interviewDuration?: number;
    questionsAsked?: number;
  };
  verification?: {
    status?:
      | 'interrogation-only'
      | 'verified'
      | 'partially-verified'
      | 'verification-failed';
    updatedAt?: string;
  };
  verdict?: VerdictSnapshot;
  regulatoryCompliance?: {
    frameworksActivated?: string[];
    controlResults?: Array<{
      frameworkId: string;
      verdict: 'verified' | 'partial' | 'unverified' | 'fail' | 'not-applicable';
      severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
      controlId: string;
      controlName?: string;
    }>;
    mandatory?: unknown;
    voluntary?: unknown;
    all?: Array<{
      framework: string;
      severity?: string;
      frameworkId?: string;
    }>;
  };
  localAgentDiscovery?: unknown;
}

// ─── Project name extraction (Q1 answer) ──────────────────────────────
//
// The runtime "Codex desktop agent in /path" name is uninformative. We
// try to extract the project name from the interview transcript's Q1
// answer (category=purpose, asks for project/product name). The
// pattern that works on the Codex demo: "1. Project/product name: <name>".
//
// If extraction fails we fall back to a labelled placeholder so it's
// obvious the analyzer needs a fix.

interface TranscriptEntry {
  category?: string;
  question?: string;
  answer?: string;
}

function extractProjectName(
  transcript: TranscriptEntry[] | undefined,
  fallback: string | undefined,
): { name: string; isFallback: boolean } {
  if (!transcript || transcript.length === 0) {
    return { name: fallback || 'Unnamed agent', isFallback: true };
  }
  // Look at the first 3 transcript entries for a purpose-category answer.
  const candidates = transcript
    .slice(0, 3)
    .filter((t) => (t.category || '').toLowerCase() === 'purpose');
  for (const c of candidates) {
    const a = (c.answer || '').trim();
    if (!a) continue;
    // Pattern 1: "1. Project/product name: <name>"
    const m1 = a.match(/(?:project\/product name|project name|product name)\s*[:\-]\s*([^\n.]+)/i);
    if (!m1 || !m1[1]) continue;
    let name = m1[1].trim();
    // Strip backticks and asterisks.
    name = name.replace(/[`*]/g, '');
    // Form 1: "Codex3 workspace for MVP Edu Content Agent (mvp-edu-content-agent)"
    //         → take what comes after "for " up to the open paren / comma.
    const forMatch = name.match(/for\s+([A-Z][^()]+?)(?:\s*\(|\s*,|\s*\.|$)/);
    if (forMatch && forMatch[1]) {
      name = forMatch[1].trim();
    } else {
      // Form 2: "MVP Edu Content Agent, running in the local workspace..."
      //         → trim at the first ", running" / ", deployed" / "; " etc.
      // Also strip parenthetical clarifications.
      name = name.split(/[,;]/)[0].trim();
      name = name.split('(')[0].trim();
    }
    // Strip trailing punctuation.
    name = name.replace(/[.,;]+$/, '').trim();
    if (name.length > 0 && name.length < 80) {
      return { name, isFallback: false };
    }
  }
  // Fallback path
  return { name: fallback || 'Unnamed agent', isFallback: true };
}

// ─── DS classifier — T1 / T2 / T3 ─────────────────────────────────────
//
// Strict keyword heuristic over the system's dataSensitivity prose. Mirrors
// the BR×DS×DM logic in `src/verification/severity-scoring.ts` but operates
// on the system-level prose since per-system structured DS isn't persisted.

function classifyDS(prose: string): { tier: 'T1' | 'T2' | 'T3'; label: string } {
  const p = (prose || '').toLowerCase();
  // T3: Article 9 / PHI / financial / gov ID
  if (
    /\b(health|medical|phi|biometric|race|religion|sexual|political|trade union|article 9|art\.?\s*9|hipaa|gov\s*id|ssn|social security|passport|tax\s*id|payment card|pci|credit card|cvv|bank account|iban|swift)\b/.test(
      p,
    )
  ) {
    return { tier: 'T3', label: 'T3 (Critical)' };
  }
  // T2: standard PII
  if (
    /\b(pii|personal data|personal information|email|phone|dob|date of birth|location|name and|address|contact|employee|employment record|messag(e|ing))\b/.test(
      p,
    )
  ) {
    return { tier: 'T2', label: 'T2 (Sensitive PII)' };
  }
  return { tier: 'T1', label: 'T1 (Standard)' };
}

// ─── Access tier derivation (read / write / admin) ────────────────────

function classifyAccess(system: SystemAssessment): 'read' | 'write' | 'admin' {
  // If any write operation declared, it's at least write
  const hasWrites = system.writeOperations && system.writeOperations.length > 0;
  // Heuristic for admin: scope strings mentioning admin / scim / owner /
  // ".admin" / role management / iam.
  const scopeBlob = [
    ...(system.scopesRequested || []),
    ...(system.scopesNeeded || []),
    ...(system.scopesDelta || []),
  ]
    .join(' ')
    .toLowerCase();
  if (/admin|scim|owner|role management|iam|account\.manage/.test(scopeBlob)) {
    return 'admin';
  }
  if (hasWrites) return 'write';
  return 'read';
}

function hasIrreversibleWrites(system: SystemAssessment): boolean {
  return (system.writeOperations || []).some((w) => !w.reversible);
}

// ─── Per-system finding lookup ────────────────────────────────────────
//
// Maps a system row to the count of verified findings that touch it. The
// finding shape doesn't carry an explicit systemId, so we match on title /
// description containing the systemId stem. Conservative — used only to
// render a ✓ / ⚠ glyph in the Verified? column.

function findingsTouchingSystem(
  systemId: string,
  verdict?: VerdictSnapshot,
): number {
  if (!verdict?.findings) return 0;
  // Build a small set of tokens to match against: the full systemId,
  // the head (e.g. "google") and the tail (e.g. "drive", "sheets").
  // Conservative — these are short tokens but findings titles are
  // short too so the false-positive risk is low.
  const id = systemId.toLowerCase();
  const parts = id.split(/[-_]/);
  const tokens = new Set<string>([id]);
  parts.forEach((p) => {
    if (p.length >= 4) tokens.add(p);
  });
  return verdict.findings.filter((f) => {
    if (f.evidenceSource === 'SLF') return false; // verified only
    const blob = `${f.title} ${f.description}`.toLowerCase();
    for (const t of tokens) {
      // Match on word-ish boundary so "drive" doesn't also match
      // "google-drive" via the stem.
      const re = new RegExp(`\\b${escapeRegex(t)}\\b`);
      if (re.test(blob)) return true;
    }
    return false;
  }).length;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Block 1: Header ──────────────────────────────────────────────────

function HeaderBlock({
  projectName,
  isFallback,
  verdict,
  verification,
  metadata,
}: {
  projectName: string;
  isFallback: boolean;
  verdict?: VerdictSnapshot;
  verification?: MinimalReportJson['verification'];
  metadata?: MinimalReportJson['metadata'];
}) {
  const posture = verdict?.posture ?? 0;
  const band = verdict?.postureBand ?? 'informational';
  const markerPct = posture > 0 ? gradientPercentForSeverity(posture) : 0;
  const markerColor = posture > 0 ? colorForSeverity(posture) : '#cbd5e1';
  const postureText =
    posture === 0
      ? 'No Verified findings'
      : `${formatSeverityNumber(posture)} ${SEVERITY_BAND_LABEL[band]}`;
  const counts = countVerifiedByBucket(
    (verdict?.findings ?? []) as Array<{
      evidenceSource: EvidenceSource;
      band: ReportSeverityBand;
      severityScore: number;
      id: string;
      title: string;
      description: string;
      severityComponents: { br: number; ds: number; dm: number };
    }>,
  );
  const countsLine = renderBucketCountsLine(counts);

  // Verified by line — derive from verification + local discovery presence
  const sourcesLine = (() => {
    const parts: string[] = [];
    if (verification?.status === 'verified' || verification?.status === 'partially-verified') {
      parts.push('Filesystem');
    }
    parts.push('OAuth N/A');
    return parts.join(' · ');
  })();

  const auditDate = metadata?.date || new Date().toISOString().slice(0, 10);

  return (
    <section
      style={{
        margin: '0 0 18px',
        padding: '20px 22px',
        background: '#ffffff',
        border: '1px solid #e5e7eb',
        borderRadius: 10,
        boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
      }}
      aria-label="Header"
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: '#71717a',
              marginBottom: 4,
            }}
          >
            Agent
          </div>
          <h1
            style={{
              fontSize: 24,
              fontWeight: 600,
              color: '#18181b',
              lineHeight: 1.2,
              margin: 0,
            }}
          >
            {projectName}
            {isFallback && (
              <span
                style={{
                  marginLeft: 10,
                  display: 'inline-block',
                  padding: '2px 8px',
                  background: '#fef9c3',
                  border: '1px solid #fde68a',
                  borderRadius: 4,
                  fontSize: 11,
                  fontWeight: 500,
                  color: '#92400e',
                  verticalAlign: 'middle',
                }}
                title="Project name couldn't be extracted from Q1 answer. Hardcoded placeholder."
              >
                fallback name
              </span>
            )}
          </h1>
          <div style={{ marginTop: 6, fontSize: 12.5, color: '#52525b' }}>
            Verified by {sourcesLine}
            <span style={{ marginLeft: 12, color: '#a1a1aa' }}>·</span>{' '}
            <span style={{ color: '#71717a' }}>Audited {auditDate}</span>
          </div>
        </div>
        <div style={{ minWidth: 260, textAlign: 'right' }}>
          <div
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: '#71717a',
              marginBottom: 4,
            }}
          >
            Posture
          </div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 600,
              color: '#18181b',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {postureText}
          </div>
          <div style={{ marginTop: 6 }}>
            <MiniGradientBar markerPct={markerPct} markerColor={markerColor} />
          </div>
          <div style={{ fontSize: 11, color: '#71717a', marginTop: 4 }}>{countsLine}</div>
        </div>
      </div>
    </section>
  );
}

function MiniGradientBar({ markerPct, markerColor }: { markerPct: number; markerColor: string }) {
  const gradient = renderGradientCSSValue();
  return (
    <div style={{ position: 'relative', height: 14, width: 240, marginLeft: 'auto' }}>
      <div
        style={{
          position: 'absolute',
          inset: '4px 0',
          background: gradient,
          borderRadius: 3,
        }}
        aria-hidden
      />
      <div
        style={{
          position: 'absolute',
          left: `calc(${markerPct}% - 5px)`,
          top: 0,
          width: 10,
          height: 10,
          borderLeft: '5px solid transparent',
          borderRight: '5px solid transparent',
          borderTop: `7px solid ${markerColor}`,
          filter: 'drop-shadow(0 1px 1px rgba(15,23,42,0.2))',
        }}
        aria-hidden
      />
    </div>
  );
}

// ─── Block 2: What it does ────────────────────────────────────────────

// Screenshot helper — `?expand=purpose,slf,compliance` URL param pre-expands
// the relevant sections so Chrome headless can capture state without
// scripted interaction.
function useExpandFlag(name: string): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams(window.location.search);
    const expand = (p.get('expand') || '').split(',').map((s) => s.trim());
    if (expand.includes(name)) setOn(true);
  }, [name]);
  return on;
}

function PurposeBlock({ json }: { json: MinimalReportJson }) {
  const initialOpen = useExpandFlag('purpose');
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (initialOpen) setExpanded(true);
  }, [initialOpen]);
  const purpose = (json.agentPurpose || '').trim();
  if (!purpose) return null;
  // Elevator pitch = first 1-2 sentences (cap ~180 chars at sentence boundary).
  const pitch = useMemo(() => firstSentences(purpose, 180), [purpose]);
  return (
    <section
      style={{
        margin: '0 0 18px',
        padding: '18px 22px',
        background: '#ffffff',
        border: '1px solid #e5e7eb',
        borderRadius: 10,
      }}
      aria-label="What it does"
    >
      <div
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: '#71717a',
          marginBottom: 8,
        }}
      >
        What it does
      </div>
      <p style={{ fontSize: 15, lineHeight: 1.55, color: '#18181b', margin: 0 }}>
        {expanded ? purpose : pitch}
      </p>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          marginTop: 10,
          background: 'transparent',
          border: 'none',
          padding: 0,
          fontSize: 12.5,
          fontWeight: 600,
          color: '#1d4ed8',
          cursor: 'pointer',
        }}
      >
        {expanded ? 'Hide details' : 'Details ▸'}
      </button>
      {expanded && (
        <dl
          style={{
            marginTop: 14,
            display: 'grid',
            gridTemplateColumns: 'max-content 1fr',
            gap: '6px 16px',
            fontSize: 13,
            color: '#3f3f46',
          }}
        >
          {json.agentTrigger && (
            <>
              <dt style={{ color: '#71717a', fontWeight: 500 }}>Trigger</dt>
              <dd style={{ margin: 0 }}>{json.agentTrigger}</dd>
            </>
          )}
          {json.agentOwner && (
            <>
              <dt style={{ color: '#71717a', fontWeight: 500 }}>Owner</dt>
              <dd style={{ margin: 0 }}>{json.agentOwner}</dd>
            </>
          )}
          {json.summary && (
            <>
              <dt style={{ color: '#71717a', fontWeight: 500 }}>Summary</dt>
              <dd style={{ margin: 0 }}>{json.summary}</dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}

function firstSentences(text: string, max: number): string {
  if (text.length <= max) return text;
  const window = text.slice(0, max);
  const sentenceEnd = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
  );
  if (sentenceEnd > max * 0.5) return text.slice(0, sentenceEnd + 1);
  const ws = window.lastIndexOf(' ');
  return text.slice(0, ws > 0 ? ws : max) + '…';
}

// ─── Block 3: Systems & access ────────────────────────────────────────

function SystemsBlock({
  systems,
  verdict,
}: {
  systems: SystemAssessment[];
  verdict?: VerdictSnapshot;
}) {
  if (!systems || systems.length === 0) return null;
  return (
    <section
      style={{
        margin: '0 0 18px',
        padding: '18px 22px',
        background: '#ffffff',
        border: '1px solid #e5e7eb',
        borderRadius: 10,
      }}
      aria-label="Systems & access"
    >
      <div
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: '#71717a',
          marginBottom: 10,
        }}
      >
        Systems &amp; access ({systems.length})
      </div>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 13,
        }}
      >
        <thead>
          <tr style={{ textAlign: 'left', color: '#71717a', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            <th style={{ padding: '8px 8px 8px 0', borderBottom: '1px solid #e5e7eb', fontWeight: 500 }}>System</th>
            <th style={{ padding: '8px 8px', borderBottom: '1px solid #e5e7eb', fontWeight: 500 }}>Access</th>
            <th style={{ padding: '8px 8px', borderBottom: '1px solid #e5e7eb', fontWeight: 500 }}>Sensitivity</th>
            <th style={{ padding: '8px 8px', borderBottom: '1px solid #e5e7eb', fontWeight: 500 }}>Writes</th>
            <th style={{ padding: '8px 0 8px 8px', borderBottom: '1px solid #e5e7eb', fontWeight: 500, textAlign: 'center' }}>Verified?</th>
          </tr>
        </thead>
        <tbody>
          {systems.map((s, i) => (
            <SystemRow key={s.systemId + '-' + i} system={s} verdict={verdict} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function SystemRow({
  system,
  verdict,
}: {
  system: SystemAssessment;
  verdict?: VerdictSnapshot;
}) {
  const [open, setOpen] = useState(false);
  const access = classifyAccess(system);
  const ds = classifyDS(system.dataSensitivity || '');
  const irreversible = hasIrreversibleWrites(system);
  const findingsCount = findingsTouchingSystem(system.systemId, verdict);
  const verifiedGlyph = findingsCount > 0 ? '⚠' : '✓';
  const verifiedColor = findingsCount > 0 ? '#c2410c' : '#15803d';
  const verifiedTitle = findingsCount > 0
    ? `${findingsCount} verified finding(s) touch this system`
    : 'No verified discrepancies for this system';

  return (
    <>
      <tr
        onClick={() => setOpen((v) => !v)}
        style={{ cursor: 'pointer', background: open ? '#f8fafc' : 'transparent' }}
      >
        <td style={{ padding: '10px 8px 10px 0', borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle' }}>
          <span style={{ marginRight: 6, color: '#a1a1aa', fontSize: 11 }}>{open ? '▼' : '▸'}</span>
          <span
            className="mono"
            style={{ fontSize: 13, fontWeight: 500, color: '#18181b' }}
          >
            {system.systemId}
          </span>
        </td>
        <td style={{ padding: '10px 8px', borderBottom: '1px solid #f1f5f9' }}>
          <AccessBadge tier={access} />
        </td>
        <td style={{ padding: '10px 8px', borderBottom: '1px solid #f1f5f9' }}>
          <SensitivityBadge label={ds.label} tier={ds.tier} />
        </td>
        <td style={{ padding: '10px 8px', borderBottom: '1px solid #f1f5f9', fontSize: 12, color: '#3f3f46' }}>
          {system.writeOperations.length === 0 ? (
            <span style={{ color: '#a1a1aa' }}>—</span>
          ) : (
            <>
              {system.writeOperations.length}{' '}
              {irreversible && (
                <span
                  title="Has irreversible write operations"
                  style={{
                    marginLeft: 6,
                    display: 'inline-block',
                    padding: '1px 6px',
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    color: '#991b1b',
                    fontSize: 10,
                    fontWeight: 600,
                    borderRadius: 3,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  irreversible
                </span>
              )}
            </>
          )}
        </td>
        <td style={{ padding: '10px 0 10px 8px', borderBottom: '1px solid #f1f5f9', textAlign: 'center' }}>
          <span
            title={verifiedTitle}
            style={{
              color: verifiedColor,
              fontSize: 16,
              fontWeight: 600,
            }}
          >
            {verifiedGlyph}
          </span>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ padding: '0 8px 14px 24px', background: '#f8fafc', borderBottom: '1px solid #f1f5f9' }}>
            <SystemDetail system={system} />
          </td>
        </tr>
      )}
    </>
  );
}

function AccessBadge({ tier }: { tier: 'read' | 'write' | 'admin' }) {
  const color =
    tier === 'admin'
      ? { bg: '#fef2f2', bd: '#fecaca', ink: '#991b1b' }
      : tier === 'write'
        ? { bg: '#fff4ed', bd: '#fed7aa', ink: '#c2410c' }
        : { bg: '#f0fdf4', bd: '#bbf7d0', ink: '#15803d' };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        background: color.bg,
        border: `1px solid ${color.bd}`,
        color: color.ink,
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}
    >
      {tier}
    </span>
  );
}

function SensitivityBadge({ label, tier }: { label: string; tier: 'T1' | 'T2' | 'T3' }) {
  const color =
    tier === 'T3'
      ? { bg: '#fef2f2', bd: '#fecaca', ink: '#991b1b' }
      : tier === 'T2'
        ? { bg: '#fef9c3', bd: '#fde68a', ink: '#92400e' }
        : { bg: '#f4f4f5', bd: '#e4e4e7', ink: '#3f3f46' };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        background: color.bg,
        border: `1px solid ${color.bd}`,
        color: color.ink,
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {label}
    </span>
  );
}

function SystemDetail({ system }: { system: SystemAssessment }) {
  return (
    <div style={{ padding: '12px 14px', fontSize: 12.5, color: '#3f3f46' }}>
      {system.systemDescription && (
        <p style={{ margin: '0 0 10px', lineHeight: 1.6 }}>{system.systemDescription}</p>
      )}
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr',
          gap: '4px 14px',
        }}
      >
        {system.scopesRequested.length > 0 && (
          <>
            <dt style={{ color: '#71717a', fontWeight: 500 }}>Scopes requested</dt>
            <dd className="mono" style={{ margin: 0, fontSize: 11.5, wordBreak: 'break-all' }}>
              {system.scopesRequested.join(' · ')}
            </dd>
          </>
        )}
        {system.scopesDelta.length > 0 && (
          <>
            <dt style={{ color: '#71717a', fontWeight: 500 }}>Excessive scope</dt>
            <dd className="mono" style={{ margin: 0, fontSize: 11.5, color: '#c2410c', wordBreak: 'break-all' }}>
              {system.scopesDelta.join(' · ')}
            </dd>
          </>
        )}
        <dt style={{ color: '#71717a', fontWeight: 500 }}>Data sensitivity</dt>
        <dd style={{ margin: 0 }}>{system.dataSensitivity || '—'}</dd>
        <dt style={{ color: '#71717a', fontWeight: 500 }}>Blast radius</dt>
        <dd style={{ margin: 0 }}>{system.blastRadius || '—'}</dd>
      </dl>
      {system.writeOperations.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: '#71717a',
              fontWeight: 600,
              marginBottom: 4,
            }}
          >
            Write operations
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
            {system.writeOperations.map((w, i) => (
              <li key={i} style={{ marginBottom: 2 }}>
                {w.operation} → {w.target}
                {!w.reversible && (
                  <span style={{ color: '#991b1b', fontWeight: 600 }}> (irreversible)</span>
                )}
                {w.approvalRequired && (
                  <span style={{ color: '#1d4ed8', fontWeight: 600 }}> (approval required)</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Block 4: Findings ────────────────────────────────────────────────

function FindingsBlock({ verdict }: { verdict?: VerdictSnapshot }) {
  const initialOpen = useExpandFlag('slf');
  const [slfOpen, setSlfOpen] = useState(false);
  useEffect(() => {
    if (initialOpen) setSlfOpen(true);
  }, [initialOpen]);
  if (!verdict || !verdict.findings || verdict.findings.length === 0) {
    return (
      <section
        style={{
          margin: '0 0 18px',
          padding: '18px 22px',
          background: '#ffffff',
          border: '1px solid #e5e7eb',
          borderRadius: 10,
        }}
      >
        <div
          style={{
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: '#71717a',
            marginBottom: 8,
          }}
        >
          Findings
        </div>
        <p style={{ fontSize: 13, color: '#71717a', margin: 0 }}>No findings.</p>
      </section>
    );
  }

  const coded = assignFindingCodes(verdict.findings as unknown as CodedVerdictFinding[]);
  const verified = coded
    .filter((f) => f.evidenceSource !== 'SLF')
    .slice()
    .sort((a, b) => b.severityScore - a.severityScore);
  const selfAttested = coded
    .filter((f) => f.evidenceSource === 'SLF')
    .slice()
    .sort((a, b) => b.severityScore - a.severityScore);

  return (
    <section
      style={{
        margin: '0 0 18px',
        padding: '18px 22px',
        background: '#ffffff',
        border: '1px solid #e5e7eb',
        borderRadius: 10,
      }}
      aria-label="Findings"
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <div
          style={{
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: '#71717a',
          }}
        >
          Findings
        </div>
        <div style={{ fontSize: 12, color: '#71717a' }}>
          {verified.length} verified · {selfAttested.length} self-attested
        </div>
      </div>

      {/* Verified subsection — expanded */}
      <div>
        <h3 style={{ margin: '4px 0 4px', fontSize: 14, fontWeight: 600, color: '#18181b' }}>
          Verified discrepancies
        </h3>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: '#71717a', lineHeight: 1.55 }}>
          Deterministic evidence (MCP inventory, OAuth scopes, .env, plugins/skills). These drive
          the posture indicator.
        </p>
        {verified.length === 0 ? (
          <p style={{ fontSize: 12.5, color: '#71717a', margin: 0, padding: '10px 12px', background: '#f8fafc', borderRadius: 6, border: '1px dashed #e5e7eb' }}>
            No verified discrepancies — either the discovery scan has not run yet, or it ran clean.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {verified.map((f) => (
              <MinimalFindingCard key={f.code} finding={f} />
            ))}
          </div>
        )}
      </div>

      {/* Self-attested — collapsed by default */}
      {selfAttested.length > 0 && (
        <div style={{ marginTop: 18, borderTop: '1px dashed #e5e7eb', paddingTop: 14 }}>
          <button
            type="button"
            onClick={() => setSlfOpen((v) => !v)}
            style={{
              display: 'flex',
              width: '100%',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontSize: 13.5,
              color: '#18181b',
              fontWeight: 600,
              textAlign: 'left',
            }}
          >
            <span>
              <span style={{ marginRight: 8, color: '#a1a1aa' }}>{slfOpen ? '▼' : '▸'}</span>
              {slfOpen
                ? `Self-attested findings (${selfAttested.length})`
                : `${selfAttested.length} self-attested finding${selfAttested.length === 1 ? '' : 's'} — click to expand`}
            </span>
            {!slfOpen && (
              <span style={{ fontSize: 11, color: '#71717a', fontWeight: 500 }}>
                interview only · do not move posture
              </span>
            )}
          </button>
          {slfOpen && (
            <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ margin: 0, fontSize: 12, color: '#71717a', lineHeight: 1.55 }}>
                Derived from the agent&apos;s interview answers only. Working hypotheses — confirm
                with deterministic evidence before relying on them.
              </p>
              {selfAttested.map((f) => (
                <MinimalFindingCard key={f.code} finding={f} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Inline finding card — minimal version (one component, used for both buckets) ───

function MinimalFindingCard({ finding }: { finding: CodedVerdictFinding }) {
  const sevColor = colorForSeverity(finding.severityScore);
  const sevText = formatSeverityNumber(finding.severityScore);
  const bandLabel = SEVERITY_BAND_LABEL[finding.band as ReportSeverityBand];

  const formula = renderSeverityFormula({
    severity: finding.severityScore,
    br: finding.severityComponents.br,
    ds: finding.severityComponents.ds,
    dm: finding.severityComponents.dm,
    ...(finding.severityComponents.brW !== undefined && { brW: finding.severityComponents.brW }),
    ...(finding.severityComponents.brR !== undefined && { brR: finding.severityComponents.brR }),
    ...(finding.severityComponents.brA !== undefined && { brA: finding.severityComponents.brA }),
  });

  const fallbackHint = getMitigationHint({ evidenceSource: finding.evidenceSource });
  const analyzerNotes = (finding as { analyzerNotes?: string }).analyzerNotes;
  const mitigation = analyzerNotes && analyzerNotes.length > 0 ? analyzerNotes : fallbackHint;

  const [descExpanded, setDescExpanded] = useState(false);
  const { head, rest } = useMemo(() => splitForCard(finding.description, 280), [finding.description]);
  const hasMore = rest.length > 0;

  const mitigationItems = mitigation.includes('; ')
    ? mitigation
        .split(/;\s+/)
        .map((s) => s.replace(/\.$/, '').trim())
        .filter((s) => s.length > 0)
    : null;

  return (
    <article
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        background: '#ffffff',
        padding: '14px 16px',
      }}
    >
      <header style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 6 }}>
        <span
          className="mono"
          style={{
            display: 'inline-block',
            padding: '3px 9px',
            background: '#f1f5f9',
            color: '#3f3f46',
            border: '1px solid #e2e8f0',
            borderRadius: 4,
            fontSize: 11.5,
            letterSpacing: '0.02em',
            minWidth: 76,
            textAlign: 'center',
            flex: '0 0 auto',
          }}
        >
          {finding.code}
        </span>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#18181b', lineHeight: 1.4 }}>
            {finding.title}
          </div>
        </div>
        <span
          title={formula}
          style={{
            display: 'inline-block',
            padding: '3px 9px',
            borderRadius: 4,
            background: sevColor,
            color: '#ffffff',
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            whiteSpace: 'nowrap',
            cursor: 'help',
            flex: '0 0 auto',
          }}
        >
          {sevText} {bandLabel}
        </span>
      </header>
      {finding.description && (
        <p style={{ margin: '4px 0 8px', fontSize: 12.5, lineHeight: 1.55, color: '#3f3f46' }}>
          {descExpanded ? finding.description : head}
          {hasMore && (
            <>
              {' '}
              <button
                type="button"
                onClick={() => setDescExpanded((v) => !v)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  color: '#1d4ed8',
                  fontSize: 12,
                  fontWeight: 600,
                  textDecoration: 'underline',
                }}
              >
                {descExpanded ? 'Show less' : 'Show more'}
              </button>
            </>
          )}
        </p>
      )}
      <div
        style={{
          marginTop: 6,
          padding: '8px 10px',
          background: '#f0fdf4',
          border: '1px solid #bbf7d0',
          borderRadius: 5,
        }}
      >
        <div
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            color: '#15803d',
            marginBottom: 3,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          Mitigation
        </div>
        {mitigationItems && mitigationItems.length > 1 ? (
          <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.5, color: '#14532d' }}>
            {mitigationItems.map((it, i) => (
              <li key={i}>{it}</li>
            ))}
          </ul>
        ) : (
          <div style={{ fontSize: 12, lineHeight: 1.5, color: '#14532d' }}>{mitigation}</div>
        )}
      </div>
    </article>
  );
}

function splitForCard(text: string, limit: number): { head: string; rest: string } {
  if (!text || text.length <= limit) return { head: text || '', rest: '' };
  const window = text.slice(0, limit);
  const sentenceEnd = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
  let cut = limit;
  if (sentenceEnd > limit * 0.6) cut = sentenceEnd + 1;
  else {
    const ws = window.lastIndexOf(' ');
    if (ws > limit * 0.6) cut = ws;
  }
  return { head: text.slice(0, cut).trimEnd() + '…', rest: text.slice(cut).trimStart() };
}

// ─── Block 5: Compliance lens ─────────────────────────────────────────

const FRAMEWORK_LABELS: Record<string, string> = {
  'eu-ai-act': 'EU AI Act',
  gdpr: 'GDPR',
  'iso-42001': 'ISO/IEC 42001',
  'aiuc-1': 'AIUC-1',
  'nist-ai-rmf': 'NIST AI RMF',
};

function ComplianceBlock({
  rc,
}: {
  rc: MinimalReportJson['regulatoryCompliance'] | undefined;
}) {
  const initialOpen = useExpandFlag('compliance');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (initialOpen) setOpen(true);
  }, [initialOpen]);
  if (!rc) return null;
  const frameworks = (rc.frameworksActivated || []) as string[];
  const controlResults = rc.controlResults || [];
  const partials = controlResults.filter((c) => c.verdict === 'partial').length;
  const fails = controlResults.filter(
    (c) => c.verdict === 'fail' && (c.severity === 'critical' || c.severity === 'high'),
  ).length;
  // The "all" array of flags is the prose engine's signal count.
  const flagsCount = (rc.all || []).length;

  return (
    <section
      style={{
        margin: '0 0 18px',
        padding: '18px 22px',
        background: '#ffffff',
        border: '1px solid #e5e7eb',
        borderRadius: 10,
      }}
      aria-label="Compliance lens"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          width: '100%',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span>
          <span
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: '#71717a',
              fontWeight: 600,
              marginRight: 10,
            }}
          >
            Compliance lens
          </span>
          <span style={{ fontSize: 13, color: '#18181b' }}>
            {frameworks.length} frameworks activated
            {controlResults.length > 0 && (
              <>
                {' · '}
                {partials} controls partial
                {' · '}
                {fails} critical fails
              </>
            )}
            {flagsCount > 0 && controlResults.length === 0 && (
              <>
                {' · '}
                {flagsCount} signals from prose engine
              </>
            )}
          </span>
        </span>
        <span style={{ fontSize: 12, color: '#1d4ed8', fontWeight: 600 }}>
          {open ? 'Hide ▾' : 'Detail ▸'}
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #e5e7eb' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 12,
            }}
          >
            {frameworks.map((fwId) => {
              const fwResults = controlResults.filter((c) => c.frameworkId === fwId);
              const fwPartial = fwResults.filter((r) => r.verdict === 'partial').length;
              const fwVerified = fwResults.filter((r) => r.verdict === 'verified').length;
              const fwFail = fwResults.filter((r) => r.verdict === 'fail').length;
              const fwSignals = (rc.all || []).filter((f) => f.frameworkId === fwId).length;
              return (
                <div
                  key={fwId}
                  style={{
                    border: '1px solid #e5e7eb',
                    borderRadius: 6,
                    padding: '10px 12px',
                    background: '#fafafa',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#18181b', marginBottom: 4 }}>
                    {FRAMEWORK_LABELS[fwId] || fwId}
                  </div>
                  <div style={{ fontSize: 11.5, color: '#52525b', lineHeight: 1.6 }}>
                    {fwResults.length > 0 ? (
                      <>
                        {fwVerified} verified · {fwPartial} partial · {fwFail} fail
                      </>
                    ) : (
                      <>{fwSignals} signals (prose only)</>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <p style={{ marginTop: 14, fontSize: 11.5, color: '#71717a', lineHeight: 1.6 }}>
            Verified = deterministic evidence matches the agent's declaration. Partial = signal
            present but no typed detector. Self-attested controls and out-of-scope items are not
            counted here.
          </p>
        </div>
      )}
    </section>
  );
}

// ─── Footer ───────────────────────────────────────────────────────────

function FooterLinks({ onSwitch }: { onSwitch?: () => void }) {
  const linkStyle: React.CSSProperties = {
    color: '#71717a',
    fontSize: 11.5,
    textDecoration: 'none',
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    padding: 0,
  };
  return (
    <footer
      style={{
        marginTop: 22,
        padding: '14px 0 8px',
        borderTop: '1px solid #e5e7eb',
        display: 'flex',
        gap: 18,
        flexWrap: 'wrap',
        fontSize: 11.5,
        color: '#71717a',
      }}
    >
      <span>References:</span>
      {onSwitch && (
        <button type="button" onClick={onSwitch} style={linkStyle}>
          Switch to full layout ↗
        </button>
      )}
      <span style={linkStyle}>Transcript ↗</span>
      <span style={linkStyle}>Local Discovery ↗</span>
      <span style={linkStyle}>Methodology / Limitations ↗</span>
    </footer>
  );
}

// ─── Top-level component ──────────────────────────────────────────────

export interface MinimalReportViewProps {
  reportJson: MinimalReportJson | undefined;
  /**
   * The transcript entries from the audit session. We use the first
   * `purpose`-category answer to extract the project name (Q1).
   */
  transcript?: TranscriptEntry[];
  /**
   * Runtime agent name (often "Codex desktop agent in /path/..." — used
   * only as fallback when project name can't be extracted from Q1.
   */
  runtimeAgentName?: string;
  /** Provided so the footer can offer a "back to full layout" link. */
  onSwitchToFullLayout?: () => void;
}

export default function MinimalReportView({
  reportJson,
  transcript,
  runtimeAgentName,
  onSwitchToFullLayout,
}: MinimalReportViewProps) {
  if (!reportJson) {
    return (
      <div className="report" style={{ padding: 24 }}>
        <p>No report data yet.</p>
      </div>
    );
  }
  const { name: projectName, isFallback } = extractProjectName(transcript, runtimeAgentName);
  return (
    <div className="report" style={{ paddingTop: 16 }}>
      <HeaderBlock
        projectName={projectName}
        isFallback={isFallback}
        verdict={reportJson.verdict}
        verification={reportJson.verification}
        metadata={reportJson.metadata}
      />
      <PurposeBlock json={reportJson} />
      <SystemsBlock systems={reportJson.systems || []} verdict={reportJson.verdict} />
      <FindingsBlock verdict={reportJson.verdict} />
      <ComplianceBlock rc={reportJson.regulatoryCompliance} />
      <FooterLinks onSwitch={onSwitchToFullLayout} />
    </div>
  );
}
