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
  // AAP-104 B4 — SLF fallback rewritten as a concrete instruction ("how
  // to convert to Verified") instead of a meta-restatement of "this is
  // self-reported". The SLF badge already labels the row; the
  // mitigation block now tells the reviewer what evidence to attach.
  SLF: 'How to convert to Verified: ask the deployer for the MCP config, OAuth scope grant, .env keys, or production audit log that backs this claim. Heron will rerun the BR×DS×DM scoring against the supplied evidence. See https://docs.heron/findings/self-attested',
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
 * AAP-105 B6 — per-subcategory SLF mitigation variants.
 *
 * The generic `EVIDENCE_SOURCE_HINTS.SLF` line ("ask the deployer for
 * the MCP config, OAuth scope grant, .env keys, or production audit
 * log…") was identical across every Self-Attested finding card. On a
 * 5-finding session this read as boilerplate noise. Each subcategory
 * here picks a more specific "ask for X" instruction matched against
 * substrings in the finding title + description.
 *
 * Order matters: the first matching pattern wins. Keep more specific
 * patterns above generic ones. The list is consulted in source order
 * by `getSlfMitigationHint`.
 *
 * The base SLF entry in `EVIDENCE_SOURCE_HINTS` stays as the final
 * fallback when none of these subcategories match — and so the
 * existing "every evidence source has a hint" test contract holds.
 */
const SLF_SUBCATEGORY_HINTS: Array<{
  pattern: RegExp;
  hint: string;
}> = [
  {
    // OAuth scope claims (any provider). Order: this MUST come before the
    // generic "credential" / "secret" pattern below, because OAuth-scope
    // findings often contain the word "credentials" in passing ("OAuth
    // user credentials with spreadsheets, drive scope") and we'd
    // misclassify them as a secrets-management finding otherwise.
    pattern: /\b(oauth\s+(?:scope|permission|access|grant|consent|credentials?)|broad\s+(?:google|microsoft|github|slack)\s+oauth|scope\s+grant|spreadsheets\s+scope|drive\s+scope|gmail\s+scope|full\s+drive|drive\s+full|google\s+oauth\s+(?:scope|permission)|excessive\s+(?:scope|oauth))/i,
    hint: 'How to convert to Verified: ask the deployer for the OAuth scope grant document or the provider consent screen for this account so Heron can compare granted scopes against declared usage. See https://docs.heron/findings/self-attested',
  },
  {
    // Secrets / credentials / .env / API keys. After OAuth — we want the
    // OAuth-scope class to win when both signals overlap.
    pattern: /\b(secret|credential\s+file|api[-\s]?key\b|env(?:ironment)?[-\s]?file|\.env\b|token[-\s]?file|service[-\s]account|password|vault|bot\s+token|login\/password)/i,
    hint: 'How to convert to Verified: ask the deployer for the .env file or credential vault export so Heron can verify which keys are actually deployed and rotate any leaked secrets. See https://docs.heron/findings/self-attested',
  },
  {
    // Bulk write / production audit log of write actions.
    pattern: /\b(bulk\s+(?:write|publish|upload|patch|create|update)|writes?\s+can\s+affect|catalog\s+writes|mass\s+update|batch\s+writes?|publish\s+(?:lessons|materials|catalogs))/i,
    hint: 'How to convert to Verified: ask the deployer for the production audit log of write actions in the last quarter so Heron can verify actual blast radius, frequency, and reversibility. See https://docs.heron/findings/self-attested',
  },
  {
    // External vendor / data sent to third-party generation provider.
    pattern: /\b(sent\s+to\s+(?:generation|external|third[-\s]party|vendor)|vendor[-\s]side|generation\s+vendor|external\s+model|gemini\s+receives|gamma\s+receives|openai\s+receives|llm\s+vendor|retention\s+contract|data[-\s]use\s+control)/i,
    hint: 'How to convert to Verified: ask the deployer for the vendor data-retention contract and data-use control terms for each external provider so Heron can confirm what the third party can do with sent content. See https://docs.heron/findings/self-attested',
  },
  {
    // Alerting / monitoring / SLA / fail-open / runbook.
    pattern: /\b(alerting|alerts?\s+fail|fail[-\s]open|notification\s+(?:fails?|stream)|runbook|on[-\s]call|sla\b|monitoring|observability|escalation\s+path)/i,
    hint: 'How to convert to Verified: ask the deployer for the alerting runbook plus SLA / escalation documentation so Heron can verify that operational failures are actually caught and acted on. See https://docs.heron/findings/self-attested',
  },
  {
    // MCP tool inventory / tool grants the agent has access to.
    pattern: /\b(mcp\s+(?:config|tool|server)|tool\s+inventory|skill\s+grant|plugin\s+grant|tool[-\s]calling\s+capability)/i,
    hint: 'How to convert to Verified: ask the deployer for the MCP server config / plugin manifest so Heron can compare declared tools against the live inventory. See https://docs.heron/findings/self-attested',
  },
  {
    // PII / data sensitivity / data minimization.
    pattern: /\b(pii\b|personal\s+data|personally[-\s]identifiable|data\s+minimization|article\s+(?:6|9)|gdpr\s+art|sensitive\s+data\s+stored|retention\s+polic)/i,
    hint: 'How to convert to Verified: ask the deployer for the data inventory or DPIA documenting which PII fields the agent actually reads and writes, plus the retention / deletion policy. See https://docs.heron/findings/self-attested',
  },
  {
    // Human-in-the-loop / approval claims.
    pattern: /\b(human[-\s]in[-\s]the[-\s]loop|hitl|manual\s+review|human\s+(?:reviews?|approves?)|approval\s+gate)/i,
    hint: 'How to convert to Verified: ask the deployer for the review SOP, throughput numbers, and a sampling audit of recent decisions so Heron can confirm review is meaningful rather than rubber-stamping. See https://docs.heron/findings/self-attested',
  },
];

/**
 * Resolve a 1-line mitigation hint for a Self-Attested (SLF) finding.
 *
 * Walks `SLF_SUBCATEGORY_HINTS` against `title + description` and
 * returns the first matching subcategory's hint. Falls back to the
 * generic SLF copy in `EVIDENCE_SOURCE_HINTS.SLF` if nothing matches.
 *
 * Total — always returns a non-empty string.
 */
export function getSlfMitigationHint(finding: {
  title?: string;
  description?: string;
}): string {
  const text = `${finding.title || ''} ${finding.description || ''}`;
  for (const entry of SLF_SUBCATEGORY_HINTS) {
    if (entry.pattern.test(text)) return entry.hint;
  }
  return EVIDENCE_SOURCE_HINTS.SLF;
}

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
 *
 * AAP-105 B6 — for SLF findings, callers should prefer
 * `getSlfMitigationHint` since it applies a subcategory match against
 * the finding's text. `getMitigationHint` keeps the generic SLF copy
 * for back-compat with the contract test.
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
