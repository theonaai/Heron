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
import type { ActualScope, SourceVerification } from '../../src/verification/types.js';

/** Build a `verified`/`discrepancy` OAuth source carrying the given scopes. */
function oauthSource(
  service: 'google-workspace' | 'greenhouse' | 'bamboohr',
  scopes: string[],
  verdict: 'verified' | 'discrepancy' = 'verified',
): SourceVerification {
  const scopeRows: ActualScope[] = scopes.map((scope) => ({ service, scope }));
  return {
    sourceId: 'oauth-scopes',
    verdict,
    diffs: [],
    inventory: { source: 'oauth-scopes', capturedAt: '2026-06-02T00:00:00.000Z', scopes: scopeRows },
  };
}

/** Build an `unverified` (errored) OAuth source — carries NO inventory. */
function oauthErrorSource(): SourceVerification {
  return {
    sourceId: 'oauth-scopes',
    verdict: 'unverified',
    diffs: [],
    error: { kind: 'unauthorized', message: 'token expired' },
  };
}

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

describe('AAP-115 — DS-tier floor from verified OAuth scopes (scoreSystemRisk)', () => {
  it('a personal-data scope floors DS to T2 even when the LLM tier is T1', () => {
    const sys: RiskScorableSystem = {
      systemId: 'gmail',
      dataSensitivity: 'agent claims it only reads subject lines, non-sensitive',
      dataSensitivityTier: 'T1', // agent UNDER-reported
      blastRadius: 'single-user',
      writeOperations: [],
    };
    // gmail.readonly inherently grants mailbox contents → floor T2.
    const r = scoreSystemRisk(sys, 'T2');
    expect(r.llmTier).toBe('T1');
    expect(r.scopeFloorTier).toBe('T2');
    expect(r.dsTier).toBe('T2'); // finalTier = max(T1, T2)
    expect(r.ds).toBe(2);
    expect(r.severity).toBe(2); // BR1 × DS2 × 1.0 — was 1 before the floor
    expect(r.dsBasis).toMatch(/floored to T2/);
  });

  it('finalTier = max(llmTier, scopeFloor): the floor may only RAISE, never lower', () => {
    const sys: RiskScorableSystem = {
      systemId: 'payroll-gmail',
      dataSensitivity: 'bank details and tax IDs',
      dataSensitivityTier: 'T3', // LLM already high
      blastRadius: 'single-user',
      writeOperations: [],
    };
    // A T2 scope floor must NOT pull the LLM's T3 down to T2.
    const r = scoreSystemRisk(sys, 'T2');
    expect(r.llmTier).toBe('T3');
    expect(r.dsTier).toBe('T3'); // max(T3, T2) = T3
    expect(r.ds).toBe(3);
    // basis stays the prose basis (floor did not move the tier).
    expect(r.dsBasis).not.toMatch(/floored/);
  });

  it('no scope floor (undefined) leaves the LLM tier untouched', () => {
    const sys: RiskScorableSystem = {
      systemId: 'drive',
      dataSensitivity: 'mostly folder structure',
      dataSensitivityTier: 'T1',
      blastRadius: 'single-user',
      writeOperations: [],
    };
    const r = scoreSystemRisk(sys, undefined);
    expect(r.dsTier).toBe('T1');
    expect(r.scopeFloorTier).toBeUndefined();
  });
});

describe('AAP-115 — DS floor wiring through computeSystemsRisk', () => {
  it('a verified gmail scope floors the google system DS; a broad drive scope does NOT', () => {
    const systems: RiskScorableSystem[] = [
      // Google system the agent rated T1; granted scope includes gmail (T2) → floored.
      { systemId: 'google-sheets', dataSensitivity: 'claims non-sensitive', dataSensitivityTier: 'T1', blastRadius: 'single-user', writeOperations: [] },
    ];
    // Verified scopes: gmail.readonly (personal data → T2) + drive (broad, no floor).
    const oauth = [oauthSource('google-workspace', ['gmail.readonly', 'drive'])];
    const summary = computeSystemsRisk(systems, oauth);
    const row = summary.systems[0];
    expect(row.llmTier).toBe('T1');
    expect(row.scopeFloorTier).toBe('T2'); // gmail floored; drive did NOT contribute
    expect(row.dsTier).toBe('T2');
    expect(row.ds).toBe(2);
    expect(summary.posture).toBe(2); // BR1 × DS2 — floored above the LLM's T1=1
  });

  it('ONLY broad scopes (drive/sheets) produce NO floor — BR ⟂ DS preserved', () => {
    const systems: RiskScorableSystem[] = [
      { systemId: 'google-sheets', dataSensitivity: 'spreadsheet cells', dataSensitivityTier: 'T1', blastRadius: 'single-user', writeOperations: [] },
    ];
    const oauth = [oauthSource('google-workspace', ['drive', 'spreadsheets'])];
    const summary = computeSystemsRisk(systems, oauth);
    const row = summary.systems[0];
    expect(row.scopeFloorTier).toBeUndefined();
    expect(row.dsTier).toBe('T1'); // unchanged — broad scopes are a BR concern
  });

  it('verified scopes only floor the system that maps to that connector', () => {
    const systems: RiskScorableSystem[] = [
      { systemId: 'gmail', dataSensitivity: 'claims non-sensitive', dataSensitivityTier: 'T1', blastRadius: 'single-user', writeOperations: [] },
      // unrelated system; the google scopes must not floor it.
      { systemId: 'linear-theona', dataSensitivity: 'issue text', dataSensitivityTier: 'T1', blastRadius: 'single-user', writeOperations: [] },
    ];
    const oauth = [oauthSource('google-workspace', ['gmail.readonly'])];
    const summary = computeSystemsRisk(systems, oauth);
    const gmail = summary.systems.find((s) => s.systemId === 'gmail')!;
    const linear = summary.systems.find((s) => s.systemId === 'linear-theona')!;
    expect(gmail.dsTier).toBe('T2'); // floored
    expect(linear.dsTier).toBe('T1'); // untouched — does not map to google-workspace
    expect(linear.scopeFloorTier).toBeUndefined();
  });

  it('an UNVERIFIED (errored) introspection never floors DS (no trustworthy inventory)', () => {
    const systems: RiskScorableSystem[] = [
      { systemId: 'gmail', dataSensitivity: 'claims non-sensitive', dataSensitivityTier: 'T1', blastRadius: 'single-user', writeOperations: [] },
    ];
    const summary = computeSystemsRisk(systems, [oauthErrorSource()]);
    const row = summary.systems[0];
    expect(row.dsTier).toBe('T1'); // a failed read cannot floor
    expect(row.scopeFloorTier).toBeUndefined();
  });
});
