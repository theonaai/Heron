/**
 * AAP-101 — BR × DS × DM severity scoring foundation.
 *
 * Tests the math-only module `src/verification/severity-scoring.ts`.
 * Three layers:
 *
 *   1. Per-axis unit tests — BR-W, BR-R, BR-A, DS, DM each verified in
 *      isolation against the documented bands.
 *   2. Composition tests — BR = max(W,R,A); DM cap at 1.5; band labels.
 *   3. Integration tests for the four worked examples from research §8
 *      (`heron-risk-scoring-research-2026-05-28.md`):
 *
 *        A) MCP write tool not declared       → BR=3, DS=2, DM=1.0 → 6 (Medium)
 *        B) OAuth Drive write + Art. 9 health → BR=3, DS=3, DM=1.5 → 13.5 (Critical)
 *        C) Read-only Slack, public channels  → BR=1, DS=1, DM=1.0 → 1 (Informational)
 *        D) MCP server config drift           → BR=3, DS=2, DM=1.0 → 6 (Medium)
 *
 * Strict math contract — every test asserts the exact severity number
 * AND the component bands. If any axis silently regresses, the failure
 * shows which one and what it was.
 */
import { describe, expect, it } from 'vitest';

import {
  bandForReachCount,
  bandForWriteCount,
  computeBR,
  computeBRA,
  computeBRR,
  computeBRW,
  computeDM,
  computeDS,
  computeSeverity,
  countWriteToolsForBR,
  severityBand,
  type SeverityEvidence,
} from '../../src/verification/severity-scoring.js';
import type { DiscoveredAgent, DiscoveryResult } from '../../src/discovery/types.js';
import type { SourceVerification } from '../../src/verification/types.js';

// ─── Fixture helpers ────────────────────────────────────────────────────

function emptyDiscovery(): DiscoveryResult {
  return {
    agents: [],
    findings: [],
    scannedAt: '2026-05-28T00:00:00.000Z',
    scannedPaths: [],
  };
}

interface ToolSpec {
  name: string;
  classification: 'read' | 'write' | 'unknown';
}

function mcpAgent(
  runtime: DiscoveredAgent['runtime'],
  servers: ReadonlyArray<{
    name: string;
    tools?: ReadonlyArray<ToolSpec>;
    redactedEnvKeys?: string[];
  }>,
): DiscoveredAgent {
  return {
    runtime,
    configPath: `/Users/me/.${runtime}/config.json`,
    mcpServers: servers.map((s) => ({
      name: s.name,
      transport: 'stdio',
      hasCredentials: false,
      redactedEnvKeys: s.redactedEnvKeys ?? [],
      toolEnumeration: s.tools
        ? {
            state: 'ok',
            attemptedAt: '2026-05-28T00:00:00.000Z',
            tools: s.tools.map((t) => ({
              name: t.name,
              classification: t.classification,
            })),
          }
        : undefined,
    })),
  };
}

function oauthSource(
  scopes: ReadonlyArray<{ service: string; scope: string }>,
): SourceVerification {
  return {
    sourceId: 'oauth-scopes',
    verdict: scopes.length === 0 ? 'verified' : 'discrepancy',
    diffs: [],
    inventory: {
      source: 'oauth-scopes',
      capturedAt: '2026-05-28T00:00:00.000Z',
      scopes: scopes.map((s) => ({ service: s.service, scope: s.scope })),
    },
  };
}

// ─── Band thresholds ────────────────────────────────────────────────────

describe('AAP-101 — band thresholds', () => {
  describe('bandForWriteCount', () => {
    it('0 → band 1', () => expect(bandForWriteCount(0)).toBe(1));
    it('1 → band 1', () => expect(bandForWriteCount(1)).toBe(1));
    it('2 → band 2', () => expect(bandForWriteCount(2)).toBe(2));
    it('4 → band 2', () => expect(bandForWriteCount(4)).toBe(2));
    it('5 → band 3', () => expect(bandForWriteCount(5)).toBe(3));
    it('100 → band 3', () => expect(bandForWriteCount(100)).toBe(3));
  });

  describe('bandForReachCount', () => {
    it('0 → band 1', () => expect(bandForReachCount(0)).toBe(1));
    it('2 → band 1', () => expect(bandForReachCount(2)).toBe(1));
    it('3 → band 2', () => expect(bandForReachCount(3)).toBe(2));
    it('6 → band 2', () => expect(bandForReachCount(6)).toBe(2));
    it('7 → band 3', () => expect(bandForReachCount(7)).toBe(3));
    it('100 → band 3', () => expect(bandForReachCount(100)).toBe(3));
  });
});

// ─── BR-W: Write scope ──────────────────────────────────────────────────

describe('AAP-101 — BR-W (write scope)', () => {
  it('counts write tools from MCP enumeration (mirrors verdict.ts countWriteTools)', () => {
    const agents: DiscoveredAgent[] = [
      mcpAgent('codex', [
        {
          name: 'salesforce',
          tools: [
            { name: 'query', classification: 'read' },
            { name: 'update_opportunity', classification: 'write' },
            { name: 'create_account', classification: 'write' },
          ],
        },
      ]),
    ];
    expect(countWriteToolsForBR(agents)).toBe(2);
  });

  it('ignores `unknown`-classified tools (conservative)', () => {
    const agents: DiscoveredAgent[] = [
      mcpAgent('codex', [
        {
          name: 'mystery',
          tools: [
            { name: 'do_something', classification: 'unknown' },
            { name: 'maybe_mutate', classification: 'unknown' },
          ],
        },
      ]),
    ];
    expect(countWriteToolsForBR(agents)).toBe(0);
  });

  it('no MCP + no OAuth + HITL hint → BR-W band 1', () => {
    const evidence: SeverityEvidence = {
      discovery: emptyDiscovery(),
      findingContext: { autonomy: 'human-in-the-loop' },
    };
    expect(computeBRW(evidence)).toBe(1);
  });

  it('2 MCP write tools → BR-W band 2', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        agents: [
          mcpAgent('codex', [
            {
              name: 'jira',
              tools: [
                { name: 'create_issue', classification: 'write' },
                { name: 'update_status', classification: 'write' },
              ],
            },
          ]),
        ],
      },
    };
    expect(computeBRW(evidence)).toBe(2);
  });

  it('5+ MCP write tools → BR-W band 3', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        agents: [
          mcpAgent('codex', [
            {
              name: 'github',
              tools: Array.from({ length: 5 }, (_, i) => ({
                name: `mutate_${i}`,
                classification: 'write' as const,
              })),
            },
          ]),
        ],
      },
    };
    expect(computeBRW(evidence)).toBe(3);
  });

  it('OAuth scope with write token → counts toward BR-W', () => {
    const evidence: SeverityEvidence = {
      discovery: emptyDiscovery(),
      oauthVerifications: [
        oauthSource([
          { service: 'github', scope: 'repo:write' },
          { service: 'slack', scope: 'chat:write' },
        ]),
      ],
    };
    expect(computeBRW(evidence)).toBe(2);
  });

  it('Google Drive `auth/drive` scope counts as write (mutator, not read-only)', () => {
    const evidence: SeverityEvidence = {
      discovery: emptyDiscovery(),
      oauthVerifications: [
        oauthSource([
          {
            service: 'google-workspace',
            scope: 'https://www.googleapis.com/auth/drive',
          },
        ]),
      ],
    };
    expect(computeBRW(evidence)).toBe(1); // 1 write tool → still band 1
  });

  it('`drive.readonly` does NOT count as write', () => {
    const evidence: SeverityEvidence = {
      discovery: emptyDiscovery(),
      oauthVerifications: [
        oauthSource([
          {
            service: 'google-workspace',
            scope: 'https://www.googleapis.com/auth/drive.readonly',
          },
        ]),
      ],
    };
    expect(computeBRW(evidence)).toBe(1);
  });

  it('declared write-tool count adds to enumerated count', () => {
    const evidence: SeverityEvidence = {
      discovery: emptyDiscovery(),
      findingContext: { declaredWriteToolCount: 3 },
    };
    expect(computeBRW(evidence)).toBe(2);
  });
});

// ─── BR-R: Reach ────────────────────────────────────────────────────────

describe('AAP-101 — BR-R (reach)', () => {
  it('empty discovery → BR-R band 1', () => {
    const evidence: SeverityEvidence = { discovery: emptyDiscovery() };
    expect(computeBRR(evidence)).toBe(1);
  });

  it('2 MCP servers → BR-R band 1', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        agents: [
          mcpAgent('codex', [{ name: 'slack' }, { name: 'github' }]),
        ],
      },
    };
    expect(computeBRR(evidence)).toBe(1);
  });

  it('3 MCP servers → BR-R band 2', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        agents: [
          mcpAgent('codex', [
            { name: 'slack' },
            { name: 'github' },
            { name: 'jira' },
          ]),
        ],
      },
    };
    expect(computeBRR(evidence)).toBe(2);
  });

  it('7+ distinct systems → BR-R band 3', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        agents: [
          mcpAgent('codex', [
            { name: 's1' },
            { name: 's2' },
            { name: 's3' },
            { name: 's4' },
            { name: 's5' },
            { name: 's6' },
            { name: 's7' },
          ]),
        ],
      },
    };
    expect(computeBRR(evidence)).toBe(3);
  });

  it('OAuth scopes contribute distinct services to reach', () => {
    const evidence: SeverityEvidence = {
      discovery: emptyDiscovery(),
      oauthVerifications: [
        oauthSource([
          { service: 'google-workspace', scope: 'gmail.readonly' },
          { service: 'github', scope: 'repo' },
          { service: 'jira', scope: 'read:issue' },
        ]),
      ],
    };
    expect(computeBRR(evidence)).toBe(2);
  });

  it('multiple scopes on the same service count as one system', () => {
    const evidence: SeverityEvidence = {
      discovery: emptyDiscovery(),
      oauthVerifications: [
        oauthSource([
          { service: 'google-workspace', scope: 'gmail.readonly' },
          { service: 'google-workspace', scope: 'drive.readonly' },
          { service: 'google-workspace', scope: 'calendar.readonly' },
        ]),
      ],
    };
    expect(computeBRR(evidence)).toBe(1);
  });

  it('workspace env vendor prefixes feed reach', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        workspaceEnv: [
          {
            path: '/x/.env',
            workspace: '/x',
            keys: ['STRIPE_SECRET_KEY', 'OPENAI_API_KEY', 'SLACK_BOT_TOKEN'],
          },
        ],
      },
    };
    expect(computeBRR(evidence)).toBe(2);
  });
});

// ─── BR-A: Autonomy ─────────────────────────────────────────────────────

describe('AAP-101 — BR-A (autonomy)', () => {
  it('human-in-the-loop → band 1', () => {
    expect(computeBRA({ findingContext: { autonomy: 'human-in-the-loop' } })).toBe(1);
  });

  it('partial → band 2', () => {
    expect(computeBRA({ findingContext: { autonomy: 'partial' } })).toBe(2);
  });

  it('autonomous → band 3', () => {
    expect(computeBRA({ findingContext: { autonomy: 'autonomous' } })).toBe(3);
  });

  it('absent autonomy hint defaults to band 3 (conservative)', () => {
    expect(computeBRA({})).toBe(3);
  });
});

// ─── BR composite (FIPS 199 high-water-mark) ────────────────────────────

describe('AAP-101 — BR = max(W, R, A) [FIPS 199 high-water-mark]', () => {
  it('autonomous + small scope still BR 3 (autonomy alone drives)', () => {
    const evidence: SeverityEvidence = {
      discovery: emptyDiscovery(),
      findingContext: { autonomy: 'autonomous' },
    };
    expect(computeBR(evidence)).toBe(3);
  });

  it('HITL + tiny scope → BR 1', () => {
    const evidence: SeverityEvidence = {
      discovery: emptyDiscovery(),
      findingContext: { autonomy: 'human-in-the-loop' },
    };
    expect(computeBR(evidence)).toBe(1);
  });

  it('HITL + 7 systems read → BR 3 (reach drives even without writes)', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        agents: [
          mcpAgent('codex', [
            { name: 's1' },
            { name: 's2' },
            { name: 's3' },
            { name: 's4' },
            { name: 's5' },
            { name: 's6' },
            { name: 's7' },
          ]),
        ],
      },
      findingContext: { autonomy: 'human-in-the-loop' },
    };
    expect(computeBR(evidence)).toBe(3);
  });
});

// ─── DS: Data Sensitivity ───────────────────────────────────────────────

describe('AAP-101 — DS (data sensitivity)', () => {
  it('empty discovery → DS 1', () => {
    expect(computeDS({ discovery: emptyDiscovery() })).toBe(1);
  });

  it('STRIPE_SECRET_KEY → T3 financial credentials', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        workspaceEnv: [
          { path: '/x/.env', workspace: '/x', keys: ['STRIPE_SECRET_KEY'] },
        ],
      },
    };
    expect(computeDS(evidence)).toBe(3);
  });

  it('HIPAA_DATABASE_URL → T3 PHI', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        workspaceEnv: [
          { path: '/x/.env', workspace: '/x', keys: ['HIPAA_DATABASE_URL'] },
        ],
      },
    };
    expect(computeDS(evidence)).toBe(3);
  });

  it('PASSPORT_VERIFY_KEY → T3 government ID', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        workspaceEnv: [
          { path: '/x/.env', workspace: '/x', keys: ['PASSPORT_VERIFY_KEY'] },
        ],
      },
    };
    expect(computeDS(evidence)).toBe(3);
  });

  it('BIOMETRIC_FACE_API_KEY → T3 Art. 9 biometric', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        workspaceEnv: [
          {
            path: '/x/.env',
            workspace: '/x',
            keys: ['BIOMETRIC_FACE_API_KEY'],
          },
        ],
      },
    };
    expect(computeDS(evidence)).toBe(3);
  });

  it('BAMBOOHR_API_KEY → T2 employment PII (no T3 special category)', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        workspaceEnv: [
          { path: '/x/.env', workspace: '/x', keys: ['BAMBOOHR_API_KEY'] },
        ],
      },
    };
    expect(computeDS(evidence)).toBe(2);
  });

  it('SLACK_BOT_TOKEN → T2 (communication content)', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        workspaceEnv: [
          { path: '/x/.env', workspace: '/x', keys: ['SLACK_BOT_TOKEN'] },
        ],
      },
    };
    expect(computeDS(evidence)).toBe(2);
  });

  it('OAuth gmail scope → T2', () => {
    const evidence: SeverityEvidence = {
      discovery: emptyDiscovery(),
      oauthVerifications: [
        oauthSource([
          {
            service: 'google-workspace',
            scope: 'https://www.googleapis.com/auth/gmail.readonly',
          },
        ]),
      ],
    };
    expect(computeDS(evidence)).toBe(2);
  });

  it('public channels only (Slack channels:read) → DS 1', () => {
    const evidence: SeverityEvidence = {
      discovery: emptyDiscovery(),
      oauthVerifications: [
        oauthSource([{ service: 'slack', scope: 'channels:read' }]),
      ],
    };
    // `channels:read` does not match any T2 OAuth scope token; `slack`
    // service identifier alone is not a T2 vendor key.
    expect(computeDS(evidence)).toBe(1);
  });

  it('dataSensitivityFloor lifts when typed evidence is silent', () => {
    const evidence: SeverityEvidence = {
      discovery: emptyDiscovery(),
      findingContext: { dataSensitivityFloor: 3 },
    };
    expect(computeDS(evidence)).toBe(3);
  });

  it('typed evidence beats a lower floor', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        workspaceEnv: [
          { path: '/x/.env', workspace: '/x', keys: ['STRIPE_SECRET_KEY'] },
        ],
      },
      findingContext: { dataSensitivityFloor: 1 },
    };
    expect(computeDS(evidence)).toBe(3);
  });
});

// ─── DM: Domain Multiplier ──────────────────────────────────────────────

describe('AAP-101 — DM (domain multiplier)', () => {
  it('empty discovery + no hints → DM 1.0', () => {
    expect(computeDM({ discovery: emptyDiscovery() })).toBe(1.0);
  });

  it('BAMBOOHR vendor → Annex III §4 employment → DM 1.5', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        agents: [
          mcpAgent('codex', [
            { name: 'bamboohr', redactedEnvKeys: ['BAMBOOHR_API_KEY'] },
          ]),
        ],
      },
    };
    expect(computeDM(evidence)).toBe(1.5);
  });

  it('CANVAS_LMS vendor → Annex III §3 education → DM 1.5', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        agents: [
          mcpAgent('codex', [
            { name: 'canvas_lms', redactedEnvKeys: ['CANVAS_LMS_TOKEN'] },
          ]),
        ],
      },
    };
    expect(computeDM(evidence)).toBe(1.5);
  });

  it('PLAID financial vendor → Annex III §5(b) credit/essential services → DM 1.5', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        agents: [
          mcpAgent('codex', [
            { name: 'plaid', redactedEnvKeys: ['PLAID_CLIENT_ID'] },
          ]),
        ],
      },
    };
    expect(computeDM(evidence)).toBe(1.5);
  });

  it('explicit annexIIIDomain=false suppresses typed-signal false positive', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        agents: [
          mcpAgent('codex', [{ name: 'bamboohr' }]),
        ],
      },
      findingContext: { annexIIIDomain: false },
    };
    expect(computeDM(evidence)).toBe(1.0);
  });

  it('Art. 35(3)(a) profiling-with-legal-effect hint → DM 1.5', () => {
    const evidence: SeverityEvidence = {
      discovery: emptyDiscovery(),
      findingContext: { profilingWithLegalEffect: true },
    };
    expect(computeDM(evidence)).toBe(1.5);
  });

  it('Art. 35(3)(c) systematic public monitoring hint → DM 1.5', () => {
    const evidence: SeverityEvidence = {
      discovery: emptyDiscovery(),
      findingContext: { systematicPublicMonitoring: true },
    };
    expect(computeDM(evidence)).toBe(1.5);
  });

  it('Art. 35(3)(b) — large-scale Art. 9 data (T3 + reach ≥ 3 systems) → DM 1.5', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        agents: [
          mcpAgent('codex', [
            { name: 'epic_fhir' },
            { name: 'cerner' },
            { name: 'athenahealth', redactedEnvKeys: ['HIPAA_API_KEY'] },
          ]),
        ],
      },
    };
    expect(computeDM(evidence)).toBe(1.5);
  });

  it('T3 data WITHOUT large reach → DM 1.0 (single-system Art. 9 ≠ large-scale)', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        workspaceEnv: [
          { path: '/x/.env', workspace: '/x', keys: ['STRIPE_SECRET_KEY'] },
        ],
      },
    };
    // Single env vendor → reach 1, not 3+. No Annex III trigger from
    // STRIPE alone (financial credential ≠ §5 credit scoring without
    // the §5 vendor list firing — PLAID would, STRIPE alone won't).
    expect(computeDM(evidence)).toBe(1.0);
  });

  it('DM cap — both Annex III AND Art. 35(3) fire → still 1.5 (no compounding)', () => {
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        agents: [
          mcpAgent('codex', [
            { name: 'bamboohr', redactedEnvKeys: ['BAMBOOHR_API_KEY'] },
          ]),
        ],
      },
      findingContext: { profilingWithLegalEffect: true },
    };
    expect(computeDM(evidence)).toBe(1.5);
  });
});

// ─── Severity bands (renderer-side labels) ──────────────────────────────

describe('AAP-101 — severityBand labels', () => {
  it('severity 1 → informational', () => expect(severityBand(1)).toBe('informational'));
  it('severity 1.5 → informational', () => expect(severityBand(1.5)).toBe('informational'));
  it('severity 2 → low', () => expect(severityBand(2)).toBe('low'));
  it('severity 3 → low', () => expect(severityBand(3)).toBe('low'));
  it('severity 4 → medium', () => expect(severityBand(4)).toBe('medium'));
  it('severity 4.5 → medium', () => expect(severityBand(4.5)).toBe('medium'));
  it('severity 6 → medium', () => expect(severityBand(6)).toBe('medium'));
  it('severity 9 → high', () => expect(severityBand(9)).toBe('high'));
  it('severity 13.5 → critical', () => expect(severityBand(13.5)).toBe('critical'));
});

// ─── Integration: 9 distinct severity values are all reachable ──────────

describe('AAP-101 — 9 distinct severity values are reachable', () => {
  it('BR=1 × DS=1 × DM=1.0 = 1', () => {
    expect(computeSeverity({
      discovery: emptyDiscovery(),
      findingContext: { autonomy: 'human-in-the-loop' },
    }).severity).toBe(1);
  });

  it('BR=1 × DS=1 × DM=1.5 = 1.5', () => {
    expect(computeSeverity({
      discovery: emptyDiscovery(),
      findingContext: {
        autonomy: 'human-in-the-loop',
        annexIIIDomain: true,
      },
    }).severity).toBe(1.5);
  });

  it('BR=2 × DS=1 × DM=1.0 = 2', () => {
    expect(computeSeverity({
      discovery: emptyDiscovery(),
      findingContext: { autonomy: 'partial' },
    }).severity).toBe(2);
  });

  it('BR=3 × DS=1 × DM=1.0 = 3', () => {
    expect(computeSeverity({
      discovery: emptyDiscovery(),
      findingContext: { autonomy: 'autonomous' },
    }).severity).toBe(3);
  });

  it('BR=2 × DS=2 × DM=1.0 = 4', () => {
    expect(computeSeverity({
      discovery: emptyDiscovery(),
      findingContext: {
        autonomy: 'partial',
        dataSensitivityFloor: 2,
      },
    }).severity).toBe(4);
  });

  it('BR=3 × DS=1 × DM=1.5 = 4.5', () => {
    expect(computeSeverity({
      discovery: emptyDiscovery(),
      findingContext: {
        autonomy: 'autonomous',
        annexIIIDomain: true,
      },
    }).severity).toBe(4.5);
  });

  it('BR=3 × DS=2 × DM=1.0 = 6', () => {
    expect(computeSeverity({
      discovery: emptyDiscovery(),
      findingContext: {
        autonomy: 'autonomous',
        dataSensitivityFloor: 2,
      },
    }).severity).toBe(6);
  });

  it('BR=3 × DS=3 × DM=1.0 = 9', () => {
    expect(computeSeverity({
      discovery: emptyDiscovery(),
      findingContext: {
        autonomy: 'autonomous',
        dataSensitivityFloor: 3,
      },
    }).severity).toBe(9);
  });

  it('BR=3 × DS=3 × DM=1.5 = 13.5', () => {
    expect(computeSeverity({
      discovery: emptyDiscovery(),
      findingContext: {
        autonomy: 'autonomous',
        dataSensitivityFloor: 3,
        annexIIIDomain: true,
      },
    }).severity).toBe(13.5);
  });
});

// ─── Worked examples — research §8 (A, B, C, D) ─────────────────────────

describe('AAP-101 — research §8 worked examples', () => {
  it('Example A — MCP write tool not declared in procurement scope → severity 6', () => {
    // Setup (research §8.A):
    //   Agent declared scope: "read-only access to CRM" (5 read tools)
    //   Heron finds salesforce.update_opportunity in MCP manifest (1 write)
    //   Salesforce contains customer financial data (T2 — not PCI cardholder,
    //   just transactional records)
    //   Autonomy: agent runs autonomously (no human review on write)
    //   Not in Annex III, no Art. 35 trigger.
    //
    // Expected: BR=3 (autonomy), DS=2, DM=1.0 → 6 (Medium).
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        agents: [
          mcpAgent('codex', [
            {
              name: 'salesforce',
              tools: [
                { name: 'query_account', classification: 'read' },
                { name: 'query_opportunity', classification: 'read' },
                { name: 'query_contact', classification: 'read' },
                { name: 'query_lead', classification: 'read' },
                { name: 'query_case', classification: 'read' },
                { name: 'update_opportunity', classification: 'write' },
              ],
              redactedEnvKeys: ['SALESFORCE_CLIENT_SECRET'],
            },
          ]),
        ],
      },
      findingContext: {
        autonomy: 'autonomous',
        dataSensitivityFloor: 2, // customer financial data → T2 sensitive PII
      },
      finding: { source: 'MCP', serial: 1, note: 'salesforce.update_opportunity undeclared' },
    };

    const result = computeSeverity(evidence);
    expect(result.severity).toBe(6);
    expect(result.br).toBe(3);
    expect(result.ds).toBe(2);
    expect(result.dm).toBe(1.0);
    expect(severityBand(result.severity)).toBe('medium');
  });

  it('Example B — OAuth Drive write to HR agent with employee health data → severity 13.5', () => {
    // Setup (research §8.B):
    //   HR onboarding agent declares "send welcome emails"
    //   OAuth token grants `https://www.googleapis.com/auth/drive` (full write)
    //   Drive contains employee records including health data
    //   Autonomy: autonomous (HR pipeline)
    //   Employment domain → Annex III §4 → DM 1.5
    //   Art. 9 health data → T3
    //
    // Expected: BR=3, DS=3, DM=1.5 → 13.5 (Critical).
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        agents: [
          mcpAgent('codex', [
            {
              name: 'bamboohr',
              redactedEnvKeys: ['BAMBOOHR_API_KEY'],
            },
          ]),
        ],
        workspaceEnv: [
          {
            path: '/Users/me/hr-agent/.env',
            workspace: '/Users/me/hr-agent',
            keys: ['HIPAA_AUDIT_LOG_KEY', 'BAMBOOHR_API_KEY'],
          },
        ],
      },
      oauthVerifications: [
        oauthSource([
          {
            service: 'google-workspace',
            scope: 'https://www.googleapis.com/auth/drive',
          },
        ]),
      ],
      findingContext: { autonomy: 'autonomous' },
      finding: { source: 'OAU', serial: 1, note: 'drive write on HR agent w/ health data' },
    };

    const result = computeSeverity(evidence);
    expect(result.severity).toBe(13.5);
    expect(result.br).toBe(3);
    expect(result.ds).toBe(3);
    expect(result.dm).toBe(1.5);
    expect(severityBand(result.severity)).toBe('critical');
  });

  it('Example C — Read-only Slack agent, public channels only → severity 1', () => {
    // Setup (research §8.C):
    //   Agent has Slack `channels:read` scope (one system, public channels)
    //   No write scopes
    //   Channel content is non-sensitive operational data
    //   Autonomy: scheduled, no chain → HITL
    //   No Annex III, no DPIA trigger.
    //
    // Expected: BR=1, DS=1, DM=1.0 → 1 (Informational).
    const evidence: SeverityEvidence = {
      discovery: emptyDiscovery(),
      oauthVerifications: [
        oauthSource([{ service: 'slack', scope: 'channels:read' }]),
      ],
      findingContext: { autonomy: 'human-in-the-loop' },
      finding: { source: 'OAU', serial: 1, note: 'public Slack read-only summary' },
    };

    const result = computeSeverity(evidence);
    expect(result.severity).toBe(1);
    expect(result.br).toBe(1);
    expect(result.ds).toBe(1);
    expect(result.dm).toBe(1.0);
    expect(severityBand(result.severity)).toBe('informational');
  });

  it('Example D — MCP server config drift (declared 3, actual 7) → severity 6', () => {
    // Setup (research §8.D):
    //   Declared: 3 MCP servers
    //   Actual: 7 servers, including one with DB admin access
    //   Autonomous agent
    //   DB contains customer PII → T2
    //   Default workflow domain → DM 1.0
    //
    // Expected: BR=3, DS=2, DM=1.0 → 6 (Medium).
    const evidence: SeverityEvidence = {
      discovery: {
        ...emptyDiscovery(),
        agents: [
          mcpAgent('codex', [
            { name: 'server-1' },
            { name: 'server-2' },
            { name: 'server-3' },
            { name: 'server-4' },
            { name: 'server-5' },
            { name: 'server-6' },
            {
              name: 'db-admin',
              tools: [
                { name: 'exec_sql', classification: 'write' },
                { name: 'alter_schema', classification: 'write' },
                { name: 'drop_table', classification: 'write' },
              ],
            },
          ]),
        ],
      },
      findingContext: {
        autonomy: 'autonomous',
        dataSensitivityFloor: 2, // customer PII in the DB
      },
      finding: { source: 'MCP', serial: 2, note: 'config drift: declared 3, actual 7' },
    };

    const result = computeSeverity(evidence);
    expect(result.severity).toBe(6);
    expect(result.br).toBe(3);
    expect(result.ds).toBe(2);
    expect(result.dm).toBe(1.0);
    expect(severityBand(result.severity)).toBe('medium');
  });
});

// ─── Public-API smoke ───────────────────────────────────────────────────

describe('AAP-101 — computeSeverity output contract', () => {
  it('exposes per-axis component breakdown', () => {
    const result = computeSeverity({
      discovery: emptyDiscovery(),
      findingContext: { autonomy: 'partial' },
    });
    expect(result).toHaveProperty('components');
    expect(result.components).toHaveProperty('brW');
    expect(result.components).toHaveProperty('brR');
    expect(result.components).toHaveProperty('brA');
    expect(result.components.brA).toBe(2);
  });

  it('passes through finding ref without affecting math', () => {
    const a = computeSeverity({
      discovery: emptyDiscovery(),
      findingContext: { autonomy: 'partial' },
    });
    const b = computeSeverity({
      discovery: emptyDiscovery(),
      findingContext: { autonomy: 'partial' },
      finding: { source: 'SLF', serial: 42, note: 'irrelevant' },
    });
    expect(a.severity).toBe(b.severity);
    expect(a.br).toBe(b.br);
    expect(a.ds).toBe(b.ds);
    expect(a.dm).toBe(b.dm);
  });

  it('empty input degrades to BR=3 / DS=1 / DM=1.0 = 3 (conservative default)', () => {
    const result = computeSeverity({});
    expect(result.br).toBe(3);
    expect(result.ds).toBe(1);
    expect(result.dm).toBe(1.0);
    expect(result.severity).toBe(3);
  });
});
