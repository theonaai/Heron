/**
 * AAP-83 Phase 3 — envelope-shaped mapFindings entrypoint.
 *
 * Pins:
 *   - Legacy `mapFindingsToRiskCategories({systems, transcript, ...})`
 *     produces the same CategorizedCompliance shape it always did,
 *     plus an empty `controlResults` field (additive).
 *   - `mapFindings({declared})` with no `actual` matches the legacy
 *     output bit-for-bit on the existing fields.
 *   - `mapFindings({declared, actual: {verificationReport: ...}})`
 *     surfaces typed-detector ControlResults into `controlResults`
 *     with the correct provenance.
 *   - Same input + actual produces deterministic output (same stableKey
 *     set, no dupes).
 */

import { describe, expect, it } from 'vitest';

import {
  mapFindings,
  mapFindingsToRiskCategories,
} from '../../src/compliance/mapper.js';
import type {
  QAPair,
  SystemAssessment,
} from '../../src/report/types.js';
import type { VerificationReport } from '../../src/verification/types.js';

const NOW = '2026-05-25T00:00:00.000Z';

function bareDeclared(): {
  systems: SystemAssessment[];
  transcript: QAPair[];
  makesDecisionsAboutPeople?: boolean;
  decisionMakingDetails?: string;
} {
  return {
    systems: [],
    transcript: [
      {
        category: 'overview',
        question: 'What does this agent do?',
        answer: 'It generates blog post outlines from topic ideas.',
      },
    ],
  };
}

function bareReport(): VerificationReport {
  return {
    capturedAt: NOW,
    agentLabel: 'test-agent',
    declared: [],
    sources: [],
  };
}

describe('mapFindings envelope — back-compat with mapFindingsToRiskCategories', () => {
  it('legacy entrypoint output now carries an empty controlResults field', () => {
    const out = mapFindingsToRiskCategories(bareDeclared());
    expect(out.controlResults).toEqual([]);
    // Legacy fields untouched.
    expect(out.mappingVersion).toBeDefined();
    expect(out.signals).toBeDefined();
    expect(out.euAiActClassification).toBeDefined();
  });

  it('mapFindings({declared}) matches mapFindingsToRiskCategories on every legacy field', () => {
    const legacy = mapFindingsToRiskCategories(bareDeclared());
    const enveloped = mapFindings({ declared: bareDeclared() });
    // Stringify rather than deep-equal to avoid Map / Set identity
    // false negatives — the CategorizedCompliance is plain JSON.
    expect(JSON.stringify(enveloped)).toBe(JSON.stringify(legacy));
  });
});

describe('mapFindings envelope — typed-evidence detectors', () => {
  it('without actual, controlResults stays empty', () => {
    const out = mapFindings({ declared: bareDeclared() });
    expect(out.controlResults).toEqual([]);
  });

  it('with actual.verificationReport, typed detectors light up with stable keys', () => {
    const out = mapFindings({
      declared: bareDeclared(),
      actual: { verificationReport: bareReport() },
    });
    expect(out.controlResults.length).toBeGreaterThan(0);
    // Every emitted result carries the Phase 2 provenance contract.
    for (const r of out.controlResults) {
      expect(r.path).toBe('typed');
      expect(r.stableKey).toMatch(/^[a-z-]+:[a-z0-9-]+:.+$/);
      expect([
        'verified',
        'partial',
        'unverified',
        'fail',
        'not-applicable',
      ]).toContain(r.verdict);
    }
  });

  it('controlResults are deduplicated by stableKey', () => {
    const out = mapFindings({
      declared: bareDeclared(),
      actual: { verificationReport: bareReport() },
    });
    const keys = out.controlResults.map((r) => r.stableKey);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it('two runs on identical input produce identical controlResults', () => {
    const a = mapFindings({
      declared: bareDeclared(),
      actual: { verificationReport: bareReport() },
    });
    const b = mapFindings({
      declared: bareDeclared(),
      actual: { verificationReport: bareReport() },
    });
    expect(JSON.stringify(a.controlResults)).toBe(JSON.stringify(b.controlResults));
  });

  it('null discovery is tolerated and the typed-detector pass still runs', () => {
    const out = mapFindings({
      declared: bareDeclared(),
      actual: { discovery: null, verificationReport: bareReport() },
    });
    expect(out.controlResults.length).toBeGreaterThan(0);
  });
});
