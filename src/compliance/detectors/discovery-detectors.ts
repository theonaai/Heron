/**
 * AAP-83 Phase 5 — typed-evidence detectors for the discovery surface.
 *
 * Replaces the synthesise-prose-then-regex anti-pattern that
 * `src/report/recompute-compliance.ts` used pre-AAP-83. Instead of
 * fabricating a fake QAPair so the prose mapper's `hasSensitivePII`
 * regex can fire, we read the typed `DiscoveryResult` directly and
 * emit `ControlResult`s with proper provenance.
 *
 * Coverage (initial pass — matches the cases pinned by
 * `tests/report/recompute-compliance.test.ts`):
 *
 *   1. Sensitive-data — sensitive credential key patterns
 *      (`STRIPE_SECRET_KEY`, `PLAID_*`, `SSN`, `PASSPORT`, `HIPAA`, …)
 *      surface as GDPR Art. 5 + 6 + 35 ControlResults.
 *   2. International transfer — third-party SaaS credential keys
 *      (`AWS_`, `OPENAI_`, `SLACK_`, `HUBSPOT_`, …) surface as the
 *      processor-flag analogue (GDPR Art. 28-class controls).
 *
 * Discovery walks every remaining surface (`agent.mcpServers[].redactedEnvKeys`,
 * `agent.capabilities[]` (auth_credential), `workspaceEnv[].keys`).
 * The key-vocabulary classifier `classifyKeyName` is the single source
 * of truth for credential-name → category mapping (the AAP-79
 * prose-synthesis shadow was deleted in AAP-86; the L3 Keychain + L4
 * OS-credential surfaces were removed in AAP-100).
 */

import type { DiscoveryResult } from '../../discovery/types.js';
import { stableKeyFor } from '../control-key.js';
import type {
  ControlResult,
  ControlResultEvidenceRef,
  TypedDetector,
  TypedEvidenceEnvelope,
} from './types.js';
import type { FindingType, FrameworkId } from '../types.js';

// ─── Key-vocabulary classifier ─────────────────────────────────────────────

interface KeyClassification {
  hasSensitivePII: boolean;
  hasHealth: boolean;
  hasInternationalTransfer: boolean;
  hasExternalProcessor: boolean;
  /** Specific evidence labels for the ControlResult rationale. */
  labels: string[];
}

/**
 * Centralised key-vocabulary classifier (AAP-86). The prose-path shadow
 * in `src/report/recompute-compliance.ts` was deleted in AAP-86 once
 * the renderer migrated to `controlResults`. This is now the SINGLE
 * source of truth for credential-key → category mapping. Future
 * additions (new payment processor, new HRIS, etc.) only need to land
 * here.
 *
 * AAP-88: categorical threshold `discovery_classifier_singleSource`
 * documented in src/verification/threshold-manifest.ts.
 */
function classifyKeyName(rawKey: string): KeyClassification {
  const key = rawKey.toLowerCase();
  const labels: string[] = [];
  const out: KeyClassification = {
    hasSensitivePII: false,
    hasHealth: false,
    hasInternationalTransfer: false,
    hasExternalProcessor: false,
    labels,
  };

  if (/stripe|credit.?card/.test(key)) {
    out.hasSensitivePII = true;
    labels.push(`${rawKey} → credit card`);
  }
  if (/plaid|bank|ach/.test(key)) {
    out.hasSensitivePII = true;
    labels.push(`${rawKey} → bank account`);
  }
  if (/ssn|social.?security/.test(key)) {
    out.hasSensitivePII = true;
    labels.push(`${rawKey} → SSN`);
  }
  if (/passport|nric|national.?id|tax.?id/.test(key)) {
    out.hasSensitivePII = true;
    labels.push(`${rawKey} → passport / national ID`);
  }
  if (/hipaa|phi|patient/.test(key)) {
    out.hasHealth = true;
    labels.push(`${rawKey} → medical / patient data`);
  }
  if (/aws|azure|gcp|google|s3|cloudfront|cloudflare/.test(key)) {
    out.hasInternationalTransfer = true;
    out.hasExternalProcessor = true;
    labels.push(`${rawKey} → cloud provider (international transfer)`);
  }
  if (/openai|anthropic/.test(key)) {
    out.hasInternationalTransfer = true;
    out.hasExternalProcessor = true;
    labels.push(`${rawKey} → AI provider (international transfer)`);
  }
  if (/slack|hubspot|salesforce|linear|github/.test(key)) {
    out.hasExternalProcessor = true;
    labels.push(`${rawKey} → third-party processor`);
  }

  return out;
}

interface Aggregate {
  hasSensitivePII: boolean;
  hasHealth: boolean;
  hasInternationalTransfer: boolean;
  hasExternalProcessor: boolean;
  evidence: ControlResultEvidenceRef[];
}

function walkDiscovery(discovery: DiscoveryResult): Aggregate {
  const agg: Aggregate = {
    hasSensitivePII: false,
    hasHealth: false,
    hasInternationalTransfer: false,
    hasExternalProcessor: false,
    evidence: [],
  };

  const ingest = (key: string, sourceRef: string) => {
    const c = classifyKeyName(key);
    if (c.hasSensitivePII) agg.hasSensitivePII = true;
    if (c.hasHealth) agg.hasHealth = true;
    if (c.hasInternationalTransfer) agg.hasInternationalTransfer = true;
    if (c.hasExternalProcessor) agg.hasExternalProcessor = true;
    for (const label of c.labels) {
      agg.evidence.push({ kind: 'inventory', ref: `${sourceRef}: ${label}` });
    }
  };

  for (const agent of discovery.agents ?? []) {
    for (const srv of agent.mcpServers ?? []) {
      for (const k of srv.redactedEnvKeys ?? []) {
        ingest(k, `mcp:${srv.name}`);
      }
    }
    for (const cap of agent.capabilities ?? []) {
      if (cap.kind === 'auth_credential') {
        ingest(cap.provider, `capability:${cap.provider}`);
      }
    }
  }

  for (const env of discovery.workspaceEnv ?? []) {
    for (const k of env.keys ?? []) {
      ingest(k, `env:${env.path}`);
    }
  }

  return agg;
}

// ─── Detector — sensitive-data on the discovery surface ────────────────────

/**
 * AAP-88: categorical threshold `discovery_sensitivePII_fail` documented in
 * src/verification/threshold-manifest.ts.
 */
function makeSensitiveDataDetector(
  frameworkId: FrameworkId,
  controlId: string,
  controlName: string,
): TypedDetector {
  return (evidence: TypedEvidenceEnvelope): ControlResult | null => {
    if (!evidence.discovery) return null;
    const agg = walkDiscovery(evidence.discovery);
    if (!agg.hasSensitivePII && !agg.hasHealth) return null;

    const verdict = 'fail';
    const severity = 'high';
    const findingType: FindingType = 'sensitive-data';
    const out: ControlResult = {
      stableKey: stableKeyFor({ findingType, frameworkId, controlId }),
      findingType,
      frameworkId,
      controlId,
      controlName,
      path: 'typed',
      surface: 'actual',
      verdict,
      severity,
      rationale: agg.hasHealth
        ? `Discovery surface contains medical / patient credential names — activates ${frameworkId} ${controlId}.`
        : `Discovery surface contains sensitive PII credential names (credit card / bank / SSN / passport / tax) — activates ${frameworkId} ${controlId}.`,
      evidenceRefs: agg.evidence,
    };
    return out;
  };
}

/**
 * AAP-88: categorical threshold `discovery_externalProcessor_partial` documented
 * in src/verification/threshold-manifest.ts.
 */
function makeProcessorDetector(
  frameworkId: FrameworkId,
  controlId: string,
  controlName: string,
): TypedDetector {
  return (evidence: TypedEvidenceEnvelope): ControlResult | null => {
    if (!evidence.discovery) return null;
    const agg = walkDiscovery(evidence.discovery);
    if (!agg.hasExternalProcessor && !agg.hasInternationalTransfer) return null;

    const findingType: FindingType = 'sensitive-data';
    const out: ControlResult = {
      stableKey: stableKeyFor({ findingType, frameworkId, controlId }),
      findingType,
      frameworkId,
      controlId,
      controlName,
      path: 'typed',
      surface: 'actual',
      verdict: 'partial',
      severity: 'medium',
      rationale: agg.hasInternationalTransfer
        ? `Discovery surface shows third-party SaaS credentials, including cross-border processors — activates ${frameworkId} ${controlId}.`
        : `Discovery surface shows third-party SaaS credentials — activates ${frameworkId} ${controlId}.`,
      evidenceRefs: agg.evidence,
    };
    return out;
  };
}

// ─── Detector — MCP tool inventory presence ────────────────────────────────

/**
 * AAP-105 D4 quick-win #3, corrected in AAP-105 A3 — fires `partial`
 * when the discovery surface lists at least one MCP server.
 *
 * The original D4 pass emitted `verified` here, reasoning that the live
 * MCP list *was* the inventory. That overclaims. ISO 42001 A.4.4 / NIST
 * AI RMF MAP 2.1 ask for a documented, categorised AI-system inventory
 * ARTEFACT — a maintained register of AI components and the tasks they
 * cover — not merely the fact that some MCP servers exist in a config.
 * "An MCP server is present in config" is real, deterministic evidence
 * that AI tooling is in use, but it is NOT proof the operator maintains
 * the inventory process the control requires. Emitting `verified` on
 * that basis is exactly the self-report / compliance-theater pattern
 * Heron exists to replace, so the verdict is `partial`: Heron observed
 * a live inventory, and a documented register would upgrade it.
 *
 * Operators who lack any MCP server (no AI tooling) legitimately fall
 * outside the control's scope — the detector returns null, leaving the
 * row inert.
 */
function makeMcpInventoryDetector(
  frameworkId: FrameworkId,
  controlId: string,
  controlName: string,
): TypedDetector {
  return (evidence: TypedEvidenceEnvelope): ControlResult | null => {
    if (!evidence.discovery) return null;
    const mcpRefs: ControlResultEvidenceRef[] = [];
    for (const agent of evidence.discovery.agents ?? []) {
      for (const srv of agent.mcpServers ?? []) {
        mcpRefs.push({
          kind: 'inventory',
          ref: `mcp:${srv.name} (${srv.transport})`,
        });
      }
    }
    if (mcpRefs.length === 0) return null;

    const findingType: FindingType = 'excessive-access';
    const out: ControlResult = {
      stableKey: stableKeyFor({ findingType, frameworkId, controlId }),
      findingType,
      frameworkId,
      controlId,
      controlName,
      path: 'typed',
      surface: 'actual',
      verdict: 'partial',
      severity: 'info',
      rationale: `Heron observed a live inventory of ${mcpRefs.length} MCP server${mcpRefs.length === 1 ? '' : 's'} in the agent's configuration. ${frameworkId === 'iso-42001' ? 'ISO 42001 A.4.4' : 'NIST AI RMF MAP 2.1'} also expects a documented, categorised AI-system inventory artefact. Supply that to upgrade this control to verified.`,
      evidenceRefs: mcpRefs.slice(0, 24),
    };
    return out;
  };
}

// ─── EU AI Act Art. 5 — prose-only (no typed detector) ─────────────────────
//
// AAP-105 A4 (Ilya, 2026-05-28, final): Art. 5 prohibited practices
// (subliminal manipulation, exploitation, social scoring, predictive
// policing, untargeted facial scraping, emotion recognition at work /
// school, biometric categorisation, real-time biometric ID) are almost
// entirely about the agent's PURPOSE / USE. None of them is detectable
// deterministically from tools / .env / OAuth — they are only knowable
// from what the agent SAYS about itself (interview transcript). So Art. 5
// belongs to the prose engine only, not a typed detector.
//
// The D4 pass added `makeEUAct5AttestationDetector`, which fired `partial`
// whenever discovery showed ≥1 MCP server. That link ("MCP server present"
// → "Art. 5 prohibited practices") is fabricated: it made every agent with
// any tooling show an Art. 5 partial, which is noise, not defensible
// evidence. The typed detector + its adapter row were removed in A4. The
// prose catalog row for Art. 5 stays in `control-mappings.ts` so the prose
// engine still catches it from the transcript when an agent describes a
// prohibited practice.

// ─── Detector — .env secret-pattern presence ───────────────────────────────

/**
 * AAP-105 D4 quick-win #4 — flags GDPR Art. 32 (security of processing)
 * when discovery surfaces secret-pattern variable names (`*_TOKEN`,
 * `*_KEY`, `*_SECRET`, `*_PASSWORD`) sitting in plain `.env` files
 * inside a workspace. Heron's name-only contract means we never read
 * the literal value; the pattern itself indicates the operator has
 * credential material in plaintext on disk, which is a recognised
 * Art. 32 control gap (encryption / pseudonymisation / restricted
 * storage are the canonical mitigations).
 *
 * The detector intentionally fires `partial` rather than `fail`: a
 * `.env` file is a common dev-loop artefact, and the canonical
 * mitigation (move to a secrets manager / use OS keychain) is a
 * follow-on remediation rather than a present compromise. AAP-100
 * removed the L3 keychain reader so we cannot prove "this credential
 * is ALSO in keychain", only the presence in `.env`.
 */
const SECRET_PATTERN_RE = /(_TOKEN|_KEY|_SECRET|_PASSWORD|_PASSWD|_API_KEY|_CREDENTIALS?|_PRIVATE_KEY)$/i;

function makeEnvSecretDetector(
  frameworkId: FrameworkId,
  controlId: string,
  controlName: string,
): TypedDetector {
  return (evidence: TypedEvidenceEnvelope): ControlResult | null => {
    if (!evidence.discovery) return null;
    const matches: ControlResultEvidenceRef[] = [];
    for (const env of evidence.discovery.workspaceEnv ?? []) {
      for (const k of env.keys ?? []) {
        if (SECRET_PATTERN_RE.test(k)) {
          matches.push({
            kind: 'inventory',
            ref: `env:${env.path}: ${k} (plaintext secret-pattern key)`,
          });
        }
      }
    }
    if (matches.length === 0) return null;

    const findingType: FindingType = 'sensitive-data';
    const out: ControlResult = {
      stableKey: stableKeyFor({ findingType, frameworkId, controlId }),
      findingType,
      frameworkId,
      controlId,
      controlName,
      path: 'typed',
      surface: 'actual',
      verdict: 'partial',
      severity: 'medium',
      rationale: `Workspace .env files contain ${matches.length} secret-pattern variable name${matches.length === 1 ? '' : 's'} (token / key / secret / password) — activates ${frameworkId} ${controlId} (security of processing — encrypt or move credentials out of plaintext storage).`,
      evidenceRefs: matches.slice(0, 24),
    };
    return out;
  };
}

// ─── Adapter rows (mirror router-adapter shape) ────────────────────────────

interface DiscoveryAdapterRow {
  findingType: FindingType;
  frameworkId: FrameworkId;
  controlId: string;
  detector: TypedDetector;
}

export const DISCOVERY_DETECTOR_ADAPTERS: ReadonlyArray<DiscoveryAdapterRow> = [
  // GDPR sensitive-data trio (matches CONTROL_MAPPINGS for sensitive-data → gdpr).
  {
    findingType: 'sensitive-data',
    frameworkId: 'gdpr',
    controlId: 'Art. 6',
    detector: makeSensitiveDataDetector(
      'gdpr',
      'Art. 6',
      'Lawful basis for processing.',
    ),
  },
  {
    findingType: 'sensitive-data',
    frameworkId: 'gdpr',
    controlId: 'Art. 35',
    detector: makeSensitiveDataDetector(
      'gdpr',
      'Art. 35',
      'DPIA for high-risk processing.',
    ),
  },
  {
    findingType: 'sensitive-data',
    frameworkId: 'gdpr',
    controlId: 'Art. 33',
    detector: makeSensitiveDataDetector(
      'gdpr',
      'Art. 33',
      '72-hour breach notification.',
    ),
  },
  // AIUC-1 A006 — PII leakage prevention. Surfaces on sensitive PII keys.
  {
    findingType: 'sensitive-data',
    frameworkId: 'aiuc-1',
    controlId: 'A006',
    detector: makeSensitiveDataDetector(
      'aiuc-1',
      'A006',
      'PII leakage prevention.',
    ),
  },
  // External-processor signal — surfaces on third-party SaaS credentials.
  // Routed onto AIUC-1 A001 (input-data policy) which already lives in the
  // sensitive-data finding mapping.
  {
    findingType: 'sensitive-data',
    frameworkId: 'aiuc-1',
    controlId: 'A001',
    detector: makeProcessorDetector(
      'aiuc-1',
      'A001',
      'Input data policy.',
    ),
  },
  // ── AAP-105 D4 quick-win #1: makeProcessorDetector reuse ──────────────────
  // Same third-party-SaaS / processor signal that already lights AIUC-1 A001
  // legitimately speaks to four more controls — one per mandatory framework
  // where the standard expects the operator to document the supplier or
  // cross-border-transfer relationship. Reusing the detector means the
  // evidence and rationale stay identical; only the framework target shifts.
  {
    findingType: 'sensitive-data',
    frameworkId: 'gdpr',
    controlId: 'Art. 28',
    detector: makeProcessorDetector(
      'gdpr',
      'Art. 28',
      'Processor obligations — written contract / DPA required.',
    ),
  },
  {
    findingType: 'sensitive-data',
    frameworkId: 'iso-42001',
    controlId: 'A.10.3',
    detector: makeProcessorDetector(
      'iso-42001',
      'A.10.3',
      'Suppliers — third-party AI components and services.',
    ),
  },
  {
    findingType: 'sensitive-data',
    frameworkId: 'nist-ai-rmf',
    controlId: 'GOVERN 6.2',
    detector: makeProcessorDetector(
      'nist-ai-rmf',
      'GOVERN 6.2',
      'Third-party AI accountability — supplier integration.',
    ),
  },
  {
    findingType: 'sensitive-data',
    frameworkId: 'nist-ai-rmf',
    controlId: 'MANAGE 3.1',
    detector: makeProcessorDetector(
      'nist-ai-rmf',
      'MANAGE 3.1',
      'Third-party risk management — pre-trained or vendor model risk.',
    ),
  },
  // ── AAP-105 D4 quick-win #3: MCP tool inventory presence ─────────────────
  // Any MCP server registered in the agent's config is, by definition, an
  // AI-tool resource that the operator is supposed to inventory. The signal
  // is binary (≥1 MCP server) — when present it lights two AI-system-
  // categorisation / tooling-inventory controls.
  {
    findingType: 'excessive-access',
    frameworkId: 'iso-42001',
    controlId: 'A.4.4',
    detector: makeMcpInventoryDetector(
      'iso-42001',
      'A.4.4',
      'Tooling resources — AI tools and components inventory.',
    ),
  },
  {
    findingType: 'excessive-access',
    frameworkId: 'nist-ai-rmf',
    controlId: 'MAP 2.1',
    detector: makeMcpInventoryDetector(
      'nist-ai-rmf',
      'MAP 2.1',
      'AI system categorisation — capabilities, methods, tasks.',
    ),
  },
  // ── AAP-105 D4 quick-win #4: .env secret-pattern detector ───────────────
  // Reframed from the original "keychain shadowing" idea (AAP-100 removed
  // L3 keychain + L4 OS credential surfaces). The signal Heron CAN see
  // post-AAP-100: secret-pattern variable names (`*_TOKEN`, `*_KEY`,
  // `*_SECRET`, `*_PASSWORD`) sitting in plaintext .env files inside a
  // project workspace. GDPR Art. 32 (security of processing) is the
  // canonical landing.
  {
    findingType: 'sensitive-data',
    frameworkId: 'gdpr',
    controlId: 'Art. 32',
    detector: makeEnvSecretDetector(
      'gdpr',
      'Art. 32',
      'Security of processing — protect credentials from disclosure.',
    ),
  },
  // AAP-105 A4: the EU AI Act Art. 5 typed detector (D4 quick-win #2) was
  // removed. Art. 5 prohibited practices are about the agent's purpose /
  // use and are only knowable from the interview prose, so Art. 5 is a
  // prose-only control now (catalog row stays in control-mappings.ts).
];
