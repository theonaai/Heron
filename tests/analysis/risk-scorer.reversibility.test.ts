import { describe, it, expect } from 'vitest';
import { computeRiskScore, computeSeveritySignals } from '../../src/analysis/risk-scorer.js';
import type { SystemAssessment } from '../../src/report/types.js';

// AAP-109: reversibility feeds the risk model. risk-scorer.ts adds +30 to the
// write-risk component per irreversible write, and `hasIrreversibleWrites`
// (an OR over !reversible) drives the write/data severity floors. These tests
// prove that correcting reversibility (true -> false) raises posture, which is
// exactly why flattening "partly reversible" up to true understated risk.
//
// Fixture shape mirrors tests/analysis/risk-scorer.test.ts.

function sys(overrides: Partial<SystemAssessment> = {}): SystemAssessment {
  return {
    systemId: 'Test System',
    scopesRequested: ['read'],
    scopesNeeded: ['read'],
    scopesDelta: [],
    dataSensitivity: 'Non-sensitive test data',
    blastRadius: 'single-user',
    frequencyAndVolume: '10 times/day',
    writeOperations: [],
    ...overrides,
  };
}

function wellkid(reversible: boolean): SystemAssessment {
  return sys({
    systemId: 'wellkid',
    dataSensitivity: 'Confidential course/platform data',
    blastRadius: 'team-scope',
    writeOperations: [
      { operation: 'publish article', target: 'Wellkid', reversible, approvalRequired: false, volumePerDay: '' },
      { operation: 'update article', target: 'Wellkid', reversible, approvalRequired: false, volumePerDay: '' },
      { operation: 'bulk publish', target: 'Wellkid', reversible, approvalRequired: false, volumePerDay: '' },
    ],
  });
}

describe('risk posture vs reversibility (AAP-109)', () => {
  it('scores irreversible writes strictly higher than the flattened version', () => {
    const flattened = computeRiskScore([wellkid(true)], []);
    const corrected = computeRiskScore([wellkid(false)], []);
    expect(corrected.breakdown.writeRisk).toBeGreaterThan(flattened.breakdown.writeRisk);
    expect(corrected.score).toBeGreaterThan(flattened.score);
  });

  it('sets hasIrreversibleWrites only when a write is not reversible', () => {
    const flattened = computeSeveritySignals([wellkid(true)]);
    const corrected = computeSeveritySignals([wellkid(false)]);
    expect(flattened.hasIrreversibleWrites).toBe(false);
    expect(corrected.hasIrreversibleWrites).toBe(true);
  });
});
