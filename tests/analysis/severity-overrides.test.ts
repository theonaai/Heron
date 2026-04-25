import { describe, it, expect } from 'vitest';
import {
  applySeverityOverrides,
  computeSeveritySignals,
} from '../../src/analysis/risk-scorer.js';
import type { Risk, SystemAssessment } from '../../src/report/types.js';

function makeSystem(overrides: Partial<SystemAssessment> = {}): SystemAssessment {
  return {
    systemId: 'Test System',
    scopesRequested: [],
    scopesNeeded: [],
    scopesDelta: [],
    dataSensitivity: '',
    blastRadius: 'single-user',
    frequencyAndVolume: '',
    writeOperations: [],
    ...overrides,
  };
}

function makeRisk(severity: Risk['severity'], title: string, description = ''): Risk {
  return { severity, title, description };
}

describe('applySeverityOverrides (AAP-43 P0 #1c)', () => {
  it('floors scope-creep risk to MEDIUM when excessive perms exist', () => {
    const systems = [
      makeSystem({
        systemId: 'Google Workspace',
        scopesRequested: ['drive'],
        scopesNeeded: ['drive.file'],
        scopesDelta: ['drive'],
      }),
    ];
    const risks = [makeRisk('low', 'Broad OAuth scope', 'scope excessive for stated purpose')];
    const out = applySeverityOverrides(risks, systems);
    expect(out[0].severity).toBe('medium');
  });

  it('floors scope-creep to HIGH when excessive perms + sensitive PII', () => {
    const systems = [
      makeSystem({
        systemId: 'Google Workspace',
        scopesRequested: ['spreadsheets'],
        scopesDelta: ['spreadsheets'],
        dataSensitivity: 'PII, names, emails, phone',
      }),
    ];
    const risks = [makeRisk('low', 'Broad OAuth scope', 'scope oauth excessive')];
    const out = applySeverityOverrides(risks, systems);
    expect(out[0].severity).toBe('high');
  });

  it('preserves LLM severity if higher than rule floor', () => {
    const systems = [makeSystem()];
    const risks = [makeRisk('critical', 'Something bad', 'scope excessive')];
    const out = applySeverityOverrides(risks, systems);
    expect(out[0].severity).toBe('critical');
  });

  it('is deterministic across identical inputs (core determinism guarantee)', () => {
    const systems = [
      makeSystem({
        systemId: 'Google Sheets',
        scopesRequested: ['spreadsheets'],
        scopesDelta: ['spreadsheets'],
        dataSensitivity: 'PII',
        writeOperations: [{ operation: 'append row', target: 'Sheet1', reversible: false, approvalRequired: false, volumePerDay: '50' }],
      }),
    ];
    const risks = [makeRisk('low', 'Scope issue', 'scope excessive oauth')];
    const runs = Array.from({ length: 5 }, () => applySeverityOverrides(risks, systems)[0].severity);
    const unique = new Set(runs);
    expect(unique.size).toBe(1);
  });

  it('floors decisions-about-people risk to HIGH when makesDecisionsAboutPeople=true', () => {
    const systems = [makeSystem()];
    const risks = [makeRisk('medium', 'Decisions about candidates', 'agent makes hiring decisions')];
    const out = applySeverityOverrides(risks, systems, true);
    expect(out[0].severity).toBe('high');
  });

  it('does not floor decisions risks when makesDecisionsAboutPeople=false', () => {
    const systems = [makeSystem()];
    const risks = [makeRisk('low', 'Decisions about users', 'user-facing decisions')];
    const out = applySeverityOverrides(risks, systems, false);
    expect(out[0].severity).toBe('low');
  });
});

describe('computeSeveritySignals (AAP-43 P0 #1c)', () => {
  it('detects org-wide writes', () => {
    const signals = computeSeveritySignals([
      makeSystem({
        blastRadius: 'org-wide',
        writeOperations: [{ operation: 'update', target: 'all users', reversible: true, approvalRequired: false, volumePerDay: '10' }],
      }),
    ]);
    expect(signals.hasOrgWideWrites).toBe(true);
  });

  it('detects sensitive PII from data sensitivity keywords', () => {
    const signals = computeSeveritySignals([
      makeSystem({ dataSensitivity: 'contains SSN and credit card' }),
    ]);
    expect(signals.hasSensitivePII).toBe(true);
  });

  // AAP-43 post-merge regression fix (2026-04-24):
  // LinkedIn ICP reference case — public PII (names, profile URLs, job
  // titles) at scale (~500 profiles/run) + excessive Google `spreadsheets`
  // scope must floor to HIGH, matching the severity anchor in the LLM
  // prompt. Before this fix the floor stopped at MEDIUM because sensitive-
  // PII keywords (SSN/bank) weren't present in dataSensitivity.
  it('detects public PII at scale (LinkedIn ICP reference case)', () => {
    // NB: dataSensitivity avoids the words "PII"/"personal" on purpose —
    // those already fire hasSensitivePII via SENSITIVE_KEYWORDS. This
    // fixture models the realistic bad case where the LLM labels the data
    // with its concrete shape ("names, LinkedIn URLs, job titles") rather
    // than the compliance-classification word "PII" — which is exactly
    // when the new signal becomes necessary.
    const signals = computeSeveritySignals([
      makeSystem({
        systemId: 'Google Sheets',
        dataSensitivity: 'Public contact info: full names, LinkedIn profile URLs, job titles, companies',
        frequencyAndVolume: 'up to 500 profiles per run, batch of 5',
      }),
    ]);
    expect(signals.hasPublicPIIAtScale).toBe(true);
    // Classical sensitive PII false (no SSN/bank/PII-label keyword)
    expect(signals.hasSensitivePII).toBe(false);
  });

  it('does NOT fire hasPublicPIIAtScale for small-volume public PII', () => {
    const signals = computeSeveritySignals([
      makeSystem({
        dataSensitivity: 'email address of one user',
        frequencyAndVolume: '1 record per run',
      }),
    ]);
    expect(signals.hasPublicPIIAtScale).toBe(false);
  });

  it('floors access risk to HIGH when public PII at scale + excessive perms', () => {
    const systems = [
      makeSystem({
        systemId: 'Google Sheets',
        scopesRequested: ['spreadsheets'],
        scopesNeeded: ['drive.file'],
        scopesDelta: ['spreadsheets'],
        dataSensitivity: 'PII: names, LinkedIn profile URLs',
        frequencyAndVolume: 'up to 500 leads per run',
      }),
    ];
    const risks = [
      { severity: 'medium' as const, title: 'Broad Google scope', description: 'OAuth scope is excessive for stated need' },
    ];
    const out = applySeverityOverrides(risks, systems);
    expect(out[0].severity).toBe('high');
  });
});
