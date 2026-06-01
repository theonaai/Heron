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
 * Doc links: deferred until a real docs site ships. Earlier drafts
 * appended `See https://docs.heron/findings/<slug>` to each hint, but
 * `docs.heron` was never a real domain and a dead link in a security
 * report erodes trust, so the suffix was removed (AAP-105 F3). Hints
 * carry only the actionable "what to do" sentence. When real docs
 * exist, links get added back in a future pass.
 */

import type { FindingType } from '../compliance/types.js';
import type { EvidenceSource } from './types.js';

/**
 * Per-FindingType hints. Each finding type maps to a single 1-line
 * remediation sentence plus a docs URL. Keys MUST match exactly the
 * literal members of the `FindingType` union.
 */
const FINDING_TYPE_HINTS: Record<FindingType, string> = {
  'excessive-access': 'Either restrict the granted scope at the provider, or update the declared scope with business justification.',
  'write-risk': 'Confirm each write operation is necessary, reversible, and bounded — or move it behind a human-in-the-loop gate.',
  'sensitive-data': 'Classify data sensitivity at the source, document the legal basis under GDPR Art. 6, and tighten access if the data is not strictly required.',
  'scope-creep': 'Reconcile declared scope with enumerated scope: either remove the extra tools / scopes or update the declared inventory with business justification.',
  'regulatory-flags': 'Map the affected control to its regulatory framework (EU AI Act, GDPR, ISO 42001, NIST AI RMF) and assign an owner to close the gap.',
  'risk-score': 'Review the contributing factors (blast radius, data sensitivity, domain) and document why the residual risk is acceptable, or remediate to lower it.',
  'decisions-about-people': 'Document the GDPR Art. 22 / EU AI Act Annex III legal basis and add a human-review gate for any automated decision with legal or significant effect.',
};

/**
 * Per-source-prefix hints. Source-based fallback for findings that
 * carry an `evidenceSource` but no typed `FindingType` (e.g. raw OAuth
 * diffs, discovery server-detection findings).
 */
const EVIDENCE_SOURCE_HINTS: Record<EvidenceSource, string> = {
  MCP: 'Either remove the tool from the MCP server config, or update the declared scope to include it with business justification.',
  OAU: 'Either restrict the OAuth scope at the provider, or update the declared scope with business justification.',
  ENV: 'Move credentials to a secret manager (Vault, AWS Secrets Manager, OS keychain) and remove the value from the workspace .env file.',
  PLG: 'Audit the plugin / skill grant: either tighten the declared filesystem / network scope, or remove the plugin from the agent runtime.',
  // #28 — honest SLF fallback. Heron has no document-upload / submit-and-
  // compare flow; it verifies by introspecting the source directly on a
  // re-scan (MCP config, OAuth introspection, .env, runtime). The earlier
  // copy ("ask the deployer for the … document … Heron will rerun the
  // BR×DS×DM scoring against the supplied evidence") promised a workflow
  // that does not exist. Reframe as "this is self-attested; here is the
  // deterministic source a re-scan would read to verify it."
  SLF: 'Self-attested — Heron has no deterministic evidence for this claim. To verify, re-run the audit with source access (MCP config, OAuth introspection, .env, or runtime) so Heron can read it directly; until then a reviewer should confirm it manually.',
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
 * The generic `EVIDENCE_SOURCE_HINTS.SLF` line was identical across every
 * Self-Attested finding card. On a 5-finding session this read as
 * boilerplate noise. Each subcategory here picks a more specific
 * remediation instruction matched against substrings in the finding title
 * + description.
 *
 * #28 — honesty pass. The previous hints said "ask the deployer for the
 * <document> so Heron can compare …", which implied an upload / submit-and-
 * compare workflow that Heron does NOT have. Heron verifies by introspecting
 * the source directly on a re-scan (and, for OAuth, by the agent forwarding
 * its own introspected scopes via the G10 `report_oauth_scopes` flow — not
 * by a human handing Heron a consent-screen screenshot). Each hint is
 * reframed as either (a) the deterministic source a re-scan would read, or
 * (b) honest reviewer guidance when there is no deterministic source.
 *
 * Order matters: the first matching pattern wins. Keep more specific
 * patterns above generic ones. The list is consulted in source order by
 * `getSlfMitigationHint`. The base SLF entry in `EVIDENCE_SOURCE_HINTS`
 * stays as the final fallback when none of these match.
 */
const SLF_SUBCATEGORY_HINTS: Array<{
  /**
   * Stable identifier for the subcategory. `getSlfMitigationHint` uses it
   * to pick a state-aware variant (AAP-110) for the classes whose live
   * audit state is available — currently `oauth` and `credentials`.
   */
  key?: 'oauth' | 'credentials';
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
    // #28 — not verified from a document. Heron checks OAuth scopes by
    // introspecting the token directly: the agent forwards its granted
    // scopes via the OAuth introspection flow (G10). To upgrade, re-run
    // with OAuth introspection enabled so Heron diffs granted vs declared.
    //
    // AAP-110: written as plain sentences (period separators, no "; ")
    // because the dashboard renderer splits a hint on "; " into separate
    // bullets, so a semicolon clause rendered as two glued fragments. This
    // is the stateless variant (introspection state unknown); the
    // state-aware variants live in `getSlfMitigationHint`.
    key: 'oauth',
    hint: 'Self-attested OAuth scope, not verified from a document. Heron verifies OAuth by introspecting the token directly: the agent forwards its granted scopes through the introspection flow. To verify, re-run with OAuth introspection enabled so granted scopes are diffed against declared usage.',
  },
  {
    // Secrets / credentials / .env / API keys. After OAuth — we want the
    // OAuth-scope class to win when both signals overlap.
    pattern: /\b(secret|credential\s+file|api[-\s]?key\b|env(?:ironment)?[-\s]?file|\.env\b|token[-\s]?file|service[-\s]account|password|vault|bot\s+token|login\/password)/i,
    // #28 — the deterministic source is the workspace .env / credential
    // files, which Heron's discovery scan reads directly. Re-run discovery
    // rather than "supplying" anything.
    //
    // AAP-110: stateless variant (discovery state unknown). When discovery
    // already read the .env this turn, `getSlfMitigationHint` returns the
    // state-aware variant instead of telling the reviewer to re-run it.
    key: 'credentials',
    hint: 'Self-attested credential use, not verified from a document. Re-run discovery with workspace access so Heron reads the .env / credential files directly and confirms which keys are deployed. Rotate any secret found in plaintext.',
  },
  {
    // Bulk write / production audit log of write actions.
    pattern: /\b(bulk\s+(?:write|publish|upload|patch|create|update)|writes?\s+can\s+affect|catalog\s+writes|mass\s+update|batch\s+writes?|publish\s+(?:lessons|materials|catalogs))/i,
    // #28 — Heron has no access to production write logs and no flow to
    // ingest one. Honest reviewer guidance: confirm blast radius /
    // frequency / reversibility against the live system.
    hint: 'Self-attested write behavior — Heron cannot observe production writes from the source. A reviewer should confirm the actual blast radius, frequency, and reversibility against the live system before approving.',
  },
  {
    // External vendor / data sent to third-party generation provider.
    pattern: /\b(sent\s+to\s+(?:generation|external|third[-\s]party|vendor)|vendor[-\s]side|generation\s+vendor|external\s+model|gemini\s+receives|gamma\s+receives|openai\s+receives|llm\s+vendor|retention\s+contract|data[-\s]use\s+control)/i,
    // #28 — vendor data-use terms are off-platform; Heron can't verify
    // them by reading any source. Reviewer guidance.
    hint: 'Self-attested vendor data handling — Heron cannot verify a third party\'s data-use terms from the source. A reviewer should confirm each external provider\'s retention and data-use controls against its contract / DPA.',
  },
  {
    // Alerting / monitoring / SLA / fail-open / runbook.
    pattern: /\b(alerting|alerts?\s+fail|fail[-\s]open|notification\s+(?:fails?|stream)|runbook|on[-\s]call|sla\b|monitoring|observability|escalation\s+path)/i,
    // #28 — operational behavior under failure isn't readable from config;
    // reviewer guidance, naming the artefacts to check.
    hint: 'Self-attested alerting / SLA — Heron cannot verify operational failure handling from the source. A reviewer should confirm the runbook, SLA, and escalation path catch real failures (test a forced failure end to end).',
  },
  {
    // MCP tool inventory / tool grants the agent has access to.
    pattern: /\b(mcp\s+(?:config|tool|server)|tool\s+inventory|skill\s+grant|plugin\s+grant|tool[-\s]calling\s+capability)/i,
    // #28 — this one IS deterministically verifiable: the MCP server
    // config / plugin manifest is on disk and discovery reads it. Re-scan.
    hint: 'Self-attested tool inventory — re-run discovery with workspace access so Heron reads the MCP server config / plugin manifest directly and diffs the live tool grants against what was declared.',
  },
  {
    // PII / data sensitivity / data minimization.
    pattern: /\b(pii\b|personal\s+data|personally[-\s]identifiable|data\s+minimization|article\s+(?:6|9)|gdpr\s+art|sensitive\s+data\s+stored|retention\s+polic)/i,
    // #28 — Heron infers DS tiers from the interview, not from a data
    // inventory it can read. Reviewer guidance.
    hint: 'Self-attested data sensitivity — Heron infers the tier from the interview, not from a deterministic data inventory. A reviewer should confirm which PII fields are actually read/written and the retention / deletion policy.',
  },
  {
    // Human-in-the-loop / approval claims.
    pattern: /\b(human[-\s]in[-\s]the[-\s]loop|hitl|manual\s+review|human\s+(?:reviews?|approves?)|approval\s+gate)/i,
    // #28 — review-quality claims aren't readable from any source;
    // reviewer guidance naming what to sample.
    hint: 'Self-attested human review — Heron cannot verify review quality from the source. A reviewer should sample recent decisions and check throughput against the review SOP to confirm the gate is meaningful, not rubber-stamping.',
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
export interface SlfMitigationState {
  oauth?: {
    /** Whether an OAuth introspection was attempted this session. */
    attempted?: boolean;
    /** Per-source verdict, e.g. "verified" | "unverified". */
    verdict?: string;
    /** Provider error when introspection failed, e.g. an invalid_token reject. */
    errorMessage?: string;
  };
  /** Whether discovery read the workspace (.env / credential files) this turn. */
  discoveryRan?: boolean;
}

/**
 * True when an OAuth introspection was attempted but the provider rejected
 * the token because it was expired / invalid (vs. a transient/other error).
 * Matches the deterministic `introspection-error: ... invalid_token` signal
 * Heron records (see `oauthScopeVerification.sources[].errorMessage`).
 */
function isExpiredOrInvalidToken(oauth: SlfMitigationState['oauth']): boolean {
  if (!oauth?.attempted) return false;
  const msg = (oauth.errorMessage || '').toLowerCase();
  return (
    /invalid[_\s-]?token/.test(msg) ||
    /\bexpired\b/.test(msg) ||
    /\binvalid value\b/.test(msg) ||
    // An attempted introspection that did not come back "verified" and
    // carries an introspection error is, for remediation purposes, a
    // rejected/stale token: refresh + re-run is the correct next step.
    (oauth.verdict !== undefined && oauth.verdict !== 'verified' && /introspection-error/.test(msg))
  );
}

/**
 * Resolve a 1-line mitigation hint for a Self-Attested (SLF) finding.
 *
 * Walks `SLF_SUBCATEGORY_HINTS` against `title + description` and returns the
 * first matching subcategory's hint. When optional `state` is supplied and
 * the matched subcategory has live state available (AAP-110: `oauth`,
 * `credentials`), returns a state-aware variant that reflects what already
 * ran this session instead of recommending an already-completed step.
 *
 * Falls back to the generic SLF copy in `EVIDENCE_SOURCE_HINTS.SLF` if
 * nothing matches.
 *
 * Total — always returns a non-empty string.
 */
export function getSlfMitigationHint(
  finding: {
    title?: string;
    description?: string;
  },
  state?: SlfMitigationState,
): string {
  const text = `${finding.title || ''} ${finding.description || ''}`;
  for (const entry of SLF_SUBCATEGORY_HINTS) {
    if (!entry.pattern.test(text)) continue;

    // AAP-110 — state-aware OAuth variant.
    if (entry.key === 'oauth' && state?.oauth) {
      if (isExpiredOrInvalidToken(state.oauth)) {
        return 'Self-attested OAuth scope. Heron attempted OAuth introspection this run, but the provider rejected the token (expired or invalid), so granted scopes could not be diffed against declared usage. Refresh the token and re-run so Heron can introspect the live scopes.';
      }
      // Introspection genuinely did not run -> keep the stateless guidance.
      return entry.hint;
    }

    // AAP-110 — state-aware credentials variant.
    if (entry.key === 'credentials' && state?.discoveryRan) {
      return 'Self-attested credential use. Discovery already read the workspace .env / credential files this run, so the deployed keys are visible to Heron. Rotate any secret found in plaintext and move it to a secret manager (Vault, AWS Secrets Manager, OS keychain).';
    }

    return entry.hint;
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
