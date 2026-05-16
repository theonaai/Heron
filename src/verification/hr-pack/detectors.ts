/**
 * 7 HR-vertical signal detectors (AAP-51).
 *
 * Each detector is a PURE function: given `VerificationSignals` it
 * returns one `HRSignal`. No I/O, no async, no shared state. The HR
 * router (`router.ts`) is responsible for the HR-agent gate; detectors
 * here assume they have already been called on an HR agent.
 *
 * Detectors share a small set of signal-extraction helpers (defined at
 * the top of this module) but the per-detector body is intentionally
 * kept readable in-place so the next reviewer can audit each rule
 * without chasing helper closures. Per-detector verbosity is a feature.
 *
 * Pattern lists (scope substrings, tool-name regexes, purpose-keyword
 * regexes) are exported as `readonly` so a future contributor can grep
 * for them when extending the heuristic.
 *
 * Tracking: https://linear.app/theona/issue/AAP-51
 */

import type { VerificationSignals } from '../frameworks/router.js';
import type { ActualScope, ActualTool } from '../types.js';
import type { HRSignal, HRSignalEvidenceRef } from './types.js';

// ─── Pattern banks ────────────────────────────────────────────────────────

/** Scope patterns indicating candidate-rejection capability. */
const REJECTION_SCOPE_PATTERNS: readonly string[] = [
  'candidates:reject',
  'applications:reject',
  ':reject',
];

/** Tool-name patterns indicating candidate-rejection capability. */
const REJECTION_TOOL_PATTERNS: readonly RegExp[] = [
  /^reject[_-]/i,
  /^decline[_-]/i,
];

/** ATS-side write scopes that exceed a sourcing/scheduling/outreach scope. */
const ATS_WRITE_SCOPE_PATTERNS: readonly string[] = [
  'candidates:write',
  'applications:write',
  'jobs:write',
  'offers:write',
];

/** Purpose keywords that indicate "outreach / sourcing / scheduling only". */
const NARROW_PURPOSE_PATTERNS: readonly RegExp[] = [
  /\boutreach\b/i,
  /\bsourcing\b/i,
  /\bsourc\w*/i,
  /\bscheduling\b/i,
  /\bschedul\w*/i,
];

/** PII-exposing scopes (gmail/drive/directory readonly). */
const PII_SCOPE_PATTERNS: readonly string[] = [
  'gmail.readonly',
  'gmail.metadata',
  'drive.readonly',
  'admin.directory.user.readonly',
  'admin.directory.user',
  'directory:read',
];

/** Scoring/ranking tool name patterns. */
const SCORING_TOOL_PATTERNS: readonly RegExp[] = [
  /^score[_-]/i,
  /^rank[_-]/i,
  /^match[_-]/i,
];

/** Outreach-capable scopes / tool patterns. */
const OUTREACH_SCOPE_PATTERNS: readonly string[] = [
  'gmail.send',
  'mail.send',
  ':send',
  'outreach:',
];
const OUTREACH_TOOL_PATTERNS: readonly RegExp[] = [
  /^send[_-]?email/i,
  /^outreach[_-]/i,
];

/** Offer-letter generation tool patterns. */
const OFFER_TOOL_PATTERNS: readonly RegExp[] = [
  /^generate[_-]offer/i,
  /^send[_-]offer/i,
  /^create[_-]offer[_-]?letter/i,
  /^create[_-]offer/i,
];

/** Sub-agent / orchestration tool patterns. */
const SUBAGENT_TOOL_PATTERNS: readonly RegExp[] = [
  /^run[_-]subagent/i,
  /^delegate[_-]/i,
  /^spawn[_-]/i,
];

// ─── Purpose-text keyword banks ───────────────────────────────────────────

/**
 * Phrases in the declared agent.purpose that indicate the operator has
 * documented a candidate-notification / human-review / GDPR Article 22
 * disclosure. Any one match disarms detector 1.
 */
const DISCLOSURE_KEYWORDS: readonly RegExp[] = [
  /\bnotif/i, // "notify", "notification"
  /\bhuman review\b/i,
  /\bhuman[- ]in[- ]the[- ]loop\b/i,
  /\bgdpr.{0,20}(art|article).{0,5}22/i,
  /\bart\.?\s*22\b/i,
  /\barticle\s*22\b/i,
  /\bcandidate.{0,20}(inform|notif)/i,
];

/** Purpose phrases indicating explicit declaration of write actions. */
const WRITE_ACTION_KEYWORDS: readonly RegExp[] = [
  /\bwrite\s+(notes?|to|back|the)\b/i,
  /\bupdate\s+(candidate|application|stage|status|ats|record)/i,
  /\b(create|update|modify|insert)\s+(records?|notes?|stages?|status)/i,
  /\bstage\s+(move|update|change)/i,
];

/** Purpose phrases indicating logging / retention / PII handling policy. */
const LOGGING_POLICY_KEYWORDS: readonly RegExp[] = [
  /\bretention\s+(policy|period|window)/i,
  /\bscrubb?ed?\s+of\s+pii/i,
  /\blogging\s+policy/i,
  /\bpii\s+(scrub|redact|strip|handling)/i,
  /\blogs?\s+are\s+scrubbed/i,
  /\blog\s+retention/i,
];

/** Purpose phrases indicating scoring criteria are published. */
const SCORING_CRITERIA_KEYWORDS: readonly RegExp[] = [
  /\bcriteria\b/i,
  /\bpublished\s+(criter|rubric|scoring)/i,
  /\brubric\b/i,
];

/** Purpose phrases indicating do-not-contact / consent process. */
const DNC_KEYWORDS: readonly RegExp[] = [
  /\bdo[- ]not[- ]contact\b/i,
  /\bdnc\s+(list|integration)/i,
  /\bdnc\b/i,
  /\bconsent\b/i,
  /\bopt[- ]out\b/i,
  /\bunsubscribe\b/i,
];

/** Purpose phrases indicating salary band + approval workflow. */
const SALARY_BAND_KEYWORDS: readonly RegExp[] = [
  /\bsalary\s+band\b/i,
  /\bcompensation\s+band\b/i,
  /\bpay\s+band\b/i,
  /\boffer\s+approval\b/i,
  /\brequires?\s+approval\b/i,
  /\bapproval\s+(by|workflow|chain)/i,
];

/** Purpose phrases indicating sub-agent architecture is documented. */
const SUBAGENT_ARCH_KEYWORDS: readonly RegExp[] = [
  /\bsub[- ]?agents?\b/i,
  /\bdelegation\b/i,
  /\bscoped\s+oauth\b/i,
  /\binherit.{0,30}scope/i,
  /\bnarrowed\s+scope/i,
  /\barchitecture\s+(diagram|doc)/i,
];

// ─── Helpers ──────────────────────────────────────────────────────────────

function matchesAnyString(value: string, patterns: readonly string[]): boolean {
  const lower = value.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

function matchesAnyRegex(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(value));
}

function findScopesMatching(
  sig: VerificationSignals,
  match: (s: ActualScope) => boolean,
): ActualScope[] {
  const out: ActualScope[] = [];
  for (const inv of sig.actualInventories) {
    for (const s of inv.scopes ?? []) {
      if (match(s)) out.push(s);
    }
  }
  return out;
}

function findToolsMatching(
  sig: VerificationSignals,
  match: (t: ActualTool) => boolean,
): ActualTool[] {
  const out: ActualTool[] = [];
  for (const inv of sig.actualInventories) {
    for (const t of inv.tools ?? []) {
      if (match(t)) out.push(t);
    }
  }
  return out;
}

function hasAnyInventory(sig: VerificationSignals): boolean {
  return sig.actualInventories.length > 0;
}

function hasMCPInventory(sig: VerificationSignals): boolean {
  return sig.actualInventories.some((i) => i.source === 'mcp-tools' || i.tools !== undefined);
}

function purposeText(sig: VerificationSignals): string {
  return sig.declaredInventory?.agent?.purpose ?? '';
}

// ─── Detector 1: auto-rejection without disclosure ────────────────────────

const D1_ID = 'auto-rejection-without-disclosure';
const D1_NAME = 'Auto-Rejection Without Disclosure';
const D1_REC = 'Document candidate notification process OR remove rejection capability.';

export function detectAutoRejectionWithoutDisclosure(sig: VerificationSignals): HRSignal {
  if (!hasAnyInventory(sig)) {
    return {
      signalId: D1_ID,
      name: D1_NAME,
      verdict: 'unverified',
      severity: 'medium',
      rationale: 'No actual inventory available; cannot evaluate candidate-rejection capability.',
      evidenceRefs: [{ kind: 'absence', ref: 'no inventory' }],
      recommendation: D1_REC,
    };
  }
  const scopeMatches = findScopesMatching(sig, (s) => matchesAnyString(s.scope, REJECTION_SCOPE_PATTERNS));
  const toolMatches = findToolsMatching(sig, (t) => matchesAnyRegex(t.name, REJECTION_TOOL_PATTERNS));
  const hasRejection = scopeMatches.length > 0 || toolMatches.length > 0;
  if (!hasRejection) {
    return {
      signalId: D1_ID,
      name: D1_NAME,
      verdict: 'not-detected',
      severity: 'info',
      rationale: 'No candidate-rejection scopes or tools detected.',
      evidenceRefs: [{ kind: 'inventory', ref: 'no rejection capability' }],
      recommendation: D1_REC,
    };
  }
  const purpose = purposeText(sig);
  if (purpose && matchesAnyRegex(purpose, DISCLOSURE_KEYWORDS)) {
    return {
      signalId: D1_ID,
      name: D1_NAME,
      verdict: 'not-detected',
      severity: 'info',
      rationale: 'Rejection capability present and declared purpose documents candidate notification / human review.',
      evidenceRefs: [{ kind: 'declared', ref: 'purpose mentions notification or Article 22 disclosure' }],
      recommendation: D1_REC,
    };
  }
  const refs: HRSignalEvidenceRef[] = [];
  if (scopeMatches[0]) refs.push({ kind: 'inventory', ref: `scope ${scopeMatches[0].service}:${scopeMatches[0].scope}` });
  if (toolMatches[0]) refs.push({ kind: 'inventory', ref: `tool ${toolMatches[0].name}` });
  refs.push({ kind: 'absence', ref: 'purpose does not document notification / human review' });
  return {
    signalId: D1_ID,
    name: D1_NAME,
    verdict: 'detected',
    severity: 'critical',
    rationale:
      'Agent has candidate-rejection capability (scope or tool) but declared purpose does not mention candidate notification, human review, or GDPR Article 22 disclosure. Triggers NYC LL 144 + GDPR Article 22 obligations.',
    evidenceRefs: refs,
    recommendation: D1_REC,
  };
}

// ─── Detector 2: ATS write-scope sprawl ───────────────────────────────────

const D2_ID = 'ats-write-scope-sprawl';
const D2_NAME = 'ATS Write-Scope Sprawl';
const D2_REC = 'Narrow OAuth scope to read-only OR explicitly declare write actions in baseline.';

export function detectATSWriteScopeSprawl(sig: VerificationSignals): HRSignal {
  if (!hasAnyInventory(sig)) {
    return {
      signalId: D2_ID,
      name: D2_NAME,
      verdict: 'unverified',
      severity: 'medium',
      rationale: 'No actual inventory available; cannot evaluate ATS write-scope footprint.',
      evidenceRefs: [{ kind: 'absence', ref: 'no inventory' }],
      recommendation: D2_REC,
    };
  }
  const writes = findScopesMatching(sig, (s) => matchesAnyString(s.scope, ATS_WRITE_SCOPE_PATTERNS));
  if (writes.length === 0) {
    return {
      signalId: D2_ID,
      name: D2_NAME,
      verdict: 'not-detected',
      severity: 'info',
      rationale: 'No ATS write scopes detected.',
      evidenceRefs: [{ kind: 'inventory', ref: 'read-only ATS scopes' }],
      recommendation: D2_REC,
    };
  }
  const purpose = purposeText(sig);
  const narrowPurpose = purpose && matchesAnyRegex(purpose, NARROW_PURPOSE_PATTERNS);
  const writeActionsDeclared = purpose && matchesAnyRegex(purpose, WRITE_ACTION_KEYWORDS);

  if (writeActionsDeclared) {
    return {
      signalId: D2_ID,
      name: D2_NAME,
      verdict: 'not-detected',
      severity: 'info',
      rationale: 'ATS write scopes present and declared purpose explicitly mentions write actions (stage updates, notes, status changes).',
      evidenceRefs: [{ kind: 'declared', ref: 'purpose declares write actions' }],
      recommendation: D2_REC,
    };
  }
  if (narrowPurpose) {
    const example = writes[0]!;
    return {
      signalId: D2_ID,
      name: D2_NAME,
      verdict: 'detected',
      severity: 'high',
      rationale: `ATS write scope '${example.service}:${example.scope}' present but declared purpose describes only narrow read-side activity (outreach / sourcing / scheduling).`,
      evidenceRefs: [
        { kind: 'inventory', ref: `scope ${example.service}:${example.scope}` },
        { kind: 'absence', ref: 'purpose does not declare write actions' },
      ],
      recommendation: D2_REC,
    };
  }
  // Write scope present but purpose is neither narrow nor declares
  // write actions — surface as detected so the operator either narrows
  // the scope or documents the write intent.
  const example = writes[0]!;
  return {
    signalId: D2_ID,
    name: D2_NAME,
    verdict: 'detected',
    severity: 'high',
    rationale: `ATS write scope '${example.service}:${example.scope}' present; declared purpose does not explicitly authorise write actions.`,
    evidenceRefs: [
      { kind: 'inventory', ref: `scope ${example.service}:${example.scope}` },
      { kind: 'absence', ref: 'purpose does not declare write actions' },
    ],
    recommendation: D2_REC,
  };
}

// ─── Detector 3: candidate PII in logs ────────────────────────────────────

const D3_ID = 'candidate-pii-in-logs';
const D3_NAME = 'Candidate PII Exposure In Logs';
const D3_REC = 'Document PII handling in agent logs OR scope to specific candidate folder access.';

export function detectCandidatePIIInLogs(sig: VerificationSignals): HRSignal {
  if (!hasAnyInventory(sig)) {
    return {
      signalId: D3_ID,
      name: D3_NAME,
      verdict: 'unverified',
      severity: 'medium',
      rationale: 'No actual inventory available; cannot evaluate PII-log risk surface.',
      evidenceRefs: [{ kind: 'absence', ref: 'no inventory' }],
      recommendation: D3_REC,
    };
  }
  const piiScopes = findScopesMatching(sig, (s) => matchesAnyString(s.scope, PII_SCOPE_PATTERNS));
  if (piiScopes.length === 0) {
    return {
      signalId: D3_ID,
      name: D3_NAME,
      verdict: 'not-detected',
      severity: 'info',
      rationale: 'No PII-exposing scopes (gmail.readonly, drive.readonly, admin.directory) detected.',
      evidenceRefs: [{ kind: 'inventory', ref: 'no PII-exposing scopes' }],
      recommendation: D3_REC,
    };
  }
  const purpose = purposeText(sig);
  if (purpose && matchesAnyRegex(purpose, LOGGING_POLICY_KEYWORDS)) {
    return {
      signalId: D3_ID,
      name: D3_NAME,
      verdict: 'not-detected',
      severity: 'info',
      rationale: 'PII-exposing scopes present but declared purpose documents a logging / retention / PII-scrubbing policy.',
      evidenceRefs: [{ kind: 'declared', ref: 'purpose documents logging policy' }],
      recommendation: D3_REC,
    };
  }
  const example = piiScopes[0]!;
  return {
    signalId: D3_ID,
    name: D3_NAME,
    verdict: 'detected',
    severity: 'medium',
    rationale: `PII-exposing scope '${example.service}:${example.scope}' present without a declared logging or retention policy. Flags the risk surface; actual log content is not inspected.`,
    evidenceRefs: [
      { kind: 'inventory', ref: `scope ${example.service}:${example.scope}` },
      { kind: 'absence', ref: 'purpose does not document logging policy' },
    ],
    recommendation: D3_REC,
  };
}

// ─── Detector 4: scoring without criteria ─────────────────────────────────

const D4_ID = 'scoring-without-criteria';
const D4_NAME = 'Scoring Without Published Criteria';
const D4_REC = 'Publish scoring criteria in declared baseline OR remove scoring tools.';

export function detectScoringWithoutCriteria(sig: VerificationSignals): HRSignal {
  if (!hasMCPInventory(sig)) {
    return {
      signalId: D4_ID,
      name: D4_NAME,
      verdict: 'unverified',
      severity: 'medium',
      rationale: 'No MCP tool inventory available; cannot evaluate scoring-tool capability.',
      evidenceRefs: [{ kind: 'absence', ref: 'no mcp-tools inventory' }],
      recommendation: D4_REC,
    };
  }
  const scoringTools = findToolsMatching(sig, (t) => matchesAnyRegex(t.name, SCORING_TOOL_PATTERNS));
  if (scoringTools.length === 0) {
    return {
      signalId: D4_ID,
      name: D4_NAME,
      verdict: 'not-detected',
      severity: 'info',
      rationale: 'No scoring or ranking tools detected.',
      evidenceRefs: [{ kind: 'inventory', ref: 'no scoring tools' }],
      recommendation: D4_REC,
    };
  }
  const purpose = purposeText(sig);
  if (purpose && matchesAnyRegex(purpose, SCORING_CRITERIA_KEYWORDS)) {
    return {
      signalId: D4_ID,
      name: D4_NAME,
      verdict: 'not-detected',
      severity: 'info',
      rationale: 'Scoring tool present and declared purpose mentions scoring criteria / rubric.',
      evidenceRefs: [{ kind: 'declared', ref: 'purpose mentions scoring criteria' }],
      recommendation: D4_REC,
    };
  }
  const example = scoringTools[0]!;
  return {
    signalId: D4_ID,
    name: D4_NAME,
    verdict: 'detected',
    severity: 'high',
    rationale: `Scoring/ranking tool '${example.name}' present but declared purpose does not publish scoring criteria. Triggers EU AI Act Annex III §4 transparency obligation.`,
    evidenceRefs: [
      { kind: 'inventory', ref: `tool ${example.name}` },
      { kind: 'absence', ref: 'purpose does not declare scoring criteria' },
    ],
    recommendation: D4_REC,
  };
}

// ─── Detector 5: do-not-contact bypass ────────────────────────────────────

const D5_ID = 'do-not-contact-bypass';
const D5_NAME = 'Do-Not-Contact Bypass';
const D5_REC = 'Document DNC list integration OR scope outreach to candidates with explicit consent.';

export function detectDoNotContactBypass(sig: VerificationSignals): HRSignal {
  if (!hasAnyInventory(sig)) {
    return {
      signalId: D5_ID,
      name: D5_NAME,
      verdict: 'unverified',
      severity: 'medium',
      rationale: 'No actual inventory available; cannot evaluate outreach capability.',
      evidenceRefs: [{ kind: 'absence', ref: 'no inventory' }],
      recommendation: D5_REC,
    };
  }
  const outreachScopes = findScopesMatching(sig, (s) => matchesAnyString(s.scope, OUTREACH_SCOPE_PATTERNS));
  const outreachTools = findToolsMatching(sig, (t) => matchesAnyRegex(t.name, OUTREACH_TOOL_PATTERNS));
  const hasOutreach = outreachScopes.length > 0 || outreachTools.length > 0;
  if (!hasOutreach) {
    return {
      signalId: D5_ID,
      name: D5_NAME,
      verdict: 'not-detected',
      severity: 'info',
      rationale: 'No outreach capability (gmail.send, outreach tools) detected.',
      evidenceRefs: [{ kind: 'inventory', ref: 'no outreach capability' }],
      recommendation: D5_REC,
    };
  }
  const purpose = purposeText(sig);
  if (purpose && matchesAnyRegex(purpose, DNC_KEYWORDS)) {
    return {
      signalId: D5_ID,
      name: D5_NAME,
      verdict: 'not-detected',
      severity: 'info',
      rationale: 'Outreach capability present and declared purpose mentions DNC / consent / opt-out handling.',
      evidenceRefs: [{ kind: 'declared', ref: 'purpose mentions DNC or consent' }],
      recommendation: D5_REC,
    };
  }
  const refs: HRSignalEvidenceRef[] = [];
  if (outreachScopes[0]) refs.push({ kind: 'inventory', ref: `scope ${outreachScopes[0].service}:${outreachScopes[0].scope}` });
  if (outreachTools[0]) refs.push({ kind: 'inventory', ref: `tool ${outreachTools[0].name}` });
  refs.push({ kind: 'absence', ref: 'purpose does not document DNC handling' });
  return {
    signalId: D5_ID,
    name: D5_NAME,
    verdict: 'detected',
    severity: 'high',
    rationale: 'Agent has outreach capability but declared purpose does not document do-not-contact list integration or consent capture. Triggers CAN-SPAM + GDPR Article 21 obligations.',
    evidenceRefs: refs,
    recommendation: D5_REC,
  };
}

// ─── Detector 6: offer letter out of range ────────────────────────────────

const D6_ID = 'offer-letter-out-of-range';
const D6_NAME = 'Offer-Letter Generation Without Salary-Band Approval';
const D6_REC = 'Document salary band approval workflow OR remove offer generation capability.';

export function detectOfferLetterOutOfRange(sig: VerificationSignals): HRSignal {
  if (!hasMCPInventory(sig)) {
    return {
      signalId: D6_ID,
      name: D6_NAME,
      verdict: 'unverified',
      severity: 'medium',
      rationale: 'No MCP tool inventory available; cannot evaluate offer-generation capability.',
      evidenceRefs: [{ kind: 'absence', ref: 'no mcp-tools inventory' }],
      recommendation: D6_REC,
    };
  }
  const offerTools = findToolsMatching(sig, (t) => matchesAnyRegex(t.name, OFFER_TOOL_PATTERNS));
  if (offerTools.length === 0) {
    return {
      signalId: D6_ID,
      name: D6_NAME,
      verdict: 'not-detected',
      severity: 'info',
      rationale: 'No offer-letter generation tools detected.',
      evidenceRefs: [{ kind: 'inventory', ref: 'no offer-generation tools' }],
      recommendation: D6_REC,
    };
  }
  const purpose = purposeText(sig);
  if (purpose && matchesAnyRegex(purpose, SALARY_BAND_KEYWORDS)) {
    return {
      signalId: D6_ID,
      name: D6_NAME,
      verdict: 'not-detected',
      severity: 'info',
      rationale: 'Offer-generation tool present and declared purpose documents salary band / approval workflow.',
      evidenceRefs: [{ kind: 'declared', ref: 'purpose mentions salary band / approval' }],
      recommendation: D6_REC,
    };
  }
  const example = offerTools[0]!;
  return {
    signalId: D6_ID,
    name: D6_NAME,
    verdict: 'detected',
    severity: 'critical',
    rationale: `Offer-generation tool '${example.name}' present but declared purpose does not document a salary band or approval workflow. Heron cannot read offer values; this flags the capability, not specific dollar amounts.`,
    evidenceRefs: [
      { kind: 'inventory', ref: `tool ${example.name}` },
      { kind: 'absence', ref: 'purpose does not document salary-band approval' },
    ],
    recommendation: D6_REC,
  };
}

// ─── Detector 7: sub-agent scope expansion ────────────────────────────────

const D7_ID = 'sub-agent-scope-expansion';
const D7_NAME = 'Sub-Agent Scope Expansion';
const D7_REC = 'Document sub-agent architecture OR remove orchestration tools.';

export function detectSubAgentScopeExpansion(sig: VerificationSignals): HRSignal {
  if (!hasMCPInventory(sig)) {
    return {
      signalId: D7_ID,
      name: D7_NAME,
      verdict: 'unverified',
      severity: 'medium',
      rationale: 'No MCP tool inventory available; cannot evaluate sub-agent orchestration capability.',
      evidenceRefs: [{ kind: 'absence', ref: 'no mcp-tools inventory' }],
      recommendation: D7_REC,
    };
  }
  const subagentTools = findToolsMatching(sig, (t) => matchesAnyRegex(t.name, SUBAGENT_TOOL_PATTERNS));
  if (subagentTools.length === 0) {
    return {
      signalId: D7_ID,
      name: D7_NAME,
      verdict: 'not-detected',
      severity: 'info',
      rationale: 'No sub-agent or orchestration tools detected.',
      evidenceRefs: [{ kind: 'inventory', ref: 'no orchestration tools' }],
      recommendation: D7_REC,
    };
  }
  const purpose = purposeText(sig);
  if (purpose && matchesAnyRegex(purpose, SUBAGENT_ARCH_KEYWORDS)) {
    return {
      signalId: D7_ID,
      name: D7_NAME,
      verdict: 'not-detected',
      severity: 'info',
      rationale: 'Orchestration tool present and declared purpose documents sub-agent architecture.',
      evidenceRefs: [{ kind: 'declared', ref: 'purpose documents sub-agent architecture' }],
      recommendation: D7_REC,
    };
  }
  const example = subagentTools[0]!;
  return {
    signalId: D7_ID,
    name: D7_NAME,
    verdict: 'detected',
    severity: 'high',
    rationale: `Orchestration tool '${example.name}' present but declared purpose does not document a sub-agent architecture. Sub-agents may inherit parent OAuth scopes without explicit narrowing.`,
    evidenceRefs: [
      { kind: 'inventory', ref: `tool ${example.name}` },
      { kind: 'absence', ref: 'purpose does not document sub-agent architecture' },
    ],
    recommendation: D7_REC,
  };
}
