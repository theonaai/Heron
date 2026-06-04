/**
 * AAP-79 / AAP-86 — Stage 3 framework re-computation with discovery
 * evidence.
 *
 * Closes the original gap that motivated AAP-79: pre-AAP-79 the
 * analyzer's `mapFindingsToRiskCategories` ran exactly once, against
 * the interview transcript only. A transcript that never mentioned PII
 * could leave the report missing GDPR Article 5(1)(c) controls even
 * when discovery later surfaced an env file with `STRIPE_SECRET_KEY`
 * in it.
 *
 * Pre-AAP-86 the recompute path synthesised a virtual evidence row
 * from the discovery payload and fed it through the prose mapper so
 * the `hasSensitivePII` regex would fire. AAP-86 deletes that synthesis
 * — the typed detectors in `src/compliance/detectors/discovery-detectors.ts`
 * read the discovery payload directly and emit `ControlResult`s with
 * proper provenance.
 *
 * These tests pin the post-AAP-86 contract:
 *   1. Empty discovery scan → recomputed compliance has no typed
 *      sensitive-data controls and no GDPR sensitive-data flag in the
 *      legacy projection.
 *   2. Discovery finds a STRIPE_SECRET_KEY → recomputed compliance
 *      surfaces typed GDPR Art. 6 / 35 / 33 + AIUC-1 A006 control
 *      results AND the legacy `compliance.all` GDPR sensitive-data
 *      flag (preserved through the merged projection in `mapFindings`).
 *   3. Same outcome from the mcpServer.redactedEnvKeys surface — the
 *      typed detectors walk both L1 (MCP) and L5 (workspace env).
 *   4. AAP-85 typed Annex III signals continue to flow through.
 */

import { describe, expect, it } from 'vitest';

import { recomputeComplianceWithDiscovery } from '../../src/report/recompute-compliance.js';
import type { DiscoveryResult } from '../../src/discovery/types.js';
import type { QAPair, SystemAssessment } from '../../src/report/types.js';
import type { VerificationReport } from '../../src/verification/types.js';

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

describe('AAP-79 / AAP-86 — recomputeComplianceWithDiscovery', () => {
  it('returns a baseline (no typed sensitive-data controls, no GDPR sensitive-data flag) when discovery is empty + transcript has no PII', () => {
    const result = recomputeComplianceWithDiscovery({
      analyzer: { systems: analyzerSystems },
      transcript: transcriptWithoutPII(),
      discovery: emptyDiscovery(),
    });

    // Typed projection: no sensitive-data controls fired.
    const typedSensitive = result.controlResults.filter(
      (r) => r.findingType === 'sensitive-data',
    );
    expect(typedSensitive).toEqual([]);

    // Legacy projection: no GDPR flag with triggeredBy=sensitive-data.
    const gdprSensitive = result.all.filter(
      (f) => f.frameworkId === 'gdpr' && f.triggeredBy === 'sensitive-data',
    );
    expect(gdprSensitive).toHaveLength(0);
  });

  it('lifts GDPR sensitive-data controls when discovery surfaces a STRIPE_SECRET_KEY env var', () => {
    // The transcript still does not mention any PII signal. The ONLY
    // thing pushing the mapper toward sensitive-data controls here is
    // the discovery payload, fed through the typed-evidence detectors
    // in `src/compliance/detectors/discovery-detectors.ts`.
    //
    // Post-AAP-86 contract: discovery-only sensitive-data signals
    // surface exclusively through `controlResults`. The renderer's
    // merged projection in templates.ts keeps `compliance.all`-driven
    // renderers honest by combining both projections at render time.
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

    const result = recomputeComplianceWithDiscovery({
      analyzer: { systems: analyzerSystems },
      transcript: transcriptWithoutPII(),
      discovery,
    });

    // Typed projection: STRIPE key fires GDPR Art. 6 / 35 / 33 + AIUC-1 A006.
    const typedSensitive = result.controlResults.filter(
      (r) => r.findingType === 'sensitive-data',
    );
    const ids = typedSensitive.map((r) => `${r.frameworkId}:${r.controlId}`);
    expect(ids).toContain('gdpr:Art. 6');
    expect(ids).toContain('gdpr:Art. 35');
    expect(ids).toContain('gdpr:Art. 33');
    expect(ids).toContain('aiuc-1:A006');
    // PII-keyed detectors must fire `fail`; env-secret-pattern detector
    // (GDPR Art. 32, AAP-105 D4) legitimately fires `partial` for the
    // same input. Pin verdicts per control rather than uniformly.
    const failControlIds = new Set(['Art. 6', 'Art. 35', 'Art. 33', 'A006']);
    for (const r of typedSensitive) {
      expect(r.path).toBe('typed');
      expect(r.surface).toBe('actual');
      if (failControlIds.has(r.controlId)) {
        expect(r.verdict).toBe('fail');
      }
    }
  });

  it('lifts the same controls when STRIPE_SECRET_KEY comes from a discovered mcpServer redactedEnvKeys', () => {
    // Same outcome from a different L1/L2 surface. Belt-and-braces — the
    // typed detector walks `agent.mcpServers[].redactedEnvKeys` AND
    // `workspaceEnv[].keys`, so both paths must produce the same
    // sensitive-data ControlResults.
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

    const typedSensitive = result.controlResults.filter(
      (r) => r.findingType === 'sensitive-data',
    );
    const ids = typedSensitive.map((r) => `${r.frameworkId}:${r.controlId}`);
    expect(ids).toContain('gdpr:Art. 6');
    expect(ids).toContain('aiuc-1:A006');
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

// ─── Forwarded-OAuth wedge: verificationReport threads into the detectors ────
//
// Pre-fix, recomputeComplianceWithDiscovery only ever passed
// `actual: { discovery }`. The router-adapter wedge detectors (AIUC-1
// A003.4/B006, GDPR Art 25/Art 22) build their signals via
// `envelopeToSignals`, which reads `evidence.verificationReport` and returns
// null without it — so a clean forwarded OAuth grant produced 0 verified wedge
// controls. The fix adds a `verificationReport` parameter that flows through to
// `mapFindings({ declared, actual: { discovery, verificationReport } })`.

/** A clean verified OAuth VerificationReport: declared==actual, no diffs. */
function cleanVerifiedOAuthReport(): VerificationReport {
  const capturedAt = '2026-05-29T10:00:00.000Z';
  return {
    capturedAt,
    agentLabel: 'sess-test',
    declared: [
      {
        source: 'interview',
        capturedAt,
        scopes: [{ service: 'google-workspace', scope: 'drive.readonly' }],
      },
    ],
    sources: [
      {
        sourceId: 'oauth-scopes',
        verdict: 'verified',
        diffs: [],
        inventory: {
          source: 'oauth-scopes',
          capturedAt,
          scopes: [{ service: 'google-workspace', scope: 'drive.readonly' }],
        },
      },
    ],
  };
}

describe('forwarded-OAuth wedge — verificationReport threads to the detectors', () => {
  it('without a verificationReport, the wedge detectors do not run', () => {
    const out = recomputeComplianceWithDiscovery({
      analyzer: { systems: analyzerSystems },
      transcript: [],
    });
    // No actual evidence ⇒ prose-only path ⇒ no typed controlResults.
    expect(out.controlResults).toEqual([]);
  });

  it('a verified forwarded report lights the wedge controls to `verified`', () => {
    const out = recomputeComplianceWithDiscovery({
      analyzer: { systems: analyzerSystems },
      transcript: [],
      verificationReport: cleanVerifiedOAuthReport(),
    });
    const verdictFor = (frameworkId: string, controlId: string) =>
      out.controlResults.find(
        (r) => r.frameworkId === frameworkId && r.controlId === controlId,
      )?.verdict;
    expect(verdictFor('aiuc-1', 'A003.4')).toBe('verified');
    expect(verdictFor('aiuc-1', 'B006')).toBe('verified');
    // AAP-135 (B9): GDPR data-minimisation control is wired under Art. 5(1)(c).
    expect(verdictFor('gdpr', 'Art. 5(1)(c)')).toBe('verified');
  });

  it('the report and discovery can be threaded together', () => {
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
        { path: '/Users/me/repo/.env', workspace: '/Users/me/repo', keys: ['STRIPE_SECRET_KEY'] },
      ],
      scannedAt: '2026-05-25T00:00:00.000Z',
      scannedPaths: [],
    };
    const out = recomputeComplianceWithDiscovery({
      analyzer: { systems: analyzerSystems },
      transcript: transcriptWithoutPII(),
      discovery,
      verificationReport: cleanVerifiedOAuthReport(),
    });
    // Discovery-driven sensitive-data controls still fire…
    const ids = out.controlResults.map((r) => `${r.frameworkId}:${r.controlId}`);
    expect(ids).toContain('gdpr:Art. 6');
    // …AND the OAuth wedge controls verify.
    expect(
      out.controlResults.find((r) => r.frameworkId === 'aiuc-1' && r.controlId === 'B006')?.verdict,
    ).toBe('verified');
  });

  it('a null verificationReport is treated as absent (back-compat)', () => {
    const withNull = recomputeComplianceWithDiscovery({
      analyzer: { systems: analyzerSystems },
      transcript: transcriptWithoutPII(),
      verificationReport: null,
    });
    const without = recomputeComplianceWithDiscovery({
      analyzer: { systems: analyzerSystems },
      transcript: transcriptWithoutPII(),
    });
    expect(withNull.all).toEqual(without.all);
    expect(withNull.controlResults).toEqual(without.controlResults);
  });
});

describe('AAP-85 — typed Annex III signals flow through recomputeComplianceWithDiscovery', () => {
  // The recompute path already feeds DiscoveryResult into mapFindings via
  // `actual.discovery`. AAP-85 wires that envelope into classifyEUAIAct so
  // typed HRIS / ATS / edtech / biometric / financial credential names
  // can elevate Annex III classification. These tests pin the end-to-end
  // flow (recompute → mapFindings → classifyEUAIAct), independent of the
  // unit-level tests in tests/compliance/aap-85-classify-typed-signals.ts.
  function transcriptAmbiguousEmployment(): QAPair[] {
    return [
      {
        category: 'overview',
        question: 'What does the agent do?',
        answer:
          'Reviews application submissions and decides who advances. Decisions are binding.',
      },
    ];
  }

  function discoveryWithCredential(provider: string): DiscoveryResult {
    return {
      agents: [
        {
          runtime: 'codex',
          configPath: '/Users/me/.codex/config.toml',
          mcpServers: [],
          capabilities: [
            {
              kind: 'auth_credential',
              runtime: 'codex',
              configPath: '/Users/me/.codex/auth.json',
              provider,
              hasValue: true,
              valueShape: 'apiKey',
            },
          ],
        },
      ],
      findings: [],
      scannedAt: '2026-05-25T00:00:00.000Z',
      scannedPaths: [],
    };
  }

  it('BAMBOOHR_API_KEY in discovery + decisions-about-people transcript → §4 employment fires', () => {
    const out = recomputeComplianceWithDiscovery({
      analyzer: {
        systems: analyzerSystems,
        makesDecisionsAboutPeople: true,
        decisionMakingDetails:
          'Agent reviews application submissions and decides advancement; decisions are binding.',
      },
      transcript: transcriptAmbiguousEmployment(),
      discovery: discoveryWithCredential('BAMBOOHR_API_KEY'),
    });
    expect(out.euAiActClassification.classification).toBe('high-risk');
    expect(out.euAiActClassification.annexIIICategories).toContain(
      '§4 employment',
    );
  });

  it('BAMBOOHR_API_KEY in discovery + explicit no-decisions transcript → stays limited (AAP-70 invariant)', () => {
    const out = recomputeComplianceWithDiscovery({
      analyzer: {
        systems: analyzerSystems,
        makesDecisionsAboutPeople: false,
      },
      transcript: transcriptWithoutPII(),
      discovery: discoveryWithCredential('BAMBOOHR_API_KEY'),
    });
    expect(out.euAiActClassification.classification).toBe('limited');
    expect(out.euAiActClassification.annexIIICategories).toEqual([]);
  });
});
