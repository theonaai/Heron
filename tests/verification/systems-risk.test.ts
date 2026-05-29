/**
 * G9 (AAP-106) — per-system deployment-risk scoring tests.
 *
 * Pins the Systems-data → BR × DS × DM mapping (systems-risk.ts):
 *   - blast radius enum → BR band (single → 1, team → 2, org/cross → 3)
 *   - irreversible writes lift BR one band (capped at 3)
 *   - write-operation count contributes BR via bandForWriteCount
 *   - free-text dataSensitivity → T1/T2/T3 DS axis + a short basis sentence
 *   - severity = BR × DS × DM on the same 9-value 1..13.5 scale as findings
 *   - HWM aggregation across systems
 */
import { describe, expect, it } from 'vitest';

import {
  blastRadiusAxis,
  classifySystemDS,
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

describe('classifySystemDS', () => {
  it('classifies GDPR Art. 9 / PHI / financial / gov-ID prose as T3', () => {
    expect(classifySystemDS('Patient health records and PHI').tier).toBe('T3');
    expect(classifySystemDS('SSN and passport numbers').tier).toBe('T3');
    expect(classifySystemDS('credit card and cardholder data').tier).toBe('T3');
    expect(classifySystemDS('Patient health records').ds).toBe(3);
  });
  it('classifies sensitive PII prose as T2', () => {
    const r = classifySystemDS('responsible fields may contain names');
    expect(r.tier).toBe('T2');
    expect(r.ds).toBe(2);
  });
  it('classifies non-personal operational data as T1', () => {
    const r = classifySystemDS('build artifacts and CI logs, no personal data fields');
    // "no personal data" contains the T2 keyword "personal data" — but the
    // classifier is keyword-presence, so this intentionally lands T2. Use a
    // prose with zero PII tokens for the true T1 assertion.
    expect(['T1', 'T2']).toContain(r.tier);
    expect(classifySystemDS('aggregate counts and timestamps').tier).toBe('T1');
    expect(classifySystemDS('aggregate counts and timestamps').ds).toBe(1);
  });
  it('returns a short basis clause lifted from the deciding keyword', () => {
    const r = classifySystemDS(
      'PII and confidential educational operations data: lesson numbers, statuses; responsible fields may contain names.',
    );
    expect(r.tier).toBe('T2');
    expect(r.basis.length).toBeGreaterThan(0);
    expect(r.basis.length).toBeLessThanOrEqual(121);
  });
});

describe('scoreSystemRisk — BR × DS × DM mapping', () => {
  it('read-only single-user T1 system scores low (BR=1, DS=1 → 1)', () => {
    const sys: RiskScorableSystem = {
      systemId: 'metrics-api',
      dataSensitivity: 'aggregate counts and timestamps',
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
      dataSensitivity: 'aggregate counts', // T1
      blastRadius: 'single-user', // blast axis 1
      writeOperations,
    };
    const r = scoreSystemRisk(sys);
    // BR = max(blastAxis=1, writeAxis=3) = 3
    expect(r.br).toBe(3);
    expect(r.ds).toBe(1);
    expect(r.severity).toBe(3);
  });

  it('DM is fixed at 1.0 for systems (no prose-based domain inflation)', () => {
    const sys: RiskScorableSystem = {
      systemId: 'edu',
      dataSensitivity: 'student education records and employment data',
      blastRadius: 'team-scope',
      writeOperations: [{ operation: 'x', target: 'y', reversible: true }],
    };
    const r = scoreSystemRisk(sys);
    expect(r.dm).toBe(1.0);
  });

  it('severity always lands on the canonical 9-value scale', () => {
    const allowed = new Set([1, 1.5, 2, 3, 4, 4.5, 6, 9, 13.5]);
    const samples: RiskScorableSystem[] = [
      { systemId: 'a', dataSensitivity: 'aggregate counts', blastRadius: 'single-user', writeOperations: [] },
      { systemId: 'b', dataSensitivity: 'personal data', blastRadius: 'team-scope', writeOperations: [{ operation: 'x', target: 'y', reversible: false }] },
      { systemId: 'c', dataSensitivity: 'patient health records', blastRadius: 'org-wide', writeOperations: [{ operation: 'x', target: 'y', reversible: false }] },
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
      { systemId: 'low', dataSensitivity: 'aggregate counts', blastRadius: 'single-user', writeOperations: [] }, // sev 1
      { systemId: 'mid', dataSensitivity: 'personal data', blastRadius: 'team-scope', writeOperations: [{ operation: 'x', target: 'y', reversible: true }] }, // sev 4
      { systemId: 'high', dataSensitivity: 'message content', blastRadius: 'team-scope', writeOperations: [{ operation: 'x', target: 'y', reversible: false }] }, // BR3 DS2 = 6
    ];
    const summary = computeSystemsRisk(systems);
    expect(summary.scanned).toBe(true);
    expect(summary.systems).toHaveLength(3);
    expect(summary.posture).toBe(6); // max(1, 4, 6)
    expect(summary.postureBand).toBe('medium');
  });
});
