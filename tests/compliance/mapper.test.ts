import { describe, it, expect } from 'vitest';
import {
  mapFindingsToRiskCategories,
  detectSignals,
  classifyDecisionImpact,
  classifyEUAIAct,
  type MapperInput,
} from '../../src/compliance/mapper.js';
import { MAPPING_VERSION } from '../../src/compliance/types.js';
import { CONTROL_MAPPINGS } from '../../src/compliance/control-mappings.js';
import {
  FRAMEWORKS,
  listMandatoryFrameworks,
  listVoluntaryFrameworks,
  frameworksFor,
} from '../../src/compliance/frameworks.js';
import type { SystemAssessment, QAPair } from '../../src/report/types.js';

const baseSystem = (over: Partial<SystemAssessment> = {}): SystemAssessment => ({
  systemId: 'Acme CRM, REST API via OAuth2',
  scopesRequested: ['crm.read', 'crm.write'],
  scopesNeeded: ['crm.read'],
  scopesDelta: ['crm.write'],
  dataSensitivity: 'PII — customer names and emails',
  blastRadius: 'org-wide',
  frequencyAndVolume: '~100/day',
  writeOperations: [
    {
      operation: 'Update contact',
      target: 'contacts',
      reversible: false,
      approvalRequired: false,
      volumePerDay: '~100/day',
    },
  ],
  ...over,
});

const tx = (answers: string[]): QAPair[] =>
  answers.map((a, i) => ({ question: `Q${i}`, answer: a, category: 'data' }));

// ─── Registry shape ─────────────────────────────────────────────────────────

describe('frameworks registry (NIST AI RMF restored)', () => {
  it('contains exactly the 5 v1 frameworks', () => {
    const ids = Object.keys(FRAMEWORKS).sort();
    expect(ids).toEqual(['aiuc-1', 'eu-ai-act', 'gdpr', 'iso-42001', 'nist-ai-rmf']);
  });

  it('uses Jurisdiction[] for mandatoriness', () => {
    for (const f of Object.values(FRAMEWORKS)) {
      expect(Array.isArray(f.mandatoryIn)).toBe(true);
    }
    expect(FRAMEWORKS['eu-ai-act'].mandatoryIn).toContain('EU');
    expect(FRAMEWORKS.gdpr.mandatoryIn).toContain('EU');
    expect(FRAMEWORKS['iso-42001'].mandatoryIn).toEqual([]);
    expect(FRAMEWORKS['aiuc-1'].mandatoryIn).toEqual([]);
    expect(FRAMEWORKS['nist-ai-rmf'].mandatoryIn).toEqual([]);
  });

  it('partitions cleanly into mandatory + voluntary', () => {
    const m = listMandatoryFrameworks().map((f) => f.id);
    const v = listVoluntaryFrameworks().map((f) => f.id).sort();
    expect(m).toEqual(expect.arrayContaining(['eu-ai-act', 'gdpr']));
    expect(v).toEqual(['aiuc-1', 'iso-42001', 'nist-ai-rmf']);
    for (const id of m) expect(v).not.toContain(id);
  });

  it('frameworksFor(EU) includes EU AI Act and GDPR', () => {
    const eu = frameworksFor('EU').map((f) => f.id);
    expect(eu).toContain('eu-ai-act');
    expect(eu).toContain('gdpr');
  });

  it('every framework has a primarySource URL', () => {
    for (const [id, f] of Object.entries(FRAMEWORKS)) {
      expect(f.primarySource, `framework ${id}`).toBeTruthy();
      expect(f.primarySource, `framework ${id}`).toMatch(/^https?:\/\//);
    }
  });
});

// ─── AIUC-1 registration (AAP-44) ───────────────────────────────────────────

describe('AIUC-1 registration (AAP-44)', () => {
  it('is present and voluntary', () => {
    expect(FRAMEWORKS).toHaveProperty('aiuc-1');
    const f = FRAMEWORKS['aiuc-1'];
    expect(f.tier).toBe('voluntary');
    expect(f.mandatoryIn).toEqual([]);
    expect(f.primarySource).toBe('https://www.aiuc-1.com/');
  });

  it('has Q2-2026 scopeNote', () => {
    const f = FRAMEWORKS['aiuc-1'];
    expect(f.scopeNote).toBeTruthy();
    expect(f.scopeNote).toMatch(/Q2-2026|2026-04-15/);
  });

  it('is listed in listVoluntaryFrameworks()', () => {
    const ids = listVoluntaryFrameworks().map((f) => f.id);
    expect(ids).toContain('aiuc-1');
  });

  it('control-mappings reference AIUC-1 in 4 finding-types, all 6 domains covered', () => {
    const aiuc1Controls: string[] = [];
    for (const [findingType, mapping] of Object.entries(CONTROL_MAPPINGS)) {
      for (const ctrl of mapping.controls) {
        if (ctrl.frameworkId === 'aiuc-1') {
          aiuc1Controls.push(`${findingType}/${ctrl.controlId}`);
        }
      }
    }
    // 16 controls total across 4 finding-types
    expect(aiuc1Controls.length).toBe(16);

    // All 6 AIUC-1 domains represented (A, B, C, D, E, F)
    const domains = new Set<string>();
    for (const entry of aiuc1Controls) {
      const controlId = entry.split('/')[1];
      domains.add(controlId.charAt(0));
    }
    expect(domains).toEqual(new Set(['A', 'B', 'C', 'D', 'E', 'F']));
  });
});

// ─── NIST AI RMF restoration ────────────────────────────────────────────────

describe('NIST AI RMF registration', () => {
  it('is present and voluntary', () => {
    expect(FRAMEWORKS).toHaveProperty('nist-ai-rmf');
    const f = FRAMEWORKS['nist-ai-rmf'];
    expect(f.tier).toBe('voluntary');
    expect(f.mandatoryIn).toEqual([]);
    expect(f.primarySource).toBe('https://www.nist.gov/itl/ai-risk-management-framework');
  });

  it('is listed in listVoluntaryFrameworks()', () => {
    const ids = listVoluntaryFrameworks().map((f) => f.id);
    expect(ids).toContain('nist-ai-rmf');
  });

  it('control-mappings reference NIST AI RMF across all 4 functions', () => {
    const nistControls: string[] = [];
    for (const mapping of Object.values(CONTROL_MAPPINGS)) {
      for (const ctrl of mapping.controls) {
        if (ctrl.frameworkId === 'nist-ai-rmf') nistControls.push(ctrl.controlId);
      }
    }
    // At least one control per NIST function (GOVERN / MAP / MEASURE / MANAGE)
    const functions = new Set<string>();
    for (const id of nistControls) functions.add(id.split(' ')[0]);
    expect(functions).toEqual(new Set(['GOVERN', 'MAP', 'MEASURE', 'MANAGE']));
    // Spot-check: referenced on excessive-access finding (least-privilege anchor)
    const excessiveAccess = CONTROL_MAPPINGS['excessive-access'].controls;
    expect(excessiveAccess.some((c) => c.frameworkId === 'nist-ai-rmf')).toBe(true);
  });
});

// ─── Deprecated frameworks fully removed ────────────────────────────────────

describe('Removed frameworks (AAP-42 scope cut; NIST since restored)', () => {
  const removed = [
    'uk-gdpr-dpa-2018',
    'colorado-ai-act',
    'hipaa',
    'ccpa-cpra',
    'iso-23894',
    'soc-2',
    'eu-ai-act-high-risk',
    'nyc-ll144',
    'ico-ai-toolkit',
  ];

  for (const id of removed) {
    it(`registry does not contain ${id}`, () => {
      expect(FRAMEWORKS).not.toHaveProperty(id);
    });
    it(`no CONTROL_MAPPINGS reference ${id}`, () => {
      for (const mapping of Object.values(CONTROL_MAPPINGS)) {
        const ids = mapping.controls.map((c) => c.frameworkId);
        expect(ids).not.toContain(id);
      }
    });
  }
});

// ─── control-mappings shape ─────────────────────────────────────────────────

describe('control-mappings table', () => {
  it('covers every finding type', () => {
    const types = Object.keys(CONTROL_MAPPINGS);
    expect(types).toContain('excessive-access');
    expect(types).toContain('write-risk');
    expect(types).toContain('sensitive-data');
    expect(types).toContain('scope-creep');
    expect(types).toContain('regulatory-flags');
    expect(types).toContain('risk-score');
    expect(types).toContain('decisions-about-people');
  });

  it('only references registered frameworks', () => {
    const ids = new Set(Object.keys(FRAMEWORKS));
    for (const m of Object.values(CONTROL_MAPPINGS)) {
      for (const c of m.controls) {
        expect(ids.has(c.frameworkId)).toBe(true);
      }
    }
  });

  it('sensitive-data activates EU AI Act, GDPR, ISO 42001', () => {
    const ids = CONTROL_MAPPINGS['sensitive-data'].controls.map((c) => c.frameworkId);
    expect(ids).toContain('eu-ai-act');
    expect(ids).toContain('gdpr');
    expect(ids).toContain('iso-42001');
  });

  it('decisions-about-people activates EU AI Act (base + annexIII) and GDPR', () => {
    const ctrls = CONTROL_MAPPINGS['decisions-about-people'].controls;
    const ids = ctrls.map((c) => c.frameworkId);
    expect(ids).toContain('eu-ai-act');
    expect(ids).toContain('gdpr');
    // Some EU AI Act controls are Annex III-gated (only fire on high-risk)
    expect(ctrls.some((c) => c.frameworkId === 'eu-ai-act' && c.annexIII === true)).toBe(true);
    // Some are baseline (always fire)
    expect(ctrls.some((c) => c.frameworkId === 'eu-ai-act' && !c.annexIII)).toBe(true);
  });

  it('every FrameworkControl has a non-empty note', () => {
    for (const [findingType, mapping] of Object.entries(CONTROL_MAPPINGS)) {
      for (const ctrl of mapping.controls) {
        expect(ctrl.note, `${findingType} / ${ctrl.frameworkId} / ${ctrl.controlId}`).toBeTruthy();
      }
    }
  });
});

// ─── mapFindingsToRiskCategories ────────────────────────────────────────────

describe('mapFindingsToRiskCategories', () => {
  it('produces mandatory + voluntary buckets with 4 categories each', () => {
    const r = mapFindingsToRiskCategories({
      systems: [baseSystem()],
      transcript: tx(['We process customer name and email PII via API']),
    });
    for (const bucket of [r.mandatory, r.voluntary]) {
      expect(bucket).toHaveProperty('privacy');
      expect(bucket).toHaveProperty('ip');
      expect(bucket).toHaveProperty('consumer-protection');
      expect(bucket).toHaveProperty('sector-specific');
    }
  });

  it('every flag carries a description with framework name', () => {
    const r = mapFindingsToRiskCategories({
      systems: [baseSystem()],
      transcript: tx(['name email pii via api']),
    });
    expect(r.all.length).toBeGreaterThan(0);
    for (const f of r.all) {
      expect(f.description.length).toBeGreaterThan(20);
    }
  });

  it('attaches euAiActClassification to every audit output', () => {
    const r = mapFindingsToRiskCategories({
      systems: [baseSystem()],
      transcript: tx(['name email PII']),
    });
    expect(r.euAiActClassification).toBeDefined();
    expect(['prohibited', 'high-risk', 'limited', 'minimal', 'unclassified'])
      .toContain(r.euAiActClassification.classification);
  });
});

// ─── Decision impact classifier ─────────────────────────────────────────────

describe('classifyDecisionImpact', () => {
  it('returns none when not deciding', () => {
    expect(classifyDecisionImpact(false)).toBe('none');
  });
  it('returns unclear without details', () => {
    expect(classifyDecisionImpact(true)).toBe('unclear');
  });
  it('detects high-impact employment', () => {
    expect(
      classifyDecisionImpact(true, 'we screen candidate resumes for hiring decisions'),
    ).toBe('high');
  });
  it('detects medium-impact scoring', () => {
    expect(
      classifyDecisionImpact(true, 'we score and rank leads for sales outreach campaigns'),
    ).toBe('medium');
  });
});

describe('detectSignals', () => {
  it('flags employment-related decisions', () => {
    const s = detectSignals(
      [],
      tx(['screening applicants']),
      true,
      'We screen candidates and recommend hiring decisions',
    );
    expect(s.hasEmploymentDecisions).toBe(true);
    expect(s.decisionImpact).toBe('high');
  });

  describe('hasBiometricSignal (Annex III §1)', () => {
    it('fires on facial recognition', () => {
      expect(detectSignals([], tx(['facial recognition matching']), false).hasBiometricSignal).toBe(true);
    });
    it('fires on voiceprint', () => {
      expect(detectSignals([], tx(['voiceprint analysis']), false).hasBiometricSignal).toBe(true);
    });
    it('does not fire on generic biometrics-adjacent language', () => {
      expect(detectSignals([], tx(['user photo upload']), false).hasBiometricSignal).toBe(false);
    });
  });

  describe('isEducationAssessmentContext (Annex III §3)', () => {
    it('fires on grading', () => {
      expect(detectSignals([], tx([]), true, 'automated grading of student submissions').isEducationAssessmentContext).toBe(true);
    });
    it('fires on admission decisions', () => {
      expect(detectSignals([], tx([]), true, 'university admission decisions').isEducationAssessmentContext).toBe(true);
    });
  });

  describe('isLawEnforcementContext (Annex III §6)', () => {
    it('fires on police/law enforcement', () => {
      expect(detectSignals([], tx(['law enforcement investigations']), true, 'crime prediction').isLawEnforcementContext).toBe(true);
    });
    it('fires on parole/sentencing', () => {
      expect(detectSignals([], tx([]), true, 'parole recommendations').isLawEnforcementContext).toBe(true);
    });
  });

  describe('hasEssentialServicesSignal (Annex III §5)', () => {
    it('fires on credit scoring', () => {
      expect(detectSignals([], tx([]), true, 'credit scoring for loan applicants').hasEssentialServicesSignal).toBe(true);
    });
    it('fires on public benefits eligibility', () => {
      expect(detectSignals([], tx(['welfare benefit eligibility determination']), true).hasEssentialServicesSignal).toBe(true);
    });
    it('does not fire on generic org decisions', () => {
      expect(detectSignals([], tx(['internal workforce planning decisions']), true).hasEssentialServicesSignal).toBe(false);
    });
  });
});

describe('hasEmploymentDecisions — plural/gerund matching', () => {
  it('matches "hiring" (gerund)', () => {
    expect(detectSignals([], tx([]), true, 'hiring decisions').hasEmploymentDecisions).toBe(true);
  });
  it('matches "candidates" (plural)', () => {
    expect(detectSignals([], tx(['screen candidates for positions']), true, 'applicants').hasEmploymentDecisions).toBe(true);
  });
  it('matches "applicants" and "resumes"', () => {
    expect(detectSignals([], tx([]), true, 'review applicants and resumes').hasEmploymentDecisions).toBe(true);
  });
  it('matches "recruiting/recruiter"', () => {
    expect(detectSignals([], tx(['our recruiter uses this']), true, 'recruiting').hasEmploymentDecisions).toBe(true);
  });
});

// ─── EU AI Act classification (replaces former two-entry split) ─────────────

describe('classifyEUAIAct', () => {
  const baseSignals = () =>
    detectSignals([], tx([]), false);

  it('defaults to limited-risk when no Annex III signals match', () => {
    const s = detectSignals([], tx(['name email PII for sales outreach']), false);
    const cls = classifyEUAIAct(s);
    expect(cls.classification).toBe('limited');
    expect(cls.annexIIICategories).toEqual([]);
  });

  it('classifies high-risk with §1 category when biometric + sensitive PII + decisions-about-people detected', () => {
    // AAP-70: §1 now requires hasDecisionsAboutPeople in addition to
    // biometric+sensitivePII. Biometric ID without automated decisions
    // about natural persons is not Annex III §1 high-risk by itself.
    const s = detectSignals(
      [],
      tx(['facial recognition with ssn government id used to deny access to applicants']),
      true,
      'The agent performs biometric identification to reject applicants from secure facilities.',
    );
    const cls = classifyEUAIAct(s);
    expect(cls.classification).toBe('high-risk');
    expect(cls.annexIIICategories.some((c) => c.includes('§1'))).toBe(true);
  });

  it('classifies high-risk with §4 category for employment decisions', () => {
    const s = detectSignals(
      [],
      tx([]),
      true,
      'screen candidates for hiring',
    );
    const cls = classifyEUAIAct(s);
    expect(cls.classification).toBe('high-risk');
    expect(cls.annexIIICategories.some((c) => c.includes('§4'))).toBe(true);
  });

  it('classifies high-risk with §3 category for education assessment', () => {
    const s = detectSignals(
      [],
      tx([]),
      true,
      'student exam grading and admission decisions',
    );
    const cls = classifyEUAIAct(s);
    expect(cls.classification).toBe('high-risk');
    expect(cls.annexIIICategories.some((c) => c.includes('§3'))).toBe(true);
  });

  it('classifies high-risk with §6 category for law enforcement', () => {
    const s = detectSignals(
      [],
      tx(['police criminal investigation']),
      true,
      'predictive policing',
    );
    const cls = classifyEUAIAct(s);
    expect(cls.classification).toBe('high-risk');
    expect(cls.annexIIICategories.some((c) => c.includes('§6'))).toBe(true);
  });

  it('classifies high-risk with §5 category for essential services credit scoring', () => {
    const s = detectSignals(
      [],
      tx([]),
      true,
      'approve or deny consumer loan applications based on credit scoring',
    );
    const cls = classifyEUAIAct(s);
    expect(cls.classification).toBe('high-risk');
    expect(cls.annexIIICategories.some((c) => c.includes('§5'))).toBe(true);
  });
});

// ─── EU AI Act per-control Annex III gating ─────────────────────────────────

describe('EU AI Act single-framework entry with Annex III gating', () => {
  it('emits exactly one EU AI Act flag per finding type (not two)', () => {
    const r = mapFindingsToRiskCategories({
      systems: [baseSystem()],
      transcript: tx([]),
      makesDecisionsAboutPeople: true,
      decisionMakingDetails: 'screen candidates for hiring',
    });

    // All EU AI Act flags should share the single framework ID `eu-ai-act`
    const euFlags = r.all.filter((f) => f.frameworkId === 'eu-ai-act');
    expect(euFlags.length).toBeGreaterThan(0);

    // No flag should use the old `eu-ai-act-high-risk` ID
    expect(r.all.some((f) => (f.frameworkId as string) === 'eu-ai-act-high-risk')).toBe(false);

    // frameworksActivated contains only the single entry
    expect(r.frameworksActivated).toContain('eu-ai-act');
    expect((r.frameworksActivated as string[])).not.toContain('eu-ai-act-high-risk');
  });

  it('Annex III-tagged controls only appear when high-risk', () => {
    // High-risk audit: Annex III §4 employment
    const highRisk = mapFindingsToRiskCategories({
      systems: [baseSystem()],
      transcript: tx([]),
      makesDecisionsAboutPeople: true,
      decisionMakingDetails: 'screen candidates for hiring',
    });
    const hrControlIds = highRisk.all
      .filter((f) => f.frameworkId === 'eu-ai-act')
      .flatMap((f) => f.controlIds);
    // Should include at least one known Annex III control
    expect(hrControlIds.some((id) => /Annex III|Art\. 9$|Art\. 10$|Art\. 14$|Art\. 27/.test(id))).toBe(true);

    // Limited-risk audit: generic outreach, no Annex III signals
    const limited = mapFindingsToRiskCategories({
      systems: [baseSystem()],
      transcript: tx(['name, email PII for sales outreach']),
      makesDecisionsAboutPeople: true,
      decisionMakingDetails: 'rank leads for outreach',
    });
    const limitedControlIds = limited.all
      .filter((f) => f.frameworkId === 'eu-ai-act')
      .flatMap((f) => f.controlIds);
    // Must NOT include Annex III-only controls
    expect(limitedControlIds.includes('Art. 27')).toBe(false);
    expect(limitedControlIds.includes('Art. 43')).toBe(false);
    expect(limitedControlIds.includes('Art. 49')).toBe(false);
    // But should include baseline (e.g. Art. 50)
    expect(limitedControlIds.some((id) => /Art\. 50|Art\. 14\(4\)\(d\)|Art\. 9\(1\)/.test(id))).toBe(true);
  });

  it('each EU AI Act flag carries euAiActClassification that matches the audit-level classification', () => {
    const r = mapFindingsToRiskCategories({
      systems: [baseSystem()],
      transcript: tx([]),
      makesDecisionsAboutPeople: true,
      decisionMakingDetails: 'screen candidates for hiring',
    });
    for (const f of r.all.filter((f) => f.frameworkId === 'eu-ai-act')) {
      expect(f.euAiActClassification).toBe(r.euAiActClassification.classification);
    }
  });
});

// ─── Flag disclaimer (jurisdictional caveat) ────────────────────────────────

describe('Flag disclaimers — surviving frameworks only', () => {
  function findingWith(input: MapperInput, frameworkId: string) {
    const r = mapFindingsToRiskCategories(input);
    return r.all.find((f) => f.frameworkId === frameworkId);
  }

  it('EU AI Act flag description names EU market/output test', () => {
    const flag = findingWith({
      systems: [baseSystem()],
      transcript: tx(['name email PII']),
    }, 'eu-ai-act');
    expect(flag).toBeDefined();
    expect(flag!.description).toMatch(/EU market|outputs are used in the EU/i);
  });

  it('GDPR flag description names EU data-subject test', () => {
    const flag = findingWith({
      systems: [baseSystem()],
      transcript: tx(['name email PII']),
    }, 'gdpr');
    expect(flag).toBeDefined();
    expect(flag!.description).toMatch(/EU data subjects|EU-based behaviour/i);
  });
});

describe('Legacy removal', () => {
  it('mapper module does not export toLegacyJurisdictions', async () => {
    const m = await import('../../src/compliance/mapper.js');
    expect((m as Record<string, unknown>).toLegacyJurisdictions).toBeUndefined();
  });
});

// ─── AAP-44: AIUC-1 signal detection + per-control gating ──────────────────

describe('AIUC-1 architecture signals (AAP-44)', () => {
  it('hasMCPOrA2A fires on MCP', () => {
    const s = detectSignals([], tx(['We talk to an MCP server for tool integration']), false);
    expect(s.hasMCPOrA2A).toBe(true);
  });
  it('hasMCPOrA2A fires on A2A / agent-to-agent', () => {
    const s = detectSignals([], tx(['This agent uses A2A to talk to other agents']), false);
    expect(s.hasMCPOrA2A).toBe(true);
  });
  it('hasMCPOrA2A does not fire on generic tool talk', () => {
    const s = detectSignals([], tx(['We call a REST API to fetch data']), false);
    expect(s.hasMCPOrA2A).toBe(false);
  });

  it('hasSubAgents fires on sub-agent wording', () => {
    const s = detectSignals([], tx(['This agent spawns sub-agents for each sub-task']), false);
    expect(s.hasSubAgents).toBe(true);
  });
  it('hasSubAgents fires on chained tool calls', () => {
    const s = detectSignals([], tx(['We chain tool calls across multiple steps']), false);
    expect(s.hasSubAgents).toBe(true);
  });
  it('hasSubAgents does not fire on simple one-step tool use', () => {
    const s = detectSignals([], tx(['I call one function per request']), false);
    expect(s.hasSubAgents).toBe(false);
  });

  it('hasCrossCustomer fires on multi-customer wording', () => {
    const s = detectSignals([], tx(['One deployment serves multiple customers in a shared tenancy']), false);
    expect(s.hasCrossCustomer).toBe(true);
  });
  it('hasCrossCustomer fires on multi-tenant', () => {
    const s = detectSignals([], tx(['This is a multi-tenant deployment']), false);
    expect(s.hasCrossCustomer).toBe(true);
  });
  it('hasCrossCustomer does not fire on single-tenant wording', () => {
    const s = detectSignals([], tx(['Each customer has their own dedicated deployment']), false);
    expect(s.hasCrossCustomer).toBe(false);
  });
});

describe('AIUC-1 per-control gating (AAP-44)', () => {
  // Transcript that triggers all four AIUC-1 finding-types.
  const richTranscriptFor = (extraAnswers: string[] = []): QAPair[] =>
    tx([
      'We process customer name and email PII',
      'We write to CRM and send emails',
      ...extraAnswers,
    ]);

  it('B008.2 (MCP/A2A) is SKIPPED when no MCP signal', () => {
    const r = mapFindingsToRiskCategories({
      systems: [baseSystem()],
      transcript: richTranscriptFor([]),
    });
    const aiuc1Ids = r.all
      .filter((f) => f.frameworkId === 'aiuc-1')
      .flatMap((f) => f.controlIds);
    expect(aiuc1Ids).not.toContain('B008.2');
  });
  it('B008.2 APPEARS when MCP mentioned in transcript', () => {
    const r = mapFindingsToRiskCategories({
      systems: [baseSystem()],
      transcript: richTranscriptFor(['Yes, we talk to an MCP server with token auth']),
    });
    const aiuc1Ids = r.all
      .filter((f) => f.frameworkId === 'aiuc-1')
      .flatMap((f) => f.controlIds);
    expect(aiuc1Ids).toContain('B008.2');
  });

  it('E015.2 (sub-agent logging) is SKIPPED without sub-agents', () => {
    const r = mapFindingsToRiskCategories({
      systems: [baseSystem()],
      transcript: richTranscriptFor([]),
    });
    const aiuc1Ids = r.all
      .filter((f) => f.frameworkId === 'aiuc-1')
      .flatMap((f) => f.controlIds);
    expect(aiuc1Ids).not.toContain('E015.2');
  });
  it('E015.2 APPEARS when sub-agents mentioned', () => {
    const r = mapFindingsToRiskCategories({
      systems: [baseSystem()],
      transcript: richTranscriptFor(['This agent spawns sub-agents for research']),
    });
    const aiuc1Ids = r.all
      .filter((f) => f.frameworkId === 'aiuc-1')
      .flatMap((f) => f.controlIds);
    expect(aiuc1Ids).toContain('E015.2');
  });

  it('A005 (cross-customer) is SKIPPED for single-customer deployment', () => {
    const r = mapFindingsToRiskCategories({
      systems: [baseSystem()],
      transcript: richTranscriptFor([]),
    });
    const aiuc1Ids = r.all
      .filter((f) => f.frameworkId === 'aiuc-1')
      .flatMap((f) => f.controlIds);
    expect(aiuc1Ids).not.toContain('A005');
  });
  it('A005 APPEARS when multi-customer deployment', () => {
    const r = mapFindingsToRiskCategories({
      systems: [baseSystem()],
      transcript: richTranscriptFor(['This is a multi-tenant deployment serving multiple customers']),
    });
    const aiuc1Ids = r.all
      .filter((f) => f.frameworkId === 'aiuc-1')
      .flatMap((f) => f.controlIds);
    expect(aiuc1Ids).toContain('A005');
  });

  it('Un-gated AIUC-1 controls ALWAYS appear when their finding-type fires', () => {
    const r = mapFindingsToRiskCategories({
      systems: [baseSystem()],
      transcript: richTranscriptFor([]),
    });
    const aiuc1Ids = r.all
      .filter((f) => f.frameworkId === 'aiuc-1')
      .flatMap((f) => f.controlIds);
    // sensitive-data (no multi-tenant): A001, A002, A006 present; A005 gated
    expect(aiuc1Ids).toContain('A001');
    expect(aiuc1Ids).toContain('A002');
    expect(aiuc1Ids).toContain('A006');
    // excessive-access (no MCP): A003.3, A003.4, B007 present; B008.2 gated
    expect(aiuc1Ids).toContain('A003.3');
    expect(aiuc1Ids).toContain('A003.4');
    expect(aiuc1Ids).toContain('B007');
    // write-risk (no sub-agents): B006, D003, F001 present; E015.2 gated
    expect(aiuc1Ids).toContain('B006');
    expect(aiuc1Ids).toContain('D003');
    expect(aiuc1Ids).toContain('F001');
  });

  it('With all 3 triggers, all 16 AIUC-1 controls appear', () => {
    const r = mapFindingsToRiskCategories({
      systems: [baseSystem()],
      transcript: tx([
        'We process customer name and email PII',
        'We write to CRM',
        'We talk to an MCP server using static tokens',
        'We spawn sub-agents for each task',
        'This is a multi-tenant deployment',
      ]),
      makesDecisionsAboutPeople: true,
      decisionMakingDetails: 'We screen candidates and recommend hiring decisions',
    });
    const aiuc1Ids = new Set(
      r.all.filter((f) => f.frameworkId === 'aiuc-1').flatMap((f) => f.controlIds),
    );
    const expected = [
      'A001', 'A002', 'A005', 'A006',
      'A003.3', 'A003.4', 'B007', 'B008.2',
      'B006', 'D003', 'E015.2', 'F001',
      'C007', 'C009', 'E004', 'E016',
    ];
    for (const id of expected) {
      expect(aiuc1Ids, `missing AIUC-1 control ${id}`).toContain(id);
    }
    expect(aiuc1Ids.size).toBe(16);
  });
});
