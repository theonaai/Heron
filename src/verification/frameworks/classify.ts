/**
 * AAP-86 — HR-agent classifier.
 *
 * `isHRAgent` previously lived in `router.ts` alongside the framework
 * detectors. Phase 9 deletes `router.ts`, so the classifier moves into
 * a dedicated module that has no other dependencies on the framework
 * detector implementations. Both the framework detectors and the HR
 * vertical pack consume it.
 *
 * PR #22 round-2 MEDIUM fix preserved: requires AT LEAST TWO independent
 * signals from {connector, scope, keyword}. Two-signal requirement
 * prevents false-positive HR classification on agents that share one
 * keyword with the HR domain (e.g. "candidate accounts" in a marketing
 * context, "hire a car" in a travel-booking agent).
 */

import type { ActualInventory, DeclaredInventory } from '../types.js';
import type { VerificationSignals } from './envelope.js';

/**
 * HR-vertical signals. The agent is classified as HR if AT LEAST TWO
 * of the three independent signals fire:
 *
 *   1. Connector — declared scope.service exactly matches a known HR
 *      SaaS canonical name (Greenhouse, BambooHR, Workday, …).
 *   2. HR scope — declared scope.scope matches an HR-class scope
 *      pattern (admin.directory, candidates:*, applications:*,
 *      jobs:*, offers:*, recruiting:*, employees:*, interviews:*).
 *   3. HR keyword — declared agent.purpose or tool name/description
 *      matches an HR-phrase regex (e.g. "candidate notification",
 *      "hiring process", "employee onboarding").
 *
 * PR #22 round-2 MEDIUM fix: the previous gate fired on ANY one of
 * the three signals using substring matching for connectors and
 * bare-word regex for keywords. That produced false positives —
 * "greenhouse-marketing" → substring match; "hire a car rental"
 * → bare-word match; "marketing emails to candidate accounts" →
 * bare-word match on /candidate/.
 *
 * Two-signal requirement prevents false-positive HR classification on
 * agents that share one keyword with the HR domain. Connector match is
 * also tightened to exact equality so a SaaS product whose name simply
 * contains the substring "greenhouse" cannot be misclassified.
 */
const HR_CONNECTORS: ReadonlySet<string> = new Set([
  'greenhouse',
  'bamboohr',
  'bamboo',
  'workday',
  'lever',
  'gusto',
  'rippling',
  'sapsuccessfactors',
]);

const HR_SCOPE_PATTERNS: readonly RegExp[] = [
  // Google Workspace admin directory — the canonical "I can read your
  // employee roster" scope. Highly HR-class.
  /admin\.directory/i,
  // ATS-native HR namespaces. Kept narrow on purpose: scopes like
  // `jobs:` or `directory:` are ambiguous (jobs could be cron jobs,
  // directory could be filesystem) and are intentionally NOT in this
  // list — they wouldn't count as a stand-alone HR signal even when
  // paired with an HR connector.
  /\bcandidates?:/i,
  /\bapplicants?:/i,
  /\bapplications?:/i,
  /\binterviews?:/i,
  /\brecruiting:/i,
];

const HR_KEYWORDS: readonly RegExp[] = [
  /\bcandidate\s+(rejection|notification|scoring|review|outreach|pipeline)/i,
  /\b(recruit(er|ing|ment))\b/i,
  /\b(hiring|hire)\s+(decision|process|workflow|manager|criteria)/i,
  /\b(employee|onboarding)\s+(scoring|review|onboard|directory|record)/i,
  /\b(applicant|interview)\s+(tracking|scheduling|scoring|review)/i,
  /\b(cv|resume)\s+(parsing|review|scoring)/i,
];

function matchesAnyRegex(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((p) => p.test(value));
}

function matchesHRConnector(service: string): boolean {
  return HR_CONNECTORS.has(service.toLowerCase().trim());
}

function hasHRConnector(d: DeclaredInventory | undefined): boolean {
  if (!d) return false;
  for (const s of d.scopes ?? []) {
    if (matchesHRConnector(s.service)) return true;
  }
  return false;
}

function hasHRScope(d: DeclaredInventory | undefined, _actuals: readonly ActualInventory[]): boolean {
  if (!d) return false;
  for (const s of d.scopes ?? []) {
    if (matchesAnyRegex(s.scope, HR_SCOPE_PATTERNS)) return true;
    // admin.directory is sometimes encoded in the service field
    // (Google Workspace canonical service paths).
    if (matchesAnyRegex(s.service, HR_SCOPE_PATTERNS)) return true;
  }
  return false;
}

function hasHRKeyword(d: DeclaredInventory | undefined): boolean {
  if (!d) return false;
  const purpose = d.agent?.purpose ?? '';
  if (purpose && matchesAnyRegex(purpose, HR_KEYWORDS)) return true;
  for (const t of d.tools ?? []) {
    const text = `${t.name} ${t.description ?? ''}`;
    if (matchesAnyRegex(text, HR_KEYWORDS)) return true;
  }
  return false;
}

/**
 * Exported for the framework Annex III §4 detector, the HR vertical
 * pack gate, and unit tests / downstream consumers that need to gate a
 * UI hint on whether the agent is HR-class. Pure boolean; no side
 * effects.
 *
 * PR #22 round-2 MEDIUM fix: requires AT LEAST TWO independent signals
 * from {connector, scope, keyword}. Two-signal requirement prevents
 * false-positive HR classification on agents that share one keyword
 * with the HR domain (e.g. "candidate accounts" in a marketing context,
 * "hire a car" in a travel-booking agent).
 */
export function isHRAgent(sig: VerificationSignals): boolean {
  // AAP-88: thresholds documented in src/verification/threshold-manifest.ts.
  //   - classify_hrAgent_minSignals (>=2 of {connector, scope, keyword})
  //   - classify_hrConnector_exactMatch (exact lowercased equality)
  const d = sig.declaredInventory;
  if (!d) return false;

  let signalCount = 0;
  if (hasHRConnector(d)) signalCount++;
  if (hasHRScope(d, sig.actualInventories)) signalCount++;
  if (hasHRKeyword(d)) signalCount++;
  return signalCount >= 2;
}
