/**
 * AAP-80 — unit tests for `reportVerificationStatusFromVerdict`.
 *
 * The helper lives in `src/verification/verdict-pipeline.ts` and maps a
 * `Verdict` (verdict-level surface 2 state) to the report-level
 * `ReportVerificationStatus` field that the markdown renderer and the
 * dashboard banner both read.
 *
 * Before AAP-80 the two code paths that persist this field
 * (`handleStartVerification` MCP handler and `POST /api/discovery/scan`)
 * hardcoded `'verified'` regardless of the underlying verdict. This
 * helper centralises the mapping so the two paths cannot drift.
 */

import { describe, expect, it } from 'vitest';

import {
  reportVerificationStatusFromVerdict,
  buildVerdictSnapshot,
} from '../../src/verification/verdict-pipeline.js';
import { computeVerdict } from '../../src/verification/verdict.js';
import type { Verdict } from '../../src/verification/verdict.js';
import type { DiscoveryFinding } from '../../src/discovery/types.js';

function verdict(status: Verdict['status']): Verdict {
  return {
    status,
    primaryRiskLevel: status === 'unverified' ? 'unverified' : 'medium',
    primaryRiskSource: status === 'unverified' ? 'no-evidence' : 'deterministic',
    discrepancies: [],
  };
}

describe('reportVerificationStatusFromVerdict (AAP-80)', () => {
  it("maps verdict.status='verified' to 'verified'", () => {
    expect(reportVerificationStatusFromVerdict(verdict('verified'))).toBe('verified');
  });

  it("maps verdict.status='partial' to 'partially-verified'", () => {
    expect(reportVerificationStatusFromVerdict(verdict('partial'))).toBe(
      'partially-verified',
    );
  });

  it("maps verdict.status='unverified' to 'interrogation-only' by default", () => {
    // Default: no Surface 2 source attempted ⇒ interrogation-only.
    expect(reportVerificationStatusFromVerdict(verdict('unverified'))).toBe(
      'interrogation-only',
    );
  });

  it("maps verdict.status='unverified' with surface2Attempted to 'verification-failed'", () => {
    // Surface 2 attempted but failed (e.g. workspace_hint missing) ⇒
    // verification-failed. The persist paths short-circuit on errors
    // before calling this branch, but the helper must be total.
    expect(
      reportVerificationStatusFromVerdict(verdict('unverified'), {
        surface2Attempted: true,
      }),
    ).toBe('verification-failed');
  });

  it('surface2Attempted=false explicit is treated the same as omitted', () => {
    expect(
      reportVerificationStatusFromVerdict(verdict('unverified'), {
        surface2Attempted: false,
      }),
    ).toBe('interrogation-only');
  });

  it('verified verdict ignores surface2Attempted (mapping stays at verified)', () => {
    // The Surface 2 attempted flag only disambiguates the unverified
    // branch — it should not affect verified or partial outcomes.
    expect(
      reportVerificationStatusFromVerdict(verdict('verified'), {
        surface2Attempted: true,
      }),
    ).toBe('verified');
    expect(
      reportVerificationStatusFromVerdict(verdict('verified'), {
        surface2Attempted: false,
      }),
    ).toBe('verified');
  });

  it('partial verdict ignores surface2Attempted (mapping stays at partially-verified)', () => {
    expect(
      reportVerificationStatusFromVerdict(verdict('partial'), {
        surface2Attempted: true,
      }),
    ).toBe('partially-verified');
    expect(
      reportVerificationStatusFromVerdict(verdict('partial'), {
        surface2Attempted: false,
      }),
    ).toBe('partially-verified');
  });
});

// AAP-105 (G8b) — the snapshot is what persists to report.json and reaches
// the dashboard, so it must carry the reclassified host capabilities.
describe('buildVerdictSnapshot — G8b hostCapabilities propagation (AAP-105)', () => {
  it('propagates reclassified global-scope MCP servers into the snapshot', () => {
    const discoveryFindings: DiscoveryFinding[] = [
      { kind: 'EXTRA', severity: 'MEDIUM', serverName: 'supabase', runtime: 'codex', description: 'x' },
      { kind: 'MISSING', severity: 'MEDIUM', serverName: 'drive', runtime: '—', description: 'y' },
    ];
    const v = computeVerdict({ discoveryFindings });
    const snap = buildVerdictSnapshot(v);

    expect(snap.hostCapabilities).toHaveLength(1);
    expect(snap.hostCapabilities[0].serverName).toBe('supabase');
    expect(snap.hostCapabilities[0].runtime).toBe('codex');
    // The drive MISSING is still a Verified finding in the snapshot.
    expect(snap.findings.filter((f) => f.evidenceSource === 'MCP')).toHaveLength(1);
    expect(snap.findings.find((f) => f.title.includes('supabase'))).toBeUndefined();
  });

  it('snapshot hostCapabilities is an empty array when none reclassified', () => {
    const v = computeVerdict({
      discoveryFindings: [
        { kind: 'EXTRA', severity: 'HIGH', serverName: 'postgres', runtime: 'claude-code', description: 'x' },
      ],
    });
    const snap = buildVerdictSnapshot(v);
    expect(snap.hostCapabilities).toEqual([]);
    // claude-code EXTRA still a Verified finding in the snapshot.
    expect(snap.findings.filter((f) => f.evidenceSource === 'MCP')).toHaveLength(1);
  });
});
