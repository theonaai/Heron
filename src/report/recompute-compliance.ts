/**
 * AAP-79 — recompute the Stage 3 framework mapping with discovery evidence.
 *
 * The original analyzer pipeline runs `mapFindingsToRiskCategories` exactly
 * once, on the LLM-extracted systems + the raw interview transcript. Surface
 * 2 evidence (`runDiscovery` filesystem reads — L1-L5) lands later, after
 * the report is already on disk. Pre-AAP-79 the mapping was never
 * re-computed, so a transcript that never mentioned PII could still leave
 * the report missing GDPR Art 5(1)(c) controls even when discovery found an
 * AWS credentials file or a `.env` with `STRIPE_SECRET_KEY` in it.
 *
 * This module closes that gap (Finding 1 in the 2026-05-24 architecture
 * audit). It synthesises a virtual transcript fragment from the discovery
 * payload — names only, never values, mirroring the names-not-values
 * contract that the discovery readers themselves uphold — and feeds the
 * augmented transcript back into `mapFindingsToRiskCategories`.
 *
 * Why the synthesis route rather than retrofitting `detectSignals` with an
 * extra parameter: the analyzer + mapper already speak the same vocabulary
 * (transcript text). Pushing discovery evidence through the same channel
 * means every signal regex the mapper already maintains (`hasSensitivePII`,
 * `hasInternationalTransfer`, `hasMCPOrA2A`, etc.) automatically benefits
 * without a coordinated schema change. The synthesised text is also kept
 * out of the persisted transcript itself — only the mapper sees it.
 *
 * Privacy contract: this module NEVER reads credential values. It accepts
 * the already-redacted `DiscoveryResult` (output of the discovery readers
 * + secretlint pass) and constructs evidence text from KEY NAMES, FILE
 * PATHS, PROFILE NAMES, and SERVICE NAMES only.
 */

import type { DiscoveryResult } from '../discovery/types.js';
import {
  mapFindingsToRiskCategories,
  type CategorizedCompliance,
} from '../compliance/mapper.js';
import type {
  AnalysisResult,
  QAPair,
  SystemAssessment,
} from './types.js';

/**
 * Minimum subset of the analyzer output the recompute path needs. We keep
 * this narrow on purpose — the discovery scan route patches a partial
 * report.json before this runs, and we tolerate older sessions that
 * predate AAP-79.
 */
export interface RecomputeAnalyzerSubset {
  systems: SystemAssessment[];
  makesDecisionsAboutPeople?: AnalysisResult['makesDecisionsAboutPeople'];
  decisionMakingDetails?: AnalysisResult['decisionMakingDetails'];
}

/**
 * Recompute `compliance` (CategorizedCompliance) from the analyzer
 * output plus an augmented transcript that includes a synthesised
 * "discovery evidence" QA pair. Returns the fresh CategorizedCompliance
 * for the caller to write back onto the report — pure function, no IO.
 *
 * `discovery` is the structurally-typed payload that lives at
 * `reportJson.localAgentDiscovery` after `runDiscovery` completes. The
 * function tolerates partial / undefined fields — anything missing
 * falls through as "no extra signal" and the mapper output matches the
 * Stage 3 original.
 */
export function recomputeComplianceWithDiscovery(args: {
  analyzer: RecomputeAnalyzerSubset;
  transcript: QAPair[];
  discovery?: DiscoveryResult | null;
}): CategorizedCompliance {
  const augmentedTranscript = args.discovery
    ? [...args.transcript, synthesizeDiscoveryEvidence(args.discovery)]
    : args.transcript;

  return mapFindingsToRiskCategories({
    systems: args.analyzer.systems,
    transcript: augmentedTranscript,
    ...(args.analyzer.makesDecisionsAboutPeople !== undefined
      ? { makesDecisionsAboutPeople: args.analyzer.makesDecisionsAboutPeople }
      : {}),
    ...(args.analyzer.decisionMakingDetails !== undefined
      ? { decisionMakingDetails: args.analyzer.decisionMakingDetails }
      : {}),
  });
}

/**
 * Build the synthetic QA pair that carries Surface 2 evidence into the
 * mapper's signal-detection regexes. Category is set to `'data'` so the
 * mapper treats it as substantive answer text (categories without a
 * `data`-adjacent label get scrubbed by some signal heuristics).
 *
 * Question text is intentionally constant so a downstream reader who
 * dumps the augmented transcript for debugging sees a clear marker for
 * the synthesised row. Answer text is built from the discovery payload
 * with a hard cap so a pathological discovery dump cannot blow past
 * Heron's per-answer budget.
 *
 * Exported for unit-test introspection — production callers use
 * `recomputeComplianceWithDiscovery` exclusively.
 */
export function synthesizeDiscoveryEvidence(discovery: DiscoveryResult): QAPair {
  const fragments: string[] = [];

  // ── L1 + L2 — MCP servers + plugins + skills + auth credentials ──────
  for (const agent of discovery.agents ?? []) {
    for (const srv of agent.mcpServers ?? []) {
      const transport = srv.transport ?? 'stdio';
      const creds = srv.hasCredentials ? ' (credentials configured)' : '';
      fragments.push(`mcp server ${srv.name} via ${transport}${creds}.`);
      for (const key of srv.redactedEnvKeys ?? []) {
        fragments.push(envKeyToEvidence(key));
      }
    }
    for (const cap of agent.capabilities ?? []) {
      if (cap.kind === 'auth_credential') {
        fragments.push(envKeyToEvidence(cap.provider));
      }
      if (cap.kind === 'plugin') {
        fragments.push(`plugin ${cap.name} enabled=${cap.enabled}.`);
      }
    }
  }

  // ── L3 — Keychain service names ──────────────────────────────────────
  for (const kc of discovery.keychainServices ?? []) {
    fragments.push(`keychain service ${kc.service} category=${kc.category}.`);
  }

  // ── L4 — cross-cutting OS credential files ───────────────────────────
  for (const oc of discovery.osCredentials ?? []) {
    fragments.push(
      `OS credential file ${oc.kind} at ${oc.path} tokens=${(oc.tokens ?? []).join(',') || 'none'}.`,
    );
  }

  // ── L5 — per-workspace .env variable names ───────────────────────────
  for (const env of discovery.workspaceEnv ?? []) {
    fragments.push(`workspace env file ${env.path}:`);
    for (const key of env.keys ?? []) {
      fragments.push(envKeyToEvidence(key));
    }
  }

  // ── Diff findings (EXTRA / MISSING / HIDDEN-CREDENTIALS) ─────────────
  for (const finding of discovery.findings ?? []) {
    fragments.push(`discovery finding ${finding.kind}: ${finding.description}.`);
  }

  // Cap the synthesised body so a pathological discovery dump cannot
  // dominate the transcript-text join. 16 KB matches the analyzer's
  // per-answer ceiling elsewhere in the pipeline.
  const MAX_LEN = 16 * 1024;
  let answer = fragments.join(' ');
  if (answer.length > MAX_LEN) {
    answer = answer.slice(0, MAX_LEN);
  }

  return {
    category: 'data',
    question: '[heron-internal] Surface 2 evidence summary',
    answer,
  };
}

/**
 * Translate a redacted credential KEY name into evidence text the
 * mapper's signal regexes can lock onto. The names follow widely-used
 * conventions (`AWS_`, `STRIPE_`, `HUBSPOT_`, ...); the mapper already
 * matches the common third-party vendors via the
 * `hasInternationalTransfer` regex. Sensitive PII keys land under
 * `hasSensitivePII` via the credit-card / bank-account / SSN patterns.
 */
function envKeyToEvidence(rawKey: string): string {
  const key = rawKey.toLowerCase();
  const tags: string[] = [];

  // Map common credential names onto the vocabulary the mapper already
  // recognises. The mapper does case-insensitive substring matching, so
  // we emit the canonical English word the regex looks for.
  if (/stripe|credit.?card/.test(key)) tags.push('credit card');
  if (/plaid|bank|ach/.test(key)) tags.push('bank account');
  if (/ssn|social.?security/.test(key)) tags.push('SSN');
  if (/passport|nric|national.?id|tax.?id/.test(key)) tags.push('passport');
  if (/hipaa|phi|patient/.test(key)) tags.push('medical patient data');
  if (/aws|azure|gcp|google|s3|cloudfront|cloudflare/.test(key)) {
    tags.push('aws international transfer');
  }
  if (/openai|anthropic/.test(key)) tags.push('openai international transfer');
  if (/slack|hubspot|salesforce|linear|github/.test(key)) {
    tags.push('third party processor');
  }

  const tagsLine = tags.length > 0 ? ` (${tags.join('; ')})` : '';
  return `credential key ${rawKey}${tagsLine}.`;
}
