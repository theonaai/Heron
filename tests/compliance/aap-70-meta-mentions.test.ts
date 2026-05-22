/**
 * AAP-70 Part B: tests for the dropMetaMentions preprocessor and its
 * effect on detectSignals' Annex III category regex passes.
 */

import { describe, it, expect } from 'vitest';
import {
  detectSignals,
  dropMetaMentions,
  classifyEUAIAct,
} from '../../src/compliance/mapper.js';
import type { QAPair } from '../../src/report/types.js';

function qa(answer: string, category: QAPair['category'] = 'purpose'): QAPair {
  return { question: 'Q', answer, category };
}

describe('dropMetaMentions — unit', () => {
  it('strips negation window around a single keyword', () => {
    const cleaned = dropMetaMentions('I do not do biometric ID for anyone.');
    expect(/biometric/i.test(cleaned)).toBe(false);
  });

  it('strips negation window across multiple keywords in a list', () => {
    const cleaned = dropMetaMentions(
      'I do not do biometric, law enforcement, or essential services work.',
    );
    expect(/biometric/i.test(cleaned)).toBe(false);
    expect(/law enforcement/i.test(cleaned)).toBe(false);
    expect(/essential services/i.test(cleaned)).toBe(false);
  });

  it('strips structured prefix tokens (skill, tool, mcp_server, connector, framework)', () => {
    const cleaned = dropMetaMentions(
      'skills: investigate, biometric-tool; tool: forensic-search; mcp_server: police-rec',
    );
    // The keywords are inside structured tokens — should not survive.
    expect(/investigate/i.test(cleaned)).toBe(false);
    expect(/forensic/i.test(cleaned)).toBe(false);
    expect(/police/i.test(cleaned)).toBe(false);
  });

  it('strips meta-mentions of 3+ Annex III category names', () => {
    const cleaned = dropMetaMentions(
      'Annex III categories include biometric, education, employment, essential services, law enforcement.',
    );
    expect(/biometric/i.test(cleaned)).toBe(false);
    expect(/education/i.test(cleaned)).toBe(false);
    expect(/employment/i.test(cleaned)).toBe(false);
    expect(/essential services/i.test(cleaned)).toBe(false);
    expect(/law enforcement/i.test(cleaned)).toBe(false);
  });

  it('PRESERVES genuine biometric usage in positive context', () => {
    const cleaned = dropMetaMentions(
      'Our system performs biometric identification of natural persons at the entry gate.',
    );
    expect(/biometric/i.test(cleaned)).toBe(true);
  });

  it('PRESERVES genuine law enforcement context not in negation', () => {
    const cleaned = dropMetaMentions(
      'The agent runs predictive policing models for the police department.',
    );
    expect(/police/i.test(cleaned)).toBe(true);
  });
});

describe('detectSignals — Annex III category false positives suppressed', () => {
  it('agent saying "I do not do biometric, law enforcement, or essential services" → no §1/§5/§6 signals', () => {
    const transcript = [
      qa(
        'I do not do biometric identification, law enforcement, or essential services routing. ' +
          'My job is to draft outbound emails for sales prospects.',
      ),
    ];
    const signals = detectSignals([], transcript, false);
    expect(signals.hasBiometricSignal).toBe(false);
    expect(signals.isLawEnforcementContext).toBe(false);
    expect(signals.hasEssentialServicesSignal).toBe(false);
    const cls = classifyEUAIAct(signals);
    expect(cls.classification).toBe('limited');
    expect(cls.annexIIICategories).toEqual([]);
  });

  it('agent with skill named "investigate-deps" → no §6 law enforcement signal', () => {
    const transcript = [
      qa(
        'The agent uses skill: investigate-deps to look at dependency graphs. ' +
          'No regulated decision-making.',
      ),
    ];
    const signals = detectSignals([], transcript, false);
    expect(signals.isLawEnforcementContext).toBe(false);
  });

  it('meta-mention of Annex III category list → no false positives', () => {
    const transcript = [
      qa(
        'EU AI Act Annex III categories include biometric, education, employment, essential services, and law enforcement applications. ' +
          'This agent does none of those — it summarises meeting notes.',
      ),
    ];
    const signals = detectSignals([], transcript, false);
    expect(signals.hasBiometricSignal).toBe(false);
    expect(signals.isLawEnforcementContext).toBe(false);
    expect(signals.hasEssentialServicesSignal).toBe(false);
    expect(signals.isEducationAssessmentContext).toBe(false);
    const cls = classifyEUAIAct(signals);
    expect(cls.annexIIICategories).toEqual([]);
  });

  it('POSITIVE control: real biometric usage still fires §1 when sensitive PII + decisions-about-people present', () => {
    const transcript = [
      qa(
        'Our system processes biometric data — fingerprint and iris scans — to identify natural persons in the workforce. ' +
          'It uses SSN as a secondary identifier. Decisions about facility access are automated.',
      ),
    ];
    const signals = detectSignals(
      [],
      transcript,
      true,
      'The agent denies facility access to applicants based on biometric match and SSN.',
    );
    expect(signals.hasBiometricSignal).toBe(true);
    expect(signals.hasSensitivePII).toBe(true);
    expect(signals.hasDecisionsAboutPeople).toBe(true);
    const cls = classifyEUAIAct(signals);
    expect(cls.annexIIICategories.some((c) => c.includes('§1'))).toBe(true);
  });

  it('agent mentions essential services routing but makesDecisionsAboutPeople=false → no §5', () => {
    const transcript = [
      qa(
        'Documentation references essential services routing as an example of what the team does not build.',
      ),
    ];
    const signals = detectSignals([], transcript, false);
    const cls = classifyEUAIAct(signals);
    expect(cls.annexIIICategories.some((c) => c.includes('§5'))).toBe(false);
  });

  it('POSITIVE control: HR template (automated candidate screening) → §4 employment fires', () => {
    const transcript = [
      qa(
        'The agent screens candidate resumes and automatically rejects applicants below a threshold score. ' +
          'Top candidates are forwarded to recruiters.',
      ),
    ];
    const signals = detectSignals(
      [],
      transcript,
      true,
      'Automated screening rejection of candidates for the recruiting team; hiring managers receive only pre-filtered shortlists.',
    );
    expect(signals.hasEmploymentDecisions).toBe(true);
    expect(signals.decisionImpact).toBe('high');
    const cls = classifyEUAIAct(signals);
    expect(cls.classification).toBe('high-risk');
    expect(cls.annexIIICategories).toContain('§4 employment');
  });
});
