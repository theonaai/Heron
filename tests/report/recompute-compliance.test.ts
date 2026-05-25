/**
 * AAP-79 — Stage 3 framework re-computation with discovery evidence.
 *
 * Closes the original gap that motivated this ticket: pre-AAP-79 the
 * analyzer's `mapFindingsToRiskCategories` ran exactly once, against
 * the interview transcript only. A transcript that never mentioned PII
 * could leave the report missing GDPR Article 5(1)(c) controls even
 * when discovery later surfaced an env file with `STRIPE_SECRET_KEY`
 * in it.
 *
 * `recomputeComplianceWithDiscovery` synthesises a virtual evidence
 * row from the discovery payload (names only, never values, mirroring
 * the discovery readers' privacy contract) and re-feeds the augmented
 * transcript through the same mapper. The mapper's `hasSensitivePII`
 * signal regex picks up the synthesised `credit card` token and the
 * sensitive-data finding now fires against the GDPR framework.
 *
 * These tests pin two scenarios:
 *   1. Empty discovery scan → recomputed compliance matches the baseline
 *      (no regressions for sessions without Surface 2 evidence).
 *   2. Discovery finds a STRIPE_SECRET_KEY → recomputed compliance picks
 *      up GDPR sensitive-data flags (the recompute path is the only way
 *      that flag can fire, since the transcript itself never mentioned
 *      sensitive PII).
 */

import { describe, expect, it } from 'vitest';

import {
  recomputeComplianceWithDiscovery,
  synthesizeDiscoveryEvidence,
} from '../../src/report/recompute-compliance.js';
import type { DiscoveryResult } from '../../src/discovery/types.js';
import type { QAPair, SystemAssessment } from '../../src/report/types.js';

function emptyDiscovery(): DiscoveryResult {
  return {
    agents: [],
    findings: [],
    scannedAt: '2026-05-25T00:00:00.000Z',
    scannedPaths: [],
  };
}

function transcriptWithoutPII(): QAPair[] {
  // Deliberately mundane interview content. None of the strings here
  // should trip the hasPII / hasSensitivePII regexes. The agent talks
  // about MCP and Slack and that's it.
  return [
    {
      category: 'purpose',
      question: 'What does the agent do?',
      answer: 'It posts Slack reminders when a build finishes.',
    },
    {
      category: 'systems',
      question: 'Which systems does it touch?',
      answer: 'Slack via MCP. Nothing else.',
    },
    {
      category: 'writes',
      question: 'Does it write anywhere?',
      answer: 'Posts a single message to one Slack channel per run.',
    },
  ];
}

const analyzerSystems: SystemAssessment[] = [];

describe('AAP-79 — recomputeComplianceWithDiscovery', () => {
  it('returns a baseline (no PII flags) when discovery is empty + transcript has no PII', () => {
    const result = recomputeComplianceWithDiscovery({
      analyzer: { systems: analyzerSystems },
      transcript: transcriptWithoutPII(),
      discovery: emptyDiscovery(),
    });

    // No PII surfaced anywhere → sensitive-data finding never fires.
    expect(result.signals.hasSensitivePII).toBe(false);
    expect(result.signals.hasPublicPII).toBe(false);
    expect(result.signals.hasPII).toBe(false);

    // No GDPR flag with triggeredBy=sensitive-data.
    const gdprSensitive = result.all.filter(
      (f) => f.frameworkId === 'gdpr' && f.triggeredBy === 'sensitive-data',
    );
    expect(gdprSensitive).toHaveLength(0);
  });

  it('lifts GDPR sensitive-data flag when discovery surfaces a STRIPE_SECRET_KEY env var', () => {
    // The transcript still does not mention any PII signal. The ONLY
    // thing pushing the mapper towards a sensitive-data finding here
    // is the discovery payload, fed through `synthesizeDiscoveryEvidence`
    // and folded into the augmented transcript by the recompute helper.
    const discovery: DiscoveryResult = {
      agents: [
        {
          runtime: 'codex',
          configPath: '/Users/me/.codex/config.toml',
          mcpServers: [],
          capabilities: [],
        },
      ],
      findings: [],
      workspaceEnv: [
        {
          path: '/Users/me/repo/.env',
          workspace: '/Users/me/repo',
          keys: ['STRIPE_SECRET_KEY'],
        },
      ],
      scannedAt: '2026-05-25T00:00:00.000Z',
      scannedPaths: ['/Users/me/.codex/config.toml'],
    };

    // Sanity-check the synthesiser maps STRIPE_ to the "credit card"
    // vocabulary the mapper's regex looks for. Without this token the
    // recompute wouldn't trip hasSensitivePII.
    const synthesized = synthesizeDiscoveryEvidence(discovery);
    expect(synthesized.answer.toLowerCase()).toContain('credit card');

    const result = recomputeComplianceWithDiscovery({
      analyzer: { systems: analyzerSystems },
      transcript: transcriptWithoutPII(),
      discovery,
    });

    expect(result.signals.hasSensitivePII).toBe(true);
    expect(result.signals.hasPII).toBe(true);

    // Sensitive-data flag now fires against GDPR. The control ID label
    // contains "Article 5" (data minimisation / lawful basis); the exact
    // wording is owned by the framework registry, we just assert one of
    // the GDPR controls landed.
    const gdprSensitive = result.all.filter(
      (f) => f.frameworkId === 'gdpr' && f.triggeredBy === 'sensitive-data',
    );
    expect(gdprSensitive.length).toBeGreaterThan(0);
    // Severity escalates to action-required when the trigger is sensitive
    // (rather than public) PII — covered in describeFinding().
    expect(gdprSensitive[0]?.severity).toBe('action-required');
  });

  it('lifts the same flag when STRIPE_SECRET_KEY comes from a discovered mcpServer redactedEnvKeys', () => {
    // Same outcome from a different L1/L2 surface. Belt-and-braces — the
    // synthesiser walks both `agent.mcpServers[].redactedEnvKeys` AND
    // `workspaceEnv[].keys`, so both paths must produce the same
    // vocabulary the mapper can lock onto.
    const discovery: DiscoveryResult = {
      agents: [
        {
          runtime: 'codex',
          configPath: '/Users/me/.codex/config.toml',
          mcpServers: [
            {
              name: 'stripe-mcp',
              transport: 'stdio',
              hasCredentials: true,
              redactedEnvKeys: ['STRIPE_SECRET_KEY'],
            },
          ],
          capabilities: [],
        },
      ],
      findings: [],
      scannedAt: '2026-05-25T00:00:00.000Z',
      scannedPaths: [],
    };

    const result = recomputeComplianceWithDiscovery({
      analyzer: { systems: analyzerSystems },
      transcript: transcriptWithoutPII(),
      discovery,
    });

    expect(result.signals.hasSensitivePII).toBe(true);
    const gdprSensitive = result.all.filter(
      (f) => f.frameworkId === 'gdpr' && f.triggeredBy === 'sensitive-data',
    );
    expect(gdprSensitive.length).toBeGreaterThan(0);
  });

  it('does not synthesise content for discovery=undefined (back-compat with pre-AAP-79 reports)', () => {
    // When called from a legacy code path without a discovery payload,
    // the result must match the bare mapper output. Otherwise pre-AAP-79
    // reports loaded from disk would shift their flag set on re-render.
    const transcript = transcriptWithoutPII();
    const withUndefined = recomputeComplianceWithDiscovery({
      analyzer: { systems: analyzerSystems },
      transcript,
      discovery: undefined,
    });
    const withEmpty = recomputeComplianceWithDiscovery({
      analyzer: { systems: analyzerSystems },
      transcript,
      discovery: emptyDiscovery(),
    });

    expect(withUndefined.all).toEqual(withEmpty.all);
    expect(withUndefined.signals).toEqual(withEmpty.signals);
  });
});
