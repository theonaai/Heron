import { describe, it, expect } from 'vitest';
import { MAPPING_VERSION } from '../../src/compliance/types.js';
import { renderStructuredCompliance } from '../../src/report/templates.js';
import type { StructuredCompliance } from '../../src/report/types.js';

const gdprFlag = {
  framework: 'GDPR',
  severity: 'action-required' as const,
  description: 'Personal data processed without explicit consent basis.',
  controlIds: ['Art. 6', 'Art. 13'],
  category: 'privacy' as const,
  tier: 'mandatory' as const,
  mandatoryIn: ['EU'],
  frameworkId: 'gdpr',
  triggeredBy: 'sensitive-data',
};

const iso42001Flag = {
  framework: 'ISO/IEC 42001',
  severity: 'warning' as const,
  description: 'Sensitive data handling procedures not documented in AIMS.',
  controlIds: ['A.7.4', 'A.7.5'],
  category: 'privacy' as const,
  tier: 'voluntary' as const,
  mandatoryIn: [] as string[],
  frameworkId: 'iso-42001',
  triggeredBy: 'sensitive-data',
};

const fakeCompliance: StructuredCompliance = {
  mappingVersion: MAPPING_VERSION,
  mandatory: {
    privacy: [gdprFlag],
    ip: [],
    'consumer-protection': [],
    'sector-specific': [],
  },
  voluntary: {
    privacy: [iso42001Flag],
    ip: [],
    'consumer-protection': [],
    'sector-specific': [],
  },
  frameworksActivated: ['gdpr', 'iso-42001'],
  all: [gdprFlag, iso42001Flag],
  euAiActClassification: { classification: 'limited', annexIIICategories: [] },
} as StructuredCompliance;

const emptyCompliance: StructuredCompliance = {
  mappingVersion: MAPPING_VERSION,
  mandatory: {
    privacy: [],
    ip: [],
    'consumer-protection': [],
    'sector-specific': [],
  },
  voluntary: {
    privacy: [],
    ip: [],
    'consumer-protection': [],
    'sector-specific': [],
  },
  frameworksActivated: [],
  all: [],
  euAiActClassification: { classification: 'limited', annexIIICategories: [] },
} as StructuredCompliance;

describe('Template — structured compliance (AAP-42 scope)', () => {
  it('contains Methodology section', () => {
    const md = renderStructuredCompliance(fakeCompliance);
    expect(md).toMatch(/## Regulatory Compliance[\s\S]*### Methodology/);
  });

  it('contains finding-first Compliance Detail section', () => {
    const md = renderStructuredCompliance(fakeCompliance);
    expect(md).toMatch(/### Compliance Detail/);
    expect(md).toMatch(/#### (Excessive permissions|Data handling|Write operation risks|Automated decision-making)/);
  });

  it('shows Affects line with grouped framework controls', () => {
    const md = renderStructuredCompliance(fakeCompliance);
    expect(md).toContain('**Affects:**');
    expect(md).toMatch(/GDPR|EU AI Act|ISO 42001/);
  });

  it('does NOT contain Jurisdictional Appendix or EU/US/UK H3s', () => {
    const md = renderStructuredCompliance(fakeCompliance);
    expect(md).not.toMatch(/Jurisdictional Appendix/i);
    expect(md).not.toMatch(/^### EU\s*$/m);
    expect(md).not.toMatch(/^### US\s*$/m);
    expect(md).not.toMatch(/^### UK\s*$/m);
  });

  it('Methodology includes MAPPING_VERSION', () => {
    const md = renderStructuredCompliance(fakeCompliance);
    expect(md).toContain(MAPPING_VERSION);
  });

  it('references framework controls in Affects line (indicative note in Methodology only)', () => {
    const md = renderStructuredCompliance(fakeCompliance);
    expect(md).toMatch(/GDPR \(Art\. 6/);
    expect(md).toContain('Control mappings are indicative');
  });

  it('renders Applicability Summary table with mandatory and voluntary sections', () => {
    const md = renderStructuredCompliance(fakeCompliance);
    expect(md).toContain('### Applicability Summary');
    expect(md).toContain('| Framework | Status | Gaps Found |');
    expect(md).toContain('**Mandatory Law**');
    expect(md).toContain('**Voluntary Frameworks**');
  });

  it('emits fallback text when no compliance gaps exist', () => {
    const md = renderStructuredCompliance(emptyCompliance);
    expect(md).toMatch(/No compliance gaps identified/);
  });

  it('GDPR name appears in Affects line', () => {
    const md = renderStructuredCompliance(fakeCompliance);
    expect(md).toContain('GDPR');
  });

  it('ISO 42001 appears in Affects line or summary table', () => {
    const md = renderStructuredCompliance(fakeCompliance);
    expect(md).toContain('ISO 42001');
  });
});

describe('Template — EU AI Act single-entry with classification scope', () => {
  const highRiskCompliance: StructuredCompliance = {
    ...fakeCompliance,
    frameworksActivated: ['eu-ai-act', 'gdpr', 'iso-42001'],
    euAiActClassification: {
      classification: 'high-risk',
      annexIIICategories: ['§4 employment'],
    },
  } as StructuredCompliance;

  it('renders EU AI Act as a single row with High-Risk classification label', () => {
    const md = renderStructuredCompliance(highRiskCompliance);
    expect(md).toMatch(/EU AI Act — High-Risk \(Annex III §4 employment\)/);
    // Must NOT emit two separate rows for base + high-risk
    expect(md).not.toMatch(/EU AI Act — High-Risk \(Annex III\).*\n.*EU AI Act/);
  });

  it('renders limited-risk with Art. 50 transparency label', () => {
    const limitedCompliance: StructuredCompliance = {
      ...fakeCompliance,
      frameworksActivated: ['eu-ai-act', 'gdpr'],
      euAiActClassification: { classification: 'limited', annexIIICategories: [] },
    } as StructuredCompliance;
    const md = renderStructuredCompliance(limitedCompliance);
    expect(md).toMatch(/EU AI Act — Limited-Risk \(Art\. 50 transparency\)/);
  });
});

// ─── AAP-44: AIUC-1 rendering ───────────────────────────────────────────────

describe('Template — AIUC-1 (AAP-44)', () => {
  const aiuc1Flag = {
    framework: 'AIUC-1 — A003.4',
    severity: 'warning' as const,
    description: 'Agent holds permissions beyond stated need. Activates AIUC-1 control A003.4. Narrow scopes to the minimum required.',
    controlIds: ['A003.4'],
    category: 'privacy' as const,
    tier: 'voluntary' as const,
    mandatoryIn: [] as string[],
    frameworkId: 'aiuc-1',
    triggeredBy: 'excessive-access',
  };

  const aiuc1Compliance: StructuredCompliance = {
    mappingVersion: MAPPING_VERSION,
    mandatory: {
      privacy: [],
      ip: [],
      'consumer-protection': [],
      'sector-specific': [],
    },
    voluntary: {
      privacy: [aiuc1Flag],
      ip: [],
      'consumer-protection': [],
      'sector-specific': [],
    },
    frameworksActivated: ['aiuc-1'],
    all: [aiuc1Flag],
    euAiActClassification: { classification: 'limited', annexIIICategories: [] },
  } as StructuredCompliance;

  it('renders AIUC-1 with Q2-2026 pin in Applicability Summary voluntary section', () => {
    const md = renderStructuredCompliance(aiuc1Compliance);
    expect(md).toContain('### Applicability Summary');
    expect(md).toContain('**Voluntary Frameworks**');
    expect(md).toContain('AIUC-1 (Q2-2026)');
  });

  it('AIUC-1 appears in **Affects:** line of finding detail', () => {
    const md = renderStructuredCompliance(aiuc1Compliance);
    expect(md).toContain('**Affects:**');
    expect(md).toMatch(/AIUC-1 \(Q2-2026\)/);
  });

  it('Methodology line mentions AIUC-1 with Q2-2026 pin', () => {
    const md = renderStructuredCompliance(aiuc1Compliance);
    expect(md).toMatch(/AIUC-1.*Q2-2026/);
  });
});
