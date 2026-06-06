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

/**
 * Collect the connectors whose introspection verdict came back `verified` and
 * the service-level scopes they returned. Returns null when no source verified.
 */
function collectVerifiedOAuth(
  section: OAuthScopeVerificationEvidence | undefined,
): VerifiedOAuth | null {
  const sources = section?.sources ?? [];
  const connectors: string[] = [];
  const scopeSet = new Set<string>();
  for (const s of sources) {
    if (s.verdict !== 'verified') continue;
    if (s.connector) connectors.push(s.connector);
    for (const a of s.actualScopes ?? []) {
      // Prefer the short service identifier (documents / drive / spreadsheets);
      // fall back to the raw scope string when no service was provided.
      const label = a.service || a.scope;
      if (label) scopeSet.add(label);
    }
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
 *   - `excessive-access` / `scope-creep` + at least one VERIFIED OAuth source
 *     -> `evidenceCrossRef { kind: 'oauth-verified', connectors, scopes }`
 *        + a `reconciledMitigation` opening with what Heron verified.
 *   - `sensitive-data` / `credential-exposure` + .env secret detection
 *     -> `evidenceCrossRef { kind: 'env-secrets', envKeyCount, ... }`
 *        + a `reconciledMitigation` opening with what Heron detected.
 *   - `regulatory-flags` (governance) -> `verificationPath: 'operator-artifact'`
 *        + a `reconciledMitigation` naming the operator-artifact path, NO link.
 */
export function reconcileSlfWithEvidence(
  findings: ReadonlyArray<VerdictFinding>,
  evidence: SlfReconciliationEvidence,
): VerdictFinding[] {
  const verifiedOAuth = collectVerifiedOAuth(evidence.oauthScopeVerification);
  const envKeyCount = countEnvKeys(evidence.workspaceEnv);

  return findings.map((f): VerdictFinding => {
    // Only SLF findings reconcile. Verified (MCP/OAU/ENV/PLG) findings already
    // carry their own evidence and never need a cross-ref.
    if (f.evidenceSource !== 'SLF') return f;
    const ft = f.findingType;
    if (!ft) return f;

    if (OAUTH_EVIDENCE_TYPES.has(ft) && verifiedOAuth) {
      const crossRef: SlfEvidenceCrossRef = {
        kind: 'oauth-verified',
        connectors: verifiedOAuth.connectors,
        scopes: verifiedOAuth.scopes,
      };
      return {
        ...f,
        evidenceCrossRef: crossRef,
        reconciledMitigation: oauthVerifiedMitigation(verifiedOAuth),
      };
    }

    if (ENV_EVIDENCE_TYPES.has(ft) && envKeyCount > 0) {
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
