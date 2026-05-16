/**
 * Integration tests for runHRPack (AAP-51).
 *
 * Tests cover: HR-agent gate (no detectors run for non-HR), aggregated
 * summary correctness, ordering stability, env-toggle behaviour.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { runHRPack, isHRPackDisabled } from '../../../src/verification/hr-pack/router.js';
import type { VerificationReport } from '../../../src/verification/types.js';

function baseReport(
  partial: Partial<VerificationReport> = {},
): VerificationReport {
  return {
    capturedAt: '2026-05-15T11:00:00Z',
    agentLabel: 'test-agent',
    declared: [],
    sources: [],
    ...partial,
  };
}

describe('runHRPack — HR agent gate', () => {
  it('returns isHRAgent=false with empty signals for a non-HR agent', () => {
    const report = baseReport({
      declared: [
        {
          source: 'agent-declaration',
          capturedAt: '2026-05-01T00:00:00Z',
          agent: { name: 'BillingBot', purpose: 'Pull invoices and reconcile QuickBooks.' },
          scopes: [{ service: 'quickbooks', scope: 'invoices:read' }],
        },
      ],
    });
    const r = runHRPack(report);
    expect(r.isHRAgent).toBe(false);
    expect(r.signals).toEqual([]);
    expect(r.summary.detectedCount).toBe(0);
    expect(r.summary.notDetectedCount).toBe(0);
  });

  it('runs all 7 detectors when isHRAgent=true', () => {
    const report = baseReport({
      declared: [
        {
          source: 'agent-declaration',
          capturedAt: '2026-05-01T00:00:00Z',
          agent: { name: 'Recruiter', purpose: 'Sourcing candidates.' },
          scopes: [{ service: 'greenhouse', scope: 'candidates:read' }],
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
            scopes: [{ service: 'greenhouse', scope: 'candidates:read' }],
          },
        },
      ],
    });
    const r = runHRPack(report);
    expect(r.isHRAgent).toBe(true);
    expect(r.signals).toHaveLength(7);
  });

  it('aggregates summary correctly for HR-fail scenario', () => {
    const report = baseReport({
      declared: [
        {
          source: 'agent-declaration',
          capturedAt: '2026-05-01T00:00:00Z',
          agent: { name: 'BadRecruiter', purpose: 'Sourcing candidates.' },
          scopes: [{ service: 'greenhouse', scope: 'candidates:read' }],
        },
      ],
      sources: [
        {
          sourceId: 'oauth-scopes',
          verdict: 'discrepancy',
          diffs: [],
          inventory: {
            source: 'oauth-scopes',
            capturedAt: '2026-05-15T10:00:00Z',
            scopes: [
              { service: 'greenhouse', scope: 'candidates:reject' }, // detector 1
              { service: 'greenhouse', scope: 'candidates:write' }, // detector 2
              { service: 'google-workspace', scope: 'gmail.readonly' }, // detector 3
              { service: 'google-workspace', scope: 'gmail.send' }, // detector 5
            ],
          },
        },
        {
          sourceId: 'mcp-tools',
          verdict: 'verified',
          diffs: [],
          inventory: {
            source: 'mcp-tools',
            capturedAt: '2026-05-15T10:00:00Z',
            tools: [
              { name: 'score_candidate' }, // detector 4
              { name: 'generate_offer' }, // detector 6
              { name: 'run_subagent' }, // detector 7
            ],
          },
        },
      ],
    });
    const r = runHRPack(report);
    expect(r.isHRAgent).toBe(true);
    expect(r.summary.detectedCount).toBeGreaterThanOrEqual(5);
    expect(r.summary.criticalDetected).toBeGreaterThanOrEqual(1);
    expect(r.summary.highDetected).toBeGreaterThanOrEqual(1);
  });

  it('stable ordering of signals matches detector order', () => {
    const report = baseReport({
      declared: [
        {
          source: 'agent-declaration',
          capturedAt: '2026-05-01T00:00:00Z',
          agent: { name: 'R', purpose: 'Sourcing candidates.' },
          scopes: [{ service: 'greenhouse', scope: 'candidates:read' }],
        },
      ],
    });
    const r1 = runHRPack(report);
    const r2 = runHRPack(report);
    expect(r1.signals.map((s) => s.signalId)).toEqual(r2.signals.map((s) => s.signalId));
    expect(r1.signals[0]!.signalId).toBe('auto-rejection-without-disclosure');
    expect(r1.signals[6]!.signalId).toBe('sub-agent-scope-expansion');
  });
});

describe('runHRPack — env toggle', () => {
  const origEnv = process.env.HERON_HR_PACK_DISABLED;
  afterEach(() => {
    if (origEnv === undefined) {
      delete process.env.HERON_HR_PACK_DISABLED;
    } else {
      process.env.HERON_HR_PACK_DISABLED = origEnv;
    }
  });

  it('isHRPackDisabled returns false by default', () => {
    delete process.env.HERON_HR_PACK_DISABLED;
    expect(isHRPackDisabled()).toBe(false);
  });

  it('isHRPackDisabled returns true when env is set to "true"', () => {
    process.env.HERON_HR_PACK_DISABLED = 'true';
    expect(isHRPackDisabled()).toBe(true);
  });

  it('runHRPack returns empty result when env is disabled', () => {
    process.env.HERON_HR_PACK_DISABLED = 'true';
    const report = baseReport({
      declared: [
        {
          source: 'agent-declaration',
          capturedAt: '2026-05-01T00:00:00Z',
          agent: { name: 'R', purpose: 'Sourcing candidates.' },
          scopes: [{ service: 'greenhouse', scope: 'candidates:read' }],
        },
      ],
    });
    const r = runHRPack(report);
    expect(r.isHRAgent).toBe(false);
    expect(r.signals).toEqual([]);
  });
});
