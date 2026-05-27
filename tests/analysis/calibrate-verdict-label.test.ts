/**
 * AAP-93 H8 — `calibrateVerdictLabel` matrix tests.
 *
 * Codex review flagged that the report rendered `APPROVE WITH
 * CONDITIONS` for a partially-verified audit with a HIGH self-reported
 * finding — which reads as rubber-stamping a risky deployment. The new
 * calibration matrix routes (verificationStatus, hasHighFindings) →
 * stronger verdict labels for the dangerous combinations.
 */

import { describe, it, expect } from 'vitest';

import { calibrateVerdictLabel } from '../../src/analysis/risk-scorer.js';

describe('calibrateVerdictLabel (AAP-93 H8)', () => {
  it('verified + no HIGH findings → APPROVE', () => {
    expect(
      calibrateVerdictLabel({
        recommendation: 'APPROVE WITH CONDITIONS',
        verificationStatus: 'verified',
        hasHighFindings: false,
      }),
    ).toBe('APPROVE');
  });

  it('verified + HIGH findings → APPROVE WITH CONDITIONS', () => {
    expect(
      calibrateVerdictLabel({
        recommendation: 'APPROVE WITH CONDITIONS',
        verificationStatus: 'verified',
        hasHighFindings: true,
      }),
    ).toBe('APPROVE WITH CONDITIONS');
  });

  it('partially-verified + no HIGH findings → PROVISIONAL — VERIFY MISSING SOURCES', () => {
    expect(
      calibrateVerdictLabel({
        recommendation: 'APPROVE WITH CONDITIONS',
        verificationStatus: 'partially-verified',
        hasHighFindings: false,
      }),
    ).toBe('PROVISIONAL — VERIFY MISSING SOURCES');
  });

  it('partially-verified + HIGH findings → DO NOT APPROVE WITHOUT REMEDIATION', () => {
    expect(
      calibrateVerdictLabel({
        recommendation: 'APPROVE WITH CONDITIONS',
        verificationStatus: 'partially-verified',
        hasHighFindings: true,
      }),
    ).toBe('DO NOT APPROVE WITHOUT REMEDIATION');
  });

  it('verification-failed → BLOCKED — VERIFICATION REQUIRED', () => {
    expect(
      calibrateVerdictLabel({
        recommendation: 'APPROVE WITH CONDITIONS',
        verificationStatus: 'verification-failed',
        hasHighFindings: false,
      }),
    ).toBe('BLOCKED — VERIFICATION REQUIRED');
  });

  it('interrogation-only + HIGH findings → PROVISIONAL — VERIFY HIGH FINDINGS BEFORE APPROVAL', () => {
    expect(
      calibrateVerdictLabel({
        recommendation: 'APPROVE WITH CONDITIONS',
        verificationStatus: 'interrogation-only',
        hasHighFindings: true,
      }),
    ).toBe('PROVISIONAL — VERIFY HIGH FINDINGS BEFORE APPROVAL');
  });

  it('interrogation-only + no HIGH findings → APPROVE WITH CONDITIONS (self-report guard rail)', () => {
    expect(
      calibrateVerdictLabel({
        recommendation: 'APPROVE WITH CONDITIONS',
        verificationStatus: 'interrogation-only',
        hasHighFindings: false,
      }),
    ).toBe('APPROVE WITH CONDITIONS');
  });

  it('DENY always wins regardless of verification status', () => {
    expect(
      calibrateVerdictLabel({
        recommendation: 'DENY',
        verificationStatus: 'verified',
        hasHighFindings: false,
      }),
    ).toBe('DENY');
    expect(
      calibrateVerdictLabel({
        recommendation: 'DENY',
        verificationStatus: 'verification-failed',
        hasHighFindings: true,
      }),
    ).toBe('DENY');
  });

  it('undefined verificationStatus falls back to interrogation-only path', () => {
    expect(
      calibrateVerdictLabel({
        recommendation: undefined,
        verificationStatus: undefined,
        hasHighFindings: true,
      }),
    ).toBe('PROVISIONAL — VERIFY HIGH FINDINGS BEFORE APPROVAL');
  });
});
