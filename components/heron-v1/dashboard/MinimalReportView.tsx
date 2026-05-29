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

import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';

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
import { getMitigationHint, getSlfMitigationHint } from '@/src/report/mitigation-catalog';
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
      // AAP-105 A7: why a control is partial/fail and what evidence drove it.
      // Persisted in report.json; surfaced inline in the expanded framework
      // accordion so a reviewer can read the reasoning, not just the verdict.
      rationale?: string;
      evidenceRefs?: Array<{ kind?: string; ref?: string }>;
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
  // AAP-105 A5: L6 OAuth scope-verification results. Present (with a
  // non-empty `sources`) only when an OAuth introspection actually ran.
  // The header's "Verified by" line reads this to decide whether to show
  // "OAuth" vs "OAuth N/A" — derived from real evidence, not the
  // aggregate verification.status. Mirrors `OAuthScopeVerificationSection`
  // in lib/report-json.ts.
  oauthScopeVerification?: {
    capturedAt?: string;
    sources?: Array<{ connector?: string; verdict?: string }>;
  };
}

// ─── Project name extraction ──────────────────────────────────────────
//
// AAP-105 C1: the runtime "Codex desktop agent in /path" name is
// uninformative — every Codex audit ends up with the same header. We
// extract the project name from two sources, in order of reliability:
//
//   1. `agentPurpose` (LLM-distilled summary on report.json) — the
//      analyzer already picked the canonical pipeline / product name
//      from Q1 + Q26-Q28 answers. It's the highest-signal field, and
//      the noun phrase before the first comma / "for" / "that" is
//      almost always the right answer.
//   2. Q1 transcript answer — structured "1. Project/product name: <X>"
//      block. The Codex desktop probe stuffs runtime metadata into the
//      first line ("Codex desktop GPT-5 coding agent operating in
//      workspace …, whose repository is `mvp-edu-content-agent`"), so
//      we also look for a backticked repo identifier as a secondary
//      signal and humanize it (`mvp-edu-content-agent` → "MVP Edu
//      Content Agent"). The "1. … name: …" lookup remains the last
//      structured fallback.
//   3. Runtime metadata (fallback only) — surfaces a `fallback name`
//      badge so it's visually obvious extraction failed.

interface TranscriptEntry {
  category?: string;
  question?: string;
  answer?: string;
}

const NAME_NOISE_PHRASES = [
  /codex desktop( gpt-?5)?( coding)? agent/i,
  /coding agent/i,
  /local workspace/i,
  /the agent/i,
];

function isUsefulName(name: string): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length < 3 || trimmed.length > 80) return false;
  for (const noise of NAME_NOISE_PHRASES) {
    if (noise.test(trimmed)) return false;
  }
  return true;
}

/**
 * AAP-105 C2: derive a short human-readable system name from the
 * analyzer's kebab-case `systemId`.
 *
 *   "google-sheets-api"      → "Google Sheets"
 *   "openai-codex-runtime"   → "OpenAI Codex"
 *   "telegram-bot-api"       → "Telegram"
 *   "gemini-api"             → "Gemini"
 *   "wellkid-api"            → "Wellkid"
 *
 * Strips trailing noise suffixes (`-api`, `-rest`, `-v1`, `-prod`,
 * `-runtime`, etc.). Caps at the first 3 meaningful tokens so the
 * label fits the System column.
 */
function humanizeSystemId(systemId: string): string {
  if (!systemId) return 'Unknown';
  const id = systemId.trim().toLowerCase();
  // If it's already a sentence (analyzer leaked prose), give up gracefully:
  // collapse whitespace and cap at 40 chars.
  if (/\s/.test(systemId) || systemId.length > 50) {
    const collapsed = systemId.replace(/\s+/g, ' ').trim();
    return collapsed.length <= 40 ? collapsed : collapsed.slice(0, 40).trim() + '…';
  }
  // Tokenize, drop trailing noise tokens.
  let tokens = id.split(/[-_]/).filter((t) => t.length > 0);
  const NOISE = new Set([
    'api', 'rest', 'graphql', 'grpc', 'rpc',
    'v1', 'v2', 'v3', 'v4', 'v5',
    'prod', 'production', 'dev', 'staging',
    'runtime', 'service', 'endpoint', 'backend',
  ]);
  // Strip noise from the END only (keep "openai" in "openai-codex-runtime").
  while (tokens.length > 1 && NOISE.has(tokens[tokens.length - 1]!)) {
    tokens = tokens.slice(0, -1);
  }
  // Cap at the first 3 tokens for column-fit.
  tokens = tokens.slice(0, 3);
  // Title-case with brand-aware overrides.
  const BRANDS: Record<string, string> = {
    google: 'Google',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    gemini: 'Gemini',
    gamma: 'Gamma',
    telegram: 'Telegram',
    slack: 'Slack',
    github: 'GitHub',
    gitlab: 'GitLab',
    aws: 'AWS',
    gcp: 'GCP',
    azure: 'Azure',
    notion: 'Notion',
    airtable: 'Airtable',
    salesforce: 'Salesforce',
    hubspot: 'HubSpot',
    sheets: 'Sheets',
    docs: 'Docs',
    drive: 'Drive',
    gmail: 'Gmail',
    calendar: 'Calendar',
    bot: 'Bot',
    codex: 'Codex',
    wellkid: 'Wellkid',
  };
  return tokens
    .map((t) => BRANDS[t] ?? (t.charAt(0).toUpperCase() + t.slice(1)))
    .join(' ');
}

function humanizeKebab(s: string): string {
  return s
    .split(/[-_]/)
    .filter((p) => p.length > 0)
    .map((p) => {
      // Keep common short uppercase tokens as-is (MVP, API, AI, OCR, etc.).
      if (/^[a-z]{2,4}$/.test(p) && /^(mvp|api|ai|ml|llm|ui|ux|sdk|crm|cms|cli|aws|gcp|qa)$/i.test(p)) {
        return p.toUpperCase();
      }
      // Title-case other words; map known abbreviations.
      if (p.toLowerCase() === 'edu') return 'Educational';
      return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
    })
    .join(' ');
}

/**
 * Extract a project name from `agentPurpose` prose. Looks for the
 * standout noun phrase the LLM almost always emits: the lead clause
 * describing the pipeline / agent / product.
 *
 * Heuristics, in order:
 *   - "<X> pipeline" / "<X> system" / "<X> agent" / "<X> service" / "<X> platform"
 *   - first noun phrase up to ~6 capitalized-or-lowercase words before
 *     a verb / preposition. We bias toward including descriptors like
 *     "MVP educational content".
 */
function extractFromAgentPurpose(purpose: string): string | null {
  if (!purpose) return null;
  const text = purpose.trim();

  // Pattern A: "<a|an|the> <X> <noun>" where noun ∈ pipeline / system /
  // platform / service / agent / orchestrator / workflow / app.
  //
  // The key constraint: we anchor on a leading article ("an MVP …
  // pipeline"), which forces the regex to pick the OUTERMOST noun
  // phrase rather than a sub-phrase like "Russian educational
  // lessons". `[\s\S]+?` is non-greedy so the article-to-noun span
  // stays minimal, but article-anchoring guarantees we cover the
  // full descriptor up to the head noun.
  const articlePattern = /\b(?:a|an|the)\s+([A-Za-z][\w-]*(?:\s+(?!for\b|that\b|which\b|to\b|in\b|on\b|and\b)[\w-]+){0,7})\s+(pipeline|system|platform|service|orchestrator|workflow|app|backend|product|application)\b/i;
  const m1 = text.match(articlePattern);
  if (m1 && m1[1]) {
    const titled = titleCasePhrase(`${m1[1]} ${m1[2]}`);
    if (isUsefulName(titled)) return titled;
  }

  // Pattern B: agent-specific — "the X agent" but only when X is at
  // least 2 tokens. Avoid matching "the agent edits" (Pattern A's
  // negative lookahead already blocks single-token verbs but this
  // adds a safety net for the bare phrase).
  const agentPattern = /\b(?:a|an|the)\s+([A-Z][\w-]+(?:\s+[\w-]+){1,5})\s+agent\b/;
  const m2 = text.match(agentPattern);
  if (m2 && m2[1]) {
    const titled = titleCasePhrase(`${m2[1]} agent`);
    if (isUsefulName(titled)) return titled;
  }

  // Pattern C: "for <X>" lead-in for short prose lacking the article
  // anchor. Last-resort heuristic.
  const forMatch = text.match(/\bfor\s+(?:a|an|the)\s+([A-Z][A-Za-z0-9 -]{4,60})\b/);
  if (forMatch && forMatch[1] && isUsefulName(forMatch[1])) {
    return titleCasePhrase(forMatch[1].trim());
  }

  return null;
}

function titleCasePhrase(s: string): string {
  const stopwords = new Set([
    'a', 'an', 'and', 'or', 'of', 'for', 'in', 'on', 'the', 'to', 'with', 'by',
  ]);
  return s
    .split(/\s+/)
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (i > 0 && stopwords.has(lower)) return lower;
      // Preserve internal capitalization (MVP, GPT-5, API, etc.) if already
      // present, otherwise title-case.
      if (/^[A-Z]{2,}$/.test(w)) return w;
      if (/^[A-Z][a-z0-9]+$/.test(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ')
    .trim();
}

function extractProjectName(
  transcript: TranscriptEntry[] | undefined,
  fallback: string | undefined,
  agentPurpose: string | undefined,
): { name: string; isFallback: boolean } {
  // Source #1: agentPurpose (LLM-distilled, highest signal).
  if (agentPurpose) {
    const fromPurpose = extractFromAgentPurpose(agentPurpose);
    if (fromPurpose && isUsefulName(fromPurpose)) {
      return { name: fromPurpose, isFallback: false };
    }
  }

  // Source #2: Q1 transcript answer ("1. Project/product name: ...").
  if (transcript && transcript.length > 0) {
    const candidates = transcript
      .slice(0, 3)
      .filter((t) => (t.category || '').toLowerCase() === 'purpose');

    for (const c of candidates) {
      const a = (c.answer || '').trim();
      if (!a) continue;

      // Sub-pattern 2a: backticked repo identifier (Codex desktop probe pattern).
      // "whose repository is `mvp-edu-content-agent`" → "MVP Edu Content Agent"
      const repoMatch = a.match(/repositor(?:y|ies)\s+(?:is|are|named|called)\s+`([a-z0-9_-]{3,60})`/i);
      if (repoMatch && repoMatch[1]) {
        const humanized = humanizeKebab(repoMatch[1]);
        if (isUsefulName(humanized)) {
          return { name: humanized, isFallback: false };
        }
      }

      // Sub-pattern 2b: structured "1. Project/product name: <X>" header.
      const m1 = a.match(/(?:project\/product name|project name|product name)\s*[:\-]\s*([^\n.]+)/i);
      if (m1 && m1[1]) {
        let name = m1[1].trim().replace(/[`*]/g, '');
        // Strip trailing "operating in workspace …" / "running in the local …".
        name = name.split(/\s+(?:operating|running|deployed|hosted|located)\s+in\b/i)[0]!.trim();
        // "Codex3 workspace for MVP Edu Content Agent (mvp-edu-content-agent)"
        const forMatch = name.match(/for\s+([A-Z][^()]+?)(?:\s*\(|\s*,|\s*\.|$)/);
        if (forMatch && forMatch[1]) {
          name = forMatch[1].trim();
        } else {
          name = name.split(/[,;]/)[0]!.trim().split('(')[0]!.trim();
        }
        name = name.replace(/[.,;]+$/, '').trim();
        if (isUsefulName(name)) {
          return { name, isFallback: false };
        }
      }
    }
  }

  // Source #3: runtime metadata (last resort).
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
  metadata,
  localAgentDiscovery,
  oauthScopeVerification,
}: {
  projectName: string;
  isFallback: boolean;
  verdict?: VerdictSnapshot;
  metadata?: MinimalReportJson['metadata'];
  localAgentDiscovery?: unknown;
  oauthScopeVerification?: MinimalReportJson['oauthScopeVerification'];
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

  // AAP-105 A5: "Verified by X" must reflect which evidence sources
  // ACTUALLY ran, not the aggregate verification.status. The old code
  // showed "Filesystem" whenever status was verified / partially-verified
  // — but an OAuth-only verification (skipFilesystem with OAuth sources)
  // also lands those statuses, so it falsely claimed a filesystem scan it
  // never ran. We derive each source from the real evidence on the report:
  //
  //   - Filesystem ran  ⇐  localAgentDiscovery carries scan output
  //     (agents / findings / scannedPaths / workspaceEnv). The persisted
  //     `verification` object has no explicit "filesystem ran" flag, so
  //     localAgentDiscovery presence is the best available proxy — its
  //     existence means runDiscovery's filesystem readers produced a
  //     result for this session.
  //   - OAuth ran       ⇐  oauthScopeVerification.sources is non-empty
  //     (a real introspection result per connector). Absent / empty →
  //     OAuth genuinely wasn't in scope → "OAuth N/A".
  const sourcesLine = (() => {
    const parts: string[] = [];
    const disc =
      localAgentDiscovery && typeof localAgentDiscovery === 'object'
        ? (localAgentDiscovery as {
            agents?: unknown[];
            findings?: unknown[];
            scannedPaths?: unknown[];
            workspaceEnv?: unknown[];
          })
        : null;
    const filesystemRan =
      !!disc &&
      ((disc.agents?.length ?? 0) > 0 ||
        (disc.findings?.length ?? 0) > 0 ||
        (disc.scannedPaths?.length ?? 0) > 0 ||
        (disc.workspaceEnv?.length ?? 0) > 0);
    if (filesystemRan) parts.push('Filesystem');

    const oauthRan = (oauthScopeVerification?.sources?.length ?? 0) > 0;
    parts.push(oauthRan ? 'OAuth' : 'OAuth N/A');

    // Guard the degenerate case (no filesystem, no OAuth) so the line is
    // never empty / misleading.
    if (parts.length === 0) return 'No deterministic sources';
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
  // Fix 2 / Fix 6 / AAP-105 NEW-2: collapsed pitch shows the first 2
  // sentences (or up to ~360 chars at a sentence boundary). G7 iter 2
  // truncated at the first period, which was too curt for the demo
  // session — readers lost the bit explaining what the pipeline
  // actually does. Two sentences gives the reader a useful peek
  // without dumping the full LLM analyzer paragraph.
  const pitch = useMemo(() => firstSentences(purpose, 2, 440), [purpose]);
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

/**
 * Fix 2 / Fix 6 / AAP-105 NEW-2: walk forward through sentence-end
 * markers (". ", "! ", "? ") and return up to `maxSentences` sentences
 * worth of text, capped at `charLimit`. The collapsed body always
 * reads as a complete clause, never mid-word.
 *
 *   - If the first sentence already runs past `charLimit`, we fall
 *     back to a single sentence + char-based truncation with ellipsis.
 *   - If we hit `maxSentences` before `charLimit`, we return that.
 *   - If the text contains fewer than `maxSentences` sentences, we
 *     return what's there.
 *
 * On the demo session this picks up the second sentence ("The
 * pipeline processes Google Sheets rows through Gemini/OpenAI content
 * generation…") which is what readers actually need to understand
 * what the agent does.
 */
function firstSentences(text: string, maxSentences: number, charLimit: number): string {
  const t = text.trim();
  if (!t) return '';
  if (t.length <= charLimit && maxSentences <= 0) return t;

  // Build the list of sentence-end positions in order. A sentence-end
  // is either ". " / "! " / "? " mid-text, or terminal "." / "!" / "?"
  // at end of string (otherwise the LAST sentence — which has no
  // trailing space — never registers as a boundary).
  const ends: number[] = [];
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c !== '.' && c !== '!' && c !== '?') continue;
    const next = i + 1 < t.length ? t[i + 1] : '';
    if (next === ' ' || next === '') {
      ends.push(i + 1); // include the punctuation
    }
  }

  // Walk forward picking up sentences until we have `maxSentences` or
  // would exceed `charLimit`.
  let cut = -1;
  let count = 0;
  for (const e of ends) {
    if (e > charLimit) break;
    cut = e;
    count += 1;
    if (count >= maxSentences) break;
  }

  if (cut > 0) {
    // Found a clean sentence boundary within the limit.
    return t.slice(0, cut).trimEnd();
  }

  // No sentence boundary within the limit — char-based truncation at
  // the last whitespace before `charLimit`.
  if (t.length <= charLimit) return t;
  const window = t.slice(0, charLimit);
  const ws = window.lastIndexOf(' ');
  return t.slice(0, ws > 0 ? ws : charLimit).trimEnd() + '…';
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
  // Screenshot helper — `?expandSystem=<systemId>` pre-expands that row.
  // Used by the headless Chrome capture script. Lives on the client only.
  const preOpen = (() => {
    if (typeof window === 'undefined') return false;
    const p = new URLSearchParams(window.location.search);
    const list = (p.get('expandSystem') || '').split(',').map((s) => s.trim());
    return list.includes(system.systemId);
  })();
  const [open, setOpen] = useState(preOpen);
  const access = classifyAccess(system);
  const ds = classifyDS(system.dataSensitivity || '');
  const irreversible = hasIrreversibleWrites(system);
  const findingsCount = findingsTouchingSystem(system.systemId, verdict);
  const verifiedGlyph = findingsCount > 0 ? '⚠' : '✓';
  const verifiedColor = findingsCount > 0 ? '#c2410c' : '#15803d';
  const verifiedTitle = findingsCount > 0
    ? `${findingsCount} verified finding(s) touch this system`
    : 'No verified discrepancies for this system';

  // AAP-105 C2: surface a short canonical name (e.g. "Google Sheets")
  // as the primary row label, with the raw kebab id shown beneath in
  // muted mono type. Some analyzer outputs still ship long technical
  // prose in `systemId`; if `humanizeSystemId` can't shorten further
  // we fall back to the systemId verbatim.
  const displayName = humanizeSystemId(system.systemId);
  const showRawId = displayName.toLowerCase() !== system.systemId.toLowerCase().replace(/[-_]/g, ' ');

  return (
    <>
      <tr
        onClick={() => setOpen((v) => !v)}
        style={{ cursor: 'pointer', background: open ? '#f8fafc' : 'transparent' }}
      >
        <td style={{ padding: '10px 8px 10px 0', borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle' }}>
          <span style={{ marginRight: 6, color: '#a1a1aa', fontSize: 11 }}>{open ? '▼' : '▸'}</span>
          <span style={{ display: 'inline-flex', flexDirection: 'column', verticalAlign: 'middle' }}>
            <span
              style={{ fontSize: 13, fontWeight: 600, color: '#18181b', lineHeight: 1.2 }}
            >
              {displayName}
            </span>
            {showRawId && (
              <span
                className="mono"
                style={{ fontSize: 10.5, color: '#a1a1aa', lineHeight: 1.2, marginTop: 1 }}
                title={system.systemId}
              >
                {system.systemId}
              </span>
            )}
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

/**
 * Fix 3 / Fix 7: expanded system row.
 *
 * Before: wall of text — long `system` description as the first paragraph,
 * then Property/Value rows for scopes / data sensitivity / blast radius.
 *
 * After:
 *   - Top row of chips: [access] [sensitivity tier] [blast radius]
 *   - Scopes block: chip-style monospace list (requested + excessive)
 *   - Write operations: bulleted list with reversible / approval badges
 *   - "Implementation notes" (the long `system` / `systemDescription` text)
 *     pushed to the bottom, italic, smaller font, labeled
 *
 * The systemId (e.g. "google-sheets") is already used as the row's primary
 * label in SystemRow — the long technical prose is now strictly secondary.
 */
function SystemDetail({ system }: { system: SystemAssessment }) {
  const blastRadius = (system.blastRadius || '').trim();
  const blastTier = classifyBlastRadius(blastRadius);
  const requested = system.scopesRequested || [];
  const excessive = new Set((system.scopesDelta || []).map((s) => s.trim()));

  return (
    <div style={{ padding: '12px 14px', fontSize: 12.5, color: '#3f3f46' }}>
      {/* AAP-105 D3: collapsed row already shows ACCESS + SENSITIVITY in the
          parent table. Surfacing them again as chips at the top of the
          expansion duplicated information. Only Blast Radius is genuinely
          new — render it alone so the chip row carries net-new evidence. */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <ChipLabeled label="Blast radius">
          <BlastRadiusBadge tier={blastTier} />
        </ChipLabeled>
      </div>

      {/* Scopes as chip-style monospace list. Excessive scopes get a red
          ring + tooltip so they don't need a separate Property/Value row. */}
      {requested.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <SectionLabel>Scopes</SectionLabel>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
            {requested.map((s, i) => {
              const isExcess = excessive.has(s.trim());
              return (
                <span
                  key={i}
                  className="mono"
                  title={isExcess ? 'Excessive scope — broader than declared usage' : undefined}
                  style={{
                    fontSize: 11.5,
                    padding: '2px 7px',
                    background: isExcess ? '#fef2f2' : '#f4f4f5',
                    border: `1px solid ${isExcess ? '#fecaca' : '#e4e4e7'}`,
                    color: isExcess ? '#991b1b' : '#3f3f46',
                    borderRadius: 3,
                    wordBreak: 'break-all',
                  }}
                >
                  {s}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Write operations — list with reversible / approval badges (kept). */}
      {system.writeOperations.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <SectionLabel>Write operations</SectionLabel>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 1.6 }}>
            {system.writeOperations.map((w, i) => (
              <li key={i} style={{ marginBottom: 3 }}>
                {w.operation} → {w.target}
                {' '}
                <WriteOpBadge
                  text={w.reversible ? 'reversible' : 'irreversible'}
                  variant={w.reversible ? 'neutral' : 'danger'}
                />
                {w.approvalRequired && (
                  <>
                    {' '}
                    <WriteOpBadge text="approval required" variant="info" />
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Implementation notes — the long technical `system` / description
          prose, demoted to italic secondary text at the bottom. */}
      {(system.systemDescription || system.dataSensitivity || blastRadius) && (
        <div style={{ marginTop: 8, paddingTop: 10, borderTop: '1px dashed #e5e7eb' }}>
          <SectionLabel>Implementation notes</SectionLabel>
          {system.systemDescription && (
            <p style={{ margin: '4px 0 6px', fontSize: 11.5, lineHeight: 1.55, color: '#52525b', fontStyle: 'italic' }}>
              {system.systemDescription}
            </p>
          )}
          {system.dataSensitivity && (
            <p style={{ margin: '4px 0 0', fontSize: 11.5, lineHeight: 1.55, color: '#52525b', fontStyle: 'italic' }}>
              <strong style={{ fontWeight: 600, fontStyle: 'normal', color: '#71717a' }}>Data sensitivity:</strong>{' '}
              {system.dataSensitivity}
            </p>
          )}
          {blastRadius && (
            <p style={{ margin: '4px 0 0', fontSize: 11.5, lineHeight: 1.55, color: '#52525b', fontStyle: 'italic' }}>
              <strong style={{ fontWeight: 600, fontStyle: 'normal', color: '#71717a' }}>Blast radius:</strong>{' '}
              {blastRadius}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: '#71717a',
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}

function ChipLabeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          fontSize: 10.5,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: '#a1a1aa',
          fontWeight: 600,
        }}
      >
        {label}
      </span>
      {children}
    </span>
  );
}

function WriteOpBadge({ text, variant }: { text: string; variant: 'neutral' | 'danger' | 'info' }) {
  const palette =
    variant === 'danger'
      ? { bg: '#fef2f2', bd: '#fecaca', ink: '#991b1b' }
      : variant === 'info'
        ? { bg: '#eff6ff', bd: '#bfdbfe', ink: '#1d4ed8' }
        : { bg: '#f0fdf4', bd: '#bbf7d0', ink: '#15803d' };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0 6px',
        background: palette.bg,
        border: `1px solid ${palette.bd}`,
        color: palette.ink,
        borderRadius: 3,
        fontSize: 10,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        verticalAlign: 'middle',
      }}
    >
      {text}
    </span>
  );
}

/**
 * Blast radius is a normalized enum on the schema (see
 * `blastRadiusLevels` in src/report/types.ts):
 *   single-record < single-user < team-scope < org-wide < cross-tenant
 * We assign a 3-tier palette: cross-tenant/org-wide = danger,
 * team-scope = warn, single-* = safe.
 */
type BlastTier = 'cross-tenant' | 'org-wide' | 'team-scope' | 'single-user' | 'single-record' | 'unknown';

const BLAST_LABELS: Record<BlastTier, string> = {
  'cross-tenant': 'Cross-tenant',
  'org-wide': 'Org-wide',
  'team-scope': 'Team scope',
  'single-user': 'Single user',
  'single-record': 'Single record',
  unknown: 'Unspecified',
};

function classifyBlastRadius(prose: string): BlastTier {
  const p = (prose || '').trim().toLowerCase();
  if (!p) return 'unknown';
  // Direct canonical match from schema.
  const canon: BlastTier[] = ['cross-tenant', 'org-wide', 'team-scope', 'single-user', 'single-record'];
  for (const c of canon) {
    if (p === c) return c;
  }
  // Fuzzy fallback for legacy prose (rare — analyzer normalizes on the way in).
  if (p.includes('cross') && p.includes('tenant')) return 'cross-tenant';
  if (p.includes('org')) return 'org-wide';
  if (p.includes('team')) return 'team-scope';
  if (p.includes('record')) return 'single-record';
  if (p.includes('user') || p.includes('self') || p.includes('single')) return 'single-user';
  return 'unknown';
}

function BlastRadiusBadge({ tier }: { tier: BlastTier }) {
  const danger = tier === 'org-wide' || tier === 'cross-tenant';
  const warn = tier === 'team-scope';
  const palette = danger
    ? { bg: '#fef2f2', bd: '#fecaca', ink: '#991b1b' }
    : warn
      ? { bg: '#fff4ed', bd: '#fed7aa', ink: '#c2410c' }
      : tier === 'unknown'
        ? { bg: '#f4f4f5', bd: '#e4e4e7', ink: '#52525b' }
        : { bg: '#f0fdf4', bd: '#bbf7d0', ink: '#15803d' };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        background: palette.bg,
        border: `1px solid ${palette.bd}`,
        color: palette.ink,
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}
    >
      {BLAST_LABELS[tier]}
    </span>
  );
}

// ─── Block 3.5: Credentials & secrets ─────────────────────────────────
//
// AAP-105 NEW-4: G7 minimal layout cut the entire Local Discovery section,
// which dropped the env-key inventory (`workspaceEnv[].keys` +
// `mcpServers[].redactedEnvKeys` + capability `auth_credential` entries)
// from the report.
//
// The wedge sells on "we found 40+ env keys deterministically — the
// declared scope is a tiny subset". Without the keys visible somewhere
// the minimal layout has no surface for that evidence.
//
// Solution: a compact collapsed block between Systems and Findings that
// summarises key count + a representative chip row, with a Details ▸
// toggle that expands to the full grouped list. Closed by default so
// the layout still reads as minimal.
//
// Redaction invariant: every key is a NAME ONLY (see
// `src/discovery/readers/_shared.ts:redactEnvKeys`). No values, ever.
// The block surfaces a small "names only" affordance to reinforce that
// for the reader.

interface MinimalLocalDiscovery {
  agents?: Array<{
    runtime?: string;
    configPath?: string;
    mcpServers?: Array<{
      name?: string;
      redactedEnvKeys?: string[];
    }>;
    capabilities?: Array<{
      kind?: string;
      provider?: string;
    }>;
  }>;
  workspaceEnv?: Array<{
    path?: string;
    workspace?: string;
    keys?: string[];
  }>;
}

/**
 * Collect every env-key-shaped string from the discovery section and
 * deduplicate. Sources:
 *   - workspaceEnv[].keys   (.env / .env.example readers)
 *   - mcpServers[].redactedEnvKeys (MCP config env passthroughs)
 *   - capabilities[].provider where kind === 'auth_credential' AND the
 *     provider looks like an env-key (UPPER_SNAKE_CASE). Some readers
 *     emit non-env-key provider labels (e.g. "anthropic"), so we filter
 *     to only ALL-CAPS-with-underscores tokens.
 */
function collectEnvKeys(d: MinimalLocalDiscovery): string[] {
  const set = new Set<string>();
  const envKeyShape = /^[A-Z][A-Z0-9_]{2,}$/;
  for (const f of d.workspaceEnv ?? []) {
    for (const k of f.keys ?? []) {
      if (typeof k === 'string' && k.length > 0) set.add(k);
    }
  }
  for (const a of d.agents ?? []) {
    for (const s of a.mcpServers ?? []) {
      for (const k of s.redactedEnvKeys ?? []) {
        if (typeof k === 'string' && k.length > 0) set.add(k);
      }
    }
    for (const c of a.capabilities ?? []) {
      if (c.kind === 'auth_credential' && typeof c.provider === 'string') {
        if (envKeyShape.test(c.provider)) set.add(c.provider);
      }
    }
  }
  return Array.from(set).sort();
}

/**
 * Family grouping — pick a label from a deterministic prefix match
 * against the key's first 1-2 underscore-separated tokens. Falls back
 * to "Other" so unknown providers still surface (count is still
 * accurate).
 *
 * The order here matters: more-specific prefixes come first so e.g.
 * GOOGLE_OAUTH_TOKEN_FILE doesn't get bucketed as plain "Google" when
 * "GOOGLE_OAUTH" would be more precise. For demo readability we keep
 * the buckets coarse (one bucket per provider, not per credential
 * type), so GOOGLE_API_KEY + GOOGLE_OAUTH_TOKEN_FILE both land in
 * "Google".
 */
const FAMILY_PREFIXES: Array<[RegExp, string]> = [
  [/^OPENAI(_|$)/, 'OpenAI'],
  [/^ANTHROPIC(_|$)/, 'Anthropic'],
  [/^GOOGLE(_|$)/, 'Google'],
  [/^GEMINI(_|$)/, 'Google'],
  [/^TELEGRAM(_|$)/, 'Telegram'],
  [/^SLACK(_|$)/, 'Slack'],
  [/^GITHUB(_|$)/, 'GitHub'],
  [/^GITLAB(_|$)/, 'GitLab'],
  [/^AWS(_|$)/, 'AWS'],
  [/^AZURE(_|$)/, 'Azure'],
  [/^GCP(_|$)/, 'GCP'],
  [/^NOTION(_|$)/, 'Notion'],
  [/^AIRTABLE(_|$)/, 'Airtable'],
  [/^SALESFORCE(_|$)/, 'Salesforce'],
  [/^HUBSPOT(_|$)/, 'HubSpot'],
  [/^GAMMA(_|$)/, 'Gamma'],
  [/^WELLKID(_|$)/, 'Wellkid'],
  [/^LMS(_|$)/, 'LMS'],
  [/^DB|DATABASE(_|$)/, 'Database'],
  [/^STRIPE(_|$)/, 'Stripe'],
];

function groupEnvKeysByFamily(keys: string[]): Array<{ family: string; keys: string[] }> {
  const groups = new Map<string, string[]>();
  for (const k of keys) {
    let family = 'Other';
    for (const [re, label] of FAMILY_PREFIXES) {
      if (re.test(k)) {
        family = label;
        break;
      }
    }
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family)!.push(k);
  }
  // Sort families by member count desc, then alpha; push "Other" last.
  return Array.from(groups.entries())
    .map(([family, ks]) => ({ family, keys: ks.slice().sort() }))
    .sort((a, b) => {
      if (a.family === 'Other') return 1;
      if (b.family === 'Other') return -1;
      if (b.keys.length !== a.keys.length) return b.keys.length - a.keys.length;
      return a.family.localeCompare(b.family);
    });
}

function CredentialsBlock({ discovery }: { discovery: unknown }) {
  const initialOpen = useExpandFlag('credentials');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (initialOpen) setOpen(true);
  }, [initialOpen]);

  // Narrow `unknown` once at the top. If the field isn't shaped right
  // we render nothing — keeps minimal layout safe for legacy reports
  // without a discovery scan.
  //
  // Rules-of-Hooks: the discovery-dependent `useMemo`s live in
  // `CredentialsBlockInner`, NOT here. This parent's hooks
  // (`useExpandFlag`, `useState`, `useEffect`) run unconditionally on
  // every render, so the early return below never changes the hook
  // count for THIS component. The data hooks then run unconditionally
  // inside the child whenever it is mounted. Without this split, opening
  // the report mid-audit (no `localAgentDiscovery`) and then letting
  // polling populate it would change the number of hooks called between
  // renders and crash React with an "order of Hooks changed" error.
  if (!discovery || typeof discovery !== 'object') return null;
  const d = discovery as MinimalLocalDiscovery;
  return <CredentialsBlockInner d={d} open={open} setOpen={setOpen} />;
}

function CredentialsBlockInner({
  d,
  open,
  setOpen,
}: {
  d: MinimalLocalDiscovery;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const keys = useMemo(() => collectEnvKeys(d), [d]);
  const groups = useMemo(() => groupEnvKeysByFamily(keys), [keys]);

  // Collapsed-state preview: prefer recognizable provider-family keys
  // first so the reader sees the wedge-shaped evidence (OPENAI_API_KEY,
  // GOOGLE_API_KEY, TELEGRAM_BOT_TOKEN) before any "Other" bucket noise.
  // Falls back to plain alpha order when no families are recognized.
  // Capped at 6 to avoid line wrap on standard widths.
  const preview = useMemo(() => {
    const nonOther = groups.filter((g) => g.family !== 'Other');
    if (nonOther.length === 0) return keys.slice(0, 6);
    // Pick one key from each family round-robin until we hit 6.
    const picks: string[] = [];
    const cursors = nonOther.map(() => 0);
    while (picks.length < 6) {
      let advanced = false;
      for (let i = 0; i < nonOther.length && picks.length < 6; i++) {
        const g = nonOther[i]!;
        const c = cursors[i]!;
        if (c < g.keys.length) {
          picks.push(g.keys[c]!);
          cursors[i] = c + 1;
          advanced = true;
        }
      }
      if (!advanced) break;
    }
    return picks;
  }, [groups, keys]);
  const hiddenCount = Math.max(0, keys.length - preview.length);

  // All hooks above run unconditionally on every render of this inner
  // component, so this early return is safe (no hook follows it).
  if (keys.length === 0) return null;

  return (
    <section
      style={{
        margin: '0 0 18px',
        padding: '18px 22px',
        background: '#ffffff',
        border: '1px solid #e5e7eb',
        borderRadius: 10,
      }}
      aria-label="Credentials & secrets"
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
            Credentials &amp; secrets
          </span>
          <span style={{ fontSize: 13, color: '#18181b' }}>
            {keys.length} env key{keys.length === 1 ? '' : 's'} detected
            {groups.length > 1 && (
              <>
                {' · '}
                {groups.length} provider{groups.length === 1 ? '' : 's'}
              </>
            )}
          </span>
        </span>
        <span style={{ fontSize: 12, color: '#1d4ed8', fontWeight: 600 }}>
          {open ? 'Hide ▾' : 'Details ▸'}
        </span>
      </button>

      {!open && (
        <div style={{ marginTop: 10, display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          {preview.map((k) => (
            <EnvKeyChip key={k} name={k} />
          ))}
          {hiddenCount > 0 && (
            <span style={{ fontSize: 11.5, color: '#71717a', marginLeft: 4 }}>
              + {hiddenCount} more
            </span>
          )}
        </div>
      )}

      {open && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #e5e7eb' }}>
          <p style={{ margin: '0 0 12px', fontSize: 11.5, color: '#71717a', lineHeight: 1.55 }}>
            Variable names only, never values. Collected from <span className="mono">.env</span>{' '}
            files, MCP server <span className="mono">env</span> passthroughs, and runtime auth
            credentials.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {groups.map((g) => (
              <div key={g.family}>
                <div
                  style={{
                    fontSize: 10.5,
                    textTransform: 'uppercase',
                    letterSpacing: '0.06em',
                    color: '#71717a',
                    fontWeight: 600,
                    marginBottom: 5,
                  }}
                >
                  {g.family} <span style={{ color: '#a1a1aa', fontWeight: 500 }}>({g.keys.length})</span>
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {g.keys.map((k) => (
                    <EnvKeyChip key={k} name={k} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function EnvKeyChip({ name }: { name: string }) {
  return (
    <span
      className="mono"
      title="Name only — value never read"
      style={{
        fontSize: 10.5,
        padding: '2px 7px',
        background: '#f4f4f5',
        border: '1px solid #e4e4e7',
        color: '#3f3f46',
        borderRadius: 3,
        wordBreak: 'break-all',
      }}
    >
      {name}
    </span>
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
                with deterministic evidence before relying on them. Severity here is the
                agent&apos;s own estimate, scored per finding by the BR×DS×DM rubric, not a
                verified measurement.
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

  // AAP-105 B6: SLF findings get a subcategory-specific mitigation
  // (oauth-scope / write-log / secrets / vendor / alerting / …) so
  // each card carries actionable evidence-collection guidance rather
  // than the same generic "ask the deployer for the MCP config /
  // OAuth scope grant / .env keys / production audit log" boilerplate.
  // Non-SLF findings keep the evidence-source fallback.
  const fallbackHint =
    finding.evidenceSource === 'SLF'
      ? getSlfMitigationHint({ title: finding.title, description: finding.description })
      : getMitigationHint({ evidenceSource: finding.evidenceSource });
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
  const [expandedFw, setExpandedFw] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const p = new URLSearchParams(window.location.search);
    return p.get('expandFramework') || null;
  });
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
          {/* Fix 4: per-framework accordion. Click a card → show its
              control results (filtered to ones that fired — skip
              not-applicable). One card expanded at a time. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {frameworks.map((fwId) => (
              <FrameworkCard
                key={fwId}
                fwId={fwId}
                controlResults={controlResults}
                signals={rc.all || []}
                expanded={expandedFw === fwId}
                onToggle={() => setExpandedFw(expandedFw === fwId ? null : fwId)}
              />
            ))}
          </div>
          <p style={{ marginTop: 14, fontSize: 11.5, color: '#71717a', lineHeight: 1.6 }}>
            Verified = deterministic evidence matches the agent&apos;s declaration. Partial = a
            typed detector found a relevant signal or applicable obligation, but Heron cannot
            prove the control is fully satisfied (e.g. documentation or an attestation is still
            required). Out-of-scope controls are hidden by default — toggle in each card to
            include them.
          </p>
        </div>
      )}
    </section>
  );
}

// Exported for AAP-105 A7 unit coverage: the framework accordion is behind
// two collapsed `useState` toggles, so renderToStaticMarkup (no jsdom) can't
// reach a control row from the top-level component. The row's rationale /
// evidence rendering is verified by mounting ControlRow directly.
export type ControlResult = NonNullable<
  NonNullable<MinimalReportJson['regulatoryCompliance']>['controlResults']
>[number];

function FrameworkCard({
  fwId,
  controlResults,
  signals,
  expanded,
  onToggle,
}: {
  fwId: string;
  controlResults: ControlResult[];
  signals: NonNullable<NonNullable<MinimalReportJson['regulatoryCompliance']>['all']>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [showOutOfScope, setShowOutOfScope] = useState(false);
  const fwResults = controlResults.filter((c) => c.frameworkId === fwId);
  const fwPartial = fwResults.filter((r) => r.verdict === 'partial').length;
  const fwVerified = fwResults.filter((r) => r.verdict === 'verified').length;
  const fwFail = fwResults.filter((r) => r.verdict === 'fail').length;
  const fwOos = fwResults.filter((r) => r.verdict === 'not-applicable').length;
  const fwSignals = signals.filter((f) => f.frameworkId === fwId).length;
  const hasControlData = fwResults.length > 0;
  const visibleControls = fwResults
    .filter((r) => (showOutOfScope ? true : r.verdict !== 'not-applicable'))
    .slice()
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

  return (
    <div
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 6,
        background: expanded ? '#ffffff' : '#fafafa',
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={!hasControlData}
        style={{
          display: 'flex',
          width: '100%',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'transparent',
          border: 'none',
          padding: '10px 14px',
          textAlign: 'left',
          cursor: hasControlData ? 'pointer' : 'default',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {hasControlData && (
            <span style={{ color: '#a1a1aa', fontSize: 11 }}>{expanded ? '▼' : '▸'}</span>
          )}
          <span style={{ fontSize: 13, fontWeight: 600, color: '#18181b' }}>
            {FRAMEWORK_LABELS[fwId] || fwId}
          </span>
        </span>
        <span style={{ fontSize: 11.5, color: '#52525b' }}>
          {hasControlData ? (
            <>
              {fwVerified} verified · {fwPartial} partial · {fwFail} fail
              {fwOos > 0 && (
                <span style={{ marginLeft: 6, color: '#a1a1aa' }}>· {fwOos} N/A</span>
              )}
            </>
          ) : (
            <>{fwSignals} signals (prose only)</>
          )}
        </span>
      </button>
      {expanded && hasControlData && (
        <div style={{ padding: '0 14px 12px', borderTop: '1px solid #e5e7eb' }}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '6px 0' }}>
            {fwOos > 0 && (
              <button
                type="button"
                onClick={() => setShowOutOfScope((v) => !v)}
                style={{
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  fontSize: 11,
                  color: '#1d4ed8',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {showOutOfScope ? `Hide ${fwOos} out-of-scope` : `Show ${fwOos} out-of-scope`}
              </button>
            )}
          </div>
          {visibleControls.length === 0 ? (
            <p style={{ fontSize: 12, color: '#71717a', margin: '4px 0 0' }}>
              No applicable controls fired for this framework.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {visibleControls.map((c, i) => (
                <ControlRow key={c.controlId + '-' + i} control={c} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function severityRank(s: ControlResult['severity']): number {
  return s === 'critical' ? 4 : s === 'high' ? 3 : s === 'medium' ? 2 : s === 'low' ? 1 : 0;
}

// AAP-105 F4 — collapse a raw evidenceRef string to a short, readable
// identifier for the compact Evidence line. The raw refs are verbose and
// repetitive, e.g.:
//   "capability:OPENAI_API_KEY: OPENAI_API_KEY → AI provider (international transfer)"
//   "env:/Users/me/Codex3/.env: GOOGLE_API_KEY → cloud provider (international transfer)"
//   "env:/Users/me/Codex3/.env: GAMMA_API_KEY (plaintext secret-pattern key)"
//   "mcp:linear (http)"
// We want just the load-bearing token the reviewer scans for: the env key
// name (GOOGLE_API_KEY) or the MCP server handle (mcp:linear). Drop the
// absolute path, the "→ AI provider (...)" classification tail, the
// "(plaintext secret-pattern key)" annotation, and the duplicated key in
// the capability: form. Returns '' for refs we can't shorten so the caller
// can skip them.
export function shortEvidenceLabel(ref: string): string {
  const raw = (ref || '').trim();
  if (!raw) return '';
  // MCP refs: keep the "mcp:<server>" handle, drop the " (transport)" tail.
  if (raw.startsWith('mcp:')) {
    return raw.replace(/\s*\(.*$/, '').trim();
  }
  // env: / capability: refs carry the key after the last ": " (this also
  // discards the absolute path in env:<path>: KEY and the duplicated key in
  // capability:KEY: KEY). Then cut the " → ..." tail or the " (...)"
  // annotation so only the bare key name remains.
  const afterColon = raw.includes(': ') ? raw.slice(raw.lastIndexOf(': ') + 2) : raw;
  const key = afterColon.split(' →')[0].split(' (')[0].trim();
  return key;
}

export function ControlRow({ control }: { control: ControlResult }) {
  const verdictPalette =
    control.verdict === 'verified'
      ? { bg: '#f0fdf4', ink: '#15803d' }
      : control.verdict === 'fail'
        ? { bg: '#fef2f2', ink: '#991b1b' }
        : control.verdict === 'partial'
          ? { bg: '#fef9c3', ink: '#92400e' }
          : control.verdict === 'not-applicable'
            ? { bg: '#f4f4f5', ink: '#71717a' }
            : { bg: '#eff6ff', ink: '#1d4ed8' };
  const sevPalette =
    control.severity === 'critical'
      ? { bg: '#7f1d1d', ink: '#ffffff' }
      : control.severity === 'high'
        ? { bg: '#b91c1c', ink: '#ffffff' }
        : control.severity === 'medium'
          ? { bg: '#c2410c', ink: '#ffffff' }
          : control.severity === 'low'
            ? { bg: '#facc15', ink: '#3f3f46' }
            : { bg: '#e5e7eb', ink: '#52525b' };
  // AAP-105 A7 + F4: compact evidence summary under the rationale. Raw refs
  // ("env:/abs/path/.env: KEY → AI provider (international transfer)") are
  // shortened to bare tokens (KEY, mcp:linear) via shortEvidenceLabel, then
  // deduplicated — the same key often appears as both a capability: and an
  // env: ref, and across .env / .env.example. Show the first few mono-styled
  // with an overflow count; keeps the row honest about what drove the
  // verdict without unrolling a noisy, path-heavy list.
  const refs = Array.from(
    new Set(
      (control.evidenceRefs || [])
        .map((e) => shortEvidenceLabel(e?.ref || ''))
        .filter((r) => r.length > 0),
    ),
  );
  const refsShown = refs.slice(0, 4);
  const refsExtra = refs.length - refsShown.length;
  const rationale = (control.rationale || '').trim();

  return (
    <li
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '6px 0',
        borderBottom: '1px solid #f1f5f9',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(110px, max-content) 1fr max-content max-content',
          gap: 10,
          alignItems: 'center',
        }}
      >
        <span
          className="mono"
          style={{ fontSize: 11.5, color: '#3f3f46', whiteSpace: 'nowrap' }}
        >
          {control.controlId}
        </span>
        <span style={{ fontSize: 12, color: '#52525b', lineHeight: 1.4 }}>
          {control.controlName || ''}
        </span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            padding: '2px 7px',
            borderRadius: 3,
            background: verdictPalette.bg,
            color: verdictPalette.ink,
            whiteSpace: 'nowrap',
          }}
        >
          {control.verdict}
        </span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            padding: '2px 7px',
            borderRadius: 3,
            background: sevPalette.bg,
            color: sevPalette.ink,
            whiteSpace: 'nowrap',
          }}
        >
          {control.severity}
        </span>
      </div>
      {rationale && (
        <p
          style={{
            margin: 0,
            fontSize: 11.5,
            color: '#71717a',
            lineHeight: 1.5,
            maxWidth: '62ch',
          }}
        >
          {rationale}
        </p>
      )}
      {refsShown.length > 0 && (
        <p
          className="mono"
          style={{
            margin: 0,
            fontSize: 10.5,
            color: '#a1a1aa',
            lineHeight: 1.5,
            wordBreak: 'break-word',
          }}
        >
          Evidence: {refsShown.join(', ')}
          {refsExtra > 0 && ` +${refsExtra} more`}
        </p>
      )}
    </li>
  );
}

// ─── Footer ───────────────────────────────────────────────────────────
//
// Fix 1: dropped the "References:" row with Transcript / Local Discovery /
// Methodology links — they were all inactive placeholders.
// Fix 5: layout toggle no longer lives next to the tabs (where it looked
// like a tab). It now sits bottom-right of the report as a quiet inline
// button so "Minimal" reads as a layout choice, not a tab.

function FooterToggle({ onSwitch }: { onSwitch?: () => void }) {
  if (!onSwitch) return null;
  return (
    <footer
      style={{
        marginTop: 22,
        padding: '12px 0 4px',
        borderTop: '1px solid #f1f5f9',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <button
        type="button"
        onClick={onSwitch}
        style={{
          background: 'transparent',
          border: '1px solid #e4e4e7',
          borderRadius: 4,
          padding: '4px 10px',
          fontSize: 11.5,
          color: '#52525b',
          cursor: 'pointer',
          fontWeight: 500,
        }}
      >
        Switch to Full layout
      </button>
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
  // Screenshot helper — `?scroll=bottom` scrolls the inner `.body` container
  // to its bottom on mount. Headless Chrome capture URLs use this.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams(window.location.search);
    if (p.get('scroll') !== 'bottom') return;
    let tries = 0;
    const t = setInterval(() => {
      const b = document.querySelector('.body') as HTMLElement | null;
      if (b) {
        b.scrollTop = b.scrollHeight;
        if (tries++ > 5) clearInterval(t);
      } else if (tries++ > 20) {
        clearInterval(t);
      }
    }, 150);
    return () => clearInterval(t);
  }, []);
  if (!reportJson) {
    return (
      <div className="report" style={{ padding: 24 }}>
        <p>No report data yet.</p>
      </div>
    );
  }
  const { name: projectName, isFallback } = extractProjectName(
    transcript,
    runtimeAgentName,
    reportJson.agentPurpose,
  );
  return (
    <div className="report" style={{ paddingTop: 16 }}>
      <HeaderBlock
        projectName={projectName}
        isFallback={isFallback}
        verdict={reportJson.verdict}
        metadata={reportJson.metadata}
        localAgentDiscovery={reportJson.localAgentDiscovery}
        oauthScopeVerification={reportJson.oauthScopeVerification}
      />
      <PurposeBlock json={reportJson} />
      <SystemsBlock systems={reportJson.systems || []} verdict={reportJson.verdict} />
      <CredentialsBlock discovery={reportJson.localAgentDiscovery} />
      <FindingsBlock verdict={reportJson.verdict} />
      <ComplianceBlock rc={reportJson.regulatoryCompliance} />
      <FooterToggle onSwitch={onSwitchToFullLayout} />
    </div>
  );
}
