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

describe('AAP-93 Codex post-review fixes', () => {
  it('P2 #1: partially-verified + OAuth-only (filesystem skipped) limitation text says filesystem skipped', () => {
    // Skip-filesystem dashboard path: discoveryStatus skipped, OAuth ran.
    const verdict: Verdict = {
      status: 'partial',
      primaryRiskLevel: 'medium',
      primaryRiskSource: 'deterministic',
      deterministicRiskLevel: 'medium',
      discrepancies: [],
    };
    const report = makeReport({
      verification: { status: 'partially-verified' },
    });
    const md = renderMarkdownReport(report, {
      verdict,
      discoveryStatus: { status: 'skipped', reason: 'skipFilesystem flag' },
      oauthIntrospectionStatus: [
        { provider: 'google', status: { status: 'ran' } },
      ],
    });
    expect(md).toContain('Filesystem discovery skipped');
    expect(md).toContain('OAuth scope introspection');
  });

  it('P2 #1: partially-verified + filesystem-only (OAuth skipped) limitation text says OAuth skipped', () => {
    const verdict: Verdict = {
      status: 'partial',
      primaryRiskLevel: 'medium',
      primaryRiskSource: 'deterministic',
      deterministicRiskLevel: 'medium',
      discrepancies: [],
    };
    const report = makeReport({
      verification: { status: 'partially-verified' },
    });
    const md = renderMarkdownReport(report, {
      verdict,
      discoveryStatus: 'ran',
    });
    expect(md).toContain('Combines self-reported interview answers with filesystem discovery');
    expect(md).toContain('OAuth introspection skipped');
  });

  it('Codex round 3 P2: persisted `verified` report rendered without verdict context shows per-source table, not UNVERIFIED stub', () => {
    // Re-rendering a persisted report.json directly: no `verdict` in
    // context, but `report.verification.status` is `verified`. The
    // Verification Status section pivots to the per-source table
    // instead of the UNVERIFIED stub — so the Limitations text
    // ("Combines self-reported interview answers with filesystem
    // discovery and OAuth scope introspection") and this section
    // both agree that verification ran.
    const report = makeReport({
      verification: { status: 'verified' },
    });
    const md = renderMarkdownReport(report);
    expect(md).not.toMatch(
      /UNVERIFIED — Surface 2 deterministic sources have not run yet/,
    );
    expect(md).toContain('Filesystem discovery (Surface 2)');
    // Codex round 4 P2: persisted `verified` must NOT downgrade to PARTIAL.
    expect(md).toContain('**Verification status:** VERIFIED');
    expect(md).not.toContain('**Verification status:** PARTIAL');
  });

  it('Codex round 4 P2: persisted `partially-verified` report rendered without verdict context shows PARTIAL', () => {
    const report = makeReport({
      verification: { status: 'partially-verified' },
    });
    const md = renderMarkdownReport(report);
    expect(md).toContain('**Verification status:** PARTIAL');
  });

  it('Codex round 5 P2: persisted `verification-failed` rendered without verdict context shows FAILED, not UNVERIFIED', () => {
    const report = makeReport({
      verification: { status: 'verification-failed', reason: 'demo' },
    });
    const md = renderMarkdownReport(report);
    expect(md).toContain('FAILED');
    expect(md).not.toMatch(
      /UNVERIFIED — Surface 2 deterministic sources have not run yet/,
    );
  });

  it('P3: MISSING findings (runtime sentinel `—`) do not trigger the cross-runtime callout', () => {
    const verdict: Verdict = {
      status: 'partial',
      primaryRiskLevel: 'medium',
      primaryRiskSource: 'deterministic',
      deterministicRiskLevel: 'medium',
      discrepancies: [],
    };
    const discoveryFindings: DiscoveryFinding[] = [
      {
        kind: 'EXTRA',
        severity: 'MEDIUM',
        serverName: 'extra-server',
        runtime: 'codex',
        description: 'Discovered MCP server',
        sourcePath: '/p',
      },
      {
        kind: 'MISSING',
        severity: 'MEDIUM',
        serverName: 'slack',
        runtime: '—',
        description: 'slack mentioned but not discovered',
      },
    ];
    const md = renderMarkdownReport(makeReport(), {
      verdict,
      discoveryFindings,
    });
    expect(md).not.toContain('Findings cover all AI-runtime configs present on the host machine');
  });
});

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

describe('AAP-93 Codex round 6 — verdict reads OAuth-only deterministic HIGH', () => {
  it('OAuth-only HIGH (no discovery findings, no self-reported risks) calibrates verdict to remediation, not provisional', () => {
    // Skip-filesystem dashboard path: discoveryFindings is empty,
    // report.risks is empty, but the verdict carries
    // deterministicRiskLevel: 'high' from OAuth diffs. The verdict
    // must NOT be PROVISIONAL — VERIFY MISSING SOURCES.
    const verdict: Verdict = {
      status: 'partial',
      deterministicRiskLevel: 'high',
      primaryRiskLevel: 'high',
      primaryRiskSource: 'deterministic',
      discrepancies: [],
    };
    const report = makeReport({
      risks: [],
      verification: { status: 'partially-verified' },
    });
    const md = renderMarkdownReport(report, {
      verdict,
      discoveryFindings: [],
    });
    expect(md).toContain('DO NOT APPROVE WITHOUT REMEDIATION');
    expect(md).not.toContain('PROVISIONAL — VERIFY MISSING SOURCES');
  });

  it('Codex round 7 P2: Executive Summary deterministic cell does NOT show "None" when verdict.deterministicRiskLevel is HIGH but discoveryFindings is empty', () => {
    const verdict: Verdict = {
      status: 'partial',
      deterministicRiskLevel: 'high',
      primaryRiskLevel: 'high',
      primaryRiskSource: 'deterministic',
      discrepancies: [],
    };
    const report = makeReport({
      risks: [],
      verification: { status: 'partially-verified' },
    });
    const md = renderMarkdownReport(report, {
      verdict,
      discoveryFindings: [],
    });
    // The exec summary's Deterministic findings cell now reads
    // "See Verification Status (HIGH verdict)".
    expect(md).toContain('See Verification Status (HIGH verdict)');
    // Not the misleading "None".
    expect(md).not.toMatch(/Deterministic findings.*\|.*None/);
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

  it('Codex round 4 P3: source path containing `|` does NOT split the table row', () => {
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
        sourcePath: '/home/u/path|with|pipes/config.toml',
      },
    ];
    const md = renderMarkdownReport(makeReport(), {
      verdict,
      discoveryFindings,
    });
    const rowLine = md
      .split('\n')
      .find((l) => l.includes('leak') && l.startsWith('| '));
    expect(rowLine).toBeDefined();
    // Count `|` separators in the row — should be exactly 6 (5 columns +
    // bookends), regardless of pipe characters in the source path.
    const pipes = (rowLine ?? '').match(/(?<!\\)\|/g) ?? [];
    expect(pipes).toHaveLength(6);
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
