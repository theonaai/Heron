/**
 * AAP-104 B7 — data quality score 50 with all 7 fields PROVIDED.
 *
 * Codex demo session (`sess-20260528-091712-c37728`) extracted 7 of 7
 * compliance fields cleanly into the transcript but landed score 50.
 * Root cause: `computeNotProvidedPenalty` was penalising every system
 * whose `frequencyAndVolume` legacy string was empty, even when the
 * structured AAP-65 `frequency` object on the same system carried
 * batchSize / callsPerRun / notes. The CLI path
 * (`computeDataQualityFromTranscript`) had not been updated; the MCP
 * path (`server/sessions.ts:computeDataQuality`) already had the fix.
 *
 * These tests pin the new `hasFrequencyEvidence` behaviour so a future
 * refactor cannot silently bring the gap back.
 */

import { describe, it, expect } from 'vitest';

import { computeDataQualityFromTranscript } from '../../src/report/generator.js';
import type { QAPair, SystemAssessment } from '../../src/report/types.js';

const TRANSCRIPT_ALL_SEVEN_FIELDS: QAPair[] = [
  // systemId
  { question: 'What system?', answer: 'Google Sheets via REST API with OAuth token.', category: 'purpose' },
  // scopesRequested
  { question: 'Scopes?', answer: 'spreadsheets scope and drive scope.', category: 'access' },
  // dataSensitivity
  { question: 'Sensitivity?', answer: 'Confidential operational data, no PII.', category: 'data' },
  // blastRadius
  { question: 'Blast radius?', answer: 'team-scope — one user affected at a time.', category: 'access' },
  // frequencyAndVolume
  { question: 'How often?', answer: '50 calls per run, batch of 50 per day.', category: 'frequency' },
  // writeOperations
  { question: 'Writes?', answer: 'Yes — create, update, modify Docs.', category: 'writes' },
  // reversibility
  { question: 'Reversible?', answer: 'Updates can be undone via rollback.', category: 'writes' },
];

function systemWithStructuredFrequency(): SystemAssessment {
  return {
    systemId: 'google-sheets',
    sources: ['A1'],
    scopesRequested: ['https://www.googleapis.com/auth/spreadsheets'],
    scopesNeeded: [],
    scopesDelta: [],
    dataSensitivity: 'Confidential operational data',
    blastRadius: 'team-scope',
    // Structured frequency populated; legacy string empty.
    frequency: {
      runsLastWeek: null,
      callsPerRun: '2-4 per lesson',
      batchSize: 50,
      concurrency: 'mixed',
      notes: 'Dispatcher batch size is 50 with concurrency 10.',
    },
    frequencyAndVolume: '',
    writeOperations: [
      {
        operation: 'Mark row processing/done',
        target: 'lesson tracker rows',
        reversible: true,
        approvalRequired: false,
        volumePerDay: 'dozens/day during batches',
      },
    ],
  };
}

function systemWithLegacyFrequency(): SystemAssessment {
  const s = systemWithStructuredFrequency();
  delete s.frequency;
  s.frequencyAndVolume = '~150 calls per day, batch of 1';
  return s;
}

function systemWithNoFrequencyEvidence(): SystemAssessment {
  const s = systemWithStructuredFrequency();
  delete s.frequency;
  s.frequencyAndVolume = '';
  return s;
}

describe('AAP-104 B7 — computeDataQualityFromTranscript penalty respects structured `frequency`', () => {
  it('does NOT penalise a system whose structured frequency carries batchSize / notes (legacy field empty)', () => {
    const dq = computeDataQualityFromTranscript(
      TRANSCRIPT_ALL_SEVEN_FIELDS,
      [systemWithStructuredFrequency()],
    );
    // 7/7 fields detected from transcript regex → fieldScore = 100.
    expect(dq.fieldsProvided.length).toBe(7);
    expect(dq.fieldsMissing.length).toBe(0);
    // notProvidedPenalty: dataSensitivity OK + frequency OK + scopes OK
    // + writeOp volume OK → 0 gaps → 0 penalty → score = 100.
    expect(dq.score).toBe(100);
  });

  it('does NOT penalise a system whose legacy `frequencyAndVolume` is populated (back-compat)', () => {
    const dq = computeDataQualityFromTranscript(
      TRANSCRIPT_ALL_SEVEN_FIELDS,
      [systemWithLegacyFrequency()],
    );
    expect(dq.score).toBe(100);
  });

  it('DOES penalise a system with neither structured frequency NOR legacy string', () => {
    const dq = computeDataQualityFromTranscript(
      TRANSCRIPT_ALL_SEVEN_FIELDS,
      [systemWithNoFrequencyEvidence()],
    );
    // 1 gap × 8 = 8 penalty → score 92.
    expect(dq.score).toBe(92);
  });

  it('multi-system Codex-like input scores ≥ 60 (pre-fix it was 50)', () => {
    // Mirrors the Codex demo (sess-20260528-091712-c37728): 3 google-*
    // systems with structured frequency + 5 SaaS systems where the LLM
    // captured frequency but not scopesRequested (Gemini = API key, etc.)
    // Pre-fix: 13 gaps × 8 = 50 penalty → score 50.
    // Post-fix: 5 gaps from missing scopes × 8 = 40 penalty → score 60.
    const systems: SystemAssessment[] = [];
    for (let i = 0; i < 3; i++) {
      const s = systemWithStructuredFrequency();
      s.systemId = `google-system-${i}`;
      systems.push(s);
    }
    for (let i = 0; i < 5; i++) {
      const s = systemWithStructuredFrequency();
      s.systemId = `saas-system-${i}`;
      s.scopesRequested = []; // API-key-based, no OAuth scope
      systems.push(s);
    }
    const dq = computeDataQualityFromTranscript(TRANSCRIPT_ALL_SEVEN_FIELDS, systems);
    expect(dq.score).toBeGreaterThanOrEqual(60);
    expect(dq.score).toBeLessThan(100);
  });
});
