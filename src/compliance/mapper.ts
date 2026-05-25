/**
 * Maps raw audit signals (systems, transcript, decision metadata) onto the
 * framework-control bundles defined in `./control-mappings.ts`.
 *
 * Output shape: `CategorizedCompliance`, grouped by mandatoriness
 * (mandatory vs voluntary) and risk category (privacy / IP /
 * consumer-protection / sector-specific). The report template renders
 * this directly.
 *
 * Post-AAP-42 scope (2026-04-23):
 *   - Framework gating is simpler — only 3 frameworks (EU AI Act, GDPR,
 *     ISO/IEC 42001). All fire whenever the finding fires; no
 *     jurisdiction-specific statutes to narrow-scope.
 *   - EU AI Act controls tagged `annexIII: true` are gated per-control by
 *     the detected Annex III signals (biometrics, education, employment,
 *     essential services, law enforcement). This replaces the prior
 *     two-framework split (`eu-ai-act` + `eu-ai-act-high-risk`).
 *   - The overall EU AI Act classification is computed once per audit and
 *     attached to the `CategorizedCompliance` output so the report can show
 *     a single "EU AI Act — High-Risk (Annex III §3 Education)" label
 *     instead of two separate framework blocks.
 */

import type {
  QAPair,
  RegulatoryFlag,
  SystemAssessment,
} from '../report/types.js';
import { CONTROL_MAPPINGS } from './control-mappings.js';
import { CONTROL_CATALOG } from './control-catalog.js';
import type {
  ControlCatalogEntry,
  ControlResult,
} from './control-catalog.js';
import { stableKeyFor } from './control-key.js';
import type { TypedEvidenceEnvelope } from './detectors/types.js';
import { FRAMEWORKS } from './frameworks.js';
import type {
  ControlMapping,
  EUAIActClassification,
  FindingType,
  Framework,
  FrameworkControl,
  FrameworkId,
  FrameworkTier,
  Jurisdiction,
  RiskCategory,
} from './types.js';
import { MAPPING_VERSION } from './types.js';
import { isBusinessSystem } from '../util/systems.js';
import type {
  SourceVerification,
  VerificationReport,
} from '../verification/types.js';
import type { DiscoveryResult } from '../discovery/types.js';

// ─── Decision impact ────────────────────────────────────────────────────────

export type DecisionImpact = 'high' | 'medium' | 'unclear' | 'none';

export function classifyDecisionImpact(
  decidesAboutPeople: boolean,
  details?: string,
): DecisionImpact {
  if (!decidesAboutPeople) return 'none';
  if (!details || details === 'NOT PROVIDED' || details.trim().length < 10)
    return 'unclear';

  const text = details.toLowerCase();

  const highImpact =
    /\b(hir(e|ing)|recruit|screen.?candidate|reject|deny|approv(e|al|ing).*(loan|credit|mortgage|claim|application)|terminat|fir(e|ing)|credit.?scor|insurance.?claim|diagnos|prescri|legal.?decision|sentenc|parole|bail|evict|expel|suspend|disqualif|ban\b|block.?user|delist)\b/i;
  if (highImpact.test(text)) return 'high';

  const mediumImpact =
    /\b(scor(e|ing)|rank|filter|recommend|prioriti[sz]|moderate|flag|qualif(y|ied)|match|sort|categori[sz]|segment|lead|prospect|outreach|target|personali[sz])\b/i;
  if (mediumImpact.test(text)) return 'medium';

  return 'unclear';
}

// ─── Signal detection ───────────────────────────────────────────────────────

export interface ComplianceSignals {
  hasSensitivePII: boolean;
  hasPublicPII: boolean;
  hasPII: boolean;
  hasHealth: boolean;
  hasEmploymentDecisions: boolean;
  hasWriteOps: boolean;
  hasIrreversibleWrites: boolean;
  hasExcessivePerms: boolean;
  hasScopeCreep: boolean;
  hasOrgBlast: boolean;
  hasOrgBlastWithWrites: boolean;
  decisionImpact: DecisionImpact;
  businessSystems: SystemAssessment[];

  // ── EU AI Act Annex III category signals ───────────────────────────────
  hasBiometricSignal: boolean;           // Annex III §1
  isEducationAssessmentContext: boolean; // Annex III §3
  isLawEnforcementContext: boolean;      // Annex III §6
  hasEssentialServicesSignal: boolean;   // Annex III §5

  // ── AAP-43 P1: conditional GDPR rendering signals ──────────────────────
  /** True if automated decisions affect people (regardless of impact tier). */
  hasDecisionsAboutPeople: boolean;
  /** Data likely crosses EU borders (transcript mentions transfer/US-based processor). */
  hasInternationalTransfer: boolean;
  /** Agent uses third-party SaaS processors (triggers Art. 28 DPA obligation). */
  hasExternalProcessors: boolean;
  /** Heuristic: >=3 business systems OR >=1 org-wide blast radius system. */
  hasLargeScaleProcessing: boolean;

  // ── AIUC-1 architecture signals (AAP-44) ───────────────────────────────
  hasMCPOrA2A: boolean;       // agent uses Model Context Protocol or agent-to-agent
  hasSubAgents: boolean;      // agent spawns sub-agents or chains tool calls
  hasCrossCustomer: boolean;  // agent serves multiple customers in one deployment
}

// EU AI Act Annex III §1 — biometric identification/categorisation/emotion recognition.
const BIOMETRIC_PATTERN = new RegExp(
  '\\b(' + [
    'biometric|facial.?recognition|face.?recognit',
    'voiceprint|voice.?biometric|speaker.?recognit',
    'fingerprint|iris|retina|gait',
    'emotion.?recognition|affect.?detect',
    'liveness|anti.?spoof',
  ].join('|') + ')\\b',
  'i',
);

// EU AI Act Annex III §3 — education/vocational training assessment.
const EDUCATION_ASSESSMENT_PATTERN = new RegExp(
  '\\b(' + [
    'student.?evaluation|grading|exam.?scoring|exam.?proctor',
    'admission|enrollment|school.?assignment',
    'academic.?assessment|learning.?assessment',
    'vocational.?training|apprenticeship',
  ].join('|') + ')\\b',
  'i',
);

// EU AI Act Annex III §6 — law enforcement.
const LAW_ENFORCEMENT_PATTERN = new RegExp(
  '\\b(' + [
    'law.?enforcement|police|prosecut',
    'criminal.?investigation|criminal.?justice',
    'border|immigration|asylum',
    'parole|recidivism|sentenc',
    'predictive.?policing',
  ].join('|') + ')\\b',
  'i',
);

// EU AI Act Annex III §5 — access to essential public/private services.
// §5(a) public assistance benefits eligibility, §5(b) credit scoring/creditworthiness,
// §5(c) emergency service dispatch, §5(d) health/life insurance risk assessment.
const ESSENTIAL_SERVICES_PATTERN = new RegExp(
  '(?:' + [
    '\\bcredit(?:\\s*scor|worthiness|\\s*rating)',  // §5(b) credit scoring / creditworthiness
    '\\b(?:benefit|eligib|welfare|social\\s*service|public\\s*assistance)\\b',
    '\\b(?:emergency|911|triage|dispatch)\\b',
    '\\b(?:life\\s*insur|health\\s*insur|insur(?:ance)?\\s*pric|insur(?:ance)?\\s*risk|underwrit)',
  ].join('|') + ')',
  'i',
);

// isBusinessSystem lives in src/util/systems.ts (shared across report, analyzer, mapper).

// AAP-70 Part B — preprocess transcript text before running category regex.
// Three classes of false-positive matches must be neutralised so that mere
// mentions of Annex III keywords do not trigger high-risk classification:
//   1. Negation windows — "I do not do biometric ID", "no law enforcement"
//      use, "without facial recognition". Drop the keyword inside the window.
//   2. Meta-mentions of three or more Annex III category names in a row —
//      a sentence like "Annex III categories include biometric, education,
//      employment, essential services, law enforcement" is the agent
//      listing the categories, not declaring it uses them. Drop the list.
//   3. Prefix tokens — `skill: investigate-deps`, `tool: web-fetch`,
//      `mcp_server: github`, `connector: slack`, `framework: nist-ai-rmf`.
//      The names live in a structured token, not a regulated activity.
//
// We replace each match with a single space so word boundaries downstream
// stay correct. Apply only to the category-keyword passes (biometric, law
// enforcement, education, essential services). Leave the broader PII /
// write-op / employment regexes on the original text — they have their own
// negation guards (employment) or aren't affected by category-list noise.
const ANNEX_III_KEYWORDS_RE =
  /\b(biometric|facial.?recognition|face.?recognit|voiceprint|fingerprint|iris|retina|gait|emotion.?recognition|liveness|education|grading|exam|admission|enrollment|academic|learning.?assessment|vocational|apprenticeship|employment|hiring|recruit|essential\s+services|public\s+assistance|benefit|credit\s*scor|creditworthiness|emergency|triage|dispatch|life\s*insur|health\s*insur|underwrit|law\s+enforcement|police|prosecut|forensic|criminal|border|immigration|asylum|parole|recidivism|sentenc|predictive.?policing)\b/gi;

// Negation window: a negation cue, up to 80 chars of filler, then an Annex
// III keyword. Then optionally up to 6 more keywords each within 40 chars of
// the prior one (still inside the same sentence — `[^.!?]` stops at
// sentence boundaries). This handles "I do not do biometric, law
// enforcement, or essential services" — the trailing list shares the
// negation scope and all three keywords are scrubbed.
const NEGATION_HEAD =
  '\\b(?:no|not|never|do(?:es)?\\s+not|don\'?t|doesn\'?t|won\'?t|without|cannot|can\'?t)\\b';
const ANNEX_KEYWORDS_INNER = ANNEX_III_KEYWORDS_RE.source.replace(/\\b/g, '');
const NEGATION_WINDOW_RE = new RegExp(
  NEGATION_HEAD +
    '[^.!?]{0,80}?' +
    ANNEX_KEYWORDS_INNER +
    '(?:[^.!?]{0,40}?' +
    ANNEX_KEYWORDS_INNER +
    '){0,6}',
  'gi',
);

// Five Annex III category labels enumerated together → meta-list.
const META_CATEGORY = '(?:biometric|education|employment|essential\\s+services|law\\s+enforcement)';
const META_LIST_RE = new RegExp(
  `\\b${META_CATEGORY}\\b(?:[\\s,;/]+(?:and|or|,)?\\s*\\b${META_CATEGORY}\\b){2,}`,
  'gi',
);

// Structured prefix tokens — `skill: foo`, `tool: bar`, `mcp_server: baz`,
// `connector: qux`, `framework: quux`. Drop the entire token (label + value
// up to whitespace or punctuation).
const STRUCTURED_TOKEN_RE =
  /\b(?:skill|tool|mcp[_\s]?server|connector|framework|plugin|agent)s?\s*[:=]\s*[\w./-]+/gi;

/**
 * Strip Annex III keyword matches that appear inside negation windows,
 * meta-category enumerations, or structured prefix tokens. Returns
 * sanitised text suitable for the per-category regex passes.
 *
 * Replacement is a single space so surrounding word boundaries stay sane.
 */
export function dropMetaMentions(text: string): string {
  let out = text;
  // Order matters: structured tokens first (so `skill: investigate-foo`
  // isn't accidentally read as a negation window), then meta-lists, then
  // negation windows. Each pass returns a string with the offending matches
  // replaced — the next pass operates on already-cleaned text.
  out = out.replace(STRUCTURED_TOKEN_RE, ' ');
  out = out.replace(META_LIST_RE, ' ');
  out = out.replace(NEGATION_WINDOW_RE, ' ');
  return out;
}

export function detectSignals(
  systems: SystemAssessment[],
  transcript: QAPair[],
  decidesAboutPeople: boolean,
  decisionMakingDetails?: string,
): ComplianceSignals {
  const allText = transcript.map((qa) => qa.answer.toLowerCase()).join(' ');

  const hasSensitivePII =
    /\b(ssn|passport|social.?security|date.?of.?birth|dob|bank.?account|credit.?card|driver.?licen[sc]e|tax.?id|national.?id)\b/i.test(
      allText,
    );
  const hasPublicPII =
    /\b(pii|personal|email|name|phone|address|linkedin|profile|title|company)\b/i.test(
      allText,
    );
  const hasPII = hasSensitivePII || hasPublicPII;

  const hasMedicalTerms =
    /\b(medical|patient|hipaa|diagnosis|prescription|clinical|ehr|emr|phi\b|protected.?health)\b/i.test(
      allText,
    );
  const hasHealthInContext =
    /\b(health)\b/i.test(allText) &&
    !/health.?check|health.?endpoint|health.?status|health.?ping|health(y|ier)/i.test(
      allText,
    ) &&
    /\b(data|record|information|system|care|provider)\b/i.test(allText);
  const hasHealth = hasMedicalTerms || hasHealthInContext;

  // AAP-43 P1 #4: employment-decision signal must be gated on the explicit
  // `decidesAboutPeople` interview flag. A regex-only match on transcript
  // words like "employer" or "candidate" fired Annex III §4 on agents that
  // never made employment decisions (e.g. curriculum-generation agents).
  //
  // AAP-43 post-merge fix (2026-04-24): the gate still fails on a common
  // shape — the LinkedIn ICP agent answers Q13 with negations like
  // "does not involve hiring, credit scoring..." — the keyword is present
  // but its meaning is negated. Two guards:
  //   1. Trust `decisionMakingDetails` first (the LLM-extracted summary
  //      field). If it is provided and does NOT match the regex, do not
  //      fall back to `allText`; the structured field already represents
  //      the agent's self-classification.
  //   2. If we must use `allText`, scrub negation windows (`does not
  //      involve <keyword>`, `not a <keyword>`, `never <keyword>`) before
  //      matching.
  const employmentRegex = /\b(hir(e|ing)?|recruit(er|ing)?|employ(ee|er|ment)?|candidates?|resumes?|applicants?)\b/i;
  // Negation-stripping regex: scrub a short window (up to 3 filler words)
  // between the negation cue and the employment keyword. Covers:
  //   - "does not involve hiring"
  //   - "did not include any candidates"
  //   - "is not a hiring agent"
  //   - "is not an employment-screening tool"
  //   - "not used for recruiting"
  //   - "never hires"
  //   - "this agent is not about hiring"
  const EMPLOYMENT_KW = '(?:hir(?:e|ing)?|recruit(?:er|ing)?|employ(?:ee|er|ment)?|candidates?|resumes?|applicants?)';
  const FILL = '(?:\\w+(?:[- ]\\w+){0,2}\\s+){0,3}';
  const negationStrippingRegex = new RegExp(
    [
      // auxiliary + not + (optional filler up to 3 words) + keyword
      `\\b(?:does|do|did|is|are|was|were|has|have|had|doesn't|don't|didn't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't)\\s+not\\s+${FILL}${EMPLOYMENT_KW}`,
      // "no" or "never" + up to 3 words + keyword
      `\\b(?:no|never)\\s+${FILL}${EMPLOYMENT_KW}`,
      // bare "not" + up to 3 words + keyword ("not a hiring", "not about hiring")
      `\\bnot\\s+${FILL}${EMPLOYMENT_KW}`,
    ].join('|'),
    'gi',
  );
  const detailsHasEmployment =
    typeof decisionMakingDetails === 'string' &&
    decisionMakingDetails.length > 0 &&
    employmentRegex.test(decisionMakingDetails.replace(negationStrippingRegex, ' '));
  const detailsExplicitlyNonEmployment =
    typeof decisionMakingDetails === 'string' &&
    decisionMakingDetails.length > 10 &&
    !employmentRegex.test(decisionMakingDetails.replace(negationStrippingRegex, ' '));
  const allTextScrubbed = allText.replace(negationStrippingRegex, ' ');
  const hasEmploymentDecisions =
    decidesAboutPeople && (
      detailsHasEmployment ||
      (!detailsExplicitlyNonEmployment && employmentRegex.test(allTextScrubbed))
    );

  const combinedText = (decisionMakingDetails ?? '') + ' ' + allText;

  // AAP-70 Part B: sanitise the text used for Annex III category regex
  // passes. Strip negation windows, meta-category enumerations, and
  // structured prefix tokens (`skill: foo`). Apply to both `allText` (used
  // by biometric) and `combinedText` (used by education / law / essential
  // services so decisionMakingDetails also gets the treatment).
  const sanitisedAllText = dropMetaMentions(allText);
  const sanitisedCombinedText = dropMetaMentions(combinedText);

  const hasBiometricSignal = BIOMETRIC_PATTERN.test(sanitisedAllText);
  const isEducationAssessmentContext = EDUCATION_ASSESSMENT_PATTERN.test(sanitisedCombinedText);
  const isLawEnforcementContext = LAW_ENFORCEMENT_PATTERN.test(sanitisedCombinedText);
  const hasEssentialServicesSignal = ESSENTIAL_SERVICES_PATTERN.test(sanitisedCombinedText);

  // ── AIUC-1 architecture signals (AAP-44) ──────────────────────────────
  // Sourced from transcript text (answers to Q11–15). Used for per-control
  // `gatedBy` filtering so that AIUC-1 controls only render when the
  // corresponding architecture is actually in play.
  const hasMCPOrA2A =
    /\bmcp\b|model\s+context\s+protocol|\ba2a\b|agent-to-agent|agent\s+to\s+agent/i.test(allText);
  const hasSubAgents =
    /\bsub-?agent|chain(?:ed|s|ing)?\s+tool|spawn(?:s|ed|ing)?\s+(?:a\s+)?(?:sub-?)?agent|delegate[sd]?\s+to\s+(?:another\s+)?agent|tool\s+orchestrat/i.test(allText);
  const hasCrossCustomer =
    /\bmulti-?tenant|multi-?customer|shared\s+deployment|multiple\s+customers|multiple\s+tenants|cross-?tenant|cross-?customer/i.test(allText);

  const businessSystems = systems.filter(isBusinessSystem);

  const hasWriteOps = businessSystems.some((s) => s.writeOperations.length > 0);
  const hasIrreversibleWrites = businessSystems.some((s) =>
    s.writeOperations.some((w) => !w.reversible),
  );
  const hasExcessivePerms = businessSystems.some((s) => s.scopesDelta.length > 0);
  const hasScopeCreep = businessSystems.some(
    (s) =>
      s.scopesNeeded.length > 0 &&
      s.scopesRequested.length > s.scopesNeeded.length,
  );
  const hasOrgBlast = businessSystems.some(
    (s) => s.blastRadius === 'org-wide' || s.blastRadius === 'cross-tenant',
  );
  const hasOrgBlastWithWrites = hasOrgBlast && hasWriteOps;

  const decisionImpact = classifyDecisionImpact(
    decidesAboutPeople,
    decisionMakingDetails,
  );

  // AAP-43 P1 #3: conditional GDPR signals
  const hasDecisionsAboutPeople = decidesAboutPeople && decisionImpact !== 'none';

  const transferRegex = /\b(transfer(s|red|ring)?|cross.?border|international(ly)?|outside.?(the.?)?(eu|eea)|US.?based.?(service|provider|processor)|third.?country)\b/i;
  const hasInternationalTransfer =
    transferRegex.test(allText) ||
    // Any business system that is a well-known US-based SaaS → likely cross-border.
    businessSystems.some((s) => /\b(google|apify|openai|anthropic|telegram|slack|stripe|hubspot|salesforce|vercel|aws|azure|gcp|github|linear)\b/i.test(s.systemId));

  const hasExternalProcessors = businessSystems.length > 0;

  const hasLargeScaleProcessing =
    businessSystems.length >= 3 ||
    businessSystems.some((s) => s.blastRadius === 'org-wide' || s.blastRadius === 'cross-tenant');

  return {
    hasSensitivePII,
    hasPublicPII,
    hasPII,
    hasHealth,
    hasEmploymentDecisions,
    hasWriteOps,
    hasIrreversibleWrites,
    hasExcessivePerms,
    hasScopeCreep,
    hasOrgBlast,
    hasOrgBlastWithWrites,
    decisionImpact,
    businessSystems,
    hasBiometricSignal,
    isEducationAssessmentContext,
    isLawEnforcementContext,
    hasEssentialServicesSignal,
    hasDecisionsAboutPeople,
    hasInternationalTransfer,
    hasExternalProcessors,
    hasLargeScaleProcessing,
    hasMCPOrA2A,
    hasSubAgents,
    hasCrossCustomer,
  };
}

// ─── EU AI Act classification ───────────────────────────────────────────────

/**
 * Return true if at least one Annex III category signal matches for the given
 * finding type. Used both to gate individual `annexIII: true` controls and to
 * compute the overall EU AI Act classification for the audit.
 */
function isAnnexIIIApplicableForFinding(
  findingType: FindingType,
  signals: ComplianceSignals,
): boolean {
  // AAP-70: mirror the gating in `classifyEUAIAct`. Per-control flags must
  // match the overall classification — otherwise the report shows
  // "limited" up top but renders Annex III controls below.
  // §1 — biometrics: tied to sensitive-data
  if (
    findingType === 'sensitive-data' &&
    signals.hasSensitivePII &&
    signals.hasBiometricSignal &&
    signals.hasDecisionsAboutPeople
  ) {
    return true;
  }

  // §3 — education/training assessment: tied to decisions-about-people + regulatory-flags
  if (
    (findingType === 'decisions-about-people' ||
      findingType === 'regulatory-flags') &&
    signals.isEducationAssessmentContext &&
    signals.hasDecisionsAboutPeople
  ) {
    return true;
  }

  // §4 — employment decisions: tied to decisions-about-people
  if (
    findingType === 'decisions-about-people' &&
    signals.hasEmploymentDecisions &&
    signals.decisionImpact !== 'none'
  ) {
    return true;
  }

  // §5 — access to essential services: tied to high-impact decisions
  if (
    findingType === 'decisions-about-people' &&
    signals.hasEssentialServicesSignal &&
    signals.decisionImpact === 'high' &&
    signals.hasDecisionsAboutPeople
  ) {
    return true;
  }

  // §6 — law enforcement: tied to decisions-about-people + regulatory-flags
  if (
    (findingType === 'decisions-about-people' ||
      findingType === 'regulatory-flags') &&
    signals.isLawEnforcementContext &&
    signals.hasDecisionsAboutPeople &&
    signals.decisionImpact !== 'none'
  ) {
    return true;
  }

  return false;
}

export interface EUAIActClassificationResult {
  classification: EUAIActClassification;
  /** Human-readable category labels that triggered the classification (Annex III §1, §3, etc.). */
  annexIIICategories: string[];
}

/**
 * Compute the EU AI Act classification for the audit based on detected signals.
 *
 * This replaces the prior two-framework-entry model where high-risk was a
 * separate framework ID. Now it is a scope label on the single `eu-ai-act`
 * framework entry. Called once per audit and attached to the output.
 *
 * Prohibited / minimal tiers are out-of-scope for v1 signal detection; we
 * surface `high-risk` if any Annex III signal matches, otherwise `limited`
 * (which maps to Art. 50 transparency obligations only).
 */
export function classifyEUAIAct(
  signals: ComplianceSignals,
): EUAIActClassificationResult {
  // AAP-70: every Annex III category requires `hasDecisionsAboutPeople` at
  // minimum. §6 / §5 also require a non-trivial `decisionImpact`. §4 keeps
  // its prior gate (employment decisions are implicitly decisions about
  // people, so the existing impact gate is sufficient). §3 stays single-
  // signal — the EDUCATION_ASSESSMENT_PATTERN is narrow enough not to fire
  // on unrelated transcripts.
  //
  // Rationale: every Annex III category is fundamentally about automated
  // decisions affecting natural persons. If an agent declares it makes no
  // decisions about people AND has no decision-impact, it cannot be a
  // high-risk Annex III deployer. The pre-AAP-70 single-signal trigger for
  // §6 (and the loose gate on §1/§5) produced false positives on agents
  // whose transcripts merely mentioned compliance categories in negations,
  // skill names, or enumerated meta-lists. See AAP-70 ticket for the
  // 2026-05-21 Claude Code self-audit repro.
  const categories: string[] = [];
  if (
    signals.hasBiometricSignal &&
    signals.hasSensitivePII &&
    signals.hasDecisionsAboutPeople
  )
    categories.push('§1 biometric');
  if (
    signals.isEducationAssessmentContext &&
    signals.hasDecisionsAboutPeople
  )
    categories.push('§3 education');
  if (signals.hasEmploymentDecisions && signals.decisionImpact !== 'none')
    categories.push('§4 employment');
  if (
    signals.hasEssentialServicesSignal &&
    signals.decisionImpact === 'high' &&
    signals.hasDecisionsAboutPeople
  )
    categories.push('§5 essential services');
  if (
    signals.isLawEnforcementContext &&
    signals.hasDecisionsAboutPeople &&
    signals.decisionImpact !== 'none'
  )
    categories.push('§6 law enforcement');

  if (categories.length > 0) {
    return { classification: 'high-risk', annexIIICategories: categories };
  }

  // No Annex III signals — fall back to limited-risk (Art. 50 transparency only).
  return { classification: 'limited', annexIIICategories: [] };
}

// ─── Typed flag shape ───────────────────────────────────────────────────────

export type FlagSeverity =
  | 'info'
  | 'warning'
  | 'action-required'
  | 'clarification-needed';

export interface TypedRegulatoryFlag extends RegulatoryFlag {
  frameworkId: FrameworkId;
  /** All controls from this framework activated by the triggering finding. */
  controlIds: string[];
  category: RiskCategory;
  tier: FrameworkTier;
  mandatoryIn: Jurisdiction[];
  scopeNote?: string;
  triggeredBy: FindingType;
  /**
   * EU AI Act only: the classification label relevant to this flag
   * (e.g. "high-risk" if this flag was activated by Annex III gating).
   * Undefined for non-EU-AI-Act flags.
   */
  euAiActClassification?: EUAIActClassification;
}

export interface CategorizedBucket {
  privacy: TypedRegulatoryFlag[];
  ip: TypedRegulatoryFlag[];
  'consumer-protection': TypedRegulatoryFlag[];
  'sector-specific': TypedRegulatoryFlag[];
}

export interface CategorizedCompliance {
  mappingVersion: string;
  mandatory: CategorizedBucket;
  voluntary: CategorizedBucket;
  /** Frameworks actually activated — drives the jurisdictional appendix. */
  frameworksActivated: FrameworkId[];
  /** Flat list for backward-compat consumers. */
  all: TypedRegulatoryFlag[];
  /**
   * EU AI Act classification for this audit, with the Annex III categories
   * (if any) that triggered the high-risk tier. Always present — drives the
   * single-entry EU AI Act display (replaces the old two-entry split).
   */
  euAiActClassification: EUAIActClassificationResult;
  /**
   * AAP-43 P1: detected signals exposed so renderers can gate conditional
   * content (e.g. GDPR obligations table rows, regulatory overall status).
   * Read-only snapshot of the signals that produced the flags above.
   */
  signals: ComplianceSignals;
  /**
   * AAP-83 — per-control results from typed-evidence detectors. Empty when
   * the caller did not provide an `actual` envelope (the `mapFindings`
   * default). Populated when the dashboard / CLI feeds discovery, the
   * verification report, or OAuth introspection into the mapper.
   *
   * The legacy `TypedRegulatoryFlag` projection above still drives the
   * existing renderers — this field is additive so future surfaces
   * (per-control verdict pills, control-level provenance hovers) have
   * structured data to render. Dedup is by `stableKey`.
   */
  controlResults: ControlResult[];
}

function emptyBucket(): CategorizedBucket {
  return {
    privacy: [],
    ip: [],
    'consumer-protection': [],
    'sector-specific': [],
  };
}

// ─── Jurisdictional disclaimer appender ────────────────────────────────────

function disclaimerFor(frameworkId: FrameworkId, baseDescription: string): string {
  switch (frameworkId) {
    case 'gdpr':
      return `${baseDescription} Applies if offering goods/services to EU data subjects or monitoring EU-based behaviour (Art. 3(2)).`;
    case 'eu-ai-act':
      return `${baseDescription} Applies if placing AI on the EU market, if you are an EU-established deployer, or if outputs are used in the EU.`;
    case 'iso-42001':
      return baseDescription;
    default:
      return baseDescription;
  }
}

// ─── Per-finding description builder ───────────────────────────────────────

function describeFinding(
  findingType: FindingType,
  framework: Framework,
  controlIds: string[],
  signals: ComplianceSignals,
  decisionDetails?: string,
): { severity: FlagSeverity; description: string } {
  const ids = controlIds.join(', ');
  switch (findingType) {
    case 'excessive-access':
      return {
        severity: 'warning',
        description: `Agent holds permissions beyond stated need. Activates ${framework.name} controls (${ids}). Narrow scopes to the minimum required.`,
      };

    case 'scope-creep':
      return {
        severity: 'warning',
        description: `Requested scopes exceed stated needs across one or more systems. Activates ${framework.name} controls (${ids}). Review purpose-limitation and change-management process.`,
      };

    case 'sensitive-data': {
      const sev: FlagSeverity = signals.hasSensitivePII
        ? 'action-required'
        : 'info';
      const qualifier = signals.hasSensitivePII
        ? 'sensitive personal data (government IDs, financial identifiers)'
        : 'personal data';
      return {
        severity: sev,
        description: `Agent processes ${qualifier}. Activates ${framework.name} controls (${ids}). Ensure lawful basis, data minimization, and breach-readiness.`,
      };
    }

    case 'write-risk': {
      const sev: FlagSeverity =
        signals.hasIrreversibleWrites || signals.hasOrgBlastWithWrites
          ? 'warning'
          : 'info';
      const qualifier = signals.hasIrreversibleWrites
        ? 'Irreversible write operations detected. '
        : signals.hasOrgBlastWithWrites
          ? 'Org-wide blast radius with write access. '
          : 'Write operations detected. ';
      return {
        severity: sev,
        description: `${qualifier}Activates ${framework.name} controls (${ids}). Require approval, monitoring, and rollback paths for high-impact operations.`,
      };
    }

    case 'regulatory-flags':
      return {
        severity: 'clarification-needed',
        description: `Agent may operate in a regulated domain (employment, credit, insurance, health, housing, education, legal). Activates ${framework.name} controls (${ids}). Clarify the agent's domain to determine obligations.`,
      };

    case 'risk-score':
      return {
        severity: 'info',
        description: `Overall risk rating is anchored to ${framework.name} risk-management controls (${ids}). See Methodology.`,
      };

    case 'decisions-about-people': {
      const impact = signals.decisionImpact;
      if (impact === 'high') {
        const employment = /\b(hir(e|ing)?|recruit(er|ing)?|employ(ee|er|ment)?|candidates?|resumes?|applicants?)\b/i.test(
          decisionDetails ?? '',
        );
        return {
          severity: 'action-required',
          description: `High-impact automated decisions about people${
            employment ? ' (employment context)' : ''
          }. Activates ${framework.name} controls (${ids}). Requires human oversight, contestability, and explanation of logic.`,
        };
      }
      if (impact === 'medium') {
        return {
          severity: 'info',
          description: `Agent influences outcomes for people (scoring/ranking/recommending) without binding legal effects. Activates ${framework.name} controls (${ids}). Maintain transparency and data-subject rights.`,
        };
      }
      if (impact === 'unclear') {
        return {
          severity: 'clarification-needed',
          description: `Agent reports making decisions about people but impact level is unclear. Activates ${framework.name} controls (${ids}). Clarify whether decisions have legal/significant effects.`,
        };
      }
      return {
        severity: 'info',
        description: `No decisions about people detected. ${framework.name} controls (${ids}) listed for reference.`,
      };
    }
  }
}

// ─── Finding gating (is the finding active at all?) ────────────────────────

function isFindingActive(
  findingType: FindingType,
  signals: ComplianceSignals,
): boolean {
  switch (findingType) {
    case 'excessive-access':
      return signals.hasExcessivePerms;
    case 'write-risk':
      return signals.hasWriteOps;
    case 'sensitive-data':
      return signals.hasPII || signals.hasHealth;
    case 'scope-creep':
      return signals.hasScopeCreep || signals.hasExcessivePerms;
    case 'regulatory-flags':
      return signals.hasHealth || signals.decisionImpact !== 'none';
    case 'risk-score':
      return true;
    case 'decisions-about-people':
      return true;
  }
}

// ─── Main mapper ────────────────────────────────────────────────────────────

export interface MapperInput {
  systems: SystemAssessment[];
  transcript: QAPair[];
  makesDecisionsAboutPeople?: boolean;
  decisionMakingDetails?: string;
}

/**
 * AAP-83 — declared half of the envelope-shaped mapper input.
 *
 * Mirrors the fields the legacy `MapperInput` already accepts. Lives
 * under `MapFindingsInput.declared` so the call site can distinguish
 * Surface 1 evidence (interview / agent declaration) from Surface 2
 * evidence (`actual`).
 */
export interface DeclaredEvidence {
  systems: SystemAssessment[];
  transcript: QAPair[];
  makesDecisionsAboutPeople?: boolean;
  decisionMakingDetails?: string;
}

/**
 * AAP-83 — actual (Surface 2 / cloud) half of the envelope. Optional
 * in every field so phases 3 and 4 can roll out the new shape without
 * forcing every caller to wire up discovery / verification / OAuth at
 * once. When omitted, the typed-evidence detectors return null and the
 * mapper falls back to the prose path unchanged.
 *
 * `discovery` carries filesystem L1-L5 reads (MCP configs, OAuth scopes,
 * env files, keychain). `verificationReport` carries the diff +
 * inventory + approval chain output from `runVerification`.
 * `oauthVerifications` is the per-provider source-verification array
 * the cloud-side L7 introspection produces.
 */
export interface ActualEvidence {
  discovery?: DiscoveryResult | null;
  verificationReport?: VerificationReport;
  oauthVerifications?: SourceVerification[];
}

/**
 * AAP-83 envelope-shaped input. Surface 1 / Surface 2 split is now
 * explicit — `declared` for what the agent owner says, `actual` for
 * what infrastructure shows.
 */
export interface MapFindingsInput {
  declared: DeclaredEvidence;
  actual?: ActualEvidence;
}

/**
 * AAP-83 — envelope-shaped public entrypoint. The legacy
 * `mapFindingsToRiskCategories` is now a thin alias that calls into
 * this function with `actual` omitted. Existing callers (generator.ts,
 * sessions.ts) keep working unchanged; new callers that have typed
 * evidence on hand wire it through `actual` to light up the
 * deterministic detectors per catalog entry.
 *
 * The function preserves the legacy `CategorizedCompliance` output
 * shape end-to-end, plus the new `controlResults` array that carries
 * per-control verdicts + provenance for any catalog entry that fired
 * a typed-evidence detector. Empty array when no `actual` was provided
 * — additive, no behaviour change for legacy reports.
 */
export function mapFindings(input: MapFindingsInput): CategorizedCompliance {
  const out = mapFindingsCore(input.declared);
  if (input.actual) {
    out.controlResults = runTypedDetectors(input.actual);
  }
  return out;
}

/**
 * Run every catalog entry's `deterministicDetector` against the typed
 * evidence envelope. Detectors that return null are skipped (no
 * relevant evidence). Phase 4 promotes these results into the
 * per-control verdict ladder; Phase 3 just collects them.
 */
function runTypedDetectors(actual: ActualEvidence): ControlResult[] {
  const evidence: TypedEvidenceEnvelope = {};
  if (actual.discovery !== undefined && actual.discovery !== null) {
    evidence.discovery = actual.discovery;
  }
  if (actual.verificationReport !== undefined) {
    evidence.verificationReport = actual.verificationReport;
  }
  if (actual.oauthVerifications !== undefined) {
    evidence.oauthVerifications = actual.oauthVerifications;
  }

  const out: ControlResult[] = [];
  const seen = new Set<string>();
  for (const entry of CONTROL_CATALOG as ControlCatalogEntry[]) {
    if (!entry.deterministicDetector) continue;
    const result = entry.deterministicDetector(evidence) as ControlResult | null;
    if (!result) continue;
    const key = stableKeyFor({
      findingType: entry.findingType,
      frameworkId: entry.frameworkId,
      controlId: entry.controlId,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
  }
  return out;
}

/**
 * Legacy entrypoint preserved verbatim. Routes through `mapFindings` so
 * the envelope shape becomes the canonical implementation path. New
 * callers should use `mapFindings({ declared, actual })` directly.
 */
export function mapFindingsToRiskCategories(
  input: MapperInput,
): CategorizedCompliance {
  const declared: DeclaredEvidence = {
    systems: input.systems,
    transcript: input.transcript,
  };
  if (input.makesDecisionsAboutPeople !== undefined) {
    declared.makesDecisionsAboutPeople = input.makesDecisionsAboutPeople;
  }
  if (input.decisionMakingDetails !== undefined) {
    declared.decisionMakingDetails = input.decisionMakingDetails;
  }
  return mapFindings({ declared });
}

/**
 * The original `mapFindingsToRiskCategories` body lives here, scoped to
 * the declared half of the envelope. `mapFindings` calls into it and
 * then optionally enriches the output with typed-evidence detector
 * results.
 */
function mapFindingsCore(input: DeclaredEvidence): CategorizedCompliance {
  const signals = detectSignals(
    input.systems,
    input.transcript,
    input.makesDecisionsAboutPeople === true,
    input.decisionMakingDetails,
  );
  const euAiActClassification = classifyEUAIAct(signals);

  const mandatory = emptyBucket();
  const voluntary = emptyBucket();
  const all: TypedRegulatoryFlag[] = [];
  const activated = new Set<FrameworkId>();

  for (const mapping of Object.values(CONTROL_MAPPINGS) as ControlMapping[]) {
    if (!isFindingActive(mapping.findingType, signals)) continue;

    // Per-control gating:
    //  - drop EU AI Act controls tagged annexIII=true when the Annex III
    //    signal set does not fire for this finding type.
    //  - drop controls tagged gatedBy=[...] when none of the named signals
    //    are truthy (AIUC-1 architecture gating: MCP, sub-agents, multi-customer).
    const annexIIIOn = isAnnexIIIApplicableForFinding(mapping.findingType, signals);
    const applicableControls = mapping.controls.filter((ctrl) => {
      if (ctrl.frameworkId === 'eu-ai-act' && ctrl.annexIII === true) {
        if (!annexIIIOn) return false;
      }
      if (ctrl.gatedBy && ctrl.gatedBy.length > 0) {
        const sigBag = signals as unknown as Record<string, unknown>;
        const anyOn = ctrl.gatedBy.some((sig) => sigBag[sig] === true);
        if (!anyOn) return false;
      }
      return true;
    });

    // Group remaining controls by framework — one flag per framework per finding.
    const byFramework = new Map<FrameworkId, FrameworkControl[]>();
    for (const ctrl of applicableControls) {
      const arr = byFramework.get(ctrl.frameworkId) ?? [];
      arr.push(ctrl);
      byFramework.set(ctrl.frameworkId, arr);
    }

    for (const [frameworkId, controls] of byFramework) {
      const framework = FRAMEWORKS[frameworkId];
      const controlIds = controls.map((c) => c.controlId);
      const { severity, description: baseDescription } = describeFinding(
        mapping.findingType,
        framework,
        controlIds,
        signals,
        input.decisionMakingDetails,
      );
      const description = disclaimerFor(frameworkId, baseDescription);

      const controlsLabel = controlIds.join(', ');
      const flag: TypedRegulatoryFlag = {
        framework: `${framework.name} — ${controlsLabel}`,
        severity,
        description,
        frameworkId: framework.id,
        controlIds,
        category: mapping.category,
        tier: framework.tier,
        mandatoryIn: framework.mandatoryIn,
        scopeNote: framework.scopeNote,
        triggeredBy: mapping.findingType,
        euAiActClassification:
          framework.id === 'eu-ai-act' ? euAiActClassification.classification : undefined,
      };

      all.push(flag);
      activated.add(framework.id);
      const bucket = framework.tier === 'mandatory' ? mandatory : voluntary;
      bucket[mapping.category].push(flag);
    }
  }

  return {
    mappingVersion: MAPPING_VERSION,
    mandatory,
    voluntary,
    frameworksActivated: [...activated],
    all,
    euAiActClassification,
    signals,
    // AAP-83 phase 3 — empty by default; `mapFindings` populates this
    // when the caller provides typed evidence in `actual`.
    controlResults: [],
  };
}
