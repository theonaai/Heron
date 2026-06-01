/**
 * G9 (DS-tier rework) — per-system deployment-risk scoring tests.
 *
 * Pins the Systems-data → BR × DS × DM mapping (systems-risk.ts):
 *   - blast radius enum → BR band (single → 1, team → 2, org/cross → 3)
 *   - irreversible writes lift BR one band (capped at 3)
 *   - write-operation count contributes BR via bandForWriteCount
 *   - analyzer-supplied dataSensitivityTier → T1/T2/T3 DS axis (the prose no
 *     longer drives the tier; the old regex classifier was deleted)
 *   - missing tier defaults conservatively to T2
 *   - severity = BR × DS × DM on the same 9-value 1..13.5 scale as findings
 *   - HWM aggregation across systems
 */
import { describe, expect, it } from 'vitest';

import {
  blastRadiusAxis,
  computeSystemsRisk,
  scoreSystemRisk,
  type RiskScorableSystem,
} from '../../src/verification/systems-risk.js';

describe('blastRadiusAxis', () => {
  it('maps single-record / single-user to band 1', () => {
    expect(blastRadiusAxis('single-record')).toBe(1);
    expect(blastRadiusAxis('single-user')).toBe(1);
  });
  it('maps team-scope to band 2', () => {
    expect(blastRadiusAxis('team-scope')).toBe(2);
  });
  it('maps org-wide and cross-tenant to band 3', () => {
    expect(blastRadiusAxis('org-wide')).toBe(3);
    expect(blastRadiusAxis('cross-tenant')).toBe(3);
  });
  it('defaults unknown / empty to band 1 (conservative-low, no inflation)', () => {
    expect(blastRadiusAxis('')).toBe(1);
    expect(blastRadiusAxis(undefined)).toBe(1);
    expect(blastRadiusAxis('something weird')).toBe(1);
  });
});

describe('scoreSystemRisk — DS tier comes from the analyzer, not the prose', () => {
  it('T1 tier → ds 1 even when the prose contains tier-suggestive words', () => {
    // Prose has "lesson" and "names" — the OLD regex classifier would have
    // returned T2. With the analyzer tier driving DS, the explicit T1 wins.
    const sys: RiskScorableSystem = {
      systemId: 'curriculum',
      dataSensitivity: 'lesson numbers and folder names, no personal data',
      dataSensitivityTier: 'T1',
      blastRadius: 'single-user',
      writeOperations: [],
    };
    const r = scoreSystemRisk(sys);
    expect(r.dsTier).toBe('T1');
    expect(r.ds).toBe(1);
    expect(r.severity).toBe(1); // BR1 × DS1 × 1.0
    expect(r.band).toBe('informational');
  });

  it('T2 tier → ds 2', () => {
    const sys: RiskScorableSystem = {
      systemId: 'drive',
      dataSensitivity: 'file contents and shared documents',
      dataSensitivityTier: 'T2',
      blastRadius: 'single-user',
      writeOperations: [],
    };
    const r = scoreSystemRisk(sys);
    expect(r.dsTier).toBe('T2');
    expect(r.ds).toBe(2);
    expect(r.severity).toBe(2); // BR1 × DS2 × 1.0
  });

  it('T3 tier → ds 3', () => {
    const sys: RiskScorableSystem = {
      systemId: 'payroll',
      dataSensitivity: 'employee bank account and tax IDs',
      dataSensitivityTier: 'T3',
      blastRadius: 'single-user',
      writeOperations: [],
    };
    const r = scoreSystemRisk(sys);
    expect(r.dsTier).toBe('T3');
    expect(r.ds).toBe(3);
    expect(r.severity).toBe(3); // BR1 × DS3 × 1.0
  });

  it('MISSING tier defaults conservatively to T2 (ds 2) with a default-note basis', () => {
    const sys: RiskScorableSystem = {
      systemId: 'mystery',
      dataSensitivity: 'aggregate counts and timestamps', // looks T1, but no tier given
      // dataSensitivityTier omitted on purpose
      blastRadius: 'single-user',
      writeOperations: [],
    };
    const r = scoreSystemRisk(sys);
    expect(r.dsTier).toBe('T2');
    expect(r.ds).toBe(2);
    expect(r.severity).toBe(2); // BR1 × DS2 × 1.0 — does NOT under-rate to 1
    expect(r.dsBasis).toBe('tier not provided by analyzer; defaulted conservatively to T2');
  });

  it('NEGATION case: prose says "no student names or credentials" but tier is T1 → ds 1', () => {
    // The exact regression the regex classifier got wrong: it matched
    // "names"/"credentials" and returned T2 despite the explicit negation.
    // The analyzer (which understands negation) emits T1; we honour it.
    const sys: RiskScorableSystem = {
      systemId: 'curriculum-tracker',
      dataSensitivity:
        'confidential curriculum tracker rows including lesson numbers; agent stated no student names or credentials were found',
      dataSensitivityTier: 'T1',
      blastRadius: 'single-user',
      writeOperations: [],
    };
    const r = scoreSystemRisk(sys);
    expect(r.dsTier).toBe('T1');
    expect(r.ds).toBe(1); // old regex would have given 2 here
    expect(r.severity).toBe(1);
  });

  it('when a tier IS provided, the basis is the first clause of the prose', () => {
    const sys: RiskScorableSystem = {
      systemId: 'sheets',
      dataSensitivity:
        'PII and confidential educational operations data; responsible fields may contain names',
      dataSensitivityTier: 'T2',
      blastRadius: 'single-user',
      writeOperations: [],
    };
    const r = scoreSystemRisk(sys);
    expect(r.dsBasis).toBe('PII and confidential educational operations data');
    expect(r.dsBasis.length).toBeLessThanOrEqual(121);
  });
});

describe('scoreSystemRisk — BR × DS × DM mapping', () => {
  it('read-only single-user T1 system scores low (BR=1, DS=1 → 1)', () => {
    const sys: RiskScorableSystem = {
      systemId: 'metrics-api',
      dataSensitivity: 'aggregate counts and timestamps',
      dataSensitivityTier: 'T1',
      blastRadius: 'single-user',
      writeOperations: [],
    };
    const r = scoreSystemRisk(sys);
    expect(r.br).toBe(1);
    expect(r.ds).toBe(1);
    expect(r.severity).toBe(1);
    expect(r.band).toBe('informational');
    expect(r.hasIrreversibleWrite).toBe(false);
  });

  it('team-scope T2 system with reversible writes scores BR=2 DS=2 → 4 (medium)', () => {
    const sys: RiskScorableSystem = {
      systemId: 'drive',
      dataSensitivity: 'PII and confidential content; file names may include personal names',
      dataSensitivityTier: 'T2',
      blastRadius: 'team-scope',
      writeOperations: [
        { operation: 'create', target: 'drive', reversible: true },
        { operation: 'update', target: 'drive', reversible: true },
      ],
    };
    const r = scoreSystemRisk(sys);
    expect(r.br).toBe(2);
    expect(r.ds).toBe(2);
    expect(r.severity).toBe(4);
    expect(r.band).toBe('medium');
  });

  it('irreversible write lifts BR one band (team-scope T2 irreversible → BR=3 → 6)', () => {
    const sys: RiskScorableSystem = {
      systemId: 'telegram',
      dataSensitivity: 'message previews, topic names, error messages',
      dataSensitivityTier: 'T2',
      blastRadius: 'team-scope',
      writeOperations: [
        { operation: 'send message', target: 'chat', reversible: false },
      ],
    };
    const r = scoreSystemRisk(sys);
    expect(r.hasIrreversibleWrite).toBe(true);
    expect(r.br).toBe(3); // team-scope(2) + irreversible(+1) = 3
    expect(r.ds).toBe(2);
    expect(r.severity).toBe(6);
    expect(r.band).toBe('medium');
  });

  it('irreversible write on single-user lifts BR to 2 (Gamma-like: 1 → 2)', () => {
    const sys: RiskScorableSystem = {
      systemId: 'gamma',
      dataSensitivity: 'slide-outline prompt text and lesson title',
      dataSensitivityTier: 'T1',
      blastRadius: 'single-user',
      writeOperations: [
        { operation: 'create generation', target: 'gamma', reversible: false },
      ],
    };
    const r = scoreSystemRisk(sys);
    expect(r.hasIrreversibleWrite).toBe(true);
    expect(r.br).toBe(2); // single-user(1) + irreversible(+1) = 2
    expect(r.severity).toBe(r.br * r.ds * r.dm);
  });

  it('write-operation count contributes BR independently (5+ writes → BR ≥ 3)', () => {
    const writeOperations = Array.from({ length: 5 }, (_, i) => ({
      operation: `op${i}`,
      target: 'x',
      reversible: true,
    }));
    const sys: RiskScorableSystem = {
      systemId: 'many-writes',
      dataSensitivity: 'aggregate counts',
      dataSensitivityTier: 'T1',
      blastRadius: 'single-user', // blast axis 1
      writeOperations,
    };
    const r = scoreSystemRisk(sys);
    // BR = max(blastAxis=1, writeAxis=3) = 3
    expect(r.br).toBe(3);
    expect(r.ds).toBe(1);
    expect(r.severity).toBe(3);
  });

  it('DM is fixed at 1.0 for systems (no domain inflation)', () => {
    const sys: RiskScorableSystem = {
      systemId: 'edu',
      dataSensitivity: 'student education records and employment data',
      dataSensitivityTier: 'T2',
      blastRadius: 'team-scope',
      writeOperations: [{ operation: 'x', target: 'y', reversible: true }],
    };
    const r = scoreSystemRisk(sys);
    expect(r.dm).toBe(1.0);
  });

  it('severity always lands on the canonical 9-value scale', () => {
    const allowed = new Set([1, 1.5, 2, 3, 4, 4.5, 6, 9, 13.5]);
    const samples: RiskScorableSystem[] = [
      { systemId: 'a', dataSensitivity: 'aggregate counts', dataSensitivityTier: 'T1', blastRadius: 'single-user', writeOperations: [] },
      { systemId: 'b', dataSensitivity: 'personal data', dataSensitivityTier: 'T2', blastRadius: 'team-scope', writeOperations: [{ operation: 'x', target: 'y', reversible: false }] },
      { systemId: 'c', dataSensitivity: 'patient health records', dataSensitivityTier: 'T3', blastRadius: 'org-wide', writeOperations: [{ operation: 'x', target: 'y', reversible: false }] },
    ];
    for (const s of samples) {
      expect(allowed.has(scoreSystemRisk(s).severity)).toBe(true);
    }
  });
});

describe('computeSystemsRisk — HWM aggregation', () => {
  it('returns posture 0 + scanned=false when there are no systems', () => {
    expect(computeSystemsRisk([])).toMatchObject({ posture: 0, scanned: false });
    expect(computeSystemsRisk(undefined)).toMatchObject({ posture: 0, scanned: false });
  });

  it('posture is the max severity across systems (FIPS high-water-mark)', () => {
    const systems: RiskScorableSystem[] = [
      { systemId: 'low', dataSensitivity: 'aggregate counts', dataSensitivityTier: 'T1', blastRadius: 'single-user', writeOperations: [] }, // sev 1
      { systemId: 'mid', dataSensitivity: 'personal data', dataSensitivityTier: 'T2', blastRadius: 'team-scope', writeOperations: [{ operation: 'x', target: 'y', reversible: true }] }, // sev 4
      { systemId: 'high', dataSensitivity: 'message content', dataSensitivityTier: 'T2', blastRadius: 'team-scope', writeOperations: [{ operation: 'x', target: 'y', reversible: false }] }, // BR3 DS2 = 6
    ];
    const summary = computeSystemsRisk(systems);
    expect(summary.scanned).toBe(true);
    expect(summary.systems).toHaveLength(3);
    expect(summary.posture).toBe(6); // max(1, 4, 6)
    expect(summary.postureBand).toBe('medium');
  });
});
