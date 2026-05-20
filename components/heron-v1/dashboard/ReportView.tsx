'use client';

import './report.css';

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  McpInventorySection as McpInventorySectionComponent,
  DeclaredDiffSection as DeclaredDiffSectionComponent,
  OAuthScopesSection as OAuthScopesSectionComponent,
  LocalDiscoverySection as LocalDiscoverySectionComponent,
} from './McpSections';
import type {
  McpInventorySection as McpInventoryData,
  DeclaredDiffSection as DeclaredDiffData,
  OAuthScopesSection as OAuthScopesData,
  LocalAgentDiscoverySection as LocalDiscoveryData,
} from '@/lib/report-json';

/* ── Canonical deployer obligations ──
   These are NOT extracted from the interview — they're the fixed list
   of GDPR + supporting obligations that any deployer running an AI
   agent that touches PII must address independently. Mirrors OSS
   Heron's published reports (heron-open-source-copy on Railway) so
   buyers see consistent reminders across versions.
*/
const DEPLOYER_OBLIGATIONS: { ref: string; action: string }[] = [
  {
    ref: 'GDPR Art. 6',
    action:
      'Decide and document WHY you are allowed to process this data (e.g. legitimate business interest — must document a balancing test).',
  },
  {
    ref: 'GDPR Art. 13/14',
    action:
      'Tell people you are collecting their data: what, why, how long, and their rights.',
  },
  {
    ref: 'GDPR Art. 15',
    action: 'Be ready to show someone all data you hold on them if they ask.',
  },
  {
    ref: 'GDPR Art. 17',
    action: 'Be ready to delete someone’s data from all systems if they ask.',
  },
  {
    ref: 'GDPR Art. 30',
    action:
      'Keep a written log of what personal data you process, why, and who has access.',
  },
  {
    ref: 'GDPR Art. 5(1)(e)',
    action:
      'Set rules for how long you keep data — then actually delete it on schedule.',
  },
  {
    ref: 'GDPR Art. 21',
    action:
      'Let people opt out of being profiled for sales/marketing — you must stop if they object.',
  },
  {
    ref: 'GDPR Art. 28',
    action:
      'Sign data processing contracts with every service you send data to (Google, Apify, etc.).',
  },
  {
    ref: 'GDPR Art. 35',
    action:
      'Do a privacy impact assessment before going live (large-scale / profiling / sensitive data → likely required).',
  },
  {
    ref: 'GDPR Arts. 44-49',
    action:
      'Data leaves the EU (e.g. to US-based providers) — you need a legal basis for that transfer (SCCs, adequacy decision, etc.).',
  },
  {
    ref: 'GDPR Art. 22',
    action:
      'AI makes decisions about people: ensure a human can review, people can contest, and the logic is explainable.',
  },
  {
    ref: 'Credentials',
    action:
      'Store API keys/tokens in a secrets manager (not in code or env files), rotate them regularly.',
  },
  {
    ref: 'Platform ToS',
    action:
      'Check you are not violating the rules of LinkedIn, Google, or other connected services (scraping, rate limits, usage policies).',
  },
  {
    ref: 'Incident response',
    action:
      'Have a plan: if data leaks, who do you notify and within what timeframe? (EU: 72 hours to regulator).',
  },
];

/* ── Types matching backend auditReportSchema ── */
interface WriteOperation {
  operation: string;
  target: string;
  reversible: boolean;
  approvalRequired: boolean;
  volumePerDay: string;
}

interface SystemAssessment {
  systemId: string;
  scopesRequested: string[];
  scopesNeeded: string[];
  scopesDelta: string[];
  dataSensitivity: string;
  blastRadius: string;
  frequencyAndVolume: string;
  writeOperations: WriteOperation[];
}

type FindingType =
  | 'excessive-access'
  | 'write-risk'
  | 'sensitive-data'
  | 'scope-creep'
  | 'regulatory-flags'
  | 'risk-score'
  | 'decisions-about-people'
  | 'dsr-readiness'
  | 'prohibited-practice';

interface Risk {
  severity: string;
  title: string;
  description: string;
  mitigation?: string;
  /** Backend-supplied finding-type tag(s). Optional for backwards compat
      with sessions audited before this field landed — frontend falls back
      to TRIGGER_REGEX matching when missing. */
  triggeredBy?: FindingType[];
}

interface DataQuality {
  score: number;
  uniqueAnswers: number;
  totalQuestions: number;
  fieldsProvided: string[];
  fieldsMissing: string[];
  repeatedAnswers: number;
}

type FlagSeverity = 'info' | 'warning' | 'action-required' | 'clarification-needed';
type FrameworkId = 'eu-ai-act' | 'gdpr' | 'iso-42001' | 'aiuc-1' | 'nist-ai-rmf';
type RiskCategory = 'privacy' | 'ip' | 'consumer-protection' | 'sector-specific';
type FrameworkTier = 'mandatory' | 'voluntary';
type EUAIActClassification = 'prohibited' | 'high-risk' | 'limited' | 'minimal' | 'unclassified';

interface RegulatoryFlag {
  framework: string;
  severity: FlagSeverity;
  description: string;
  frameworkId?: FrameworkId;
  controlIds?: string[];
  category?: RiskCategory;
  tier?: FrameworkTier;
  triggeredBy?: string;
  euAiActClassification?: EUAIActClassification;
}

type CategoryBucket = Record<RiskCategory, RegulatoryFlag[]>;

interface CategorizedCompliance {
  mappingVersion: string;
  mandatory: CategoryBucket;
  voluntary: CategoryBucket;
  frameworksActivated: FrameworkId[];
  all: RegulatoryFlag[];
  euAiActClassification: {
    classification: EUAIActClassification;
    annexIIICategories: string[];
  };
}

interface LegacyRegulatoryCompliance {
  eu: RegulatoryFlag[];
  us: RegulatoryFlag[];
  uk: RegulatoryFlag[];
}

type RegulatoryCompliance = CategorizedCompliance | LegacyRegulatoryCompliance;

function isCategorizedCompliance(rc: RegulatoryCompliance): rc is CategorizedCompliance {
  return 'mandatory' in rc && 'voluntary' in rc && 'euAiActClassification' in rc;
}

interface ReportJson {
  summary: string;
  agentPurpose: string;
  agentTrigger?: string;
  agentOwner?: string;
  systems: SystemAssessment[];
  risks: Risk[];
  recommendations: string[];
  recommendation?: string;
  overallRiskLevel: string;
  dataQuality?: DataQuality;
  makesDecisionsAboutPeople?: boolean;
  decisionMakingDetails?: string;
  regulatoryCompliance?: RegulatoryCompliance;
  metadata?: {
    date: string;
    target: string;
    interviewDuration: number;
    questionsAsked: number;
  };
  /** MCP-scan sections (#33-C / AAP-64). Optional — rendered only when present. */
  mcpInventory?: McpInventoryData;
  declaredDiff?: DeclaredDiffData;
  oauthScopes?: OAuthScopesData;
  /** AAP-53: deterministic local-machine agent discovery. Optional. */
  localAgentDiscovery?: LocalDiscoveryData;
}

/* ── Constants ── */

const FRAMEWORK_LABELS: Record<FrameworkId, string> = {
  'eu-ai-act': 'EU AI Act',
  gdpr: 'GDPR',
  'iso-42001': 'ISO/IEC 42001',
  'aiuc-1': 'AIUC-1',
  'nist-ai-rmf': 'NIST AI RMF',
};

const CATEGORY_LABELS: Record<RiskCategory, string> = {
  privacy: 'Privacy & data handling',
  ip: 'IP & content rights',
  'consumer-protection': 'Decision-making & consumer protection',
  'sector-specific': 'Sector-specific obligations',
};

/* Concern buckets — matches OSS Heron's grouping. We group by what the
   audit FOUND (triggeredBy) rather than by legal category, so a reader
   sees "what risk are we dealing with" before "what law it activates".
   Backend's `triggeredBy` enum maps into 4 buckets:

     write-risk, scope-creep              → Write operation risks
     excessive-access, sensitive-data     → Data handling
     decisions-about-people               → Automated decision-making
     regulatory-flags, risk-score         → Regulatory concerns

   Anything unrecognized falls into a synthetic 'other' bucket. */
type ConcernBucket =
  | 'data-handling'
  | 'write-ops'
  | 'decisions'
  | 'regulatory'
  | 'other';

const TRIGGER_TO_BUCKET: Record<string, ConcernBucket> = {
  'write-risk': 'write-ops',
  'scope-creep': 'write-ops',
  'excessive-access': 'data-handling',
  'sensitive-data': 'data-handling',
  'decisions-about-people': 'decisions',
  'regulatory-flags': 'regulatory',
  'risk-score': 'regulatory',
};

const BUCKET_LABELS: Record<ConcernBucket, string> = {
  'data-handling': 'Data handling',
  'write-ops': 'Write operation risks',
  decisions: 'Automated decision-making',
  regulatory: 'Regulatory concerns',
  other: 'Other regulatory flags',
};

const BUCKET_ORDER: ConcernBucket[] = [
  'data-handling',
  'write-ops',
  'decisions',
  'regulatory',
  'other',
];

function bucketFor(flag: RegulatoryFlag): ConcernBucket {
  if (flag.triggeredBy && TRIGGER_TO_BUCKET[flag.triggeredBy]) {
    return TRIGGER_TO_BUCKET[flag.triggeredBy];
  }
  // Fallback: use legal category as a hint when triggeredBy is missing.
  if (flag.category === 'privacy') return 'data-handling';
  if (flag.category === 'consumer-protection') return 'regulatory';
  if (flag.category === 'sector-specific') return 'regulatory';
  return 'other';
}

const EU_CLASS_LABELS: Record<EUAIActClassification, string> = {
  prohibited: 'Prohibited',
  'high-risk': 'High-Risk (Annex III)',
  limited: 'Limited Risk',
  minimal: 'Minimal Risk',
  unclassified: 'Unclassified',
};

// Sentence-case labels for inline rendering inside the EU AI Act framework
// chip — e.g. "EU AI Act (limited risk)". The 'high-risk' label drops the
// "(Annex III)" suffix because the annex categories render alongside it
// explicitly (e.g. "high risk — §3 education") and to avoid nested parens.
const EU_INLINE_LABELS: Record<EUAIActClassification, string> = {
  prohibited: 'prohibited',
  'high-risk': 'high risk',
  limited: 'limited risk',
  minimal: 'minimal risk',
  unclassified: 'unclassified',
};

const blastRadiusLabel: Record<string, string> = {
  'single-record': 'Single record',
  'single-user': 'Single user',
  'team-scope': 'Team scope',
  'org-wide': 'Org-wide',
  'cross-tenant': 'Cross-tenant',
};

const fieldDescriptions: Record<string, string> = {
  systemId: 'External systems connected (name, API type, auth)',
  scopesRequested: 'Permissions/scopes granted to the agent',
  dataSensitivity: 'Data classification (PII, financial, etc.)',
  blastRadius: 'Scope of impact if something goes wrong',
  frequencyAndVolume: 'How often it runs, API calls per run',
  writeOperations: 'What the agent creates, modifies, or deletes',
  reversibility: 'Whether write operations can be undone',
};

/* ── Helpers ── */

function computeSystemRisk(sys: SystemAssessment): 'high' | 'medium' | 'low' {
  let score = 0;
  const brScores: Record<string, number> = {
    'single-record': 0,
    'single-user': 1,
    'team-scope': 2,
    'org-wide': 3,
    'cross-tenant': 4,
  };
  score += brScores[sys.blastRadius] ?? 1;
  if (sys.scopesDelta.length > 0) score += 1;
  if (sys.writeOperations.some((w) => !w.reversible)) score += 2;
  if (/pii|personal|health|financial|credit/i.test(sys.dataSensitivity)) score += 1;
  if (score >= 5) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

function isBusinessSystem(s: SystemAssessment): boolean {
  const id = s.systemId.toLowerCase();
  if (/\bheron\b/.test(id)) return false;
  if (/internal\s*(orchestrat|api|platform)/.test(id)) return false;
  if (/interview\s*(platform|endpoint|api)/.test(id)) return false;
  if (/audit\s*(platform|endpoint|api)/.test(id)) return false;
  return true;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function severityOrder(severity: string): number {
  switch (severity) {
    case 'critical':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
    default:
      return 0;
  }
}

function inferDomain(risk: Risk): string {
  const t = `${risk.title} ${risk.description}`.toLowerCase();
  if (/scope|permission|least.privilege|over.broad|excessive/.test(t)) return 'Scope & Permissions';
  if (/write|append|insert|update|delete|create.*row|create.*file/.test(t)) return 'Write Access';
  if (/reversib|rollback|undo|irrevers/.test(t)) return 'Reversibility';
  if (/pii|personal|health|gdpr|sensitive|financial/.test(t)) return 'Data Sensitivity';
  if (/network|firewall|ingress|local|expose|listen/.test(t)) return 'Network';
  if (/decision|automated|profil/.test(t)) return 'Decision-making';
  if (/secret|token|credential|auth/.test(t)) return 'Auth & Secrets';
  return 'General';
}

/* Framework-basis matcher.
   Primary path: backend now tags risks with `triggeredBy: FindingType[]`
   (LLM-emitted). When present, we look up flags whose own `triggeredBy`
   matches any tag on the risk and pick the highest-rank one
   (mandatory > voluntary, action-required > warning > clarification-needed).
   Ties are broken by mandatory-frameworks-alphabetical for determinism.

   Fallback path: for older sessions whose risks were generated before the
   field landed, fall back to the historical regex heuristic — match
   `TRIGGER_REGEX` against risk title+description and pick the highest-rank
   matching flag. Returns "—" only when neither path yields anything. */
const TRIGGER_REGEX: Record<string, RegExp> = {
  'excessive-access': /scope|permission|broad|excessive|over.broad|unused permissions/i,
  'sensitive-data': /pii|personal|sensitive|health|financial|credit|gdpr|biometric/i,
  'write-risk': /write|append|insert|update|delete|modify|create.*(row|file|record)/i,
  'scope-creep': /unused|excessive|exceed|narrow|more than (needed|stated)/i,
  'decisions-about-people': /decision|profil|evaluat|scor|rank|recommend.*(people|user)/i,
  'regulatory-flags': /regulated|sector|domain.*(employment|credit|insurance|health|housing|legal)/i,
};

function flagRank(flag: RegulatoryFlag): number {
  return (
    (flag.tier === 'mandatory' ? 100 : 0) +
    (flag.severity === 'action-required'
      ? 30
      : flag.severity === 'warning'
        ? 20
        : flag.severity === 'clarification-needed'
          ? 10
          : 0)
  );
}

function formatFlagBasis(flag: RegulatoryFlag): string {
  // frameworkName strips the "— Art. X, Y" suffix the LLM likes to bake
  // into the framework string. Show name + first control.
  const name = frameworkName(flag.framework);
  const ctl = flag.controlIds?.[0];
  return ctl ? `${name} ${ctl}` : name;
}

/** Pick the best flag among candidates by (rank desc, mandatory then alpha by framework). */
function pickBestFlag(candidates: RegulatoryFlag[]): RegulatoryFlag | null {
  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestRank = flagRank(best);
  for (let i = 1; i < candidates.length; i++) {
    const flag = candidates[i];
    const rank = flagRank(flag);
    if (rank > bestRank) {
      best = flag;
      bestRank = rank;
      continue;
    }
    if (rank === bestRank) {
      // Deterministic tie-break: mandatory before voluntary, then alpha by framework.
      const bestMandatory = best.tier === 'mandatory' ? 1 : 0;
      const flagMandatory = flag.tier === 'mandatory' ? 1 : 0;
      if (flagMandatory > bestMandatory) {
        best = flag;
        continue;
      }
      if (flagMandatory === bestMandatory) {
        if (frameworkName(flag.framework) < frameworkName(best.framework)) {
          best = flag;
        }
      }
    }
  }
  return best;
}

function frameworkBasisFor(
  risk: Risk,
  compliance: RegulatoryCompliance | undefined,
): string {
  if (!compliance || !isCategorizedCompliance(compliance)) return '—';
  const all: RegulatoryFlag[] = [
    ...Object.values(compliance.mandatory).flat(),
    ...Object.values(compliance.voluntary).flat(),
  ];

  // Primary path: risk carries explicit triggeredBy from the backend.
  if (risk.triggeredBy && risk.triggeredBy.length > 0) {
    const tags = new Set<string>(risk.triggeredBy);
    const matches = all.filter(
      (flag) => flag.triggeredBy && tags.has(flag.triggeredBy),
    );
    const best = pickBestFlag(matches);
    if (best) return formatFlagBasis(best);
    // Fall through to regex if no flag matches the tagged finding-type
    // (e.g. backend tagged a finding bucket that didn't fire any flag for
    // this particular session).
  }

  // Fallback path: legacy regex match against risk title+description.
  const text = `${risk.title} ${risk.description}`.toLowerCase();
  const regexMatches = all.filter((flag) => {
    if (!flag.triggeredBy) return false;
    const re = TRIGGER_REGEX[flag.triggeredBy];
    return Boolean(re && re.test(text));
  });
  const best = pickBestFlag(regexMatches);
  if (!best) return '—';
  return formatFlagBasis(best);
}

function severityRank(s: FlagSeverity): number {
  switch (s) {
    case 'action-required':
      return 3;
    case 'warning':
      return 2;
    case 'clarification-needed':
      return 1;
    default:
      return 0;
  }
}

function flagSeverityClass(s: FlagSeverity): string {
  switch (s) {
    case 'action-required':
      return 'sev-high';
    case 'warning':
      return 'sev-medium';
    case 'clarification-needed':
      return 'sev-clarify';
    default:
      return 'sev-info';
  }
}

function flagSeverityLabel(s: FlagSeverity): string {
  switch (s) {
    case 'action-required':
      return 'Action required';
    case 'warning':
      return 'Review';
    case 'clarification-needed':
      return 'Clarify';
    default:
      return 'Informational';
  }
}

function flagSeverityDot(s: FlagSeverity): string {
  switch (s) {
    case 'action-required':
      return 'high';
    case 'warning':
      return 'medium';
    case 'clarification-needed':
      return 'medium';
    default:
      return 'info';
  }
}

/* ── Section header ── */

function SectionHead({
  num,
  label,
  title,
  meta,
  id,
}: {
  num: string;
  label: string;
  title?: string;
  meta?: React.ReactNode;
  id: string;
}) {
  return (
    <div id={id} className="h-section">
      {num && <span className="num">{num}</span>}
      <span className="label">{label}</span>
      {title && <span className="title">{title}</span>}
      {meta && <span className="meta">{meta}</span>}
    </div>
  );
}

/* ── Verdict banner ── */
function VerdictBanner({ verdict, meta }: { verdict: string; meta?: React.ReactNode }) {
  const v = verdict.toUpperCase();
  const cls = v.includes('DENY') ? 'verdict deny' : v.includes('APPROVE WITHOUT') ? 'verdict approve' : 'verdict';
  const icon = v.includes('DENY') ? '✕' : '⚠';
  return (
    <div className={cls}>
      <span aria-hidden style={{ fontSize: 14 }}>
        {icon}
      </span>
      <span>{verdict}</span>
      {meta && <span className="verdict-meta">{meta}</span>}
    </div>
  );
}

/* ── Findings table ──
   Mirrors OSS Heron's published table:
   ID · Severity · Framework basis · Finding · Description · Recommendation
   Framework basis is heuristically matched: each risk's text is tested
   against compliance flag `triggeredBy` keywords; the highest-severity
   mandatory flag whose trigger matches the risk wins. If nothing
   matches we render "—" (same as OSS Heron, where many rows are
   unattributed). */
type EnrichedFinding = Risk & { id: string; domain: string; frameworkBasis: string };

const TIER_ORDER: ('critical' | 'high' | 'medium' | 'low')[] = [
  'critical',
  'high',
  'medium',
  'low',
];

/* Findings split by severity tier — same visual grammar as Systems &
   Access. Each tier renders its own table with a tier-label header.
   Earlier we had filter chips on a single table; the chips are
   redundant when each tier has its own visual block. */
function FindingsByTier({ findings }: { findings: EnrichedFinding[] }) {
  const groups = useMemo(() => {
    const g: Record<string, EnrichedFinding[]> = { critical: [], high: [], medium: [], low: [] };
    for (const f of findings) {
      const tier = (g as Record<string, EnrichedFinding[]>)[f.severity] ? f.severity : 'low';
      g[tier].push(f);
    }
    return g;
  }, [findings]);

  return (
    <div className="stack-lg">
      {TIER_ORDER.map((tier) => {
        const items = groups[tier];
        if (!items || items.length === 0) return null;
        return (
          <div key={tier}>
            <div className="tier-label">
              <span className={`dot ${tier}`} />
              <span>{tier} risk</span>
              <span className="tier-count">
                {items.length} {items.length === 1 ? 'finding' : 'findings'}
              </span>
            </div>
            <FindingsTable findings={items} />
          </div>
        );
      })}
    </div>
  );
}

function FindingsTable({ findings }: { findings: EnrichedFinding[] }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl tbl-findings">
        <thead>
          <tr>
            <th style={{ width: 92 }}>ID</th>
            <th style={{ width: 86 }}>Severity</th>
            <th style={{ width: 180 }}>Framework basis</th>
            <th style={{ width: 220 }}>Finding</th>
            <th>Description</th>
            <th>Recommendation</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((f) => (
            <tr key={f.id}>
              <td className="mono" style={{ color: 'var(--r-ink-3)' }}>
                {f.id}
              </td>
              <td>
                <span className={`sev sev-${f.severity}`}>{f.severity}</span>
              </td>
              <td>
                {f.frameworkBasis === '—' ? (
                  <span style={{ color: 'var(--r-ink-4)' }}>—</span>
                ) : (
                  <span
                    className="mono"
                    style={{ color: 'var(--r-ink-2)', fontSize: 11.5, lineHeight: 1.45 }}
                  >
                    {f.frameworkBasis}
                  </span>
                )}
              </td>
              <td style={{ fontWeight: 500, color: 'var(--r-ink)', lineHeight: 1.5 }}>{f.title}</td>
              <td style={{ color: 'var(--r-ink-2)', fontSize: 12.5, lineHeight: 1.55 }}>
                {f.description}
              </td>
              <td style={{ color: 'var(--r-ink-2)', fontSize: 12.5, lineHeight: 1.55 }}>
                {f.mitigation && f.mitigation !== 'NOT PROVIDED' ? (
                  f.mitigation
                ) : (
                  <span style={{ color: 'var(--r-ink-4)' }}>—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Systems grouped by risk ──
   Tier label is a non-clickable section header (one short line) and
   each system is rendered as a fully-expanded card. Earlier impl had
   nested collapse (tier-level + per-row), which produced a confusing
   "open one to open another" interaction — flagged as bad UX. */
function SystemsGrouped({ systems }: { systems: SystemAssessment[] }) {
  const groups: Record<'high' | 'medium' | 'low', SystemAssessment[]> = {
    high: [],
    medium: [],
    low: [],
  };
  for (const s of systems) groups[computeSystemRisk(s)].push(s);

  const orderedRisks: ('high' | 'medium' | 'low')[] = ['high', 'medium', 'low'];

  return (
    <div className="stack-lg">
      {orderedRisks.map((risk) => {
        const items = groups[risk];
        if (items.length === 0) return null;
        return (
          <div key={risk}>
            <div className="tier-label">
              <span className={`dot ${risk}`} />
              <span>{risk} risk</span>
              <span className="tier-count">
                {items.length} {items.length === 1 ? 'system' : 'systems'}
              </span>
            </div>
            <div className="stack-md">
              {items.map((s) => (
                <SystemCard key={s.systemId} system={s} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SystemCard({ system }: { system: SystemAssessment }) {
  const hasExcess =
    system.scopesDelta.length > 0 && !system.scopesDelta.every((s) => s === 'NOT PROVIDED');

  return (
    <div className="panel sys-card">
      <div className="sys-card-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row-tight" style={{ marginBottom: 4 }}>
            <span className="sys-name">{system.systemId}</span>
            {hasExcess && <span className="sev sev-high">excess scopes</span>}
          </div>
          <div className="sys-sub">
            {blastRadiusLabel[system.blastRadius] ?? system.blastRadius} ·{' '}
            {system.dataSensitivity || '—'}
          </div>
        </div>
      </div>

      <div className="sys-card-body stack-md" style={{ fontSize: 12.5 }}>
        {system.frequencyAndVolume && system.frequencyAndVolume !== 'NOT PROVIDED' && (
          <div>
            <span className="field-label">Frequency</span>
            <span style={{ color: 'var(--r-ink-2)' }}>{system.frequencyAndVolume}</span>
          </div>
        )}

        {system.scopesRequested.length > 0 && (
          <div>
            <span className="field-label">Scopes granted</span>
            <div className="row-tight" style={{ gap: 6 }}>
              {system.scopesRequested.map((s) => {
                const isExcessive = system.scopesDelta.includes(s);
                return (
                  <span key={s} className={`scope-chip ${isExcessive ? 'excess' : ''}`}>
                    {s}
                  </span>
                );
              })}
            </div>
          </div>
        )}

        {system.scopesNeeded.length > 0 && (
          <div>
            <span className="field-label">Minimum required</span>
            <div className="row-tight" style={{ gap: 6 }}>
              {system.scopesNeeded.map((s) => (
                <span key={s} className="scope-chip required">
                  {s}
                </span>
              ))}
            </div>
          </div>
        )}

        {system.writeOperations.length > 0 && (
          <div>
            <span className="field-label">Write operations</span>
            <ul className="stack" style={{ gap: 4 }}>
              {system.writeOperations.map((w, i) => (
                <li
                  key={i}
                  className="row-tight"
                  style={{ color: 'var(--r-ink-2)', fontSize: 12.5 }}
                >
                  <span style={{ fontWeight: 500 }}>{w.operation}</span>
                  <span style={{ color: 'var(--r-ink-4)' }}>→</span>
                  <span>{w.target}</span>
                  <span className={`sev ${w.reversible ? 'sev-low' : 'sev-high'}`}>
                    {w.reversible ? 'reversible' : 'irreversible'}
                  </span>
                  {w.volumePerDay && w.volumePerDay !== 'NOT PROVIDED' && (
                    <span className="mono" style={{ color: 'var(--r-ink-4)', fontSize: 11.5 }}>
                      {w.volumePerDay}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Compliance — concern-grouped ── */
// Backend stores framework as e.g. "ISO/IEC 42001 — A.6.2.6, A.6.2.5, A.9.2"
// — the control IDs are baked into the name. Strip them so we can render
// a clean framework name + a single mono chip for refs (instead of two
// duplicated lists side-by-side).
function frameworkName(raw: string): string {
  // Match common separators: em-dash, en-dash, hyphen.
  const dashIdx = raw.search(/\s+[—–-]\s+/);
  return dashIdx > 0 ? raw.slice(0, dashIdx).trim() : raw.trim();
}

// Strip the framework-specific "Activates <Framework> controls (<ids>)."
// sentence from the bucket headline. Each backend flag carries its own
// description naming a single framework (mapper.mjs `describeFinding`),
// but a concern bucket aggregates flags from every activated framework
// — naming one in the body misleads readers into thinking it's the
// "primary" basis when really all the frameworks listed in the Affects
// row apply equally. We also strip the GDPR / EU AI Act jurisdictional
// disclaimer that disclaimerFor() appends, since the headline shouldn't
// privilege those frameworks either.
function genericConcernBody(description: string): string {
  let out = description;
  // "Activates ISO/IEC 42001 controls (A.6.2.6, A.6.2.5)." (controls list optional)
  out = out.replace(/\s*Activates\s+[^.]+?\s+controls?(?:\s*\([^)]*\))?\.\s*/g, ' ');
  // "Applies if offering goods/services to EU data subjects ..." (GDPR)
  out = out.replace(/\s*Applies if offering goods\/services to EU[^.]*\.\s*/g, ' ');
  // "Applies if placing AI on the EU market, ..." (EU AI Act)
  out = out.replace(/\s*Applies if placing AI on the EU market[^.]*\.\s*/g, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

// Group by the cleaned framework name so multiple flags activating the
// same framework with different controls collapse to one chip.
function ConcernCard({ bucket, flags }: { bucket: ConcernBucket; flags: RegulatoryFlag[] }) {
  const byFramework = new Map<
    string,
    { framework: string; controls: Set<string>; severity: FlagSeverity }
  >();
  for (const f of flags) {
    const key = frameworkName(f.framework);
    if (!byFramework.has(key)) {
      byFramework.set(key, { framework: key, controls: new Set(), severity: f.severity });
    }
    const entry = byFramework.get(key)!;
    for (const c of f.controlIds ?? []) entry.controls.add(c);
    if (severityRank(f.severity) > severityRank(entry.severity)) entry.severity = f.severity;
  }

  const worst = flags.reduce<FlagSeverity>(
    (acc, f) => (severityRank(f.severity) > severityRank(acc) ? f.severity : acc),
    'info',
  );
  const headline = genericConcernBody(flags[0]?.description ?? '');
  const triggers = Array.from(
    new Set(flags.map((f) => f.triggeredBy).filter((t): t is string => !!t && t.trim().length > 0)),
  );

  return (
    <div className="concern">
      <div className="concern-head">
        <span className={`dot ${flagSeverityDot(worst)}`} style={{ width: 9, height: 9 }} />
        <h3 className="concern-title">{BUCKET_LABELS[bucket]}</h3>
        <span className={`sev ${flagSeverityClass(worst)}`}>{flagSeverityLabel(worst)}</span>
      </div>

      <p className="concern-body">{headline}</p>

      {triggers.length > 0 && (
        <details>
          <summary>Show specifics</summary>
          <ul>
            {triggers.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="concern-affects">
        <div className="field-label">Affects</div>
        <div className="row-tight" style={{ gap: 6 }}>
          {Array.from(byFramework.values()).map((f) => (
            <div key={f.framework} className="fw-chip">
              <span className="fw-name">{f.framework}</span>
              {f.controls.size > 0 && (
                <span className="fw-refs">{Array.from(f.controls).join(' · ')}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ComplianceConcerns({ flags }: { flags: RegulatoryFlag[] }) {
  // Group by trigger-derived bucket — matches OSS Heron's published
  // section ordering (Data handling → Write ops → Decisions → Regulatory).
  const byBucket = new Map<ConcernBucket, RegulatoryFlag[]>();
  for (const f of flags) {
    const k = bucketFor(f);
    if (!byBucket.has(k)) byBucket.set(k, []);
    byBucket.get(k)!.push(f);
  }

  const sections = BUCKET_ORDER.map((b) => ({ bucket: b, flags: byBucket.get(b) ?? [] })).filter(
    (s) => s.flags.length > 0,
  );

  if (sections.length === 0) {
    return (
      <p style={{ fontSize: 12.5, color: 'var(--r-ink-3)', fontStyle: 'italic' }}>
        No regulatory concerns activated by this audit.
      </p>
    );
  }

  return (
    <div className="stack-md">
      {sections.map(({ bucket, flags }) =>
        bucket === 'other' ? (
          <div key="other" className="concern">
            <div className="concern-head">
              <h3 className="concern-title">{BUCKET_LABELS.other}</h3>
            </div>
            <div className="stack-md">
              {flags.map((f, i) => (
                <div key={i} style={{ fontSize: 13, color: 'var(--r-ink-2)' }}>
                  <div className="row-tight" style={{ marginBottom: 4 }}>
                    <span style={{ fontWeight: 600 }}>{f.framework}</span>
                    <span className={`sev ${flagSeverityClass(f.severity)}`}>
                      {flagSeverityLabel(f.severity)}
                    </span>
                  </div>
                  <p
                    style={{ margin: 0, color: 'var(--r-ink-3)', fontSize: 12.5, lineHeight: 1.55 }}
                  >
                    {f.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <ConcernCard key={bucket} bucket={bucket} flags={flags} />
        ),
      )}
    </div>
  );
}

function CategorizedComplianceView({ compliance }: { compliance: CategorizedCompliance }) {
  const allFlags =
    compliance.all && compliance.all.length > 0
      ? compliance.all
      : [...Object.values(compliance.mandatory).flat(), ...Object.values(compliance.voluntary).flat()];

  const euClass = compliance.euAiActClassification?.classification ?? 'unclassified';
  const annexCats = compliance.euAiActClassification?.annexIIICategories ?? [];
  const activated = compliance.frameworksActivated ?? [];

  return (
    <div>
      <p style={{ fontSize: 12, color: 'var(--r-ink-4)', marginBottom: 12, fontStyle: 'italic' }}>
        Advisory only. Mappings indicate which framework clauses a finding typically activates — not
        certification that controls are satisfied. Consult qualified legal counsel.
      </p>

      <div className="eu-banner">
        <div className="eu-banner-help">
          Only frameworks <strong>activated by at least one finding</strong> in this audit are
          listed below. Frameworks whose controls weren&apos;t triggered are not shown. The EU AI
          Act risk-tier classification (when applicable) appears inline in parentheses.
        </div>
        <div className="eu-row">
          <span className="eu-label">Frameworks activated:</span>
          {activated.length === 0 ? (
            <span style={{ fontSize: 11.5, color: 'var(--r-ink-4)', fontStyle: 'italic' }}>
              none
            </span>
          ) : (
            activated.map((id) => {
              const baseLabel = FRAMEWORK_LABELS[id] ?? id;
              // EU AI Act gets its risk-tier classification inline in parens.
              // No other framework has a built-in classification concept, so
              // they render as plain chips.
              if (id === 'eu-ai-act' && euClass !== 'unclassified') {
                // Build a clean inline label. We don't reuse EU_CLASS_LABELS
                // verbatim because 'high-risk' renders as 'High-Risk (Annex
                // III)' — the parenthesized "(Annex III)" would clash with
                // the outer parens and is already covered by annexCats.
                const inlineClass = EU_INLINE_LABELS[euClass];
                const cats = annexCats.length > 0 ? ` — ${annexCats.join(', ')}` : '';
                const isHighRisk = euClass === 'prohibited' || euClass === 'high-risk';
                return (
                  <span
                    key={id}
                    className={`eu-fw${isHighRisk ? ' eu-fw-warn' : ''}`}
                  >
                    {baseLabel} ({inlineClass}{cats})
                  </span>
                );
              }
              return (
                <span key={id} className="eu-fw">
                  {baseLabel}
                </span>
              );
            })
          )}
        </div>
        {/* mappingVersion is an internal debug identifier from the
            backend; not useful to readers. Omitted from UI. */}
      </div>

      <ComplianceConcerns flags={allFlags} />

      <ObligationsRequiringReview />
    </div>
  );
}

/* ── Deployer obligations the audit can't verify alone ──
   Same canonical list and framing OSS Heron renders. Keeps buyer-facing
   reports consistent across our deployments. */
function ObligationsRequiringReview() {
  return (
    <div style={{ marginTop: 28 }}>
      <div
        style={{
          fontFamily: 'var(--r-font-mono)',
          fontSize: 11,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--r-ink-3)',
          marginBottom: 8,
          fontWeight: 600,
        }}
      >
        Obligations Requiring Further Review
      </div>
      <p
        style={{
          fontSize: 12.5,
          color: 'var(--r-ink-3)',
          margin: '0 0 12px',
          fontStyle: 'italic',
          lineHeight: 1.55,
        }}
      >
        The following cannot be assessed from this interview alone — the deployer must address them
        independently.
      </p>
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: 200 }}>Obligation</th>
            <th>Action required</th>
          </tr>
        </thead>
        <tbody>
          {DEPLOYER_OBLIGATIONS.map((o) => (
            <tr key={o.ref}>
              <td
                className="mono"
                style={{ fontSize: 12, color: 'var(--r-ink-2)', fontWeight: 500 }}
              >
                {o.ref}
              </td>
              <td style={{ color: 'var(--r-ink-2)', fontSize: 13, lineHeight: 1.55 }}>
                {o.action}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LegacyComplianceView({ compliance }: { compliance: LegacyRegulatoryCompliance }) {
  const labels: Record<'eu' | 'us' | 'uk', string> = {
    eu: 'EU (EU AI Act + GDPR)',
    us: 'US (SOC 2 + State AI Laws)',
    uk: 'UK (UK GDPR + ICO Guidance)',
  };
  return (
    <div>
      <p style={{ fontSize: 12, color: 'var(--r-ink-4)', marginBottom: 12, fontStyle: 'italic' }}>
        Advisory only. Consult qualified legal counsel for compliance decisions.
        <span style={{ marginLeft: 8, fontSize: 10 }}>(legacy report — pre-compliance-module)</span>
      </p>
      <div>
        {(['eu', 'us', 'uk'] as const).map((j) => {
          const flags = compliance[j];
          if (!flags || flags.length === 0) return null;
          return (
            <div key={j} className="concern">
              <div className="concern-head">
                <h3 className="concern-title">{labels[j]}</h3>
              </div>
              <div className="stack-md">
                {flags.map((f, i) => (
                  <div key={i} style={{ fontSize: 13, color: 'var(--r-ink-2)' }}>
                    <div className="row-tight" style={{ marginBottom: 4 }}>
                      <span style={{ fontWeight: 600 }}>{f.framework}</span>
                      <span className={`sev ${flagSeverityClass(f.severity)}`}>
                        {flagSeverityLabel(f.severity)}
                      </span>
                      {f.controlIds && f.controlIds.length > 0 && (
                        <span
                          className="mono"
                          style={{ fontSize: 10.5, color: 'var(--r-ink-3)' }}
                        >
                          {f.controlIds.join(' · ')}
                        </span>
                      )}
                    </div>
                    <p
                      style={{ margin: 0, color: 'var(--r-ink-3)', fontSize: 12.5, lineHeight: 1.55 }}
                    >
                      {f.description}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Markdown fallback ── */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function markdownToHtml(md: string): string {
  let html = escapeHtml(md)
    .replace(/^### (.+)$/gm, '<h3 class="text-base font-semibold text-slate-800 mt-4 mb-1">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-lg font-semibold text-slate-800 mt-5 mb-1">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-xl font-bold text-slate-900 mt-6 mb-2">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code class="rounded bg-slate-100 px-1 py-0.5 text-xs font-mono">$1</code>')
    .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc text-slate-600">$1</li>')
    .replace(/^(?!<[hlu]|<li)(.+)$/gm, '<p class="text-sm text-slate-600 mb-2">$1</p>');
  html = html.replace(
    /(<li[^>]*>.*?<\/li>\n?)+/g,
    (match) => `<ul class="my-2 space-y-1">${match}</ul>`,
  );
  return html;
}

/* ── Anchor rail ── */
function AnchorRail({
  items,
  active,
}: {
  items: { id: string; label: string }[];
  active: string;
}) {
  // Programmatic scroll instead of native href="#sec-x" — the browser may
  // pick the wrong scrollable ancestor when several are nested (page shell
  // + .body inside SessionDetail). scrollIntoView walks up to the nearest
  // scroll parent, which is .body.
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <nav className="anchor-rail">
      {items.map((it) => (
        <a
          key={it.id}
          href={`#${it.id}`}
          onClick={(e) => onClick(e, it.id)}
          className={active === it.id ? 'active' : ''}
        >
          {it.label}
        </a>
      ))}
    </nav>
  );
}

/* ── Main ReportView ──
   Note: Download .md lives in SessionDetail's topbar now (next to
   Share), not inside the report body. ReportView still receives the
   markdown string for the legacy markdown-only fallback path. */
export default function ReportView({
  report,
  reportJson,
}: {
  report: string;
  reportJson?: unknown;
  riskLevel?: string;
}) {
  const [activeAnchor, setActiveAnchor] = useState<string>('sec-scope');
  const reportRootRef = useRef<HTMLDivElement>(null);

  const json = reportJson as ReportJson | undefined;

  const hasInterviewBody = !!(json && Array.isArray(json.systems) && json.systems.length > 0);
  const hasMcpBody = !!(
    json &&
    (json.mcpInventory || json.declaredDiff || json.oauthScopes || json.localAgentDiscovery)
  );

  useEffect(() => {
    if (!hasInterviewBody && !hasMcpBody) return;
    const ids = [
      'sec-scope',
      'sec-summary',
      'sec-findings',
      'sec-systems',
      'sec-working',
      'sec-verdict',
      'sec-compliance',
      'sec-quality',
      'sec-mcp-inventory',
      'sec-declared-diff',
      'sec-oauth-scopes',
      'sec-discovery',
    ];

    // The actual scroll container is .report-shell > .body (set up by
    // SessionDetail). Walk up from our root to find it; fall back to
    // viewport (null) if not present.
    const root =
      reportRootRef.current?.closest('.body') as HTMLElement | null ?? null;

    // Track which sections have ever entered the viewport; pick the one
    // closest to the top of the scroll container as active. Plain
    // `isIntersecting` sets the wrong active when scrolling past a
    // section that briefly intersects on its way out.
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        if (visible.size === 0) return;
        // Pick the topmost visible section by source order.
        for (const id of ids) {
          if (visible.has(id)) {
            setActiveAnchor(id);
            return;
          }
        }
      },
      { root, rootMargin: '-10% 0px -70% 0px', threshold: 0 },
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [hasInterviewBody, hasMcpBody]);

  // ── MCP-scan branch ──────────────────────────────────────────────────
  // A `heron scan --mcp` report carries no interview systems but at least
  // one of the new MCP sections. Render those alone (no interview body)
  // and skip the legacy markdown fallback.
  if (!hasInterviewBody && hasMcpBody && json) {
    const mcpAnchors: { id: string; label: string }[] = [];
    if (json.mcpInventory) mcpAnchors.push({ id: 'sec-mcp-inventory', label: 'MCP Inventory' });
    if (json.declaredDiff) mcpAnchors.push({ id: 'sec-declared-diff', label: 'Declared Diff' });
    if (json.oauthScopes) mcpAnchors.push({ id: 'sec-oauth-scopes', label: 'OAuth Scopes' });
    if (json.localAgentDiscovery)
      mcpAnchors.push({ id: 'sec-discovery', label: 'Local Discovery' });
    return (
      <div className="report" ref={reportRootRef}>
        <VerdictBanner
          verdict={json.overallRiskLevel?.toUpperCase() ?? 'MCP SCAN'}
          meta={json.mcpInventory ? `${json.mcpInventory.tools.length} tools · ${json.mcpInventory.server}` : null}
        />
        {mcpAnchors.length > 0 && <AnchorRail items={mcpAnchors} active={activeAnchor} />}
        {json.summary && (
          <p
            style={{
              fontSize: 14,
              lineHeight: 1.65,
              color: 'var(--r-ink-2)',
              margin: '0 0 16px',
            }}
          >
            {json.summary}
          </p>
        )}
        {json.mcpInventory && <McpInventorySectionComponent inventory={json.mcpInventory} />}
        {json.declaredDiff && <DeclaredDiffSectionComponent diff={json.declaredDiff} />}
        {json.oauthScopes && <OAuthScopesSectionComponent scopes={json.oauthScopes} />}
        {json.localAgentDiscovery && (
          <LocalDiscoverySectionComponent discovery={json.localAgentDiscovery} />
        )}
        <div className="footer">
          <span>Heron · MCP scan report v1</span>
          <span>Generated by `heron scan --mcp`</span>
        </div>
      </div>
    );
  }

  if (!hasInterviewBody) {
    // Legacy markdown-only path. SessionDetail's topbar still shows
    // Download .md so the user can grab the source.
    return (
      <div className="report">
        <div
          className="prose prose-sm max-w-none"
          dangerouslySetInnerHTML={{ __html: markdownToHtml(report) }}
        />
      </div>
    );
  }

  let verdict = json.recommendation ?? 'APPROVE WITH CONDITIONS';
  if (verdict === 'APPROVE') verdict = 'APPROVE WITH CONDITIONS';

  const sortedRisks = [...json.risks].sort(
    (a, b) => severityOrder(b.severity) - severityOrder(a.severity),
  );
  const findingsWithMeta = sortedRisks.map((r, i) => ({
    ...r,
    id: `HERON-${String(i + 1).padStart(3, '0')}`,
    domain: inferDomain(r),
    frameworkBasis: frameworkBasisFor(r, json.regulatoryCompliance),
  }));

  const businessSystems = json.systems.filter(isBusinessSystem);

  const excessiveBySystem = new Map<string, string[]>();
  for (const sys of businessSystems) {
    for (const scope of sys.scopesDelta) {
      if (scope !== 'NOT PROVIDED') {
        if (!excessiveBySystem.has(sys.systemId)) excessiveBySystem.set(sys.systemId, []);
        // AAP-62 round-3 — strip the repetitive "Unused in this audit
        // task so far:" / "Unused in this task:" lead-in the analyzer
        // LLM tends to prepend to every excessive-scope entry. The
        // section header above already says "Permissions delta —
        // excessive (revokable)"; repeating the same lead-in 7 times
        // below it is pure noise. Also drop trailing source refs like
        // " (A11)." that don't add information at this level of
        // summary.
        const cleaned = scope
          .replace(/^\s*Unused in this(?:\s+(?:audit\s+task|task))?\s+so\s+far\s*:?\s*/i, '')
          .replace(/^\s*Unused (?:in this )?(?:audit )?task(?:\s+so\s+far)?\s*:?\s*/i, '')
          .replace(/\s*\(A\d+\)\s*\.?\s*$/i, '')
          .trim();
        excessiveBySystem.get(sys.systemId)!.push(cleaned || scope);
      }
    }
  }

  const countBySev = (sev: string) => json.risks.filter((r) => r.severity === sev).length;
  const sevCounts = [
    { label: 'Critical', count: countBySev('critical'), cls: 'sev-critical' },
    { label: 'High', count: countBySev('high'), cls: 'sev-high' },
    { label: 'Medium', count: countBySev('medium'), cls: 'sev-medium' },
    { label: 'Low', count: countBySev('low'), cls: 'sev-low' },
  ].filter((s) => s.count > 0);

  const allWrites = businessSystems.flatMap((s) => s.writeOperations);
  const positives: string[] = [];
  if (allWrites.length > 0 && allWrites.every((w) => w.reversible)) {
    positives.push('All write operations are reversible');
  }
  const totalExcessive = businessSystems.reduce((n, s) => n + s.scopesDelta.length, 0);
  if (totalExcessive === 0 && businessSystems.length > 0) {
    positives.push('No excessive permissions detected — follows least-privilege principle');
  }
  if (
    businessSystems.length > 0 &&
    businessSystems.every((s) => s.blastRadius === 'single-user' || s.blastRadius === 'single-record')
  ) {
    positives.push('Blast radius limited to single user/record');
  }
  if (allWrites.length > 0 && allWrites.some((w) => w.approvalRequired)) {
    positives.push('Some write operations require approval before execution');
  }
  if (json.makesDecisionsAboutPeople === false) {
    positives.push('Does not make automated decisions about people');
  }

  const anchorItems = [
    { id: 'sec-scope', label: 'Scope' },
    { id: 'sec-summary', label: 'Summary' },
    { id: 'sec-findings', label: 'Findings' },
    { id: 'sec-systems', label: 'Systems' },
    ...(positives.length > 0 ? [{ id: 'sec-working', label: 'Working' }] : []),
    { id: 'sec-verdict', label: 'Verdict' },
    ...(json.regulatoryCompliance ? [{ id: 'sec-compliance', label: 'Compliance' }] : []),
    ...(json.dataQuality ? [{ id: 'sec-quality', label: 'Data quality' }] : []),
    ...(json.mcpInventory ? [{ id: 'sec-mcp-inventory', label: 'MCP Inventory' }] : []),
    ...(json.declaredDiff ? [{ id: 'sec-declared-diff', label: 'Declared Diff' }] : []),
    ...(json.oauthScopes ? [{ id: 'sec-oauth-scopes', label: 'OAuth Scopes' }] : []),
    ...(json.localAgentDiscovery ? [{ id: 'sec-discovery', label: 'Local Discovery' }] : []),
  ];

  const overallRiskClass = (() => {
    const lv = (json.overallRiskLevel || '').toLowerCase();
    if (lv === 'critical') return 'sev-critical';
    if (lv === 'high') return 'sev-high';
    if (lv === 'medium') return 'sev-medium';
    if (lv === 'low') return 'sev-low';
    return 'sev-info';
  })();

  return (
    <div className="report" ref={reportRootRef}>
      {/* Top verdict — short tl;dr above the rail. Download .md is in
          the page topbar; we don't repeat it here. */}
      <VerdictBanner
        verdict={verdict}
        meta={
          json.metadata
            ? `${json.metadata.questionsAsked} questions · ${formatDuration(
                json.metadata.interviewDuration,
              )} · ${json.metadata.date}`
            : null
        }
      />

      <AnchorRail items={anchorItems} active={activeAnchor} />

      {/* 01 Scope & Methodology */}
      <SectionHead num="01" id="sec-scope" label="Scope & Methodology" />
      <dl className="kv">
        <dt>Assessment type</dt>
        <dd>
          Automated structured interview
          {json.metadata &&
            ` (${json.metadata.questionsAsked} questions, ${formatDuration(
              json.metadata.interviewDuration,
            )})`}
        </dd>
        <dt>Coverage</dt>
        <dd>
          Agent purpose, data access, permissions, write operations, operational frequency,
          decision-making impact
        </dd>
        <dt>Limitations</dt>
        <dd className="muted" style={{ fontStyle: 'italic' }}>
          Based on self-reported information. No runtime analysis, code review, or network traffic
          inspection performed.
        </dd>
      </dl>

      {/* 02 Executive Summary */}
      <SectionHead
        num="02"
        id="sec-summary"
        label="Executive Summary"
        meta={`${businessSystems.length} systems · ${
          sevCounts.map((s) => `${s.count} ${s.label[0]}`).join(' · ') || '0 findings'
        }`}
      />
      <div
        className="row"
        style={{
          gap: 24,
          marginBottom: 14,
          fontFamily: 'var(--r-font-mono)',
          fontSize: 12,
          flexWrap: 'wrap',
        }}
      >
        <span>
          <span className="muted" style={{ marginRight: 6, fontSize: 10.5, letterSpacing: '0.1em' }}>
            RISK
          </span>
          <span className={`sev ${overallRiskClass}`}>{json.overallRiskLevel}</span>
        </span>
        <span>
          <span className="muted" style={{ marginRight: 6, fontSize: 10.5, letterSpacing: '0.1em' }}>
            SYSTEMS
          </span>
          <span style={{ color: 'var(--r-ink)', fontWeight: 600 }}>{businessSystems.length}</span>
        </span>
        <span className="row-tight">
          <span className="muted" style={{ marginRight: 6, fontSize: 10.5, letterSpacing: '0.1em' }}>
            FINDINGS
          </span>
          {sevCounts.length === 0 ? (
            <span className="muted">None</span>
          ) : (
            sevCounts.map((s) => (
              <span key={s.label} className={`sev ${s.cls}`}>
                {s.count} {s.label}
              </span>
            ))
          )}
        </span>
      </div>
      <p
        style={{
          fontSize: 14,
          lineHeight: 1.65,
          color: 'var(--r-ink-2)',
          margin: '0 0 16px',
        }}
      >
        {json.summary}
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 12,
        }}
      >
        {[
          { label: 'Purpose', body: json.agentPurpose },
          { label: 'Trigger', body: json.agentTrigger },
          {
            label: 'Owner',
            body: json.agentOwner === 'NOT PROVIDED' ? undefined : json.agentOwner,
          },
        ].map((b) =>
          b.body ? (
            <div key={b.label} className="panel panel-pad panel-muted">
              <div className="field-label">{b.label}</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--r-ink-2)' }}>
                {b.body}
              </div>
            </div>
          ) : null,
        )}
      </div>

      {/* 03 Findings */}
      <SectionHead
        num="03"
        id="sec-findings"
        label="Findings"
        title="Risk-rated issues with remediations"
        meta={`${findingsWithMeta.length} total`}
      />
      {findingsWithMeta.length > 0 ? (
        <FindingsByTier findings={findingsWithMeta} />
      ) : (
        <p style={{ fontSize: 12.5, color: 'var(--r-ink-3)', fontStyle: 'italic' }}>
          No risk findings raised.
        </p>
      )}

      {/* 04 Systems & Access */}
      <SectionHead
        num="04"
        id="sec-systems"
        label="Systems & Access"
        title="External integrations grouped by risk"
        meta={`${businessSystems.length} ${businessSystems.length === 1 ? 'system' : 'systems'}`}
      />
      <SystemsGrouped systems={businessSystems} />

      {/* 05 Working Controls */}
      {positives.length > 0 && (
        <>
          <SectionHead num="05" id="sec-working" label="Controls Working as Expected" />
          <div className="working">
            <div className="working-label">Controls working as expected</div>
            <ul>
              {positives.map((p, i) => (
                <li key={i}>
                  <span className="check">✓</span>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {/* 06 Verdict & Recommendations */}
      <SectionHead num="06" id="sec-verdict" label="Verdict & Recommendations" />
      <div style={{ marginBottom: 16 }}>
        <VerdictBanner verdict={verdict} />
      </div>

      {json.recommendations.length > 0 && (
        <ol className="numlist">
          {json.recommendations.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ol>
      )}

      {excessiveBySystem.size > 0 && (
        <div className="panel panel-pad" style={{ marginTop: 20 }}>
          <div className="field-label">Permissions delta — excessive (revokable)</div>
          <div className="stack-md">
            {Array.from(excessiveBySystem.entries()).map(([system, scopes]) => (
              <div key={system}>
                <div
                  style={{
                    fontSize: 13,
                    color: 'var(--r-ink)',
                    fontWeight: 500,
                    marginBottom: 8,
                    wordBreak: 'break-word',
                  }}
                >
                  {system}
                </div>
                <div className="stack" style={{ gap: 6 }}>
                  {scopes.map((s, i) => {
                    // The backend's `scopesDelta` field is sometimes a short
                    // token (e.g. "drive.file") and sometimes a long
                    // descriptive sentence explaining WHY a scope is
                    // excessive. Long entries render as readable note
                    // panels (sans, slate ink, soft orange accent);
                    // short entries as chips.
                    const isLong = s.length > 60 || /\s.+\s/.test(s);
                    return isLong ? (
                      <div key={i} className="delta-note">
                        {s}
                      </div>
                    ) : (
                      <span key={i} className="scope-chip excess">
                        {s}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 07 Compliance Detail */}
      {json.regulatoryCompliance && (
        <>
          <SectionHead
            num="07"
            id="sec-compliance"
            label="Compliance Detail"
            title="Risks grouped by concern, mapped across frameworks"
          />
          {isCategorizedCompliance(json.regulatoryCompliance) ? (
            <CategorizedComplianceView compliance={json.regulatoryCompliance} />
          ) : (
            <LegacyComplianceView compliance={json.regulatoryCompliance} />
          )}
        </>
      )}

      {/* 08 Data Quality */}
      {json.dataQuality && (
        <>
          <SectionHead
            num="08"
            id="sec-quality"
            label="Data Quality"
            title="What the agent reported"
          />

          <div className="spread" style={{ marginBottom: 8, fontSize: 12.5 }}>
            <span className="muted">
              {json.dataQuality.fieldsProvided.length} of{' '}
              {json.dataQuality.fieldsProvided.length + json.dataQuality.fieldsMissing.length} fields
              collected
            </span>
            <span className="mono muted">{json.dataQuality.score}/100</span>
          </div>

          <div className="bar-track" style={{ marginBottom: 14 }}>
            <div
              className={`bar-fill ${
                json.dataQuality.score >= 80
                  ? ''
                  : json.dataQuality.score >= 60
                    ? 'warn'
                    : 'crit'
              }`}
              style={{ width: `${json.dataQuality.score}%` }}
            />
          </div>

          {json.dataQuality.repeatedAnswers > 0 && (
            <div className="info-banner">
              <span aria-hidden>ℹ</span>
              <span>
                {json.dataQuality.repeatedAnswers} of {json.dataQuality.totalQuestions} answers were
                repeated/canned responses. Data may be incomplete.
              </span>
            </div>
          )}

          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 220 }}>Field</th>
                <th>What it measures</th>
                <th style={{ width: 120 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {json.dataQuality.fieldsProvided.map((f) => (
                <tr key={f}>
                  <td className="mono" style={{ fontSize: 12, color: 'var(--r-ink-2)' }}>
                    {f}
                  </td>
                  <td className="muted">{fieldDescriptions[f] ?? ''}</td>
                  <td>
                    <span className="sev sev-low">provided</span>
                  </td>
                </tr>
              ))}
              {json.dataQuality.fieldsMissing.map((f) => (
                <tr key={f}>
                  <td className="mono" style={{ fontSize: 12, color: 'var(--r-ink-2)' }}>
                    {f}
                  </td>
                  <td className="muted">{fieldDescriptions[f] ?? ''}</td>
                  <td>
                    <span className="sev sev-critical">missing</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {/* MCP-scan sections — rendered alongside the interview body when
          a single AuditSession carries both halves (rare; defensive). */}
      {json.mcpInventory && <McpInventorySectionComponent inventory={json.mcpInventory} />}
      {json.declaredDiff && <DeclaredDiffSectionComponent diff={json.declaredDiff} />}
      {json.oauthScopes && <OAuthScopesSectionComponent scopes={json.oauthScopes} />}
      {json.localAgentDiscovery && (
        <LocalDiscoverySectionComponent discovery={json.localAgentDiscovery} />
      )}

      {/* Footer */}
      <div className="footer">
        <span>Heron · audit report v1{json.metadata && ` · ${json.metadata.date}`}</span>
        <span>Generated by interview agent</span>
      </div>
    </div>
  );
}
