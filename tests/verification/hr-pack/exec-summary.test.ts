/**
 * Golden + structure tests for the executive summary renderer (AAP-51).
 *
 * The exec summary is the 1-page memo at the top of the verification
 * report for the DPO. Snapshot tests pin the structure for the three
 * canonical scenarios: HR-fail, HR-clean, non-HR.
 */

import { describe, it, expect } from 'vitest';

import { renderExecutiveSummary } from '../../../src/verification/hr-pack/exec-summary.js';
import { runHRPack } from '../../../src/verification/hr-pack/router.js';
import { runFrameworkMapping } from '../../../src/verification/frameworks/router.js';
import type { VerificationReport } from '../../../src/verification/types.js';
import type { ApprovalChain } from '../../../src/approvals/types.js';

function makeReport(opts: {
  agent?: { name?: string; purpose?: string; owner?: string };
  scopes?: Array<{ service: string; scope: string }>;
  tools?: Array<{ name: string; description?: string }>;
  withApprovalChain?: boolean;
}): VerificationReport {
  const chain: ApprovalChain = {
    schemaVersion: 1,
    agentId: 'recruiter-outreach-agent',
    entries: [
      {
        sequence: 1,
        timestamp: '2026-05-01T00:00:00Z',
        action: 'declared',
        actor: { name: 'Jane Doe', role: 'Head of HR' },
        prevHash: null,
        hash: 'a'.repeat(64),
      },
      {
        sequence: 2,
        timestamp: '2026-05-08T00:00:00Z',
        action: 'reviewed',
        actor: { name: 'Bob Mason', role: 'Security Reviewer' },
        prevHash: 'a'.repeat(64),
        hash: 'b'.repeat(64),
        comment: 'Reviewed declared scope and approval workflow.',
      },
      {
        sequence: 3,
        timestamp: '2026-05-15T00:00:00Z',
        action: 'approved',
        actor: { name: 'Carla Reyes', role: 'DPO' },
        prevHash: 'b'.repeat(64),
        hash: 'c'.repeat(64),
      },
    ],
  };

  const report: VerificationReport = {
    capturedAt: '2026-05-16T11:00:00Z',
    agentLabel: opts.agent?.name ?? 'test-agent',
    declared: [
      {
        source: 'agent-declaration',
        capturedAt: '2026-05-01T00:00:00Z',
        agent: opts.agent ?? { name: 'Test Agent' },
        scopes: opts.scopes ? [{ service: 'greenhouse', scope: 'candidates:read' }] : undefined,
      },
    ],
    sources: [
      {
        sourceId: 'oauth-scopes',
        verdict: 'verified',
        diffs: [],
        inventory: {
          source: 'oauth-scopes',
          capturedAt: '2026-05-15T10:00:00Z',
          scopes: opts.scopes ?? [],
        },
      },
      {
        sourceId: 'mcp-tools',
        verdict: 'verified',
        diffs: [],
        inventory: {
          source: 'mcp-tools',
          capturedAt: '2026-05-15T10:00:00Z',
          tools: opts.tools ?? [],
        },
      },
    ],
  };

  if (opts.withApprovalChain) {
    report.approvalChain = {
      chain,
      integrity: { ok: true },
    };
  }
  report.frameworkMapping = runFrameworkMapping(report);
  return report;
}

describe('renderExecutiveSummary — HR-fail scenario', () => {
  it('renders critical findings, framework section, approval trail', () => {
    const report = makeReport({
      agent: {
        name: 'Recruiter Outreach Agent',
        purpose: 'Sources candidates.',
        owner: 'Talent Acquisition Team',
      },
      scopes: [
        { service: 'greenhouse', scope: 'candidates:reject' },
        { service: 'google-workspace', scope: 'gmail.send' },
      ],
      tools: [{ name: 'generate_offer' }],
      withApprovalChain: true,
    });
    const hr = runHRPack(report);
    const out = renderExecutiveSummary(report, hr);

    expect(out).toContain('# Executive Summary');
    expect(out).toContain('Recruiter Outreach Agent');
    expect(out).toContain('Talent Acquisition Team');
    expect(out).toContain('HR / Recruiting');
    expect(out).toContain('Headline Findings');
    expect(out).toContain('CRITICAL');
    expect(out).toContain('Framework Coverage');
    expect(out).toContain('Approval Trail');
    expect(out).toContain('Carla Reyes');
    expect(out).toContain('Recommended Actions');
  });

  it('matches golden snapshot for HR-fail scenario', () => {
    const report = makeReport({
      agent: {
        name: 'Recruiter Outreach Agent',
        purpose: 'Sources candidates.',
        owner: 'Talent Acquisition Team',
      },
      scopes: [
        { service: 'greenhouse', scope: 'candidates:reject' },
        { service: 'google-workspace', scope: 'gmail.send' },
      ],
      tools: [{ name: 'generate_offer' }, { name: 'score_candidate' }],
      withApprovalChain: true,
    });
    const hr = runHRPack(report);
    const out = renderExecutiveSummary(report, hr);
    expect(out).toMatchSnapshot();
  });
});

describe('renderExecutiveSummary — non-HR agent', () => {
  it('says "Generic agent" instead of HR vertical, omits HR findings', () => {
    const report = makeReport({
      agent: { name: 'BillingBot', purpose: 'Pull invoices.', owner: 'Finance' },
      scopes: [{ service: 'quickbooks', scope: 'invoices:read' }],
      tools: [],
      withApprovalChain: true,
    });
    const hr = runHRPack(report);
    const out = renderExecutiveSummary(report, hr);
    expect(out).toContain('BillingBot');
    expect(out).toContain('Generic agent');
    expect(out).not.toContain('HR / Recruiting');
  });

  it('matches golden snapshot for non-HR scenario', () => {
    const report = makeReport({
      agent: { name: 'BillingBot', purpose: 'Pull invoices.', owner: 'Finance' },
      scopes: [{ service: 'quickbooks', scope: 'invoices:read' }],
      tools: [],
      withApprovalChain: true,
    });
    const hr = runHRPack(report);
    const out = renderExecutiveSummary(report, hr);
    expect(out).toMatchSnapshot();
  });
});

describe('renderExecutiveSummary — HR-clean scenario', () => {
  it('matches golden snapshot for clean HR scenario', () => {
    const report = makeReport({
      agent: {
        name: 'Clean Recruiter Bot',
        purpose:
          'Read-only candidate sourcing. Logs are scrubbed of PII; retention policy is 30 days.',
        owner: 'TA Team',
      },
      scopes: [{ service: 'greenhouse', scope: 'candidates:read' }],
      tools: [{ name: 'list_candidates' }],
      withApprovalChain: true,
    });
    const hr = runHRPack(report);
    const out = renderExecutiveSummary(report, hr);
    expect(out).toMatchSnapshot();
  });
});

describe('renderExecutiveSummary — graceful degradation', () => {
  it('handles missing frameworkMapping', () => {
    const report = makeReport({
      agent: { name: 'A', purpose: 'Sourcing.', owner: 'TA' },
      scopes: [{ service: 'greenhouse', scope: 'candidates:read' }],
      tools: [],
      withApprovalChain: true,
    });
    delete report.frameworkMapping;
    const hr = runHRPack(report);
    const out = renderExecutiveSummary(report, hr);
    expect(out).toContain('framework mapping disabled');
  });

  it('handles missing approvalChain', () => {
    const report = makeReport({
      agent: { name: 'A', purpose: 'Sourcing.', owner: 'TA' },
      scopes: [{ service: 'greenhouse', scope: 'candidates:read' }],
      tools: [],
      withApprovalChain: false,
    });
    const hr = runHRPack(report);
    const out = renderExecutiveSummary(report, hr);
    expect(out).toContain('Not recorded');
  });

  it('handles missing declared agent metadata', () => {
    const report = makeReport({
      scopes: [{ service: 'greenhouse', scope: 'candidates:read' }],
      tools: [],
      withApprovalChain: false,
    });
    // wipe agent block
    if (report.declared[0]) report.declared[0].agent = undefined;
    const hr = runHRPack(report);
    expect(() => renderExecutiveSummary(report, hr)).not.toThrow();
  });

  it('escapes user-controlled agent name (markdown injection defence)', () => {
    const report = makeReport({
      agent: {
        name: '[evil](javascript:alert(1))',
        purpose: 'Sourcing.',
        owner: '<script>alert(1)</script>',
      },
      scopes: [],
      tools: [],
      withApprovalChain: false,
    });
    const hr = runHRPack(report);
    const out = renderExecutiveSummary(report, hr);
    expect(out).not.toContain('[evil](javascript:');
    expect(out).not.toContain('<script>');
  });

  it('truncates very long agent name to bounded length', () => {
    const longName = 'A'.repeat(1000);
    const report = makeReport({
      agent: { name: longName, purpose: 'P', owner: 'O' },
      scopes: [],
      tools: [],
      withApprovalChain: false,
    });
    const hr = runHRPack(report);
    const out = renderExecutiveSummary(report, hr);
    // Find the line containing the name; it should not include the
    // full 1000 chars.
    const idx = out.indexOf('AAAAA');
    expect(idx).toBeGreaterThan(-1);
    // The output should not contain 600+ consecutive As.
    expect(out).not.toMatch(/A{600,}/);
  });
});
