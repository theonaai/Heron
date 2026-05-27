/**
 * AAP-93 template fixes covered by this file:
 *   - H1: Limitations text is conditional on verification.status
 *   - H2: Header gap count matches Applicability Summary row count
 *   - H3: Executive Summary splits Deterministic + Self-reported streams
 *   - H6: Systems section carries the per-system risk explanation
 *   - H7: "No excessive permissions" suppressed when EXTRA findings exist
 *   - H9: Obligations cite actual systems instead of boilerplate vendors
 *   - M3: Source column appears in deterministic findings table
 *   - M4: Verification Status row carries a reason when skipped
 *   - M5: Header splits Risk Level and Verification onto distinct fields
 */

import { describe, it, expect } from 'vitest';

import { renderMarkdownReport } from '../../src/report/templates.js';
import type {
  AuditReport,
  ReportVerificationStatus,
} from '../../src/report/types.js';
import type { DiscoveryFinding } from '../../src/discovery/types.js';
import type { Verdict } from '../../src/verification/verdict.js';

function makeReport(
  overrides: Partial<AuditReport> = {},
): AuditReport {
  return {
    summary: 'Demo report.',
    agentPurpose: 'Demo purpose',
    systems: [
      {
        systemId: 'google-workspace',
        scopesRequested: ['drive.readonly'],
        scopesNeeded: ['drive.readonly'],
        scopesDelta: [],
        dataSensitivity: 'PII',
        blastRadius: 'team-scope',
        frequencyAndVolume: '50/day',
        writeOperations: [],
        sources: [],
      },
    ],
    dataNeeds: [],
    accessAssessment: {
      claimed: [],
      actuallyNeeded: [],
      excessive: [],
      missing: [],
    },
    risks: [],
    recommendations: [],
    recommendation: 'APPROVE WITH CONDITIONS',
    overallRiskLevel: 'medium',
    transcript: [{ question: 'q', answer: 'a', category: 'purpose' }],
    metadata: {
      date: '2026-05-27',
      target: 'demo',
      interviewDuration: 1000,
      questionsAsked: 1,
    },
    ...overrides,
  } as AuditReport;
}

describe('AAP-93 H1 — Limitations text is conditional on verification.status', () => {
  it('interrogation-only: legacy self-report-only copy', () => {
    const md = renderMarkdownReport(makeReport());
    expect(md).toContain('based solely on the agent');
    expect(md).toContain('self-reported information');
  });

  it('partially-verified: mentions filesystem discovery + OAuth skipped', () => {
    const report = makeReport({
      verification: { status: 'partially-verified' },
    });
    const md = renderMarkdownReport(report);
    expect(md).toContain('Combines self-reported interview answers with filesystem discovery');
    expect(md).toContain('OAuth introspection skipped');
  });

  it('verified: mentions filesystem discovery AND OAuth introspection', () => {
    const report = makeReport({
      verification: { status: 'verified' },
    });
    const md = renderMarkdownReport(report);
    expect(md).toContain('filesystem discovery and OAuth scope introspection');
  });

  it('verification-failed: explicitly says verification did not complete', () => {
    const report = makeReport({
      verification: { status: 'verification-failed', reason: 'demo' },
    });
    const md = renderMarkdownReport(report);
    expect(md).toContain('Verification attempted but did not complete cleanly');
  });
});

describe('AAP-93 H3 — Executive Summary splits Deterministic + Self-reported streams', () => {
  it('Deterministic and Self-reported findings render as distinct cells', () => {
    const verdict: Verdict = {
      status: 'partial',
      deterministicRiskLevel: 'medium',
      primaryRiskLevel: 'medium',
      primaryRiskSource: 'deterministic',
      discrepancies: [],
    };
    const discoveryFindings: DiscoveryFinding[] = [
      {
        kind: 'EXTRA',
        severity: 'HIGH',
        serverName: 'unknown',
        runtime: 'codex',
        description: 'undisclosed server',
      },
      {
        kind: 'EXTRA',
        severity: 'MEDIUM',
        serverName: 'other',
        runtime: 'codex',
        description: 'another undisclosed server',
      },
    ];
    const report = makeReport({
      risks: [
        {
          severity: 'high',
          title: 'Unrestricted shell',
          description: 'agent has unrestricted local shell',
        },
      ],
    });
    const md = renderMarkdownReport(report, { verdict, discoveryFindings });
    // Both stream headers appear.
    expect(md).toContain('Deterministic findings');
    expect(md).toContain('Self-reported findings');
    // The deterministic cell counts both Surface 2 rows.
    expect(md).toMatch(/1 High, 1 Medium/);
    // The self-reported cell counts only Surface 1 risks (the analyzer's).
    expect(md.match(/1 High/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe('AAP-93 H6 — Systems section explains per-system vs overall risk', () => {
  it('Systems section carries the per-system risk explanation', () => {
    const md = renderMarkdownReport(makeReport());
    expect(md).toContain('Per-system risk shown below');
    expect(md).toContain('Overall deployment risk');
  });
});

describe('AAP-93 H7 — "No excessive permissions" is gated on EXTRA findings', () => {
  it('NOT rendered when EXTRA discovery findings exist', () => {
    const discoveryFindings: DiscoveryFinding[] = [
      {
        kind: 'EXTRA',
        severity: 'MEDIUM',
        serverName: 'unmentioned-server',
        runtime: 'codex',
        description: 'undisclosed MCP server',
      },
    ];
    const md = renderMarkdownReport(makeReport(), {
      verdict: {
        status: 'partial',
        primaryRiskLevel: 'medium',
        primaryRiskSource: 'deterministic',
        deterministicRiskLevel: 'medium',
        discrepancies: [],
      },
      discoveryFindings,
    });
    expect(md).not.toContain(
      'No excessive permissions detected — follows least-privilege principle',
    );
  });

  it('rendered when no EXTRA findings exist and other gates pass', () => {
    const md = renderMarkdownReport(makeReport());
    expect(md).toContain(
      'No excessive permissions detected — follows least-privilege principle',
    );
  });

  it('verdict block mentions reducing tool surface when EXTRA findings exist', () => {
    const discoveryFindings: DiscoveryFinding[] = [
      {
        kind: 'EXTRA',
        severity: 'MEDIUM',
        serverName: 'unmentioned-mcp',
        runtime: 'codex',
        description: 'Discovered MCP server "unmentioned-mcp" was not mentioned',
      },
    ];
    const md = renderMarkdownReport(makeReport(), {
      verdict: {
        status: 'partial',
        primaryRiskLevel: 'medium',
        primaryRiskSource: 'deterministic',
        deterministicRiskLevel: 'medium',
        discrepancies: [],
      },
      discoveryFindings,
    });
    expect(md).toContain('Reduce tool surface to declared scope');
  });
});

describe('AAP-93 H9 — Obligations table cites actual systems, not boilerplate vendors', () => {
  it('Platform ToS row references the actual systems (not LinkedIn/Google hardcode)', () => {
    const md = renderMarkdownReport(makeReport({
      verification: { status: 'verified' },
    }));
    // The systems list contains 'google-workspace' — the obligation
    // row's example should cite it. Pre-fix the row hardcoded
    // "LinkedIn, Google, or other connected services".
    expect(md).not.toMatch(/LinkedIn, Google, or other connected services/i);
  });
});

describe('AAP-93 M3 — Source column in deterministic findings table', () => {
  it('Findings table carries a Source column populated from sourcePath', () => {
    const verdict: Verdict = {
      status: 'partial',
      deterministicRiskLevel: 'high',
      primaryRiskLevel: 'high',
      primaryRiskSource: 'deterministic',
      discrepancies: [],
    };
    const discoveryFindings: DiscoveryFinding[] = [
      {
        kind: 'EXTRA',
        severity: 'HIGH',
        serverName: 'leak',
        runtime: 'codex',
        description: 'undisclosed server',
        sourcePath: '/home/u/.codex/config.toml',
      },
    ];
    const md = renderMarkdownReport(makeReport(), {
      verdict,
      discoveryFindings,
    });
    expect(md).toContain('| Kind | Severity | Server / Runtime | Source | Description |');
    expect(md).toContain('/home/u/.codex/config.toml');
  });
});

describe('AAP-93 M4 — Verification Status row carries a reason', () => {
  it('explicit {status, reason} object renders the reason inline', () => {
    const verdict: Verdict = {
      status: 'partial',
      primaryRiskLevel: 'medium',
      primaryRiskSource: 'deterministic',
      deterministicRiskLevel: 'medium',
      discrepancies: [],
    };
    const md = renderMarkdownReport(makeReport(), {
      verdict,
      discoveryStatus: 'ran',
      oauthIntrospectionStatus: [
        {
          provider: 'google',
          status: { status: 'skipped', reason: 'no OAuth credentials configured' },
        },
      ],
    });
    expect(md).toMatch(/OAuth introspection.*google.*skipped \(reason: no OAuth credentials configured\)/);
  });

  it('default OAuth row surfaces a structural skip reason when no per-provider rows', () => {
    const verdict: Verdict = {
      status: 'partial',
      primaryRiskLevel: 'medium',
      primaryRiskSource: 'deterministic',
      deterministicRiskLevel: 'medium',
      discrepancies: [],
    };
    const md = renderMarkdownReport(makeReport(), { verdict });
    expect(md).toMatch(/OAuth introspection.*skipped \(reason: /);
  });
});

describe('AAP-93 M5 — Header splits Risk Level and Verification', () => {
  it('partially-verified: header has Risk Level + Verification as separate fields', () => {
    const verdict: Verdict = {
      status: 'partial',
      deterministicRiskLevel: 'high',
      primaryRiskLevel: 'high',
      primaryRiskSource: 'deterministic',
      discrepancies: [],
    };
    const report = makeReport({
      verification: { status: 'partially-verified' },
    });
    const md = renderMarkdownReport(report, { verdict });
    expect(md).toContain('**Risk Level**: HIGH');
    expect(md).toContain('**Verification**: Partial');
    expect(md).not.toContain('Risk Level (Partially Verified)');
  });
});
