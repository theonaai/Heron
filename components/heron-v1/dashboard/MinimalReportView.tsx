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
import { extractProjectName } from '@/src/report/agent-name';
import {
  buildSlfMitigationState,
  getMitigationHint,
  getSlfMitigationHint,
  type SlfMitigationState,
} from '@/src/report/mitigation-catalog';
import type {
  EvidenceSource,
  ReportSeverityBand,
  VerdictSnapshot,
} from '@/src/report/types';
import {
  allLensFrameworks,
  composeFrameworkLensRows,
  frameworkLens,
  slfFindingsForFramework,
  type FrameworkLens,
} from '@/src/report/compliance-lens';
import type { ControlResult as LensSourceControlResult } from '@/src/compliance/control-catalog';
import type { TypedRegulatoryFlag } from '@/src/compliance/mapper';
// AAP-126 (S10): the systems-table "Verified?" glyph is driven from REAL
// per-system OAuth introspection. We map a system to its connector exactly
// the way the declared-baseline builder does (`connectorForSystemId`) and
// compare the system's OWN declared scopes against that connector's
// introspection result using the SAME shared scope-token canonicalizer the
// differ / declared baseline / DS floor use, so the dashboard glyph cannot
// drift from the backend comparison.
import { connectorForSystemId } from '@/src/verification/declared-baseline';
import { canonicalizeScopeToken } from '@/src/verification/scope-canonical';

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
      // AAP-111: denormalised owning-framework join field, persisted in
      // report.json. Equals `frameworkId`; carried so the per-control
      // framework matches `frameworksActivated` + `FRAMEWORK_LABELS`.
      framework?: string;
      verdict: 'verified' | 'partial' | 'unverified' | 'fail' | 'not-applicable';
      severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
      controlId: string;
      controlName?: string;
      // AAP-105 A7: why a control is partial/fail and what evidence drove it.
      // Persisted in report.json; surfaced inline in the expanded framework
      // accordion so a reviewer can read the reasoning, not just the verdict.
      rationale?: string;
      evidenceRefs?: Array<{ kind?: string; ref?: string }>;
      // AAP-118 (S3): the honest 4-bucket classification, denormalised onto
      // each result by the mapper. Drives the AAP-121 (S5) lens: only
      // `verifiable` + `self-attested` controls are "active" (shown); the two
      // `oos-*` buckets are an out-of-scope COUNT only.
      bucket?: 'verifiable' | 'self-attested' | 'oos-operator-artifact' | 'oos-not-verifiable';
    }>;
    mandatory?: unknown;
    voluntary?: unknown;
    all?: Array<{
      framework: string;
      severity?: string;
      frameworkId?: string;
      // AAP-31: control IDs this self-report flag activated.
      controlIds?: string[];
      // AAP-120 (S2): every prose flag is self-attested by construction. The
      // lens reads this to count self-attested controls per framework.
      selfAttested?: boolean;
      triggeredBy?: string;
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
    // `errorMessage` carries the provider's introspection rejection (e.g.
    // `introspection-error: ... invalid_token ...`). AAP-110 reads it so the
    // SLF OAuth mitigation is state-aware (attempted + rejected -> refresh the
    // token, not "enable introspection").
    //
    // AAP-126 (S10): `actualScopes` + `diffs` are read by the systems table's
    // "Verified?" column to drive the per-system glyph from REAL introspection
    // evidence (✓ only when the system's own declared scope is confirmed; ⚠
    // when it shows up in a diff; — when the connector was not introspected or
    // the system declared no OAuth scope). Mirrors
    // `OAuthScopeVerificationSourceResult` in lib/report-json.ts; both fields
    // optional so legacy/partial blobs degrade to "—" rather than throw.
    sources?: Array<{
      connector?: string;
      verdict?: string;
      errorMessage?: string;
      actualScopes?: Array<{ service?: string; scope?: string }>;
      diffs?: Array<{ kind?: string; service?: string; scope?: string }>;
    }>;
  };
}

// ─── Project name extraction ──────────────────────────────────────────
//
// AAP-105 C1 / #26 A1: the agent display-name extraction now lives in the
// shared, environment-agnostic `src/report/agent-name.ts` so the Node
// storage layer can stamp the same name onto `meta.extractedAgentName` and
// every surface (card / overview / sidebar) reads one field. The card here
// still calls `extractProjectName` (imported above) as the runtime path
// and for sessions whose meta predates the stamp.
//
// `TranscriptEntry` is the local alias used by the props below; it matches
// the shared `TranscriptEntryLike` shape.

interface TranscriptEntry {
  category?: string;
  question?: string;
  answer?: string;
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

// ─── AAP-110: posture-popover driver helpers ──────────────────────────
//
// One per-system risk row off `verdict.systemsRisk.systems`. The canonical
// score field is `severity` (BR × DS × DM, see SystemRiskResult in
// `src/verification/systems-risk.ts` and `systemRiskSnapshotSchema` in
// `src/report/types.ts`). We read `severity` and tolerate a legacy/alias
// `posture` key so blobs persisted under either name still score.
type SystemRiskRow = NonNullable<VerdictSnapshot['systemsRisk']>['systems'][number];

/** Per-system risk score: `severity` (canonical), with a `posture` fallback. */
function systemRiskScore(row: SystemRiskRow): number {
  const withAlias = row as SystemRiskRow & { posture?: number };
  return row.severity ?? withAlias.posture ?? 0;
}

/**
 * Per-system severity readout sourced from the persisted snapshot
 * (`verdict.systemsRisk.systems[].severity` + `.band`). The headline posture
 * is the FIPS high-water-mark of these per-system severities, so surfacing
 * them per row lets a reviewer see which system drives the verdict. Looks up
 * the row by `systemId` (same as the DS-tier/basis lookups). Returns `null`
 * when the snapshot has no matching row (edge / pre-snapshot report) so the
 * caller can degrade gracefully.
 */
function systemSeverity(
  system: SystemAssessment,
  verdict?: VerdictSnapshot,
): { score: number; band: ReportSeverityBand; br: number; ds: number; dm: number } | null {
  const row = verdict?.systemsRisk?.systems?.find(
    (r) => r.systemId === system.systemId,
  );
  if (!row) return null;
  return { score: systemRiskScore(row), band: row.band, br: row.br, ds: row.ds, dm: row.dm };
}

/**
 * Resolve the human DISPLAY NAME for a systems-risk row. The row carries only
 * the kebab `systemId`, so match it against the named `systems` list (the same
 * source `SystemsBlock` renders) and humanize via `humanizeSystemId` — exactly
 * how `SystemRow` derives its label. When nothing matches (or no list was
 * threaded), fall back to humanizing the raw id directly.
 */
function resolveSystemDisplayName(
  systemId: string,
  systems?: SystemAssessment[],
): string {
  const match = systems?.find((s) => s.systemId === systemId);
  return humanizeSystemId(match?.systemId ?? systemId);
}

// ─── DS tier (T1 / T2 / T3) — persisted, never re-classified ───────────
//
// The authoritative per-system data-sensitivity tier is computed by the
// backend (`src/verification/severity-scoring.ts`) and persisted on the
// verdict snapshot at `verdict.systemsRisk.systems[].dsTier`. The dashboard
// READS that value — it must never re-derive the tier from the free-text
// prose (an earlier local regex drifted from the backend and could
// contradict the posture math). Mirrors `systemDsBasis` below: persisted
// snapshot is the single source of truth.

const DS_TIER_LABEL: Readonly<Record<'T1' | 'T2' | 'T3', string>> = {
  T1: 'T1 (Standard)',
  T2: 'T2 (Sensitive PII)',
  T3: 'T3 (Critical)',
};

function systemDsTier(
  system: SystemAssessment,
  verdict?: VerdictSnapshot,
): { tier: 'T1' | 'T2' | 'T3'; label: string } | null {
  const tier = verdict?.systemsRisk?.systems?.find(
    (r) => r.systemId === system.systemId,
  )?.dsTier;
  if (!tier) return null;
  return { tier, label: DS_TIER_LABEL[tier] };
}

// ─── G9 (AAP-106): PII / sensitivity basis inline ─────────────────────
//
// Surface a compact "why this DS tier" basis next to the sensitivity badge.
// Prefer the backend-computed `dsBasis` (persisted on `verdict.systemsRisk`,
// same classifier that drives the risk DS axis — single source of truth).
// Fall back to a short clause from the sensitivity prose when the snapshot
// predates G9. Returns '' when there is nothing to show.

function systemDsBasis(
  system: SystemAssessment,
  verdict?: VerdictSnapshot,
): string {
  const fromSnapshot = verdict?.systemsRisk?.systems?.find(
    (r) => r.systemId === system.systemId,
  )?.dsBasis;
  if (fromSnapshot && fromSnapshot.trim().length > 0) return fromSnapshot.trim();
  return shortBasisFromProse(system.dataSensitivity || '');
}

/** First clause of the sensitivity prose, capped — the fallback basis. */
function shortBasisFromProse(prose: string): string {
  const p = (prose || '').trim();
  if (!p) return '';
  const clause = p.split(/[;.]|,(?=\s)/)[0]?.trim() ?? p;
  if (clause.length <= 90) return clause;
  const window = clause.slice(0, 90);
  const ws = window.lastIndexOf(' ');
  return clause.slice(0, ws > 0 ? ws : 90).trimEnd() + '…';
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

// ─── AAP-126 (S10): per-system "Verified?" status ─────────────────────
//
// THE BUG THIS REPLACES. The old `findingsTouchingSystem` rendered ✓ for ANY
// system that had no VERIFIED finding whose title/description text happened to
// mention the system-id stem. Two ways that was dishonest in a column titled
// "Verified?":
//   (1) ✓ showed for systems that were NEVER introspected at all (gamma /
//       telegram / wellkid had no OAuth verification, yet read as "verified").
//   (2) the short "google" stem matched the text of findings for EVERY
//       google-* system, including `google-gemini` (which has no OAuth scopes),
//       so an unrelated finding could flip an unverified system to ⚠.
//
// THE FIX. Drive the glyph from REAL per-system verification evidence:
//   1. Map the system to its OAuth connector the SAME way the declared-baseline
//      builder does (`connectorForSystemId`). No connector -> not verifiable.
//   2. Find that connector's introspection result in `oauthScopeVerification`.
//      Not introspected (no matching source) -> "—" Not verified.
//   3. Canonicalize the system's OWN declared scopes (`scopesRequested`) via the
//      shared `canonicalizeScopeToken` (so a full Google scope URL matches the
//      short tokeninfo form the connector emits — same helper as the differ).
//        - No declared OAuth scope            -> "—" Not verified.
//        - A declared scope appears in `diffs` -> ⚠ Discrepancy (its own access
//          is implicated: a `missing` it declared-but-lacks, or an `extra`
//          granted-but-undeclared scope it nonetheless lists).
//        - >=1 declared scope AND every declared scope is in `actualScopes`
//          with no diff hit -> ✓ Verified.
//        - otherwise (declared scope neither confirmed nor flagged) -> "—".
//
// Conservative by construction: ✓ ONLY when the system's own declared access
// was deterministically confirmed against introspection. When in doubt we show
// the neutral "—", never a misleading ✓.

export type SystemVerificationState = 'verified' | 'discrepancy' | 'unverified';

export interface SystemVerificationStatus {
  state: SystemVerificationState;
  glyph: '✓' | '⚠' | '—';
  /** Hex color for the glyph (green / orange / neutral grey). */
  color: string;
  /** Per-cell tooltip explaining what the glyph means. */
  title: string;
}

const NOT_VERIFIED_STATUS: SystemVerificationStatus = {
  state: 'unverified',
  glyph: '—',
  color: '#a1a1aa',
  title: 'No deterministic verification (system declares no OAuth scope, or its connector was not introspected)',
};

/** Minimal shape this helper reads off `oauthScopeVerification`. */
type OAuthSourceLike = NonNullable<
  NonNullable<MinimalReportJson['oauthScopeVerification']>['sources']
>[number];

/**
 * Resolve the "Verified?" status for one system row from real OAuth-scope
 * introspection evidence. Pure + exported so the matching logic is unit-tested
 * directly (the project's vitest setup has no DOM).
 */
export function systemVerificationStatus(
  system: Pick<SystemAssessment, 'systemId' | 'scopesRequested'>,
  oauthScopeVerification?: MinimalReportJson['oauthScopeVerification'],
): SystemVerificationStatus {
  const connector = connectorForSystemId(system.systemId || '');
  if (!connector) return NOT_VERIFIED_STATUS;

  const sources: OAuthSourceLike[] = oauthScopeVerification?.sources ?? [];
  const source = sources.find((s) => s.connector === connector);
  if (!source) return NOT_VERIFIED_STATUS;

  // The system's OWN declared scopes, canonicalized to the short comparison
  // form (full Google URL -> short tokeninfo name) the connector emits.
  const declared = (Array.isArray(system.scopesRequested) ? system.scopesRequested : [])
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .map((s) => canonicalizeScopeToken(s));
  if (declared.length === 0) return NOT_VERIFIED_STATUS;

  // Canonicalize both sides of the comparison the same way.
  const actualSet = new Set(
    (source.actualScopes ?? [])
      .map((a) => (typeof a?.scope === 'string' ? canonicalizeScopeToken(a.scope) : ''))
      .filter((s) => s.length > 0),
  );
  const diffSet = new Set(
    (source.diffs ?? [])
      .map((d) => (typeof d?.scope === 'string' ? canonicalizeScopeToken(d.scope) : ''))
      .filter((s) => s.length > 0),
  );

  // Any of the system's OWN declared scopes implicated in a diff -> discrepancy.
  if (declared.some((tok) => diffSet.has(tok))) {
    return {
      state: 'discrepancy',
      glyph: '⚠',
      color: '#c2410c',
      title: 'Scope discrepancy: this system’s declared OAuth scope does not match what introspection found',
    };
  }

  // Every declared scope confirmed in the actual introspection result -> verified.
  if (declared.every((tok) => actualSet.has(tok))) {
    return {
      state: 'verified',
      glyph: '✓',
      color: '#15803d',
      title: 'Verified against OAuth introspection: every declared scope was confirmed granted',
    };
  }

  // Declared scope neither confirmed nor flagged (e.g. partial introspection
  // read). Stay neutral rather than imply a ✓ we cannot back.
  return NOT_VERIFIED_STATUS;
}

// ─── AAP-107: Findings empty-state copy (three distinct states) ────────
//
// The pre-G9 copy ("No verified discrepancies — either the discovery scan
// has not run yet, or it ran clean.") collapsed two genuinely different
// states into one misleading line. On the demo session
// (`sess-20260530-092850-2ae330`) discovery RAN and the agent carries real
// deployment risk (posture 6 Medium), yet there were zero VERIFIED
// discrepancies — so the line both implied the scan might not have run AND
// implied the agent was clean. Neither is true.
//
// We now pick the message off whether discovery actually ran:
//   (a) discovery NOT run / unverified → honest "scan not run yet".
//   (b) discovery ran, zero verified discrepancies → must NOT say "has not
//       run yet" and must NOT imply clean; say there are no declared-vs-
//       actual discrepancies AND that posture still reflects systems risk.
//   (c) discovery ran WITH discrepancies → handled by the list path; this
//       helper is only consulted when the verified list is empty, so it
//       never needs to render a "(c)" string.
//
// Pure + exported so the three-state selection is unit-tested directly
// (the JSX branch is exercised separately via renderToStaticMarkup).

export type FindingsEmptyStateKind = 'not-run' | 'no-discrepancies';

export interface FindingsEmptyStateInput {
  /** Did a deterministic discovery / verification pass actually run? */
  discoveryRan: boolean;
  /** Count of VERIFIED (non-SLF) discrepancy findings. */
  verifiedDiscrepancyCount: number;
  /** Did the systems-risk pass score any systems (posture has a basis)? */
  systemsRiskNonZero: boolean;
}

export interface FindingsEmptyStateResult {
  kind: FindingsEmptyStateKind;
  message: string;
}

/**
 * Choose the Findings empty-state line. Only meaningful when there are no
 * verified discrepancies to list (the caller guards on `verified.length`).
 *
 *   discoveryRan === false                 → (a) "not-run"
 *   discoveryRan === true, count === 0     → (b) "no-discrepancies"
 *
 * `systemsRiskNonZero` tunes the (b) copy: when systems were scored we say
 * posture reflects their deployment risk (the demo case); when no systems
 * were scored (a genuinely clean, low-risk agent) we keep it to the plain
 * "no discrepancies" statement so we don't gesture at risk that isn't there.
 */
export function findingsEmptyState(
  input: FindingsEmptyStateInput,
): FindingsEmptyStateResult {
  if (!input.discoveryRan) {
    return {
      kind: 'not-run',
      message:
        'Discovery scan has not run yet. Run verification to compare declared access against deterministic evidence.',
    };
  }
  // Discovery ran, zero verified discrepancies. Never claim the agent is
  // clean: posture is risk-based (G9), so a Medium agent with no
  // declared-vs-actual gaps still has real deployment risk.
  if (input.systemsRiskNonZero) {
    return {
      kind: 'no-discrepancies',
      message:
        'No declared-vs-actual discrepancies. Posture reflects deployment risk from the systems above.',
    };
  }
  return {
    kind: 'no-discrepancies',
    message:
      'No declared-vs-actual discrepancies found in the deterministic evidence.',
  };
}

/**
 * AAP-107: did a deterministic discovery / verification pass actually run
 * for this session? Mirrors the header's `scanned` derivation so the
 * Findings empty-state and the posture indicator never disagree about
 * whether evidence exists. True when ANY of:
 *   - the systems-risk pass scored systems (`verdict.systemsRisk.scanned`);
 *   - `verdict.status` is set and not the pure no-evidence baseline; or
 *   - `localAgentDiscovery` carries filesystem scan output
 *     (agents / findings / scannedPaths / workspaceEnv), the same proxy
 *     the header uses for "Filesystem ran".
 * The `verification.status` lifecycle field is also honoured: anything past
 * 'interrogation-only' means a Surface 2 pass ran.
 */
export function discoveryRanFor(
  verdict: VerdictSnapshot | undefined,
  verification: MinimalReportJson['verification'] | undefined,
  localAgentDiscovery: unknown,
): boolean {
  if (verdict?.systemsRisk?.scanned) return true;
  if (verdict?.status !== undefined && verdict.status !== 'unverified') return true;
  if (
    verification?.status !== undefined &&
    verification.status !== 'interrogation-only'
  ) {
    return true;
  }
  const disc =
    localAgentDiscovery && typeof localAgentDiscovery === 'object'
      ? (localAgentDiscovery as {
          agents?: unknown[];
          findings?: unknown[];
          scannedPaths?: unknown[];
          workspaceEnv?: unknown[];
        })
      : null;
  return (
    !!disc &&
    ((disc.agents?.length ?? 0) > 0 ||
      (disc.findings?.length ?? 0) > 0 ||
      (disc.scannedPaths?.length ?? 0) > 0 ||
      (disc.workspaceEnv?.length ?? 0) > 0)
  );
}

// ─── Shared instant-hover popover (AAP-107 round 2, items 1 + 3) ──────
//
// The native `title` tooltip the posture (?) and the severity chip used to
// carry has two problems the product owner flagged: it lags ~1s before the
// browser shows it, and it drops BELOW the element where it can fall off the
// page's right edge. This is a custom popover that appears INSTANTLY on hover
// (React onMouseEnter/onMouseLeave, no browser delay) and is positioned away
// from the right edge so it never overflows.
//
// One component, two callers: the posture (?) (placement 'left', opens to the
// left of the affordance) and the severity chip (placement 'below-left', opens
// below and anchored to the right so it grows leftward). The visible hover
// affordance is passed as `children`; the popover body is `content`. Hover
// interactions cannot be driven under renderToStaticMarkup, so the popover
// markup is always rendered and hidden via `visibility: hidden` until hover.
// Tests assert the breakdown/formula text is present in the static markup, and
// the live show/hide is verified in a browser.
function InfoPopover({
  content,
  ariaLabel,
  placement = 'left',
  width = 280,
  children,
}: {
  content: React.ReactNode;
  ariaLabel?: string;
  placement?: 'left' | 'below-left';
  width?: number;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // 'left':        sit to the left of the affordance, vertically centered.
  // 'below-left':  sit below the affordance, right edges aligned so the box
  //                extends leftward (keeps a right-aligned chip on-page).
  const popoverPosition: React.CSSProperties =
    placement === 'below-left'
      ? { top: 'calc(100% + 6px)', right: 0 }
      : { right: 'calc(100% + 8px)', top: '50%', transform: 'translateY(-50%)' };
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {children}
      <span
        role="tooltip"
        aria-label={ariaLabel}
        style={{
          position: 'absolute',
          ...popoverPosition,
          width,
          background: '#ffffff',
          border: '1px solid #e2e8f0',
          borderRadius: 6,
          boxShadow: '0 4px 14px rgba(15,23,42,0.12)',
          padding: 10,
          fontSize: 12,
          lineHeight: 1.5,
          color: '#334155',
          fontWeight: 400,
          textTransform: 'none',
          letterSpacing: 'normal',
          textAlign: 'left',
          whiteSpace: 'normal',
          zIndex: 50,
          // Instant show on hover; kept in the DOM (not unmounted) so the
          // content is always present in static markup for contract tests.
          visibility: open ? 'visible' : 'hidden',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        {content}
      </span>
    </span>
  );
}

// ─── Block 1: Header ──────────────────────────────────────────────────

function HeaderBlock({
  projectName,
  isFallback,
  verdict,
  systems,
  metadata,
  localAgentDiscovery,
  oauthScopeVerification,
}: {
  projectName: string;
  isFallback: boolean;
  verdict?: VerdictSnapshot;
  // AAP-110: the named systems list `SystemsBlock` renders. Threaded in so the
  // posture popover can resolve the highest-risk system's DISPLAY NAME (e.g.
  // "Google Sheets") — the per-system risk rows on `verdict.systemsRisk.systems`
  // carry only the kebab `systemId`, not a human name.
  systems?: SystemAssessment[];
  metadata?: MinimalReportJson['metadata'];
  localAgentDiscovery?: unknown;
  oauthScopeVerification?: MinimalReportJson['oauthScopeVerification'];
}) {
  const posture = verdict?.posture ?? 0;
  const band = verdict?.postureBand ?? 'informational';

  // G9 (AAP-106) — posture now reflects DEPLOYMENT RISK (per-system blast
  // radius × sensitivity), not just verified discrepancies. The label must be
  // positive + risk-based, and distinguish two zero-ish cases:
  //   - clean + low/no risk (a scan ran, low blast radius, no discrepancies)
  //     → green "Low risk · no discrepancies", NOT the empty gray "no findings"
  //   - no scan (discovery never ran, no systems) → gray "Not yet verified"
  //
  // `scanned` is true when the systems-risk pass had systems to score OR any
  // Surface 2 source ran (status left 'unverified' only on a pure no-evidence
  // baseline). The gradient marker is colored by the risk band whenever there
  // IS a scan — gray only for the genuine no-scan state.
  const scanned =
    (verdict?.systemsRisk?.scanned ?? false) ||
    (verdict?.status !== undefined && verdict.status !== 'unverified');
  const verifiedDiscrepancyCount = (verdict?.findings ?? []).filter(
    (f) => f.evidenceSource !== 'SLF',
  ).length;
  const discrepancySubNote =
    verifiedDiscrepancyCount === 0
      ? 'no discrepancies'
      : `${verifiedDiscrepancyCount} discrepanc${verifiedDiscrepancyCount === 1 ? 'y' : 'ies'}`;

  // Marker: colored by band when scanned (green at the low end, ramping to
  // red); gray only for the no-scan state. When scanned with posture 0 we
  // still want a green marker at the low end of the gradient, so snap to the
  // lowest stop rather than hiding the marker.
  const markerPct = scanned
    ? gradientPercentForSeverity(posture > 0 ? posture : 1)
    : 0;
  const markerColor = scanned
    ? colorForSeverity(posture > 0 ? posture : 1)
    : '#cbd5e1';

  let postureText: string;
  let postureSubNote: string | null;
  if (posture > 0) {
    postureText = `${formatSeverityNumber(posture)} ${SEVERITY_BAND_LABEL[band]} risk`;
    postureSubNote = discrepancySubNote;
  } else if (scanned) {
    // Scan ran, low/no blast radius, no discrepancies — honest clean state.
    postureText = 'Low risk';
    postureSubNote = discrepancySubNote;
  } else {
    // No deterministic scan and no systems scored — genuine no-evidence state.
    postureText = 'Not yet verified';
    postureSubNote = null;
  }
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
  // G9 (AAP-106) — the bucket-counts line counts VERIFIED DISCREPANCY findings.
  // With G9 the headline posture can be risk-based even with zero such
  // findings, so the raw "No verified findings" reads as a contradiction next
  // to "Medium risk". When the risk is sourced from the systems surface
  // (posture > 0, no verified discrepancies), say so explicitly; otherwise
  // keep the bucket breakdown.
  //
  // AAP-107 item 3: the discrepancy half ("· 0 verified discrepancies") was
  // already stated in the headline ("… · no discrepancies"), so saying it
  // again here was duplicate. Keep just "Risk from N systems" and move the
  // "how is this number computed" note into the (?) tooltip (postureExplain).
  const systemsScored = verdict?.systemsRisk?.systems?.length ?? 0;
  const countsLine =
    verifiedDiscrepancyCount === 0 && posture > 0 && systemsScored > 0
      ? `Risk from ${systemsScored} system${systemsScored === 1 ? '' : 's'}`
      : renderBucketCountsLine(counts);

  // AAP-110: the "Risk posture (?)" affordance opens an INSTANT popover (see
  // InfoPopover) carrying a DRIVER-BASED explanation in plain English, not the
  // raw "= the higher of" decomposition. Posture is still the higher of two
  // high-water-marks — the systems deployment-risk score and any verified-
  // discrepancy severity — but instead of listing both inputs we name the ONE
  // that actually drives the headline number:
  //   - if systems risk wins (and there is >=1 scored system), show the single
  //     highest-risk system with its BR × DS × DM breakdown + a discrepancy
  //     line.
  //   - else a verified declared-vs-actual discrepancy is the driver.
  //   - systemsRisk.posture is the deployment-risk HWM (0 when no systems).
  //   - discrepancyPosture is the verified-discrepancy-only HWM (schema-
  //     defaulted to 0; the field is `discrepancyPosture` on VerdictSnapshot).
  const systemsDeploymentRisk = verdict?.systemsRisk?.posture ?? 0;
  const discrepancyPosture = verdict?.discrepancyPosture ?? 0;
  const postureBandWord = SEVERITY_BAND_LABEL[band];

  // Pick the single highest-risk system row (tie -> first). The canonical
  // per-system score field is `severity` (BR × DS × DM, see
  // `src/verification/systems-risk.ts` SystemRiskResult / the
  // `systemRiskSnapshotSchema` in src/report/types.ts). We read `severity` and
  // fall back to any `posture`-named field for forward/back-compat with blobs
  // that may carry the alias.
  const systemRiskRows = verdict?.systemsRisk?.systems ?? [];
  const topSystemRow =
    systemRiskRows.length > 0
      ? systemRiskRows.reduce((best, row) =>
          systemRiskScore(row) > systemRiskScore(best) ? row : best,
        )
      : undefined;
  // Resolve the DISPLAY NAME. The risk row carries only the kebab `systemId`,
  // so match it against the named `systems` list (same source SystemsBlock
  // renders) and humanize, exactly like SystemRow does. Fall back to the raw
  // id when nothing matches.
  const topSystemName = topSystemRow
    ? resolveSystemDisplayName(topSystemRow.systemId, systems)
    : '';

  // Driver decision (mirrors the HWM that set `posture`): systems risk wins on
  // a tie, and only counts when there is at least one scored system.
  const systemsDriven =
    systemsDeploymentRisk >= discrepancyPosture && !!topSystemRow;

  // a11y fallback: the popover content is visual; keep a short label so the
  // affordance still announces its purpose to a screen reader.
  const postureAriaLabel =
    'What drives the risk posture number: either the highest-risk system or ' +
    'a verified declared-vs-actual discrepancy.';

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
          {/* AAP-107 item 2: bare "POSTURE" was jargon. Label it "Risk
              posture" and carry a (?) affordance. AAP-107 round 2 item 1:
              the affordance now opens an INSTANT popover (InfoPopover) with
              the computation breakdown, positioned to the LEFT so it never
              overflows the page's right edge. */}
          <div
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: '#71717a',
              marginBottom: 4,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <span>Risk posture</span>
            <InfoPopover
              placement="left"
              width={280}
              ariaLabel={postureAriaLabel}
              content={
                <>
                  {/* AAP-110 driver-based content. Line 1: the overall number +
                      band word (same SEVERITY_BAND_LABEL map the header uses).
                      Line 2: the DRIVER, either the single highest-risk system
                      with its BR x DS x DM breakdown, or a verified discrepancy.
                      Line 3 (systems branch only): the discrepancy status. No
                      em-dashes anywhere. */}
                  <div style={{ fontWeight: 700, color: '#1e293b', marginBottom: 4 }}>
                    Overall risk: {posture} ({postureBandWord})
                  </div>
                  {systemsDriven ? (
                    <>
                      <div>
                        Highest-risk system: {topSystemName} (Blast Radius{' '}
                        {topSystemRow!.br} × Data Sensitivity {topSystemRow!.ds} ×
                        Domain Multiplier {topSystemRow!.dm} ={' '}
                        {systemRiskScore(topSystemRow!)})
                      </div>
                      <div style={{ marginTop: 4 }}>
                        {discrepancyPosture === 0
                          ? 'No verified discrepancies.'
                          : `Verified discrepancies: ${discrepancyPosture}.`}
                      </div>
                    </>
                  ) : (
                    <div>
                      Driven by a verified declared-vs-actual discrepancy
                      (severity {discrepancyPosture}).
                    </div>
                  )}
                </>
              }
            >
              <span
                aria-hidden
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 13,
                  height: 13,
                  borderRadius: '50%',
                  border: '1px solid #cbd5e1',
                  color: '#94a3b8',
                  fontSize: 9,
                  fontWeight: 700,
                  lineHeight: 1,
                  cursor: 'help',
                  textTransform: 'none',
                }}
              >
                ?
              </span>
            </InfoPopover>
          </div>
          {/* AAP-107 item 4: the headline ("6 Medium risk · no
              discrepancies") wrapped badly — the "· no" separator pushed
              right and "discrepancies" dropped below the gradient bar. Lay
              the two clauses out with flex-wrap and keep each clause on one
              line (whiteSpace: nowrap) so the discrepancy clause wraps as a
              UNIT to the next line, aligned right, instead of breaking mid-
              phrase. */}
          <div
            style={{
              fontSize: 22,
              fontWeight: 600,
              color: '#18181b',
              fontVariantNumeric: 'tabular-nums',
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'baseline',
              justifyContent: 'flex-end',
              columnGap: 8,
              rowGap: 2,
            }}
          >
            <span style={{ whiteSpace: 'nowrap' }}>{postureText}</span>
            {postureSubNote && (
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: '#71717a',
                  fontVariantNumeric: 'normal',
                  whiteSpace: 'nowrap',
                }}
              >
                · {postureSubNote}
              </span>
            )}
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
              <dd style={{ margin: 0 }}>
                <TriggerValue value={json.agentTrigger} />
              </dd>
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

/**
 * AAP-107 item 5: the Agent Profile "Trigger" row. The analyzer cap on
 * `agentTrigger` was raised (200 -> 600) so the stored root-cause value is no
 * longer clipped mid-thought. AAP-107 round 2 drops the Show more / Show less
 * toggle: we render the full stored value plainly (with a `title` for the
 * native hover-to-copy-the-whole-string affordance).
 */
function TriggerValue({ value }: { value: string }) {
  const full = (value || '').trim();
  if (!full) return null;
  return <span title={full}>{full}</span>;
}

// ─── Block 3: Systems & access ────────────────────────────────────────

function SystemsBlock({
  systems,
  verdict,
  oauthScopeVerification,
}: {
  systems: SystemAssessment[];
  verdict?: VerdictSnapshot;
  // AAP-126 (S10): threaded down so each row's "Verified?" glyph reads real
  // per-system OAuth introspection evidence.
  oauthScopeVerification?: MinimalReportJson['oauthScopeVerification'];
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
            <th style={{ padding: '8px 8px', borderBottom: '1px solid #e5e7eb', fontWeight: 500 }}>Risk</th>
            <th style={{ padding: '8px 0 8px 8px', borderBottom: '1px solid #e5e7eb', fontWeight: 500, textAlign: 'center' }}>Verified?</th>
          </tr>
        </thead>
        <tbody>
          {systems.map((s, i) => (
            <SystemRow
              key={s.systemId + '-' + i}
              system={s}
              verdict={verdict}
              oauthScopeVerification={oauthScopeVerification}
            />
          ))}
        </tbody>
      </table>
      {/* AAP-126 (S10): legend so ✓ / ⚠ / — read clearly. The "Verified?"
          column is deterministic OAuth-scope evidence, not a self-report. */}
      <div
        style={{
          marginTop: 10,
          fontSize: 11,
          color: '#71717a',
          lineHeight: 1.5,
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px 14px',
        }}
      >
        <span>
          <span style={{ color: '#15803d', fontWeight: 600 }}>✓</span> Verified against OAuth introspection
        </span>
        <span>
          <span style={{ color: '#c2410c', fontWeight: 600 }}>⚠</span> Scope discrepancy
        </span>
        <span>
          <span style={{ color: '#a1a1aa', fontWeight: 600 }}>—</span> No deterministic verification
        </span>
      </div>
    </section>
  );
}

function SystemRow({
  system,
  verdict,
  oauthScopeVerification,
}: {
  system: SystemAssessment;
  verdict?: VerdictSnapshot;
  oauthScopeVerification?: MinimalReportJson['oauthScopeVerification'];
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
  // DS tier is READ from the persisted snapshot (single source of truth,
  // aligned with the risk DS axis) — never re-classified from the prose.
  // `null` when this system has no matching persisted row (edge /
  // pre-snapshot report); we then hide the badge rather than guess.
  const ds = systemDsTier(system, verdict);
  // G9 (AAP-106) — PII-basis inline. Surface WHY this system got its DS tier
  // so a reviewer can judge over-classification (e.g. Google Sheets is T2
  // because "responsible fields may contain names" — operators/staff, a
  // possibility, not data-subject PII). Prefer the backend-computed basis
  // (single source of truth, aligned with the risk DS axis); fall back to a
  // short clause from the prose.
  const dsBasis = systemDsBasis(system, verdict);
  // Per-system deployment-risk severity + band, read from the persisted
  // snapshot. The headline posture is the max of these; surfacing each row's
  // value shows the reviewer which system drives the verdict. `null` when no
  // matching persisted row.
  const severity = systemSeverity(system, verdict);
  const irreversible = hasIrreversibleWrites(system);
  // AAP-126 (S10): "Verified?" glyph from REAL per-system OAuth introspection
  // (not finding-text overmatch). ✓ only when this system's own declared scope
  // was deterministically confirmed; ⚠ on a scope discrepancy; "—" when there
  // is no deterministic verification for it.
  const verification = systemVerificationStatus(system, oauthScopeVerification);
  const verifiedGlyph = verification.glyph;
  const verifiedColor = verification.color;
  const verifiedTitle = verification.title;

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
        <td style={{ padding: '10px 8px', borderBottom: '1px solid #f1f5f9', maxWidth: 240 }}>
          {ds ? (
            <>
              <SensitivityBadge label={ds.label} tier={ds.tier} basis={dsBasis} />
              {dsBasis && (
                <div
                  style={{
                    fontSize: 10.5,
                    color: '#a1a1aa',
                    lineHeight: 1.35,
                    marginTop: 3,
                    fontStyle: 'italic',
                  }}
                  title={dsBasis}
                >
                  {ds.tier} — {dsBasis}
                </div>
              )}
            </>
          ) : (
            <span style={{ color: '#a1a1aa' }}>—</span>
          )}
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
        <td style={{ padding: '10px 8px', borderBottom: '1px solid #f1f5f9' }}>
          {severity ? (
            <SeverityBadge score={severity.score} band={severity.band} br={severity.br} ds={severity.ds} dm={severity.dm} />
          ) : (
            <span style={{ color: '#a1a1aa' }}>—</span>
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
          <td colSpan={6} style={{ padding: '0 8px 14px 24px', background: '#f8fafc', borderBottom: '1px solid #f1f5f9' }}>
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

function SensitivityBadge({
  label,
  tier,
  basis,
}: {
  label: string;
  tier: 'T1' | 'T2' | 'T3';
  basis?: string;
}) {
  const color =
    tier === 'T3'
      ? { bg: '#fef2f2', bd: '#fecaca', ink: '#991b1b' }
      : tier === 'T2'
        ? { bg: '#fef9c3', bd: '#fde68a', ink: '#92400e' }
        : { bg: '#f4f4f5', bd: '#e4e4e7', ink: '#3f3f46' };
  return (
    <span
      title={basis ? `${tier} — ${basis}` : undefined}
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
 * Per-system deployment-risk severity badge: "<score> · <Band>" (e.g.
 * "6 · Medium"). Score + band are READ from the persisted snapshot
 * (`verdict.systemsRisk.systems[].severity` / `.band`); the headline posture
 * is the high-water-mark of these. Palette follows the band the same way the
 * other table badges do (critical/high red, medium amber, low/info neutral).
 */
function SeverityBadge({
  score,
  band,
  br,
  ds,
  dm,
}: {
  score: number;
  band: ReportSeverityBand;
  br: number;
  ds: number;
  dm: number;
}) {
  // Solid band color (the same gradient stop the posture badge and the finding
  // severity badge use) so the per-system risk reads as a highlighted chip, not
  // a faint pill.
  const sevColor = colorForSeverity(score);
  // Same BR × DS × DM decode the posture popover uses, scoped to this system,
  // so a reviewer can see WHY a row scored what it did (mirrors the finding
  // severity badge's `?` affordance). Number-first to match the posture card
  // ("2 (Low)"), not band-first.
  const formula = `Blast Radius ${br} × Data Sensitivity ${ds} × Domain ${dm} = ${formatSeverityNumber(
    score,
  )} (${SEVERITY_BAND_LABEL[band]})`;
  return (
    <InfoPopover
      placement="below-left"
      width={280}
      ariaLabel={formula}
      content={<span className="mono">{formula}</span>}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '3px 9px',
          background: sevColor,
          color: '#ffffff',
          borderRadius: 4,
          fontSize: 11,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          cursor: 'help',
        }}
      >
        {formatSeverityNumber(score)} ({SEVERITY_BAND_LABEL[band]})
        <span
          aria-hidden
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 12,
            height: 12,
            borderRadius: '50%',
            border: '1px solid rgba(255,255,255,0.7)',
            color: '#ffffff',
            fontSize: 8.5,
            fontWeight: 700,
            lineHeight: 1,
          }}
        >
          ?
        </span>
      </span>
    </InfoPopover>
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

      {/* #26 A3 — Write operations as a compact table (Operation / Target /
          Reversibility) instead of a flowing "op → target [badge]" line list.
          The line list was hard to scan once a system had several writes; a
          table lets the reviewer compare targets and reversibility down a
          column. The reversible/irreversible distinction keeps its colored
          badge; an approval-required write keeps its info badge next to the
          reversibility cell. */}
      {system.writeOperations.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <SectionLabel>Write operations</SectionLabel>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              marginTop: 6,
              fontSize: 12,
              tableLayout: 'fixed',
            }}
          >
            <thead>
              <tr
                style={{
                  textAlign: 'left',
                  color: '#71717a',
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
                <th style={{ padding: '4px 8px 4px 0', borderBottom: '1px solid #e5e7eb', fontWeight: 600, width: '38%' }}>
                  Operation
                </th>
                <th style={{ padding: '4px 8px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, width: '34%' }}>
                  Target
                </th>
                <th style={{ padding: '4px 0 4px 8px', borderBottom: '1px solid #e5e7eb', fontWeight: 600, width: '28%' }}>
                  Reversibility
                </th>
              </tr>
            </thead>
            <tbody>
              {system.writeOperations.map((w, i) => (
                <tr key={i}>
                  <td
                    style={{
                      padding: '6px 8px 6px 0',
                      borderBottom: '1px solid #f1f5f9',
                      color: '#18181b',
                      verticalAlign: 'top',
                      wordBreak: 'break-word',
                    }}
                  >
                    {w.operation}
                  </td>
                  <td
                    style={{
                      padding: '6px 8px',
                      borderBottom: '1px solid #f1f5f9',
                      color: '#3f3f46',
                      verticalAlign: 'top',
                      wordBreak: 'break-word',
                    }}
                  >
                    {w.target}
                  </td>
                  <td
                    style={{
                      padding: '6px 0 6px 8px',
                      borderBottom: '1px solid #f1f5f9',
                      verticalAlign: 'top',
                    }}
                  >
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Implementation notes — the long technical `system` / description
          prose, demoted to italic secondary text at the bottom.

          #26 A4 — blast radius is shown ONCE, as the chip at the top of this
          expansion (BlastRadiusBadge above). The earlier "Blast radius:
          <prose>" line here was a second rendering of the same fact, so it's
          dropped. The notes section now gates only on the description /
          sensitivity prose. */}
      {(system.systemDescription || system.dataSensitivity) && (
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

// `buildSlfMitigationState` (collapse the report's OAuth-introspection +
// discovery state into the `SlfMitigationState` each SLF card consumes) now
// lives in the shared backend catalog `src/report/mitigation-catalog.ts`
// alongside `getSlfMitigationHint`, so the dashboard and the markdown report
// build the SLF mitigation state through ONE function and can never drift.
// Imported at the top of this file.

function FindingsBlock({
  verdict,
  verification,
  oauthScopeVerification,
  localAgentDiscovery,
}: {
  verdict?: VerdictSnapshot;
  // AAP-107 item 1: the empty-state copy must distinguish "discovery never
  // ran" from "discovery ran, no discrepancies". That needs the same
  // evidence the header reads, so the block now also receives the
  // verification lifecycle and the discovery payload.
  verification?: MinimalReportJson['verification'];
  // AAP-110: state-aware SLF mitigation text needs the live session state
  // (did OAuth introspection run + with what result; did discovery read the
  // workspace .env). Threaded down to each SLF card via `slfState`.
  oauthScopeVerification?: MinimalReportJson['oauthScopeVerification'];
  localAgentDiscovery?: unknown;
}) {
  const initialOpen = useExpandFlag('slf');
  const [slfOpen, setSlfOpen] = useState(false);
  useEffect(() => {
    if (initialOpen) setSlfOpen(true);
  }, [initialOpen]);
  // AAP-105 (G8b) — host capabilities can exist with zero findings (a
  // clean codex agent whose only MCP servers are all host-wide globals).
  // Only short-circuit to "No findings." when there is genuinely nothing
  // to show: no findings AND no host-capability note.
  const earlyHostCapabilities =
    (verdict?.hostCapabilities as VerdictSnapshot['hostCapabilities'] | undefined) ?? [];
  if (
    (!verdict || !verdict.findings || verdict.findings.length === 0) &&
    earlyHostCapabilities.length === 0
  ) {
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

  const coded = assignFindingCodes(
    (verdict?.findings ?? []) as unknown as CodedVerdictFinding[],
  );
  const verified = coded
    .filter((f) => f.evidenceSource !== 'SLF')
    .slice()
    .sort((a, b) => b.severityScore - a.severityScore);
  const selfAttested = coded
    .filter((f) => f.evidenceSource === 'SLF')
    .slice()
    .sort((a, b) => b.severityScore - a.severityScore);
  // AAP-105 (G8b) — global-scope MCP servers reclassified out of the
  // Verified list. Rendered as a muted note, NOT as finding cards.
  const hostCapabilities = earlyHostCapabilities;
  // AAP-110: derived once, handed to every SLF card so its mitigation hint
  // reflects what already ran this session (OAuth introspection / .env read).
  const slfState = buildSlfMitigationState(oauthScopeVerification, localAgentDiscovery);

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
            {
              findingsEmptyState({
                discoveryRan: discoveryRanFor(verdict, verification, localAgentDiscovery),
                verifiedDiscrepancyCount: verified.length,
                systemsRiskNonZero:
                  (verdict?.posture ?? 0) > 0 ||
                  (verdict?.systemsRisk?.systems?.length ?? 0) > 0,
              }).message
            }
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {verified.map((f) => (
              <MinimalFindingCard key={f.code} finding={f} slfState={slfState} anchorId={findingAnchorId(f.code)} />
            ))}
          </div>
        )}
        <HostCapabilityNote capabilities={hostCapabilities} />
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
                Self-reported by the agent, not verified. Treat as working hypotheses.
              </p>
              {selfAttested.map((f) => (
                <MinimalFindingCard key={f.code} finding={f} slfState={slfState} anchorId={findingAnchorId(f.code)} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * AAP-127 (S11) — the stable DOM id for a finding's FULL card in the global
 * stream. The compact per-framework self-attested references in the Compliance
 * lens link to `#<this>` to scroll to the full card. Keyed by the Vijil-style
 * `code` (e.g. `SLF-001`), which is unique within an audit, so the id is too.
 */
export function findingAnchorId(code: string): string {
  return `finding-${code}`;
}

// ─── G8b: host-capability note (NOT a finding) ────────────────────────
//
// AAP-105 (G8b) — for a `global`-scope runtime (codex) the MCP config has
// no project binding: `~/.codex/config.toml` is shared by every project
// on the box. A discovered-but-undeclared server there is the IDE's host
// capability surface, NOT a deviation by the audited agent. So it is NOT
// a Verified discrepancy card and does NOT move posture (it never enters
// `computePosture`). We surface it here as a compact, muted, clearly-
// informational note so a reviewer sees the host's reachable tools
// without mistaking them for findings against this agent.

function HostCapabilityNote({
  capabilities,
}: {
  capabilities: VerdictSnapshot['hostCapabilities'];
}) {
  if (!capabilities || capabilities.length === 0) return null;
  // Group the (likely single) runtime so the lead-in reads naturally
  // ("the Codex IDE"). Multiple runtimes in one audit is not a thing
  // today, but join the names defensively.
  const runtimes = Array.from(new Set(capabilities.map((c) => c.runtime))).join(', ');
  const serverList = capabilities
    .map((c) => (c.transport && c.transport !== 'unknown' ? `${c.serverName} (${c.transport})` : c.serverName))
    .join(', ');
  return (
    <div
      aria-label="Host capability"
      style={{
        marginTop: 12,
        padding: '11px 13px',
        background: '#f8fafc',
        border: '1px dashed #e2e8f0',
        borderRadius: 6,
        fontSize: 12,
        color: '#64748b',
        lineHeight: 1.55,
      }}
    >
      <span style={{ fontWeight: 600, color: '#475569' }}>
        IDE host capability (not bound to this agent):
      </span>{' '}
      {serverList}. Configured in the {runtimes} IDE on this host, not specific to this
      audited agent/task — informational, not a deviation, does not move posture.
    </div>
  );
}

// ─── Inline finding card — minimal version (one component, used for both buckets) ───

export function MinimalFindingCard({
  finding,
  slfState,
  anchorId,
}: {
  finding: CodedVerdictFinding;
  // AAP-110: when present, the SLF mitigation hint is resolved state-aware
  // (e.g. introspection attempted + rejected -> refresh the token). Ignored
  // for non-SLF findings (which use the evidence-source fallback).
  slfState?: SlfMitigationState;
  // AAP-127 (S11): a DOM id for this card's <article>, so the compact
  // per-framework self-attested references (in the Compliance lens) can link
  // (`href="#<anchorId>"`) and scroll to the FULL card here in the global
  // stream. Set only on the global-stream cards (FindingsBlock); absent
  // elsewhere so no duplicate ids are emitted.
  anchorId?: string;
}) {
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
      ? getSlfMitigationHint({ title: finding.title, description: finding.description }, slfState)
      : getMitigationHint({ evidenceSource: finding.evidenceSource });
  const analyzerNotes = (finding as { analyzerNotes?: string }).analyzerNotes;
  const mitigation = analyzerNotes && analyzerNotes.length > 0 ? analyzerNotes : fallbackHint;

  // AAP-107 round 2 item 4: the description used to collapse behind a
  // "Show more / Show less" toggle (splitForCard at 280 chars + descExpanded
  // state). The toggle hid the part of the finding a reviewer most needs, so
  // we always render the FULL description now (toggle + state removed).
  const mitigationItems = mitigation.includes('; ')
    ? mitigation
        .split(/;\s+/)
        .map((s) => s.replace(/\.$/, '').trim())
        .filter((s) => s.length > 0)
    : null;

  return (
    <article
      {...(anchorId ? { id: anchorId } : {})}
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        background: '#ffffff',
        padding: '14px 16px',
        // AAP-127 (S11): give anchored cards a little scroll offset so the
        // heading is not flush against the viewport top when jumped to.
        ...(anchorId ? { scrollMarginTop: 16 } : {}),
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
        {/* AAP-107 round 2 item 3: the severity chip carries the BR/DS/DM
            decode (the `formula` string). The native title= was slow and
            could clip the page edge, so it now opens the same INSTANT
            InfoPopover, positioned below-left so it never overflows the
            right edge. A small visible "?" hint inside the chip signals it
            is hoverable (styled to match the posture (?) affordance). */}
        <InfoPopover
          placement="below-left"
          width={280}
          ariaLabel={formula}
          content={<span className="mono">{formula}</span>}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
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
            {/* Visible hoverable hint, matching the posture (?) circle but
                inverted (white-on-chip) so it reads on the colored badge. */}
            <span
              aria-hidden
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 12,
                height: 12,
                borderRadius: '50%',
                border: '1px solid rgba(255,255,255,0.7)',
                color: '#ffffff',
                fontSize: 8.5,
                fontWeight: 700,
                lineHeight: 1,
                textTransform: 'none',
              }}
            >
              ?
            </span>
          </span>
        </InfoPopover>
      </header>
      {finding.description && (
        <p style={{ margin: '4px 0 8px', fontSize: 14, lineHeight: 1.6, color: '#3f3f46' }}>
          {finding.description}
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
  verdict,
  oauthScopeVerification,
  localAgentDiscovery,
}: {
  rc: MinimalReportJson['regulatoryCompliance'] | undefined;
  // AAP-122 — the verdict snapshot's findings feed the per-framework
  // attribution of self-attested findings under each lens card. Optional so
  // pre-verdict / legacy report.json (no verdict block) renders controls with
  // no SLF sub-list.
  verdict?: VerdictSnapshot;
  // AAP-123 (S7) — live session state for the state-aware SLF mitigation hint,
  // so the finding cards now rendered under each framework match the global
  // Self-attested stream's mitigation copy. Same inputs FindingsBlock receives.
  oauthScopeVerification?: MinimalReportJson['oauthScopeVerification'];
  localAgentDiscovery?: unknown;
}) {
  // The compliance lens is ALWAYS expanded (per Ilya 2026-06-02): the 5 framework
  // cards are always shown; only each card's internals collapse, multiple at once.
  // AAP-121 (S5) FIX 2: framework cards expand independently — multiple can be
  // open at once. Per-card open-state is a Set of frameworkIds, not a single
  // active id, so opening one card no longer collapses the others.
  const [expandedFws, setExpandedFws] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    const p = new URLSearchParams(window.location.search);
    const initial = p.get('expandFramework');
    return initial ? new Set([initial]) : new Set();
  });
  const toggleFramework = (frameworkId: string) =>
    setExpandedFws((prev) => {
      const next = new Set(prev);
      if (next.has(frameworkId)) next.delete(frameworkId);
      else next.add(frameworkId);
      return next;
    });
  if (!rc) return null;
  // AAP-121 (S5): the lens is driven by the SHARED projection
  // (src/report/compliance-lens.ts) so the dashboard and the markdown report
  // cannot drift (AAP-108). The wire types are structurally compatible with the
  // projection's `ControlResult` / `TypedRegulatoryFlag` inputs — it reads
  // frameworkId / controlId / verdict / bucket (S3) and selfAttested /
  // controlIds (S2) — so a cast is honest here.
  const controlResults = (rc.controlResults || []) as unknown as LensSourceControlResult[];
  const flags = (rc.all || []) as unknown as TypedRegulatoryFlag[];
  // AAP-122 — the verdict's self-attested findings, attributed to each framework
  // card. The SAME findings stay in the global "Self-attested findings" stream
  // above (FindingsBlock) — this is an additional, framework-scoped view, never
  // a relocation.
  //
  // AAP-123 (S7) — assign Vijil-style codes here (the SAME pass FindingsBlock
  // runs over the SAME `verdict.findings`, so a framework card's SLF-NNN code
  // matches the global stream). AAP-127 (S11) — each framework now renders these
  // as COMPACT references (code + title, scrolling to the full card in the
  // global stream), not duplicated full cards, so no `slfState` is threaded to
  // the cards anymore (the global stream still builds its own for its cards).
  const codedFindings = assignFindingCodes(
    (verdict?.findings ?? []) as unknown as CodedVerdictFinding[],
  );
  // AAP-121 (S5) FIX 1: card for EVERY framework, mandatory-first. A framework
  // with zero active controls (verifiable or self-attested) still gets its
  // card with the honest "0 of ~N, the rest out of scope" summary — it no
  // longer vanishes (e.g. ISO 42001 / NIST AI RMF have 0 self-attested by
  // design, so they would disappear from a real audit otherwise).
  const lenses = allLensFrameworks().map((fwId) => frameworkLens(fwId, controlResults, flags));

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
      {/* S13 — NO top-of-lens aggregate (spec point 4). Just the section label;
          all numbers are per-framework on each card. The single legend lives
          ONCE at the bottom. */}
      <div>
        <span
          style={{
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
            color: '#71717a',
            fontWeight: 600,
          }}
        >
          Compliance lens
        </span>
      </div>
      <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #e5e7eb' }}>
          {/* S13: per-framework lens cards. On expand, controls are listed
              (verified -> partial -> self-attested) with self-attested FINDINGS
              nested under their anchored control. Cards expand independently.
              The headline is "{A} of {C} covered · {N−C} out of scope · {N} in
              framework" (no per-verdict breakdown, no `~` prefix). ALL FIVE
              frameworks always render. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {lenses.map((lens) => (
              <FrameworkCard
                key={lens.frameworkId}
                lens={lens}
                slfFindings={slfFindingsForFramework(lens.frameworkId, codedFindings)}
                expanded={expandedFws.has(lens.frameworkId)}
                onToggle={() => toggleFramework(lens.frameworkId)}
              />
            ))}
          </div>
          {/* S13 — the single legend, ONCE at the bottom (spec points 4 + 5). */}
          <p style={{ marginTop: 14, fontSize: 12.5, color: '#71717a', lineHeight: 1.6 }}>
            Some controls can earn a clean <strong>verified</strong>; others only ever{' '}
            <strong>warn</strong> (the deterministic-flag set), and{' '}
            <strong>self-attested</strong> controls are the agent&apos;s own answers, not
            deterministic verdicts. Findings nested under a control (↳) are self-reported
            (full detail in the global Self-Attested Findings stream) and do not move posture.
            Out-of-scope controls need a corporate artifact or an external probe Heron
            can&apos;t reach in an interview, so they are a count only.
          </p>
        </div>
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

/**
 * AAP-121 (S5) — per-framework lens card. Driven entirely by the shared
 * `FrameworkLens` projection (no inline counting), so it stays in lockstep with
 * the markdown report. The expanded body lists ONLY active controls, in the
 * projection's order (verified -> partial -> self-attested).
 *
 * AAP-128 (S12) — the headline is STATIC capability coverage `C of ~N covered`
 * (`counts.covered`, identical every audit) with `(N−C)` out of scope; the
 * per-audit verdict breakdown (verified / fail / partial / self-attested) is
 * KEPT as secondary detail. AAP-127 (S11) — the attributed self-attested
 * findings render as COMPACT references (code + title) linking to the full card
 * in the global stream, not duplicated full cards.
 */
export function FrameworkCard({
  lens,
  slfFindings = [],
  expanded,
  onToggle,
}: {
  lens: FrameworkLens;
  // AAP-122 — self-attested findings whose finding-type maps to THIS framework
  // (deterministically, via CONTROL_MAPPINGS). Rendered after the control rows.
  // The same findings remain in the global stream; this is an additional view.
  //
  // AAP-127 (S11) — rendered as COMPACT one-line references (code + title,
  // linking to the full card in the global Self-attested stream), so only the
  // `code` + `title` are read here. (Was the FULL coded set fed to a per-card
  // `MinimalFindingCard` in AAP-123/S7; that full card now lives only globally.)
  slfFindings?: readonly CodedVerdictFinding[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const { counts } = lens;
  // S13 — compose the render model: each self-attested FINDING nests under the
  // control it anchors to for this framework (synthesising a `self-attested`
  // control row when the anchor did not independently activate); findings with
  // no resolvable anchor fall back to standalone rows. `surfaced` is `A` — the
  // distinct controls shown as rows this audit, the headline numerator.
  const composed = composeFrameworkLensRows(lens, slfFindings);
  const isEmpty = composed.rows.length === 0 && composed.orphanFindings.length === 0;

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
        style={{
          display: 'flex',
          width: '100%',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'transparent',
          border: 'none',
          padding: '10px 14px',
          textAlign: 'left',
          cursor: 'pointer',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#a1a1aa', fontSize: 11 }}>{expanded ? '▼' : '▸'}</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#18181b' }}>
            {FRAMEWORK_LABELS[lens.frameworkId] || lens.frameworkId}
          </span>
        </span>
        {/* S13 — the header line: "{A} of {C} covered · {N−C} out of scope · {N}
            in framework". A = `composed.surfaced` (distinct controls shown as
            rows this audit), C = `counts.covered` (static catalog capability),
            N = `counts.publishedControlCount`. No per-verdict breakdown (badges
            on each row show that), no `~` prefix (exact integers). */}
        <span style={{ fontSize: 11.5, color: '#52525b' }}>
          {composed.surfaced} of {counts.covered} covered
          <span style={{ color: '#a1a1aa' }}>
            {' · '}
            {counts.outOfScope} out of scope · {counts.publishedControlCount} in framework
          </span>
        </span>
      </button>
      {expanded && (
        <div style={{ padding: '6px 14px 12px', borderTop: '1px solid #e5e7eb' }}>
          {isEmpty ? (
            <p style={{ fontSize: 13, color: '#71717a', margin: '4px 0 0' }}>
              No active controls for this framework.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {/* S13 — each control row, with any self-attested FINDINGS nested
                  directly under it as compact `↳ CODE Title ↗` references into
                  the global Self-Attested Findings stream. A control synthesised
                  ONLY because a finding anchors to it renders with the
                  `self-attested` verdict badge. */}
              {composed.rows.map((row, i) => (
                <ControlRow
                  key={row.control.controlId + '-' + i}
                  control={row.control}
                  findings={row.findings}
                />
              ))}
              {/* FALLBACK — findings whose anchor could not be resolved render as
                  standalone compact rows at the end (never dropped). */}
              {composed.orphanFindings.map((f) => (
                <li key={f.id} style={{ padding: '6px 0', borderBottom: '1px solid #f1f5f9' }}>
                  <FindingRef finding={f} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * S13 — a compact one-line reference to a self-attested FINDING: `↳ CODE Title
 * ↗`, linking to the FULL card in the GLOBAL "Self-Attested Findings" stream
 * (`#finding-<code>`). The full card (severity / description / mitigation) is
 * never duplicated here; this only points to it.
 */
function FindingRef({ finding }: { finding: { id: string; code: string; title: string } }) {
  return (
    <a
      href={`#${findingAnchorId(finding.code)}`}
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 6,
        fontSize: 12.5,
        lineHeight: 1.5,
        color: '#6d28d9',
        textDecoration: 'none',
      }}
    >
      <span aria-hidden style={{ color: '#a1a1aa' }}>↳</span>
      <span
        className="mono"
        style={{
          display: 'inline-block',
          padding: '1px 6px',
          background: '#f5f3ff',
          color: '#6d28d9',
          border: '1px solid #ddd6fe',
          borderRadius: 4,
          fontSize: 11,
        }}
      >
        {finding.code}
      </span>
      <span style={{ color: '#3f3f46' }}>{finding.title}</span>
      <span aria-hidden style={{ color: '#a1a1aa' }}>↗</span>
    </a>
  );
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

/**
 * Row prop: accepts both the raw JSON `ControlResult` (verdict ∈ the 5 wire
 * states) and the AAP-121 `LensControl` (which adds the `self-attested`
 * sentinel verdict for agent self-reports). Widening here lets the lens card
 * pass `LensControl`s straight through while the existing direct-mount tests
 * keep passing `ControlResult`.
 */
type ControlRowControl = Omit<ControlResult, 'verdict'> & {
  verdict: ControlResult['verdict'] | 'self-attested';
};

export function ControlRow({
  control,
  findings = [],
}: {
  control: ControlRowControl;
  // S13 — self-attested FINDINGS nested under this control, rendered as compact
  // `↳ CODE Title ↗` references below the row's description/evidence.
  findings?: readonly { id: string; code: string; title: string }[];
}) {
  const verdictPalette =
    control.verdict === 'verified'
      ? { bg: '#f0fdf4', ink: '#15803d' }
      : control.verdict === 'fail'
        ? { bg: '#fef2f2', ink: '#991b1b' }
        : control.verdict === 'partial'
          ? { bg: '#fef9c3', ink: '#92400e' }
          : control.verdict === 'not-applicable'
            ? { bg: '#f4f4f5', ink: '#71717a' }
            : control.verdict === 'self-attested'
              ? // Agent self-report — a claim, not a deterministic verdict.
                // Slate/violet to read distinctly from the verified-green and
                // partial-amber deterministic states.
                { bg: '#f5f3ff', ink: '#6d28d9' }
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
      {/* S13 readability — the control id stays a fixed narrow column, but the
          DESCRIPTION (controlName) takes the full remaining width (`1fr`) so it
          no longer wraps into a cramped column, and the badges sit at the right.
          The verbose rationale renders full-width below (no `62ch` cap). The
          severity badge is hidden for `self-attested` rows (agent self-reports
          carry no deterministic severity). */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(96px, max-content) 1fr max-content max-content',
          gap: 12,
          alignItems: 'baseline',
        }}
      >
        <span
          className="mono"
          style={{ fontSize: 12, color: '#3f3f46', whiteSpace: 'nowrap' }}
        >
          {control.controlId}
        </span>
        <span style={{ fontSize: 13, color: '#3f3f46', lineHeight: 1.5 }}>
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
            alignSelf: 'center',
          }}
        >
          {control.verdict}
        </span>
        {control.verdict === 'self-attested' ? (
          <span />
        ) : (
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
              alignSelf: 'center',
            }}
          >
            {control.severity}
          </span>
        )}
      </div>
      {rationale && (
        <p
          style={{
            margin: 0,
            fontSize: 13,
            color: '#52525b',
            lineHeight: 1.6,
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
      {/* S13 — self-attested FINDINGS nested under this control: compact
          `↳ CODE Title ↗` references into the global Self-Attested stream. */}
      {findings.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
          {findings.map((f) => (
            <FindingRef key={f.id} finding={f} />
          ))}
        </div>
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
        systems={reportJson.systems}
        metadata={reportJson.metadata}
        localAgentDiscovery={reportJson.localAgentDiscovery}
        oauthScopeVerification={reportJson.oauthScopeVerification}
      />
      <PurposeBlock json={reportJson} />
      <SystemsBlock
        systems={reportJson.systems || []}
        verdict={reportJson.verdict}
        oauthScopeVerification={reportJson.oauthScopeVerification}
      />
      <CredentialsBlock discovery={reportJson.localAgentDiscovery} />
      <FindingsBlock
        verdict={reportJson.verdict}
        oauthScopeVerification={reportJson.oauthScopeVerification}
        verification={reportJson.verification}
        localAgentDiscovery={reportJson.localAgentDiscovery}
      />
      <ComplianceBlock
        rc={reportJson.regulatoryCompliance}
        verdict={reportJson.verdict}
        oauthScopeVerification={reportJson.oauthScopeVerification}
        localAgentDiscovery={reportJson.localAgentDiscovery}
      />
      <FooterToggle onSwitch={onSwitchToFullLayout} />
    </div>
  );
}
