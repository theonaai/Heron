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
import type {
  DiscoveredCapability,
  DiscoveryResult,
} from '../discovery/types.js';

// ─── Decision impact ────────────────────────────────────────────────────────

export type DecisionImpact = 'high' | 'medium' | 'unclear' | 'none';

export function classifyDecisionImpact(
  decidesAboutPeople: boolean,
  details?: string,
): DecisionImpact {
  if (!decidesAboutPeople) return 'none';
  // AAP-88: threshold `mapper_decisionImpact_minDetailsLen` = 10 chars.
  // See src/verification/threshold-manifest.ts.
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

  // ── AAP-85 Codex post-review: category-specific explicit negation ──────
  // True when prose explicitly negates the category (negation cue + category
  // keyword within a single sentence window). Distinct from "category not
  // mentioned" (silence). Used by the typed-signal elevation path so a
  // BAMBOOHR env key cannot fire §4 when the agent has said "we make no
  // employment decisions", a CANVAS_LMS key cannot fire §3 when the agent
  // has said "no education decisions", etc.
  proseExplicitlyNoBiometric: boolean;        // §1
  proseExplicitlyNoEducation: boolean;        // §3
  proseExplicitlyNoEmployment: boolean;       // §4
  proseExplicitlyNoEssentialServices: boolean; // §5
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
// AAP-88: thresholds documented in src/verification/threshold-manifest.ts.
//   - mapper_negationWindow_filler (80 chars head filler)
//   - mapper_negationWindow_trailingChain (40 chars inter-keyword filler)
//   - mapper_negationWindow_trailingMax (6 trailing keywords cap)
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
// AAP-88: threshold `mapper_metaList_minCategories` = 3 (the `{2,}` repeats
// the meta-category twice MORE so the total run is 3+ categories).
// See src/verification/threshold-manifest.ts.
const META_LIST_RE = new RegExp(
  `\\b${META_CATEGORY}\\b(?:[\\s,;/]+(?:and|or|,)?\\s*\\b${META_CATEGORY}\\b){2,}`,
  'gi',
);

// Structured prefix tokens — `skill: foo`, `tool: bar`, `mcp_server: baz`,
// `connector: qux`, `framework: quux`. Drop the entire token (label + value
// up to whitespace or punctuation).
const STRUCTURED_TOKEN_RE =
  /\b(?:skill|tool|mcp[_\s]?server|connector|framework|plugin|agent)s?\s*[:=]\s*[\w./-]+/gi;

// AAP-85 Codex post-review — per-category explicit-negation detectors.
//
// Each detector takes original (pre-scrub) text and returns true if a
// negation cue + this category's keyword appear inside a single sentence
// window. Distinct from "category not mentioned" (silence). The typed-
// signal elevation path consults these so a typed credential (BAMBOOHR,
// CANVAS_LMS, AWS_REKOGNITION, PLAID...) cannot lift a category that the
// agent has explicitly negated in prose.
//
// We deliberately scope each window to a single sentence (`[^.!?]`) and
// cap filler at 80 chars after the negation cue + 40 chars between
// trailing keywords — matches the existing NEGATION_WINDOW_RE shape.

function makeCategoryNegationRE(categoryKw: string): RegExp {
  return new RegExp(
    NEGATION_HEAD + '[^.!?]{0,80}?(?:' + categoryKw + ')',
    'i',
  );
}

// §1 biometric keywords (mirrors BIOMETRIC_PATTERN core terms).
const BIOMETRIC_NEGATION_RE = makeCategoryNegationRE(
  'biometric|facial.?recognition|face.?recognit|voiceprint|voice.?biometric|speaker.?recognit|fingerprint|iris|retina|gait|emotion.?recognition|affect.?detect|liveness|anti.?spoof',
);

// §3 education keywords (mirrors EDUCATION_ASSESSMENT_PATTERN core terms,
// plus generic "education" / "educational" / "school" / "student" /
// "training" / "course" so the agent's plain "no education decisions"
// phrasing is recognised even when they don't reach for the canonical
// vocabulary).
const EDUCATION_NEGATION_RE = makeCategoryNegationRE(
  'student.?evaluation|grading|exam.?scoring|exam.?proctor|admission|enrollment|school.?assignment|academic.?assessment|learning.?assessment|vocational.?training|apprenticeship|education(?:al)?|school|students?|training|courses?',
);

// §4 employment keywords (mirrors EMPLOYMENT_KW above).
const EMPLOYMENT_NEGATION_RE = makeCategoryNegationRE(
  'hir(?:e|ing)?|recruit(?:er|ing)?|employ(?:ee|er|ment)?|candidates?|resumes?|applicants?',
);

// §5 essential-services keywords (mirrors ESSENTIAL_SERVICES_PATTERN
// core terms, plus generic "essential services" / "financial" /
// "banking" / "loan" / "insurance" so plain-language negations match).
const ESSENTIAL_SERVICES_NEGATION_RE = makeCategoryNegationRE(
  'credit(?:\\s*scor|worthiness|\\s*rating)|benefit|eligib|welfare|social\\s*service|public\\s*assistance|emergency|911|triage|dispatch|life\\s*insur|health\\s*insur|insur(?:ance)?\\s*pric|insur(?:ance)?\\s*risk|underwrit|essential\\s+services|financial|banking|loans?|payments?|insurance',
);

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
  // AAP-88: threshold `mapper_employment_negationFiller` = 3 filler words.
  // See src/verification/threshold-manifest.ts.
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
  // AAP-88: threshold `mapper_decisionsAboutPeople_minDetailsLen` = 10 chars.
  // See src/verification/threshold-manifest.ts.
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

  // AAP-88: threshold `mapper_largeScale_minBusinessSystems` = 3.
  // See src/verification/threshold-manifest.ts.
  const hasLargeScaleProcessing =
    businessSystems.length >= 3 ||
    businessSystems.some((s) => s.blastRadius === 'org-wide' || s.blastRadius === 'cross-tenant');

  // ── AAP-85 Codex post-review: per-category explicit-negation flags ─────
  // Test against original (pre-scrub) `combinedText` — we want to know
  // whether a negation cue + category keyword appeared. Sanitisation
  // would scrub the very evidence we are looking for here.
  const proseExplicitlyNoBiometric = BIOMETRIC_NEGATION_RE.test(combinedText);
  const proseExplicitlyNoEducation = EDUCATION_NEGATION_RE.test(combinedText);
  const proseExplicitlyNoEmployment = EMPLOYMENT_NEGATION_RE.test(combinedText);
  const proseExplicitlyNoEssentialServices =
    ESSENTIAL_SERVICES_NEGATION_RE.test(combinedText);

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
    proseExplicitlyNoBiometric,
    proseExplicitlyNoEducation,
    proseExplicitlyNoEmployment,
    proseExplicitlyNoEssentialServices,
  };
}

// ─── EU AI Act classification ───────────────────────────────────────────────

// Finding-type → Annex III category mapping. Mirrors the per-category
// gates in classifyEUAIAct and the rules that were previously inlined in
// the pre-AAP-85 `isAnnexIIIApplicableForFinding`.
//
// AAP-85 Codex post-review (Blocker 3): the per-control gate now drives
// off `EUAIActClassificationResult.annexIIICategories` instead of
// re-running prose-only signal checks. This guarantees top-level and
// per-control rendering agree — when typed evidence elevates §4 in the
// classification, the §4 controls are no longer hidden by the gate
// because the gate uses the same source of truth.
const FINDING_TO_ANNEX_III: Record<FindingType, string[]> = {
  'sensitive-data': ['§1 biometric'],
  'decisions-about-people': [
    '§3 education',
    '§4 employment',
    '§5 essential services',
    '§6 law enforcement',
  ],
  'regulatory-flags': ['§3 education', '§6 law enforcement'],
  // Other finding types do not gate Annex III controls.
  'excessive-access': [],
  'write-risk': [],
  'scope-creep': [],
  'risk-score': [],
  // Note: keep this Record exhaustive so a new FindingType triggers a
  // TypeScript error here and the author has to think about Annex III
  // applicability explicitly.
};

/**
 * Return true if at least one Annex III category triggered for this
 * audit applies to the given finding type. Drives off the canonical
 * classification result (which already factors in both prose AND typed
 * signals after AAP-85), so per-control gating cannot drift from the
 * top-level classification.
 *
 * AAP-70 invariant remains: when `classifyEUAIAct` returns
 * `annexIIICategories: []`, this returns false for every finding type
 * and Annex III controls stay hidden.
 */
function isAnnexIIIApplicableForFinding(
  findingType: FindingType,
  classification: EUAIActClassificationResult,
): boolean {
  if (classification.annexIIICategories.length === 0) return false;
  const applicable = FINDING_TO_ANNEX_III[findingType] ?? [];
  if (applicable.length === 0) return false;
  return classification.annexIIICategories.some((c) => applicable.includes(c));
}

export interface EUAIActClassificationResult {
  classification: EUAIActClassification;
  /** Human-readable category labels that triggered the classification (Annex III §1, §3, etc.). */
  annexIIICategories: string[];
}

// ─── AAP-85: typed Annex III signals from discovery ────────────────────────
//
// Phase 6 of mapper unification. Pre-AAP-85, classifyEUAIAct consumed only
// the LLM-derived ComplianceSignals. Surface 2 evidence — discovery
// findings like BAMBOOHR_API_KEY env vars or auth-credential providers
// such as `greenhouse_api_key` — could not influence Annex III gating.
//
// Two design rules govern the typed-signal contribution:
//   1. ELEVATE, do NOT override. A typed signal can resolve ambiguity
//      ("we may make employment decisions" + BAMBOOHR_API_KEY → §4 fires).
//      It cannot flip an explicit negation ("we make no employment
//      decisions" + BAMBOOHR_API_KEY → §4 does NOT fire). The agent's
//      self-declaration is authoritative when it is unambiguous.
//   2. Conservative on §5 / §6. The cost of a false-positive on law
//      enforcement or essential services is high (see AAP-70 repro). §6
//      gets NO typed signal at all — there is no reliable env-key
//      pattern for law enforcement. §5 requires multiple typed signals
//      OR typed + prose convergence; a lone Stripe key is not enough.
//
// The vocabulary below is intentionally narrow. Adding new keys is
// cheap once a real customer case justifies it; adding speculative
// patterns invites the AAP-70 class of false positive.
//
// Pattern conventions:
//   - Case-insensitive substring match on the credential name.
//   - Anchored to the vendor/system identifier, not generic words.
//   - Word-boundary inside the name (kebab/underscore separators ok).

interface TypedAnnexIIISignals {
  hasEmploymentTypedSignal: boolean;     // §4 — HRIS / ATS / payroll
  hasEducationTypedSignal: boolean;       // §3 — edtech / LMS
  hasBiometricTypedSignal: boolean;       // §1 — face/voice/fingerprint API
  hasFinancialTypedSignal: boolean;       // §5 — credit / banking / underwriting
  hasHealthInsuranceTypedSignal: boolean; // §5(d) — health / life insurance
  /** Specific credential names that produced each signal, for evidence trails. */
  evidenceKeys: string[];
}

// Credential names commonly use snake/kebab/camel separators. JS `\b`
// treats `_` as a word character so a pattern like `\bbamboohr\b` does
// NOT match `BAMBOOHR_API_KEY`. We therefore anchor each vendor name on
// either a string boundary or a non-letter separator (`-`, `_`, `.`,
// space, digit). The vendor token itself is letters-only; the
// surrounding boundaries are explicit.
const BOUNDARY = '(?:^|[^a-z])';
const BOUNDARY_END = '(?:[^a-z]|$)';
const employmentVendors =
  'bamboohr|greenhouse|lever|workday|adp|gusto|rippling|paycom|paychex|sapsuccessfactors|smartrecruiters|jobvite|icims|workable|recruitee|breezyhr|namely|justworks';
const EMPLOYMENT_TYPED_RE = new RegExp(
  BOUNDARY + '(' + employmentVendors + ')' + BOUNDARY_END,
  'i',
);

const educationVendors =
  'canvas_?lms|blackboard|moodle|brightspace|d2l|powerschool|schoology|edmodo|kahoot|nearpod|gradescope|turnitin|proctorio|examity|honorlock';
const EDUCATION_TYPED_RE = new RegExp(
  BOUNDARY + '(' + educationVendors + ')' + BOUNDARY_END,
  'i',
);

const biometricVendors =
  'rekognition|azure_?face|face_?api|kairos|clearview|paravision|cognitec|sensetime|megvii|neoface|innovatrics|veridium|speaker_?verification|voiceprint_?api|nuance_?voice|pindrop';
const BIOMETRIC_TYPED_RE = new RegExp(
  BOUNDARY + '(' + biometricVendors + ')' + BOUNDARY_END,
  'i',
);

const financialVendors =
  'plaid|yodlee|finicity|mx_?atrium|equifax|experian|transunion|fico|zestfinance|upstart_?credit|lendingclub|prosper|kabbage|onedeck';
const FINANCIAL_TYPED_RE = new RegExp(
  BOUNDARY + '(' + financialVendors + ')' + BOUNDARY_END,
  'i',
);

const healthInsuranceVendors =
  'epic_?fhir|cerner|allscripts|athenahealth|drchrono|practice_?fusion|nextgen_?health|kareo|simplepractice|policygenius|haven_?life|ladder_?life|gerber_?life|metlife_?underwriting|prudential_?underwriting|guardian_?underwriting';
const HEALTH_INSURANCE_TYPED_RE = new RegExp(
  BOUNDARY + '(' + healthInsuranceVendors + ')' + BOUNDARY_END,
  'i',
);

/**
 * Walk a DiscoveredCapability[] and return per-category typed signals.
 * Visits MCP server names, redacted env-key names, auth-credential
 * provider names, and the MCP server identifier itself. Never reads
 * secret VALUES — only KEY NAMES (the discovery layer guarantees the
 * shape).
 *
 * Returns an all-false TypedAnnexIIISignals when discoveryFindings is
 * undefined / empty. The classifier treats absence as "no typed signal"
 * rather than "negative typed signal" — the prose path remains
 * authoritative when typed evidence is silent.
 */
export function extractTypedAnnexIIISignals(
  discoveryFindings?: DiscoveredCapability[],
): TypedAnnexIIISignals {
  const out: TypedAnnexIIISignals = {
    hasEmploymentTypedSignal: false,
    hasEducationTypedSignal: false,
    hasBiometricTypedSignal: false,
    hasFinancialTypedSignal: false,
    hasHealthInsuranceTypedSignal: false,
    evidenceKeys: [],
  };
  if (!discoveryFindings || discoveryFindings.length === 0) return out;

  const ingest = (name: string) => {
    if (EMPLOYMENT_TYPED_RE.test(name)) {
      out.hasEmploymentTypedSignal = true;
      out.evidenceKeys.push(name);
    }
    if (EDUCATION_TYPED_RE.test(name)) {
      out.hasEducationTypedSignal = true;
      out.evidenceKeys.push(name);
    }
    if (BIOMETRIC_TYPED_RE.test(name)) {
      out.hasBiometricTypedSignal = true;
      out.evidenceKeys.push(name);
    }
    if (FINANCIAL_TYPED_RE.test(name)) {
      out.hasFinancialTypedSignal = true;
      out.evidenceKeys.push(name);
    }
    if (HEALTH_INSURANCE_TYPED_RE.test(name)) {
      out.hasHealthInsuranceTypedSignal = true;
      out.evidenceKeys.push(name);
    }
  };

  for (const cap of discoveryFindings) {
    if (cap.kind === 'mcp_server') {
      ingest(cap.name);
      for (const k of cap.redactedEnvKeys ?? []) ingest(k);
    } else if (cap.kind === 'auth_credential') {
      ingest(cap.provider);
    } else if (cap.kind === 'plugin') {
      ingest(cap.name);
    }
    // SkillCapability has no name field useful for vendor matching.
  }

  return out;
}

/**
 * AAP-85: input envelope for the typed-signal-aware classifyEUAIAct.
 * Mirrors the AAP-83 declared/actual split — `proseSignals` are the
 * Surface 1 ComplianceSignals derived from the LLM-extracted transcript,
 * `discoveryFindings` are the Surface 2 capabilities returned by the
 * discovery layer. Both optional in callers but proseSignals required
 * here (the prose path remains authoritative).
 */
export interface ClassifyEUAIActInput {
  proseSignals: ComplianceSignals;
  discoveryFindings?: DiscoveredCapability[];
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
 *
 * AAP-85 — accepts either the legacy `ComplianceSignals` directly OR the
 * `ClassifyEUAIActInput` envelope with optional `discoveryFindings`. The
 * envelope form lets typed Surface 2 evidence (HRIS / ATS / edtech /
 * biometric / financial credential names) elevate classification when
 * the prose is ambiguous, without ever overriding an explicit prose
 * negation.
 */
/**
 * AAP-88: categorical thresholds documented in
 * src/verification/threshold-manifest.ts:
 *   - mapper_annexIII_biometricGate (§1)
 *   - mapper_annexIII_educationGate (§3)
 *   - mapper_annexIII_employmentGate (§4)
 *   - mapper_annexIII_essentialServicesGate (§5)
 *   - mapper_annexIII_lawEnforcementGate (§6)
 *   - mapper_typed_elevateNotOverride (ELEVATE invariant)
 *   - mapper_categoryNegation_perCategory (per-category negation honoured)
 */
export function classifyEUAIAct(
  input: ComplianceSignals | ClassifyEUAIActInput,
): EUAIActClassificationResult {
  // Normalise the input shape. Callers that still pass bare
  // ComplianceSignals (every pre-AAP-85 caller, plus all the AAP-70
  // gating tests) keep working unchanged — the typed-signal branch is
  // simply skipped because discoveryFindings is undefined.
  const isEnvelope = (
    v: ComplianceSignals | ClassifyEUAIActInput,
  ): v is ClassifyEUAIActInput =>
    (v as ClassifyEUAIActInput).proseSignals !== undefined;
  const signals = isEnvelope(input) ? input.proseSignals : input;
  const typed = extractTypedAnnexIIISignals(
    isEnvelope(input) ? input.discoveryFindings : undefined,
  );
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
  // AAP-85: ELEVATE vs OVERRIDE rule.
  //
  // Prose negation is authoritative. If the agent has explicitly declared
  // `makesDecisionsAboutPeople: false` AND no decision impact, NO typed
  // signal can re-classify it as high-risk. This is the AAP-70 invariant —
  // the load-bearing Claude Code self-audit fixture would regress if we
  // let a stray HRIS env key flip the classification.
  //
  // Typed signals only contribute when:
  //   (a) the prose has not negated decisions-about-people, AND
  //   (b) the prose category signal is ambiguous (not firing strongly),
  //       so the typed evidence resolves the ambiguity rather than
  //       overriding a clear "no".
  //
  // The `proseExplicitlyNegated` predicate captures the AAP-70 shape: the
  // agent answered Q on decisions-about-people with `false` AND no impact
  // was inferred. Typed signals are silenced in this case.
  //
  // AAP-85 Codex post-review: in addition to the whole-classification
  // negation above, each Annex III category honours its own explicit
  // negation. `signals.proseExplicitlyNo<X>` is true when the agent's
  // prose contains a negation cue + keyword for that category (e.g.
  // "we make no employment decisions", "no biometric processing",
  // "no education decisions"). Typed elevation must respect both gates:
  //   - whole-classification negation (agent makes no decisions at all),
  //   - category-specific negation (agent explicitly excludes THIS area).
  // A BAMBOOHR env key in an agent that has said "no employment decisions"
  // does NOT elevate §4, even when prose decisions-about-people is true
  // (the agent may make decisions about people in some other domain).
  const proseExplicitlyNegated =
    !signals.hasDecisionsAboutPeople && signals.decisionImpact === 'none';

  const categories: string[] = [];

  // §1 biometric — prose path unchanged. Typed signal can elevate only
  // when prose also reports sensitive PII + decisions-about-people; we
  // refuse to lift §1 on typed-only evidence because the biometric
  // vendor list (AWS Rekognition, Azure Face, ...) is used widely for
  // non-Annex-III purposes (photo organisation, accessibility).
  if (
    signals.hasBiometricSignal &&
    signals.hasSensitivePII &&
    signals.hasDecisionsAboutPeople
  ) {
    categories.push('§1 biometric');
  } else if (
    !proseExplicitlyNegated &&
    !signals.proseExplicitlyNoBiometric &&
    typed.hasBiometricTypedSignal &&
    signals.hasSensitivePII &&
    signals.hasDecisionsAboutPeople
  ) {
    // Typed elevation path — biometric vendor + sensitive PII + decisions.
    // Still requires the prose-side PII + decision gates so a lone
    // Rekognition key in a photo-tagging agent doesn't fire §1.
    // Category-specific negation: if the agent's prose explicitly says
    // "no biometric processing", honour it even when an AWS Rekognition
    // credential is present (Rekognition is widely used for accessibility,
    // moderation, search — not always biometric ID).
    categories.push('§1 biometric');
  }

  // §3 education — typed signal elevates when prose decisions-about-people
  // is true but EDUCATION_ASSESSMENT_PATTERN didn't fire. Common shape:
  // LMS integration where the prose talks about "students" without using
  // the canonical "grading" / "assessment" vocabulary.
  if (signals.isEducationAssessmentContext && signals.hasDecisionsAboutPeople) {
    categories.push('§3 education');
  } else if (
    !proseExplicitlyNegated &&
    !signals.proseExplicitlyNoEducation &&
    typed.hasEducationTypedSignal &&
    signals.hasDecisionsAboutPeople
  ) {
    // Category-specific negation: agent prose saying "no education
    // decisions" / "not used in schools" must hold even if a CANVAS_LMS
    // token is in the workspace (could be a parent's homework helper
    // that decides about people in some non-education sense).
    categories.push('§3 education');
  }

  // §4 employment — typed signal is strongest here per AAP-85 spec.
  // BAMBOOHR / GREENHOUSE / ADP / Workday in the credential surface
  // is a high-confidence employment indicator. Elevation requires the
  // prose to NOT have negated employment context — if the agent
  // explicitly says "no employment decisions", we honour that.
  if (signals.hasEmploymentDecisions && signals.decisionImpact !== 'none') {
    categories.push('§4 employment');
  } else if (
    !proseExplicitlyNegated &&
    !signals.proseExplicitlyNoEmployment &&
    typed.hasEmploymentTypedSignal &&
    signals.hasDecisionsAboutPeople &&
    signals.decisionImpact !== 'none' &&
    // Prose must not have explicitly negated employment. We treat the
    // mapper's `hasEmploymentDecisions: false + decisionImpact !== none`
    // case as "ambiguous" (e.g. decisions about people but not extracted
    // as employment by the LLM). This is the canonical elevation case
    // from the AAP-85 brief.
    //
    // The `proseExplicitlyNoEmployment` check above adds the category-
    // specific negation gate: when the agent says "we make no employment
    // decisions" but does make OTHER decisions about people, BAMBOOHR
    // must NOT fire §4. The pre-Codex code only checked the
    // whole-classification gate, which would let typed elevate here.
    !signals.hasEmploymentDecisions
  ) {
    categories.push('§4 employment');
  }

  // §5 essential services — conservative. Typed signal alone (e.g. a
  // single Stripe key) is NOT enough; ticket spec explicitly calls out
  // the false-positive risk on financial integrations. Typed elevation
  // requires (a) high-impact decisions AND (b) BOTH typed financial AND
  // typed health-insurance, OR typed + the prose essential-services
  // signal already firing. A lone Plaid key in a budgeting agent that
  // makes high-impact decisions about people still won't fire §5 —
  // there has to be evidence that the decisions are essential-services
  // decisions, not just that financial data is being processed.
  if (
    signals.hasEssentialServicesSignal &&
    signals.decisionImpact === 'high' &&
    signals.hasDecisionsAboutPeople
  ) {
    categories.push('§5 essential services');
  } else if (
    !proseExplicitlyNegated &&
    !signals.proseExplicitlyNoEssentialServices &&
    signals.decisionImpact === 'high' &&
    signals.hasDecisionsAboutPeople &&
    // Convergence requirement: typed financial+health-insurance, or one
    // typed signal alongside the prose essential-services regex. Lone
    // Stripe / Plaid does NOT fire on its own.
    ((typed.hasFinancialTypedSignal && typed.hasHealthInsuranceTypedSignal) ||
      (typed.hasFinancialTypedSignal && signals.hasEssentialServicesSignal) ||
      (typed.hasHealthInsuranceTypedSignal && signals.hasEssentialServicesSignal))
  ) {
    // Category-specific negation: explicit "no essential services" in
    // prose blocks typed convergence too. Defensive even though the
    // convergence gate is already conservative.
    categories.push('§5 essential services');
  }

  // §6 law enforcement — NO typed signal per ticket. The credential
  // surface has no reliable law-enforcement pattern (no widely-deployed
  // border / immigration / forensic API with a recognisable key name),
  // and the cost of a false positive is the AAP-70 repro. Prose path
  // unchanged.
  if (
    signals.isLawEnforcementContext &&
    signals.hasDecisionsAboutPeople &&
    signals.decisionImpact !== 'none'
  ) {
    categories.push('§6 law enforcement');
  }

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
 * `discovery` carries filesystem L1-L3 reads (MCP configs, plugins/
 * skills/auth, workspace .env). `verificationReport` carries the diff +
 * inventory + approval chain output from `runVerification`.
 * `oauthVerifications` is the per-provider source-verification array
 * the cloud-side L4 introspection produces.
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
  // AAP-85: forward Surface 2 discovery capabilities into the core so
  // `classifyEUAIAct` can see typed Annex III signals (HRIS / ATS /
  // edtech / biometric / financial credentials). When `actual.discovery`
  // is absent or null, the typed branch is silent and the prose-only
  // path runs unchanged (AAP-70 invariant preserved).
  const discoveryFindings = collectDiscoveryCapabilities(input.actual);
  const out = mapFindingsCore(input.declared, discoveryFindings);
  if (input.actual) {
    out.controlResults = runTypedDetectors(input.actual);
  }
  return out;
}

/**
 * AAP-85 helper — flatten `actual.discovery.agents[].capabilities[]`
 * into a single `DiscoveredCapability[]` for the classifier. Returns
 * undefined when discovery is absent, so the classifier's typed branch
 * stays dormant (avoids triggering the back-compat overload mismatch).
 *
 * We deliberately walk `capabilities` (the unified AAP-58 list) rather
 * than `mcpServers` alone — the former already re-emits MCP servers
 * with `kind: 'mcp_server'` AND carries plugins + auth credentials.
 * Legacy DiscoveryResult blobs without `capabilities` populated fall
 * back to walking `mcpServers` directly so older sessions still benefit.
 */
function collectDiscoveryCapabilities(
  actual?: ActualEvidence,
): DiscoveredCapability[] | undefined {
  if (!actual || !actual.discovery) return undefined;
  const caps: DiscoveredCapability[] = [];
  for (const agent of actual.discovery.agents ?? []) {
    if (agent.capabilities && agent.capabilities.length > 0) {
      caps.push(...agent.capabilities);
    } else {
      // Legacy fallback — synthesise mcp_server capabilities for old
      // discovery blobs persisted before AAP-58.
      for (const srv of agent.mcpServers ?? []) {
        caps.push({ kind: 'mcp_server', ...srv });
      }
    }
  }
  return caps;
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
    // AAP-111: stamp the owning framework id from the catalog entry (the
    // single source of truth) onto the result's `framework` join field, so
    // report.json `controlResults[].framework` always matches
    // `frameworksActivated` and the dashboard's `FRAMEWORK_LABELS` map. The
    // catalog wins even if a detector ever set `framework` inconsistently.
    out.push({ ...result, framework: entry.frameworkId });
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
function mapFindingsCore(
  input: DeclaredEvidence,
  discoveryFindings?: DiscoveredCapability[],
): CategorizedCompliance {
  const signals = detectSignals(
    input.systems,
    input.transcript,
    input.makesDecisionsAboutPeople === true,
    input.decisionMakingDetails,
  );
  // AAP-85: typed signals from discovery contribute to Annex III gating
  // ONLY when the prose did not explicitly negate decisions-about-people.
  // See `classifyEUAIAct` for the ELEVATE-not-OVERRIDE invariant.
  const euAiActClassification = classifyEUAIAct({
    proseSignals: signals,
    ...(discoveryFindings !== undefined ? { discoveryFindings } : {}),
  });

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
    // AAP-85 Codex post-review (Blocker 3): drive the gate off the
    // already-computed classification result so per-control rendering
    // cannot diverge from the top-level classification.
    const annexIIIOn = isAnnexIIIApplicableForFinding(mapping.findingType, euAiActClassification);
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
