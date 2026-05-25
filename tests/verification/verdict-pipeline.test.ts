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

import { reportVerificationStatusFromVerdict } from '../../src/verification/verdict-pipeline.js';
import type { Verdict } from '../../src/verification/verdict.js';

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
