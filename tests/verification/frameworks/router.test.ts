/**
 * Integration tests for `runFrameworkMapping` — the top-level entry point
 * that produces a complete `FrameworkMapping` from a `VerificationReport`.
 *
 * Validates the 12-control rollout produces the expected verdicts on
 * realistic HR scenarios.
 */

import { describe, it, expect } from 'vitest';

import { runFrameworkMapping } from '../../../src/verification/frameworks/router.js';
import type { VerificationReport } from '../../../src/verification/types.js';
import { hashEntry } from '../../../src/approvals/canonical.js';
import { verifyChainIntegrity } from '../../../src/approvals/store.js';

import type { ApprovalChain, ApprovalEntry } from '../../../src/approvals/types.js';

/**
 * Build a chain in-memory with real prevHash digests so
 * `verifyChainIntegrity` returns ok on the result. Mirrors the
 * `appendEntry` logic without touching the filesystem.
 */
function buildChainViaCanonical(entries: ApprovalEntry[]): ApprovalChain {
  const out: ApprovalEntry[] = [];
  for (const e of entries) {
    if (out.length === 0) {
      out.push({ ...e });
    } else {
      const prev = out[out.length - 1]!;
      out.push({ ...e, prevHash: hashEntry(prev) });
    }
  }
  return {
    agentId: 'test-agent',
    createdAt: entries[0]!.timestamp,
    entries: out,
  };
}

function nowFreeze(): () => Date {
  return () => new Date('2026-05-16T10:00:00.000Z');
}

describe('runFrameworkMapping — end-to-end HR scenarios', () => {
  it('clean HR compliance scenario produces high-verified ratio', () => {
    const chain = buildChainViaCanonical([
      { action: 'declared', actor: { name: 'Alice', role: 'Owner' }, timestamp: '2026-05-10T09:00:00Z' },
      { action: 'reviewed', actor: { name: 'Bob', role: 'SecEng' }, timestamp: '2026-05-11T11:00:00Z' },
      { action: 'approved', actor: { name: 'Carla', role: 'DPO' }, timestamp: '2026-05-12T15:30:00Z' },
    ]);

    const report: VerificationReport = {
      capturedAt: '2026-05-16T09:30:00Z',
      agentLabel: 'recruiter',
      declared: [{
        source: 'interview',
        capturedAt: '2026-05-10T08:00:00Z',
        scopes: [{ service: 'greenhouse', scope: 'candidates:read' }],
        tools: [{ name: 'screen_candidate', description: 'Score the candidate' }],
      }],
      sources: [{
        sourceId: 'oauth-scopes',
        verdict: 'verified',
        diffs: [],
        inventory: { source: 'oauth-scopes', capturedAt: 't', scopes: [{ service: 'greenhouse', scope: 'candidates:read' }] },
      }, {
        sourceId: 'mcp-tools',
        verdict: 'verified',
        diffs: [],
        inventory: { source: 'mcp-tools', capturedAt: 't', tools: [{ name: 'screen_candidate', description: 'Score the candidate' }] },
      }],
      approvalChain: {
        chain,
        integrity: verifyChainIntegrity(chain),
      },
    };

    const mapping = runFrameworkMapping(report, { now: nowFreeze() });
    expect(mapping.controls.length).toBe(12);
    expect(mapping.summary.verifiedCount).toBeGreaterThanOrEqual(8);
    expect(mapping.summary.failCount).toBe(0);
  });

  it('failure HR scenario: extra scope + no approval produces failures', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-16T09:30:00Z',
      agentLabel: 'rogue-recruiter',
      declared: [{
        source: 'interview',
        capturedAt: '2026-05-10T08:00:00Z',
        scopes: [{ service: 'greenhouse', scope: 'candidates:read' }],
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

    const mapping = runFrameworkMapping(report, { now: nowFreeze() });
    // Should include: A003 fail, B006 fail, E004 fail (no chain), E015 partial (no chain)
    const a003 = mapping.controls.find(c => c.controlId === 'A003')!;
    const b006 = mapping.controls.find(c => c.controlId === 'B006')!;
    const e004 = mapping.controls.find(c => c.controlId === 'E004')!;
    expect(a003.verdict).toBe('fail');
    expect(b006.verdict).toBe('fail');
    expect(e004.verdict).toBe('fail');
    expect(mapping.summary.failCount).toBeGreaterThanOrEqual(3);
  });

  it('broken chain → E015 fails, E004 fails', () => {
    const chain = buildChainViaCanonical([
      { action: 'declared', actor: { name: 'Alice', role: 'Owner' }, timestamp: '2026-05-10T09:00:00Z' },
      { action: 'approved', actor: { name: 'Carla', role: 'DPO' }, timestamp: '2026-05-12T15:30:00Z' },
    ]);

    const report: VerificationReport = {
      capturedAt: '2026-05-16T09:30:00Z',
      agentLabel: 'recruiter',
      declared: [],
      sources: [],
      approvalChain: {
        chain,
        integrity: { ok: false, brokenAt: 1, reason: 'hash mismatch' },
      },
    };
    const mapping = runFrameworkMapping(report, { now: nowFreeze() });
    expect(mapping.controls.find(c => c.controlId === 'E015')!.verdict).toBe('fail');
    expect(mapping.controls.find(c => c.controlId === 'E004')!.verdict).toBe('fail');
  });

  it('non-HR agent → Annex III §4 is NOT-APPLICABLE', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-16T09:30:00Z',
      agentLabel: 'jira-bot',
      declared: [{
        source: 'interview',
        capturedAt: 't',
        scopes: [{ service: 'jira', scope: 'tickets:read' }],
        tools: [{ name: 'list_tickets', description: 'Show open issues in the backlog' }],
      }],
      sources: [{
        sourceId: 'oauth-scopes',
        verdict: 'verified',
        diffs: [],
        inventory: { source: 'oauth-scopes', capturedAt: 't', scopes: [{ service: 'jira', scope: 'tickets:read' }] },
      }],
    };
    const mapping = runFrameworkMapping(report, { now: nowFreeze() });
    const annexIII = mapping.controls.find(c => c.controlId === 'Annex III §4')!;
    expect(annexIII.verdict).toBe('not-applicable');
  });

  it('mapping is stable: same input produces same output (pure)', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-16T09:30:00Z',
      agentLabel: 'foo',
      declared: [],
      sources: [],
    };
    const m1 = runFrameworkMapping(report, { now: nowFreeze() });
    const m2 = runFrameworkMapping(report, { now: nowFreeze() });
    expect(m1).toEqual(m2);
  });
});
