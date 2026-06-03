/**
 * AAP-65 — Zod schema constraint tests.
 *
 * The systemAssessmentSchema and analysisResultSchema both enforce tighter
 * per-field shapes than before. These tests pin the exact boundaries so a
 * future relaxation can't sneak in unnoticed.
 */

import { describe, it, expect } from 'vitest';
import {
  systemAssessmentSchema,
  analysisResultSchema,
  frequencyShapeSchema,
  riskSchema,
} from '../../src/report/types.js';

describe('systemAssessmentSchema — AAP-65 tightened shape', () => {
  it('rejects a prose-shaped systemId (sentence with spaces and capitals)', () => {
    expect(() =>
      systemAssessmentSchema.parse({
        systemId:
          'Codex desktop app local agent session -> OpenAI-hosted backend (A3, A4).',
        scopesRequested: [],
        scopesNeeded: [],
        scopesDelta: [],
        dataSensitivity: '',
        blastRadius: 'single-user',
        frequencyAndVolume: '',
        writeOperations: [],
      }),
    ).toThrow(/systemId|kebab-case/i);
  });

  it('accepts a short kebab-case systemId', () => {
    const parsed = systemAssessmentSchema.parse({
      systemId: 'openai-codex-backend',
      scopesRequested: [],
      scopesNeeded: [],
      scopesDelta: [],
      dataSensitivity: '',
      blastRadius: 'single-user',
      frequencyAndVolume: '',
      writeOperations: [],
    });
    expect(parsed.systemId).toBe('openai-codex-backend');
  });

  it('rejects a systemId > 50 chars', () => {
    expect(() =>
      systemAssessmentSchema.parse({
        systemId: 'a' + '-very'.repeat(20) + '-long-id',
        scopesRequested: [],
        scopesNeeded: [],
        scopesDelta: [],
        dataSensitivity: '',
        blastRadius: 'single-user',
        frequencyAndVolume: '',
        writeOperations: [],
      }),
    ).toThrow();
  });

  it('rejects an empty systemId', () => {
    expect(() =>
      systemAssessmentSchema.parse({
        systemId: '',
        scopesRequested: [],
        scopesNeeded: [],
        scopesDelta: [],
        dataSensitivity: '',
        blastRadius: 'single-user',
        frequencyAndVolume: '',
        writeOperations: [],
      }),
    ).toThrow();
  });

  it('rejects scope tokens longer than 80 chars', () => {
    expect(() =>
      systemAssessmentSchema.parse({
        systemId: 'svc',
        scopesRequested: ['x'.repeat(81)],
        scopesNeeded: [],
        scopesDelta: [],
        dataSensitivity: '',
        blastRadius: 'single-user',
        frequencyAndVolume: '',
        writeOperations: [],
      }),
    ).toThrow();
  });

  it('rejects a sources[] entry that does not match /^A\\d+$/', () => {
    expect(() =>
      systemAssessmentSchema.parse({
        systemId: 'svc',
        sources: ['A3', 'not-a-ref'],
        scopesRequested: [],
        scopesNeeded: [],
        scopesDelta: [],
        dataSensitivity: '',
        blastRadius: 'single-user',
        frequencyAndVolume: '',
        writeOperations: [],
      }),
    ).toThrow();
  });

  it('accepts a valid frequency object', () => {
    const parsed = systemAssessmentSchema.parse({
      systemId: 'svc',
      sources: ['A1', 'A2'],
      scopesRequested: [],
      scopesNeeded: [],
      scopesDelta: [],
      dataSensitivity: '',
      blastRadius: 'single-user',
      frequencyAndVolume: '',
      frequency: {
        runsLastWeek: 7,
        callsPerRun: '10-15',
        batchSize: 1,
        concurrency: 'sequential',
        notes: 'audit pass only',
      },
      writeOperations: [],
    });
    expect(parsed.frequency?.callsPerRun).toBe('10-15');
  });

  it('frequency.runsLastWeek accepts null (meaning "not observable")', () => {
    const parsed = frequencyShapeSchema.parse({ runsLastWeek: null });
    expect(parsed.runsLastWeek).toBeNull();
  });

  it('rejects frequency.concurrency outside the allowed enum', () => {
    expect(() =>
      frequencyShapeSchema.parse({ concurrency: 'eventually' }),
    ).toThrow();
  });
});

describe('analysisResultSchema — AAP-65 top-level caps', () => {
  const baseSystem = {
    systemId: 'svc',
    scopesRequested: [],
    scopesNeeded: [],
    scopesDelta: [],
    dataSensitivity: '',
    blastRadius: 'single-user',
    frequencyAndVolume: '',
    writeOperations: [],
  };

  it('rejects summary > 800 chars', () => {
    expect(() =>
      analysisResultSchema.parse({
        summary: 'x'.repeat(801),
        agentPurpose: 'p',
        systems: [baseSystem],
        risks: [],
        recommendations: [],
        overallRiskLevel: 'low',
      }),
    ).toThrow();
  });

  it('rejects agentPurpose > 600 chars', () => {
    expect(() =>
      analysisResultSchema.parse({
        summary: 's',
        agentPurpose: 'x'.repeat(601),
        systems: [baseSystem],
        risks: [],
        recommendations: [],
        overallRiskLevel: 'low',
      }),
    ).toThrow();
  });

  it('rejects more than 20 recommendations', () => {
    expect(() =>
      analysisResultSchema.parse({
        summary: 's',
        agentPurpose: 'p',
        systems: [baseSystem],
        risks: [],
        recommendations: Array.from({ length: 21 }, () => 'rec'),
        overallRiskLevel: 'low',
      }),
    ).toThrow();
  });

  it('rejects a single recommendation > 400 chars', () => {
    expect(() =>
      analysisResultSchema.parse({
        summary: 's',
        agentPurpose: 'p',
        systems: [baseSystem],
        risks: [],
        recommendations: ['x'.repeat(401)],
        overallRiskLevel: 'low',
      }),
    ).toThrow();
  });
});

// ─── AAP-122 — riskSchema.findingType (bounded, optional) ────────────────────

describe('riskSchema — AAP-122 findingType', () => {
  const base = { severity: 'high', title: 'T', description: 'D' } as const;

  it('parses a risk WITHOUT findingType (legacy / unclassified — stays global-only)', () => {
    const r = riskSchema.parse({ ...base });
    expect(r.findingType).toBeUndefined();
  });

  it('accepts each of the seven closed finding types and round-trips the value', () => {
    for (const ft of [
      'excessive-access',
      'write-risk',
      'sensitive-data',
      'scope-creep',
      'regulatory-flags',
      'risk-score',
      'decisions-about-people',
    ] as const) {
      expect(riskSchema.parse({ ...base, findingType: ft }).findingType).toBe(ft);
    }
  });

  it('rejects a findingType outside the closed enum (no free-form values)', () => {
    expect(() => riskSchema.parse({ ...base, findingType: 'made-up-category' })).toThrow();
    expect(() => riskSchema.parse({ ...base, findingType: 'eu-ai-act' })).toThrow();
  });

  it('round-trips findingType through analysisResultSchema (the analyzer parse path)', () => {
    const parsed = analysisResultSchema.parse({
      summary: 's',
      agentPurpose: 'p',
      systems: [],
      risks: [{ ...base, findingType: 'decisions-about-people' }],
      recommendations: [],
      overallRiskLevel: 'high',
    });
    expect(parsed.risks[0]!.findingType).toBe('decisions-about-people');
  });
});
