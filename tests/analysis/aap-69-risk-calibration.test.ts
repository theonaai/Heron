/**
 * AAP-69 — overallRiskLevel ↔ recommendation calibration invariants.
 *
 * The HR-persona test run surfaced `recommendation: DENY` paired with
 * `overallRiskLevel: medium`. That contradicts itself on the published
 * report (medium pill + DENY verdict reads as a copy-paste bug to the
 * reviewer). Heron now reconciles the two categorical labels:
 *
 *   - DENY  → overallRiskLevel floored at `high` (or `critical` if rubric reached it)
 *   - APPROVE on a `critical` rubric is self-contradictory → clamp to `high`
 *     so the reviewer still sees the elevated label but the verdict label
 *     no longer disagrees with itself.
 *
 * `APPROVE WITH CONDITIONS` is the catch-all and is intentionally left
 * un-calibrated — it can coexist with any rubric severity.
 */

import { describe, it, expect } from 'vitest';
import { calibrateOverallRiskLevel } from '../../src/analysis/risk-scorer.js';

describe('AAP-69 — calibrateOverallRiskLevel invariants', () => {
  describe('DENY forces overall >= high', () => {
    it('low + DENY → high', () => {
      expect(calibrateOverallRiskLevel('low', 'DENY')).toBe('high');
    });

    it('medium + DENY → high (the HR-test regression case)', () => {
      expect(calibrateOverallRiskLevel('medium', 'DENY')).toBe('high');
    });

    it('high + DENY → high (no change)', () => {
      expect(calibrateOverallRiskLevel('high', 'DENY')).toBe('high');
    });

    it('critical + DENY → critical (preserve elevated rubric)', () => {
      expect(calibrateOverallRiskLevel('critical', 'DENY')).toBe('critical');
    });
  });

  describe('bare APPROVE cannot coincide with critical', () => {
    it('critical + APPROVE → high (clamp self-contradiction)', () => {
      expect(calibrateOverallRiskLevel('critical', 'APPROVE')).toBe('high');
    });

    it('high + APPROVE → high (no change)', () => {
      expect(calibrateOverallRiskLevel('high', 'APPROVE')).toBe('high');
    });

    it('medium + APPROVE → medium (no change — APPROVE allowed at medium)', () => {
      expect(calibrateOverallRiskLevel('medium', 'APPROVE')).toBe('medium');
    });

    it('low + APPROVE → low (no change)', () => {
      expect(calibrateOverallRiskLevel('low', 'APPROVE')).toBe('low');
    });
  });

  describe('APPROVE WITH CONDITIONS is uncalibrated', () => {
    it('critical + APPROVE WITH CONDITIONS → critical (left alone)', () => {
      expect(
        calibrateOverallRiskLevel('critical', 'APPROVE WITH CONDITIONS'),
      ).toBe('critical');
    });

    it('low + APPROVE WITH CONDITIONS → low (left alone)', () => {
      expect(
        calibrateOverallRiskLevel('low', 'APPROVE WITH CONDITIONS'),
      ).toBe('low');
    });
  });

  describe('undefined recommendation is a pass-through', () => {
    it('low + undefined → low', () => {
      expect(calibrateOverallRiskLevel('low', undefined)).toBe('low');
    });

    it('critical + undefined → critical', () => {
      expect(calibrateOverallRiskLevel('critical', undefined)).toBe(
        'critical',
      );
    });
  });
});
