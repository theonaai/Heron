/**
 * AAP-149 — reconcile Self-Attested (SLF) findings with the deterministic
 * evidence Heron already gathered this session.
 *
 * THE PROBLEM. Analysis mints SLF findings from the interview. Deterministic
 * verification / discovery (OAuth introspection, .env secret scan, systems
 * table) runs separately and was never reconciled back into those findings. So
 * an SLF finding restated a risk whose underlying FACT Heron ALREADY confirmed,
 * yet it rendered as "self-attested, interview only, do not move risk" with a
 * GENERIC remediation disconnected from the evidence. Concrete cases from live
 * session sess-20260604-032116-fcece0:
 *   - SLF "Broad Google OAuth access ..." while Google Sheets/Docs/Drive show
 *     VERIFIED in the OAuth scope verification (verdict === 'verified', scopes
 *     documents/drive/spreadsheets, diffs []). The broad scope IS verified; the
 *     finding sat as a bare unverified claim.
 *   - SLF "Workspace stores high-sensitivity credentials" while the .env scan
 *     detected 44 keys and 5 systems carry the ".env" credential glyph. The
 *     plaintext-credential fact IS detected; the finding sat as a bare claim.
 *   - SLF "No formal compliance control or independent sign-off" — governance,
 *     genuinely NOT verifiable from the agent (SLF label correct), but the
 *     mitigation was still generic with no verify-framing.
 *
 * THE DESIGN.
 *   1. Keep SLF findings as SLF. `evidenceSource` stays `'SLF'`. They do NOT
 *      move risk/posture and do NOT count toward the "verified" findings count.
 *      Heron's honesty model depends on this. We are NOT re-bucketing them.
 *   2. Cross-link each SLF finding to the deterministic evidence that confirms
 *      its underlying fact, keyed off the finding's closed `findingType` (NOT
 *      fragile free-text title matching):
 *        - `excessive-access` / `scope-creep` -> OAuth connectors whose verdict
 *          is `verified`.
 *        - `sensitive-data` / `credential-exposure` -> the .env secret detection
 *          / systems carrying the ".env" credential status.
 *        - findingTypes with no agent-observable deterministic evidence (e.g.
 *          governance / `regulatory-flags` about formal sign-off) -> NO evidence
 *          link; mark the verification path (operator-supplied artifact).
 *   3. Rewrite the SLF mitigation: open with what Heron ACTUALLY confirmed this
 *      session, then the risk + remediation. For governance, name the
 *      verification path (operator artifact) instead of generic "document X".
 *      Never say "set up / enable X" when Heron confirmed X already exists.
 *
 * This module is PURE and side-effect-free so it is unit-testable with fixtures
 * (no I/O). It runs at verification time in Phase B of `runVerificationAndPatch`
 * (src/server/mcp-server.ts), after the merge produces `oauthScopeVerification`
 * + the .env/credential evidence, so the result bakes into report.json.
 */

import type { VerdictFinding, SlfEvidenceCrossRef } from './verdict.js';

// ── Loose evidence shapes ────────────────────────────────────────────────
//
// Kept local + permissive so this module stays decoupled from the dashboard's
// `'use client'` report-json types and the node-only discovery types, mirroring
// the `OAuthScopeVerificationLike` pattern in src/report/mitigation-catalog.ts.

/** Narrowed view of `report.oauthScopeVerification` (lib/report-json.ts). */
export interface OAuthScopeVerificationEvidence {
  sources?: Array<{
    connector?: string;
    verdict?: string;
    actualScopes?: Array<{ service?: string; scope?: string }>;
  }>;
}

/** Narrowed view of `DiscoveryResult.workspaceEnv` (src/discovery/types.ts). */
export interface WorkspaceEnvEvidence {
  keys?: string[];
}

export interface SlfReconciliationEvidence {
  /** OAuth scope verification section persisted on report.json (G10). */
  oauthScopeVerification?: OAuthScopeVerificationEvidence;
  /** Per-workspace `.env*` files: variable NAMES only, never values (AAP-67). */
  workspaceEnv?: ReadonlyArray<WorkspaceEnvEvidence>;
  /**
   * Count of declared systems flagged as carrying a `.env` credential (the
   * ".env" credential glyph from AAP-140). Optional; surfaced in the cross-ref
   * + mitigation when present.
   */
  envCredentialSystemsCount?: number;
  /**
   * The systemIds of the declared systems that carry the `.env` credential glyph
   * (the subset the AAP-140 token matcher flagged). Used to SUBJECT-SCOPE the
   * .env cross-ref: when a finding names a specific declared system, the env
   * evidence only attaches if that system is among these detected ones.
   * Optional. When absent the .env cross-ref keeps the workspace-global behavior
   * (any sensitive-data / credential-exposure finding gets the global count).
   */
  envCredentialSystemIds?: ReadonlyArray<string>;
  /**
   * The systemIds of EVERY declared system this session (from report.json
   * `systems[]`). Used only to tell whether a finding NAMES A SPECIFIC SYSTEM at
   * all: an env finding that names a declared system NOT in
   * `envCredentialSystemIds` must not claim the global .env fact. A finding that
   * names no specific declared system (workspace-general phrasing) keeps the
   * global behavior. Optional; absent => workspace-global behavior preserved.
   */
  declaredSystemIds?: ReadonlyArray<string>;
}

// ── findingType -> evidence mapping ──────────────────────────────────────
//
// DETERMINISTIC routing by the closed `FindingType` enum. No title matching.

/** findingTypes whose fact is confirmable by a VERIFIED OAuth scope. */
const OAUTH_EVIDENCE_TYPES = new Set(['excessive-access', 'scope-creep']);

/** findingTypes whose fact is confirmable by the .env secret detection. */
const ENV_EVIDENCE_TYPES = new Set(['sensitive-data', 'credential-exposure']);

/**
 * findingTypes with NO agent-observable deterministic evidence: governance /
 * formal sign-off. These can only be verified by an operator-supplied artifact,
 * so they get the verification-path framing, never an evidence link.
 */
const OPERATOR_ARTIFACT_TYPES = new Set(['regulatory-flags']);

// ── OAuth evidence extraction ────────────────────────────────────────────

interface VerifiedOAuth {
  connectors: string[];
  scopes: string[];
}

/** One verified OAuth connector with the brand-stem tokens that name it. */
interface VerifiedConnector {
  /** Connector kind as introspected (e.g. `google-workspace`). */
  connector: string;
  /** Verified service-level scope labels (documents / drive / spreadsheets). */
  scopes: string[];
  /**
   * Lowercase brand-stem tokens that, if present in a finding's text, mean the
   * finding is about THIS connector. Derived deterministically from the
   * connector id (split on `-`/`_`) plus its verified service scope labels.
   */
  subjectTokens: Set<string>;
}

/**
 * Map of well-known connector kinds to extra brand synonyms a finding's prose
 * is likely to use that are NOT already in the connector id or scope labels.
 * Conservative and explainable: each entry is an unambiguous product term for
 * that connector kind. The base matcher already derives `google`, `workspace`,
 * `drive`, `spreadsheets`, `documents` from the id + scopes; this only adds the
 * common prose synonyms (`gmail`, `sheets`, `docs`) that map to the same kind.
 * Not vendor-hardcoded routing — purely a synonym dictionary keyed off the
 * connector kind the introspection already returned.
 */
const CONNECTOR_BRAND_SYNONYMS: Record<string, string[]> = {
  'google-workspace': ['google', 'gmail', 'sheets', 'spreadsheet', 'docs', 'gdrive', 'gsuite'],
  greenhouse: ['greenhouse'],
  bamboohr: ['bamboohr', 'bamboo'],
};

/**
 * Build the lowercase brand-stem token set that identifies a verified connector
 * inside a finding's free text. Conservative: id tokens (split on `-`/`_`, len
 * > 2 to drop noise like `hr`), the verified scope service labels, and any
 * curated prose synonyms for that connector kind. `workspace` is dropped as a
 * subject token because it is too generic (Slack/MS/Notion all use it) — a
 * finding must name a real product stem, not just the word "workspace".
 */
function subjectTokensForConnector(connector: string, scopes: string[]): Set<string> {
  const tokens = new Set<string>();
  const add = (raw: string): void => {
    const t = raw.toLowerCase().trim();
    // `workspace` alone is too generic to attribute a finding to a connector.
    if (t.length > 2 && t !== 'workspace') tokens.add(t);
  };
  for (const t of connector.split(/[-_]/)) add(t);
  for (const s of scopes) {
    // Scope labels can be short service words or dotted/colon scope strings;
    // take the leading service segment (drive.readonly -> drive).
    add(s.split(/[.:/]/)[0] ?? s);
  }
  for (const syn of CONNECTOR_BRAND_SYNONYMS[connector.toLowerCase()] ?? []) add(syn);
  return tokens;
}

/**
 * Collect the connectors whose introspection verdict came back `verified`, each
 * with its service-level scopes and the brand-stem tokens that name it. Returns
 * null when no source verified.
 */
function collectVerifiedOAuth(
  section: OAuthScopeVerificationEvidence | undefined,
): VerifiedConnector[] | null {
  const sources = section?.sources ?? [];
  const verified: VerifiedConnector[] = [];
  for (const s of sources) {
    if (s.verdict !== 'verified') continue;
    if (!s.connector) continue;
    const scopeSet = new Set<string>();
    for (const a of s.actualScopes ?? []) {
      // Prefer the short service identifier (documents / drive / spreadsheets);
      // fall back to the raw scope string when no service was provided.
      const label = a.service || a.scope;
      if (label) scopeSet.add(label);
    }
    const scopes = [...scopeSet];
    verified.push({
      connector: s.connector,
      scopes,
      subjectTokens: subjectTokensForConnector(s.connector, scopes),
    });
  }
  if (verified.length === 0) return null;
  return verified;
}

/** Lowercase word tokens (len > 1) of a finding's title + description. */
function findingTextTokens(f: VerdictFinding): Set<string> {
  const text = `${f.title} ${f.description}`.toLowerCase();
  const out = new Set<string>();
  for (const t of text.split(/[^a-z0-9]+/)) {
    if (t.length > 1) out.add(t);
  }
  return out;
}

/**
 * Subset of verified connectors whose brand-stem tokens appear in the finding's
 * own text. Empty when the finding names no verified connector. This is what
 * scopes the cross-ref to the finding's subject: a Slack finding never matches
 * a verified `google-workspace` source, so it gets no false cross-ref.
 */
function connectorsNamedBy(
  finding: VerdictFinding,
  verified: VerifiedConnector[],
): VerifiedOAuth | null {
  const words = findingTextTokens(finding);
  const connectors: string[] = [];
  const scopeSet = new Set<string>();
  for (const vc of verified) {
    let named = false;
    for (const tok of vc.subjectTokens) {
      if (words.has(tok)) {
        named = true;
        break;
      }
    }
    if (!named) continue;
    connectors.push(vc.connector);
    for (const s of vc.scopes) scopeSet.add(s);
  }
  if (connectors.length === 0) return null;
  return { connectors, scopes: [...scopeSet] };
}

// ── .env evidence extraction ─────────────────────────────────────────────

/** Total count of distinct .env credential KEY NAMES detected this session. */
function countEnvKeys(
  workspaceEnv: ReadonlyArray<WorkspaceEnvEvidence> | undefined,
): number {
  if (!workspaceEnv || workspaceEnv.length === 0) return 0;
  let n = 0;
  for (const f of workspaceEnv) n += f.keys?.length ?? 0;
  return n;
}

/**
 * Lowercase brand-stem tokens of a systemId (split on `-`/`_`, len > 2). Mirrors
 * the AAP-140 env-credential-systems token matcher (mcp-server.ts) so the same
 * vocabulary identifies a system in a finding's prose as identifies it on the
 * systems table.
 */
function systemBrandTokens(systemId: string): string[] {
  return systemId
    .toLowerCase()
    .split(/[-_]/)
    .filter((t) => t.length > 2);
}

/**
 * Decide whether the .env evidence may attach to an SLF credential finding.
 *
 * Workspace-global by default: when the finding names no specific declared
 * system (or no system context was supplied), the .env fact IS workspace-global
 * so the cross-ref attaches. But when the finding names a SPECIFIC declared
 * system that did NOT carry the `.env` glyph, attaching the global count would
 * overclaim against that system — so it is suppressed (prefer false negative
 * over overclaim). A finding naming an env-detected system attaches as normal.
 */
function envEvidenceAppliesTo(
  finding: VerdictFinding,
  detectedSystemIds: ReadonlyArray<string> | undefined,
  declaredSystemIds: ReadonlyArray<string> | undefined,
): boolean {
  // No system context supplied: preserve the legacy workspace-global behavior.
  if (!declaredSystemIds || declaredSystemIds.length === 0) return true;
  const words = findingTextTokens(finding);
  const detected = new Set((detectedSystemIds ?? []).map((s) => s.toLowerCase()));

  let namesSpecificSystem = false;
  for (const sysId of declaredSystemIds) {
    const named = systemBrandTokens(sysId).some((t) => words.has(t));
    if (!named) continue;
    // The finding names this declared system. If it carried the .env glyph, the
    // evidence applies; record that the finding is system-specific either way.
    namesSpecificSystem = true;
    if (detected.has(sysId.toLowerCase())) return true;
  }
  // Names a specific declared system, none of which were env-detected -> suppress.
  // Names no specific system (workspace-general) -> keep workspace-global behavior.
  return !namesSpecificSystem;
}

// ── Mitigation rewriters ─────────────────────────────────────────────────
//
// House style: plain sentences, period separators (the dashboard renderer
// splits a mitigation on newlines into bullets, never on "; "), no em-dashes.
// Each opens with what Heron CONFIRMED this session, then risk + remediation.

/** Human-readable list, e.g. "documents, drive, and spreadsheets". */
function joinHuman(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function oauthVerifiedMitigation(ev: VerifiedOAuth): string {
  const scopeList = ev.scopes.length > 0 ? joinHuman(ev.scopes) : 'the granted scopes';
  return (
    `Heron verified you hold ${scopeList} scope on ${joinHuman(ev.connectors)} ` +
    `(OAuth introspection, granted == declared, no diffs). ` +
    `The broad scope this self-report describes is the live, verified grant: each scope is a real write path. ` +
    `Confirm every granted scope is required, then either narrow it at the provider or record a business justification for keeping it. ` +
    `This finding stays self-attested because the operational risk it claims (large-scale unintended writes) is a judgement about how the scope is used, which Heron cannot observe.`
  );
}

function envSecretsMitigation(
  envKeyCount: number,
  credentialSystemsCount: number | undefined,
): string {
  const systemsClause =
    credentialSystemsCount && credentialSystemsCount > 0
      ? ` across ${credentialSystemsCount} declared system${credentialSystemsCount === 1 ? '' : 's'}`
      : '';
  return (
    `Heron detected ${envKeyCount} credential key${envKeyCount === 1 ? '' : 's'} in plaintext .env files${systemsClause} (names only, values never read). ` +
    `The high-sensitivity-credential fact this self-report describes is confirmed on disk. ` +
    `Rotate any secret that has been in plaintext and move it into a secrets manager (Vault, AWS Secrets Manager, OS keychain). ` +
    `This finding stays self-attested because the sensitivity tier and downstream handling are interview-sourced, which Heron cannot verify from the key names alone.`
  );
}

function operatorArtifactMitigation(): string {
  return (
    `Heron cannot observe a formal compliance control or independent sign-off from the agent: this is governance, verifiable only by an operator-supplied artifact. ` +
    `To close it, have the control owner produce the attestation or sign-off record (policy, review log, or independent approval) and attach it to the audit. ` +
    `This finding stays self-attested until that operator artifact exists; there is no deterministic source Heron can read to confirm it.`
  );
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Reconcile SLF findings with deterministic evidence. Returns a NEW array; the
 * input findings are never mutated. Non-SLF findings, SLF findings with no
 * `findingType`, and SLF findings whose findingType has no matching evidence
 * this session pass through unchanged.
 *
 *   - `excessive-access` / `scope-creep` + a VERIFIED OAuth source WHOSE
 *     CONNECTOR THE FINDING NAMES
 *     -> `evidenceCrossRef { kind: 'oauth-verified', connectors, scopes }`
 *        + a `reconciledMitigation` opening with what Heron verified.
 *     The cross-ref is SUBJECT-SCOPED: a finding only gets a connector's
 *     evidence when its own text (title + description) names that connector via
 *     its brand-stem tokens. A finding that names no verified connector keeps
 *     the honest legacy SLF render (no cross-ref). When several verified
 *     connectors are named, only the matched ones appear in the cross-ref.
 *   - `sensitive-data` / `credential-exposure` + .env secret detection
 *     -> `evidenceCrossRef { kind: 'env-secrets', envKeyCount, ... }`
 *        + a `reconciledMitigation` opening with what Heron detected.
 *     The .env fact is workspace-global, so a finding that names no specific
 *     system still attaches it; a finding that names a specific declared system
 *     NOT among the env-detected ones is suppressed (see `envEvidenceAppliesTo`).
 *   - `regulatory-flags` (governance) -> `verificationPath: 'operator-artifact'`
 *        + a `reconciledMitigation` naming the operator-artifact path, NO link.
 */
export function reconcileSlfWithEvidence(
  findings: ReadonlyArray<VerdictFinding>,
  evidence: SlfReconciliationEvidence,
): VerdictFinding[] {
  const verifiedConnectors = collectVerifiedOAuth(evidence.oauthScopeVerification);
  const envKeyCount = countEnvKeys(evidence.workspaceEnv);

  return findings.map((f): VerdictFinding => {
    // Only SLF findings reconcile. Verified (MCP/OAU/ENV/PLG) findings already
    // carry their own evidence and never need a cross-ref.
    if (f.evidenceSource !== 'SLF') return f;
    const ft = f.findingType;
    if (!ft) return f;

    if (OAUTH_EVIDENCE_TYPES.has(ft) && verifiedConnectors) {
      // Subject-scope: attach only the verified connectors THIS finding names.
      // No named connector -> no cross-ref (honest legacy SLF render).
      const named = connectorsNamedBy(f, verifiedConnectors);
      if (named) {
        const crossRef: SlfEvidenceCrossRef = {
          kind: 'oauth-verified',
          connectors: named.connectors,
          scopes: named.scopes,
        };
        return {
          ...f,
          evidenceCrossRef: crossRef,
          reconciledMitigation: oauthVerifiedMitigation(named),
        };
      }
      // Falls through to the no-evidence return below (no overclaim).
    }

    if (
      ENV_EVIDENCE_TYPES.has(ft) &&
      envKeyCount > 0 &&
      envEvidenceAppliesTo(f, evidence.envCredentialSystemIds, evidence.declaredSystemIds)
    ) {
      const crossRef: SlfEvidenceCrossRef = {
        kind: 'env-secrets',
        envKeyCount,
        ...(evidence.envCredentialSystemsCount !== undefined
          ? { credentialSystemsCount: evidence.envCredentialSystemsCount }
          : {}),
      };
      return {
        ...f,
        evidenceCrossRef: crossRef,
        reconciledMitigation: envSecretsMitigation(
          envKeyCount,
          evidence.envCredentialSystemsCount,
        ),
      };
    }

    if (OPERATOR_ARTIFACT_TYPES.has(ft)) {
      // No agent-observable deterministic evidence: name the verification path.
      // No evidence link is attached (the fact is not confirmed by Heron).
      return {
        ...f,
        verificationPath: 'operator-artifact',
        reconciledMitigation: operatorArtifactMitigation(),
      };
    }

    // SLF finding whose findingType has no matching evidence this session
    // (e.g. excessive-access but OAuth never verified). Leave it to the existing
    // state-aware `getSlfMitigationHint` path, unchanged.
    return f;
  });
}
