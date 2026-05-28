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
];
