/**
 * Golden snapshot tests for `renderFrameworkMappingSection`.
 *
 * Lock the Markdown output for three canonical scenarios:
 *  - HR-failure (extra scopes + no approval chain).
 *  - Clean compliance (declared matches actual + full chain).
 *  - Non-HR (Annex III §4 → not-applicable).
 *
 * Tests stay tolerant: we assert load-bearing substrings rather than
 * full-string equality, so cosmetic tweaks to the renderer (column
 * widths, exact whitespace) do not force a snapshot regeneration.
 */

import { describe, it, expect } from 'vitest';

import { mapFindings } from '../../../src/compliance/mapper.js';
import { controlResultsToFrameworkMapping } from '../../../src/verification/frameworks/control-results-to-mapping.js';
import { renderFrameworkMappingSection } from '../../../src/verification/frameworks/render.js';
import { hashEntry } from '../../../src/approvals/canonical.js';
import { verifyChainIntegrity } from '../../../src/approvals/store.js';
import type { FrameworkMapping } from '../../../src/verification/frameworks/types.js';
import type { VerificationReport } from '../../../src/verification/types.js';
import type { ApprovalChain, ApprovalEntry } from '../../../src/approvals/types.js';

// AAP-86 shim: see tests/verification/frameworks/router.test.ts.
function buildFrameworkMapping(
  report: VerificationReport,
  opts: { now?: () => Date } = {},
): FrameworkMapping {
  const compliance = mapFindings({
    declared: { systems: [], transcript: [] },
    actual: { verificationReport: report },
  });
  return controlResultsToFrameworkMapping(compliance.controlResults, opts);
}

const FROZEN_NOW = () => new Date('2026-05-16T10:00:00.000Z');

function buildChain(entries: ApprovalEntry[]): ApprovalChain {
  const out: ApprovalEntry[] = [];
  for (const e of entries) {
    if (out.length === 0) {
      out.push({ ...e });
    } else {
      const prev = out[out.length - 1]!;
      out.push({ ...e, prevHash: hashEntry(prev) });
    }
  }
  return { agentId: 'golden', createdAt: entries[0]!.timestamp, entries: out };
}

describe('Golden — HR failure scenario', () => {
  it('renders A003 + B006 + E004 failures in the table', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-16T09:30:00Z',
      agentLabel: 'rogue',
      declared: [{
        source: 'interview',
        capturedAt: 't',
        scopes: [{ service: 'greenhouse', scope: 'candidates:read' }],
        tools: [{ name: 'rank_candidate', description: 'Rank candidate for recruiter' }],
      }],
      sources: [{
        sourceId: 'oauth-scopes',
        verdict: 'discrepancy',
        diffs: [
          { kind: 'extra', dimension: 'scope', source: 'oauth-scopes', actual: { service: 'google-workspace', scope: 'drive.readonly' }, severity: 'high' },
          { kind: 'extra', dimension: 'scope', source: 'oauth-scopes', actual: { service: 'gmail', scope: 'gmail.send' }, severity: 'high' },
        ],
        inventory: { source: 'oauth-scopes', capturedAt: 't', scopes: [
          { service: 'greenhouse', scope: 'candidates:read' },
          { service: 'google-workspace', scope: 'drive.readonly' },
          { service: 'gmail', scope: 'gmail.send' },
        ] },
      }],
    };
    const mapping = buildFrameworkMapping(report, { now: FROZEN_NOW });
    const md = renderFrameworkMappingSection(mapping);
    expect(md).toMatch(/A003/);
    expect(md).toMatch(/B006/);
    expect(md).toMatch(/E004/);
    expect(md).toMatch(/Failed.*3|Failed[^\n]*[3-9]/);
  });
});

describe('Golden — Clean compliance scenario', () => {
  it('renders mostly-verified table with reviewed-and-approved chain', () => {
    const chain = buildChain([
      { action: 'declared', actor: { name: 'Alice', role: 'Owner' }, timestamp: '2026-05-10T09:00:00Z' },
      { action: 'reviewed', actor: { name: 'Bob', role: 'SecEng' }, timestamp: '2026-05-11T11:00:00Z' },
      { action: 'approved', actor: { name: 'Carla', role: 'DPO' }, timestamp: '2026-05-12T15:30:00Z' },
    ]);
    const report: VerificationReport = {
      capturedAt: '2026-05-16T09:30:00Z',
      agentLabel: 'clean-recruiter',
      declared: [{
        source: 'interview',
        capturedAt: 't',
        scopes: [{ service: 'greenhouse', scope: 'candidates:read' }],
        tools: [{ name: 'score_candidate', description: 'Score the candidate' }],
      }],
      sources: [
        {
          sourceId: 'oauth-scopes',
          verdict: 'verified',
          diffs: [],
          inventory: { source: 'oauth-scopes', capturedAt: 't', scopes: [{ service: 'greenhouse', scope: 'candidates:read' }] },
        },
        {
          sourceId: 'mcp-tools',
          verdict: 'verified',
          diffs: [],
          inventory: { source: 'mcp-tools', capturedAt: 't', tools: [{ name: 'score_candidate', description: 'Score the candidate' }] },
        },
      ],
      approvalChain: { chain, integrity: verifyChainIntegrity(chain) },
    };
    const mapping = buildFrameworkMapping(report, { now: FROZEN_NOW });
    const md = renderFrameworkMappingSection(mapping);
    expect(mapping.summary.failCount).toBe(0);
    expect(mapping.summary.verifiedCount).toBeGreaterThanOrEqual(8);
    expect(md).toMatch(/E004/);
    // AAP-86: catalog id for EU AI Act Article 14 is `Art. 14(4)(d)`
    // (Heron_v1 citation style); legacy short label was `Article 14`.
    expect(md).toMatch(/Art\. 14/);
    expect(md).toMatch(/Verified/);
  });
});

describe('Golden — Non-HR scenario', () => {
  it('Annex III §4 is NOT-APPLICABLE for a Jira ticketing agent', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-16T09:30:00Z',
      agentLabel: 'jira-bot',
      declared: [{
        source: 'interview',
        capturedAt: 't',
        scopes: [{ service: 'jira', scope: 'tickets:read' }],
        tools: [{ name: 'list_tickets', description: 'Show backlog issues' }],
      }],
      sources: [{
        sourceId: 'oauth-scopes',
        verdict: 'verified',
        diffs: [],
        inventory: { source: 'oauth-scopes', capturedAt: 't', scopes: [{ service: 'jira', scope: 'tickets:read' }] },
      }],
    };
    const mapping = buildFrameworkMapping(report, { now: FROZEN_NOW });
    const md = renderFrameworkMappingSection(mapping);
    // AAP-86: catalog id for the EU AI Act Annex III §4 employment
    // routing is `Art. 6(2) + Annex III`.
    const annex = mapping.controls.find(
      c => c.controlId === 'Art. 6(2) + Annex III',
    )!;
    expect(annex.verdict).toBe('not-applicable');
    expect(md).toMatch(/Annex III/);
  });
});
