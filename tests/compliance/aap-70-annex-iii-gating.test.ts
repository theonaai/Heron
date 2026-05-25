/**
 * AAP-70 Part A: per-category gating tests for classifyEUAIAct.
 *
 * Every Annex III category must require at least `hasDecisionsAboutPeople`.
 * §6 / §5 also require non-trivial `decisionImpact`. §1 additionally
 * requires `hasSensitivePII`. §4 is unchanged (its existing `decisionImpact
 * !== 'none'` gate implies decisions-about-people via the hasEmployment
 * pipeline). §3 keeps single-signal trigger — the regex is already narrow.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyEUAIAct,
  type ComplianceSignals,
  type DecisionImpact,
} from '../../src/compliance/mapper.js';

function makeSignals(over: Partial<ComplianceSignals> = {}): ComplianceSignals {
  return {
    hasSensitivePII: false,
    hasPublicPII: false,
    hasPII: false,
    hasHealth: false,
    hasEmploymentDecisions: false,
    hasWriteOps: false,
    hasIrreversibleWrites: false,
    hasExcessivePerms: false,
    hasScopeCreep: false,
    hasOrgBlast: false,
    hasOrgBlastWithWrites: false,
    decisionImpact: 'none' as DecisionImpact,
    businessSystems: [],
    hasBiometricSignal: false,
    isEducationAssessmentContext: false,
    isLawEnforcementContext: false,
    hasEssentialServicesSignal: false,
    hasDecisionsAboutPeople: false,
    hasInternationalTransfer: false,
    hasExternalProcessors: false,
    hasLargeScaleProcessing: false,
    hasMCPOrA2A: false,
    hasSubAgents: false,
    hasCrossCustomer: false,
    proseExplicitlyNoBiometric: false,
    proseExplicitlyNoEducation: false,
    proseExplicitlyNoEmployment: false,
    proseExplicitlyNoEssentialServices: false,
    ...over,
  };
}

describe('AAP-70 §6 law enforcement gating', () => {
  it('does NOT fire when isLawEnforcementContext=true but hasDecisionsAboutPeople=false', () => {
    const signals = makeSignals({
      isLawEnforcementContext: true,
      hasDecisionsAboutPeople: false,
      decisionImpact: 'none',
    });
    const cls = classifyEUAIAct(signals);
    expect(cls.classification).toBe('limited');
    expect(cls.annexIIICategories).toEqual([]);
  });

  it('does NOT fire when isLawEnforcementContext=true and hasDecisionsAboutPeople=true but decisionImpact=none', () => {
    // Theoretical edge — hasDecisionsAboutPeople requires impact!='none', but
    // defend against future signal-detection drift.
    const signals = makeSignals({
      isLawEnforcementContext: true,
      hasDecisionsAboutPeople: true,
      decisionImpact: 'none',
    });
    const cls = classifyEUAIAct(signals);
    expect(cls.annexIIICategories.some((c) => c.includes('law enforcement'))).toBe(false);
  });

  it('FIRES when isLawEnforcementContext + hasDecisionsAboutPeople + decisionImpact=high', () => {
    const signals = makeSignals({
      isLawEnforcementContext: true,
      hasDecisionsAboutPeople: true,
      decisionImpact: 'high',
    });
    const cls = classifyEUAIAct(signals);
    expect(cls.classification).toBe('high-risk');
    expect(cls.annexIIICategories).toContain('§6 law enforcement');
  });
});

describe('AAP-70 §1 biometric gating', () => {
  it('does NOT fire when biometric + sensitivePII but hasDecisionsAboutPeople=false', () => {
    const signals = makeSignals({
      hasBiometricSignal: true,
      hasSensitivePII: true,
      hasDecisionsAboutPeople: false,
    });
    const cls = classifyEUAIAct(signals);
    expect(cls.annexIIICategories.some((c) => c.includes('biometric'))).toBe(false);
  });

  it('FIRES when biometric + sensitivePII + hasDecisionsAboutPeople', () => {
    const signals = makeSignals({
      hasBiometricSignal: true,
      hasSensitivePII: true,
      hasDecisionsAboutPeople: true,
      decisionImpact: 'high',
    });
    const cls = classifyEUAIAct(signals);
    expect(cls.classification).toBe('high-risk');
    expect(cls.annexIIICategories).toContain('§1 biometric');
  });
});

describe('AAP-70 §5 essential services gating', () => {
  it('does NOT fire when essentialServices + impact=high but hasDecisionsAboutPeople=false', () => {
    const signals = makeSignals({
      hasEssentialServicesSignal: true,
      decisionImpact: 'high',
      hasDecisionsAboutPeople: false,
    });
    const cls = classifyEUAIAct(signals);
    expect(cls.annexIIICategories.some((c) => c.includes('essential services'))).toBe(false);
  });

  it('FIRES when essentialServices + impact=high + hasDecisionsAboutPeople', () => {
    const signals = makeSignals({
      hasEssentialServicesSignal: true,
      decisionImpact: 'high',
      hasDecisionsAboutPeople: true,
    });
    const cls = classifyEUAIAct(signals);
    expect(cls.annexIIICategories).toContain('§5 essential services');
  });
});

describe('AAP-70 §3 education gating', () => {
  it('does NOT fire when education context present but no decisions-about-people', () => {
    const signals = makeSignals({
      isEducationAssessmentContext: true,
      hasDecisionsAboutPeople: false,
    });
    const cls = classifyEUAIAct(signals);
    expect(cls.annexIIICategories.some((c) => c.includes('education'))).toBe(false);
  });

  it('FIRES on education context + decisions-about-people', () => {
    const signals = makeSignals({
      isEducationAssessmentContext: true,
      hasDecisionsAboutPeople: true,
      decisionImpact: 'medium',
    });
    const cls = classifyEUAIAct(signals);
    expect(cls.annexIIICategories).toContain('§3 education');
  });
});

describe('AAP-70 §4 employment gating (unchanged — regression guard)', () => {
  it('still FIRES on hasEmploymentDecisions + decisionImpact=high', () => {
    const signals = makeSignals({
      hasEmploymentDecisions: true,
      decisionImpact: 'high',
      hasDecisionsAboutPeople: true,
    });
    const cls = classifyEUAIAct(signals);
    expect(cls.annexIIICategories).toContain('§4 employment');
  });

  it('still NOT fire on hasEmploymentDecisions + decisionImpact=none', () => {
    const signals = makeSignals({
      hasEmploymentDecisions: true,
      decisionImpact: 'none',
    });
    const cls = classifyEUAIAct(signals);
    expect(cls.annexIIICategories.some((c) => c.includes('employment'))).toBe(false);
  });
});

describe('AAP-70 combined: Claude Code self-audit fingerprint', () => {
  // The repro from sess-20260521-114750-1bb141: bio+law+essential all
  // detected but hasDecisionsAboutPeople=false. Pre-fix classified as
  // high-risk §6. Post-fix must return limited.
  it('Claude Code self-audit signal shape → limited', () => {
    const signals = makeSignals({
      hasBiometricSignal: true,
      isLawEnforcementContext: true,
      hasEssentialServicesSignal: true,
      hasSensitivePII: false,
      hasDecisionsAboutPeople: false,
      decisionImpact: 'none',
    });
    const cls = classifyEUAIAct(signals);
    expect(cls.classification).toBe('limited');
    expect(cls.annexIIICategories).toEqual([]);
  });
});
