/**
 * AAP-103 — Mitigation hints catalog (MVP).
 *
 * One-line "what to do" sentence + docs link per finding type. Covers
 * the 7 typed `FindingType` discriminators surfaced by the deterministic
 * detector layer plus a handful of source-based hints for OAuth /
 * discovery / SLF findings whose ergonomic identifier is the
 * `evidenceSource` rather than the typed finding-type.
 *
 * Scope:
 *   - 1-sentence action + 1 doc link. Phase 2 will expand to a richer
 *     template catalog with placeholder substitution (30-50 entries),
 *     once a design partner has signed off on what they actually want
 *     to see for each class of finding.
 *   - Falls back to a generic line when no hint is registered — the
 *     report always has *something* to say, never an empty Mitigations
 *     block.
 *
 * Anchors:
 *   - heron-session-context-2026-05-28.md §"Mitigation hints (MVP)"
 *   - Linear AAP-103 §"Mitigation hints lookup"
 *
 * Docs link convention: `https://docs.heron/findings/<slug>`. The
 * domain is a placeholder until the docs site ships; the lookup
 * structure stays valid once real URLs land.
 */

import type { FindingType } from '../compliance/types.js';
import type { EvidenceSource } from './types.js';

/**
 * Per-FindingType hints. Each finding type maps to a single 1-line
 * remediation sentence plus a docs URL. Keys MUST match exactly the
 * literal members of the `FindingType` union.
 */
const FINDING_TYPE_HINTS: Record<FindingType, string> = {
  'excessive-access': 'Either restrict the granted scope at the provider, or update the declared scope with business justification. See https://docs.heron/findings/excessive-access',
  'write-risk': 'Confirm each write operation is necessary, reversible, and bounded — or move it behind a human-in-the-loop gate. See https://docs.heron/findings/write-risk',
  'sensitive-data': 'Classify data sensitivity at the source, document the legal basis under GDPR Art. 6, and tighten access if the data is not strictly required. See https://docs.heron/findings/sensitive-data',
  'scope-creep': 'Reconcile declared scope with enumerated scope: either remove the extra tools / scopes or update the declared inventory with business justification. See https://docs.heron/findings/scope-creep',
  'regulatory-flags': 'Map the affected control to its regulatory framework (EU AI Act, GDPR, ISO 42001, NIST AI RMF) and assign an owner to close the gap. See https://docs.heron/findings/regulatory-flags',
  'risk-score': 'Review the contributing factors (blast radius, data sensitivity, domain) and document why the residual risk is acceptable, or remediate to lower it. See https://docs.heron/findings/risk-score',
  'decisions-about-people': 'Document the GDPR Art. 22 / EU AI Act Annex III legal basis and add a human-review gate for any automated decision with legal or significant effect. See https://docs.heron/findings/decisions-about-people',
};

/**
 * Per-source-prefix hints. Source-based fallback for findings that
 * carry an `evidenceSource` but no typed `FindingType` (e.g. raw OAuth
 * diffs, discovery server-detection findings).
 */
const EVIDENCE_SOURCE_HINTS: Record<EvidenceSource, string> = {
  MCP: 'Either remove the tool from the MCP server config, or update the declared scope to include it with business justification. See https://docs.heron/findings/mcp-write-tool',
  OAU: 'Either restrict the OAuth scope at the provider, or update the declared scope with business justification. See https://docs.heron/findings/oauth-scope-extra',
  ENV: 'Move credentials to a secret manager (Vault, AWS Secrets Manager, OS keychain) and remove the value from the workspace .env file. See https://docs.heron/findings/env-sensitive-pii',
  PLG: 'Audit the plugin / skill grant: either tighten the declared filesystem / network scope, or remove the plugin from the agent runtime. See https://docs.heron/findings/plugin-grant',
  SLF: 'This claim is self-reported and not yet verified deterministically. Treat it as a working hypothesis until you can attach evidence (config file, OAuth scope, .env key, or audit log). See https://docs.heron/findings/self-attested',
};

/**
 * Generic fallback. Used when neither finding-type nor evidence-source
 * lookups produce a hit. Intentionally vague: the report still has a
 * Mitigations block but the reviewer is sent back to the finding
 * detail to decide remediation.
 */
const MITIGATION_FALLBACK =
  'Review the finding details and the cited framework controls; route remediation to the relevant system owner. Contact your security team if the appropriate owner is unclear.';

/**
 * Resolve a 1-line mitigation hint for a finding.
 *
 * Lookup order:
 *   1. `findingType` — typed deterministic detector signature.
 *   2. `evidenceSource` — provenance prefix when no typed signature.
 *   3. Generic fallback.
 *
 * The function is total: it always returns a non-empty string.
 *
 * Callers pass whichever discriminators they have. The verdict /
 * report layer carries `evidenceSource` on every finding (AAP-102),
 * but typed `findingType` only on the subset of findings that flowed
 * through the deterministic detector adapter layer.
 */
export function getMitigationHint(
  args: { findingType?: string; evidenceSource?: EvidenceSource } = {},
): string {
  const ft = args.findingType;
  if (ft && isKnownFindingType(ft)) {
    return FINDING_TYPE_HINTS[ft];
  }
  const ev = args.evidenceSource;
  if (ev) {
    return EVIDENCE_SOURCE_HINTS[ev];
  }
  return MITIGATION_FALLBACK;
}

function isKnownFindingType(s: string): s is FindingType {
  return Object.prototype.hasOwnProperty.call(FINDING_TYPE_HINTS, s);
}

/**
 * Expose the catalog itself for tests / introspection — callers should
 * prefer `getMitigationHint` for runtime use so the fallback contract
 * stays single-source.
 */
export const MITIGATION_CATALOG = {
  byFindingType: FINDING_TYPE_HINTS,
  byEvidenceSource: EVIDENCE_SOURCE_HINTS,
  fallback: MITIGATION_FALLBACK,
} as const;
