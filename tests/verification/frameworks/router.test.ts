/**
 * Integration tests for the framework-mapping CLI pipeline — the path the
 * `heron mcp-scan` CLI uses to attach `report.frameworkMapping`.
 *
 * AAP-86 deleted `buildFrameworkMapping` (the old standalone driver). The
 * production replacement is the two-line `mapFindings` →
 * `controlResultsToFrameworkMapping` pipeline that `src/commands/mcp-scan.ts`
 * now invokes. The local `buildFrameworkMapping` shim below mirrors that
 * pipeline exactly so this test continues to pin end-to-end behaviour for
 * the 12 framework controls without exercising the CLI command shell.
 */

import { describe, it, expect } from 'vitest';

import { mapFindings } from '../../../src/compliance/mapper.js';
import { controlResultsToFrameworkMapping } from '../../../src/verification/frameworks/control-results-to-mapping.js';
import type {
  FrameworkMapping,
} from '../../../src/verification/frameworks/types.js';
import type { VerificationReport } from '../../../src/verification/types.js';
import { hashEntry } from '../../../src/approvals/canonical.js';
import { verifyChainIntegrity } from '../../../src/approvals/store.js';

import type { ApprovalChain, ApprovalEntry } from '../../../src/approvals/types.js';

/**
 * Local shim mirroring the CLI mcp-scan pipeline. AAP-86 collapsed the
 * standalone `buildFrameworkMapping` driver into `mapFindings` (typed
 * detectors per catalog entry) plus the legacy-shape adapter. Tests
 * keep using the original signature so the historical 12-control
 * coverage stays intact.
 */
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

describe('buildFrameworkMapping — end-to-end HR scenarios', () => {
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

    const mapping = buildFrameworkMapping(report, { now: nowFreeze() });
    // AAP-86: AIUC-1 A003 wires onto a single catalog entry (A003.4,
    // least-privilege), so the pipeline emits 12 controls. A003.3 (separate
    // agent identity) was removed because the scope detector does not verify
    // identity. Verified-count floor unchanged.
    expect(mapping.controls.length).toBe(12);
    expect(mapping.summary.verifiedCount).toBeGreaterThanOrEqual(7);
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

    const mapping = buildFrameworkMapping(report, { now: nowFreeze() });
    // AAP-86: catalog ids replace the legacy router short labels.
    //   A003 → A003.4 (the wired least-privilege entry; A003.3 separate-identity
    //   was removed because the scope detector does not verify identity)
    //   B006, E004, E015 keep their labels.
    const a003_4 = mapping.controls.find(c => c.controlId === 'A003.4')!;
    const b006 = mapping.controls.find(c => c.controlId === 'B006')!;
    const e004 = mapping.controls.find(c => c.controlId === 'E004')!;
    expect(a003_4.verdict).toBe('fail');
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
    const mapping = buildFrameworkMapping(report, { now: nowFreeze() });
    // AAP-86: catalog ids — E015 → E015.2, E004 unchanged.
    expect(mapping.controls.find(c => c.controlId === 'E015.2')!.verdict).toBe('fail');
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
    const mapping = buildFrameworkMapping(report, { now: nowFreeze() });
    // AAP-86: catalog id for the EU AI Act Annex III §4 employment
    // routing is `Art. 6(2) + Annex III` (Heron_v1 citation style).
    const annexIII = mapping.controls.find(
      c => c.controlId === 'Art. 6(2) + Annex III',
    )!;
    expect(annexIII.verdict).toBe('not-applicable');
  });

  it('mapping is stable: same input produces same output (pure)', () => {
    const report: VerificationReport = {
      capturedAt: '2026-05-16T09:30:00Z',
      agentLabel: 'foo',
      declared: [],
      sources: [],
    };
    const m1 = buildFrameworkMapping(report, { now: nowFreeze() });
    const m2 = buildFrameworkMapping(report, { now: nowFreeze() });
    expect(m1).toEqual(m2);
  });
});
