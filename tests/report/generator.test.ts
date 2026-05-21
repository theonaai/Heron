import { describe, it, expect } from 'vitest';
import { renderMarkdownReport } from '../../src/report/templates.js';
import { mapFindingsToRiskCategories } from '../../src/compliance/mapper.js';
import type { AuditReport, SystemAssessment } from '../../src/report/types.js';

const sampleSystem: SystemAssessment = {
  systemId: 'HubSpot CRM, REST API via OAuth2',
  scopesRequested: ['crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.objects.deals.read', 'crm.objects.deals.write'],
  scopesNeeded: ['crm.objects.contacts.read', 'crm.objects.deals.read'],
  scopesDelta: ['crm.objects.contacts.write', 'crm.objects.deals.write'],
  dataSensitivity: 'PII — customer names, email addresses, phone numbers',
  blastRadius: 'org-wide',
  frequencyAndVolume: '~150 CRM updates/day, batch of 1',
  writeOperations: [
    {
      operation: 'Update invoice status',
      target: 'Invoice records in CRM',
      reversible: true,
      approvalRequired: false,
      volumePerDay: '~150/day',
    },
  ],
};

const sampleReport: AuditReport = {
  summary: 'The agent processes invoices with excessive access to production systems.',
  agentPurpose: 'Invoice processing and CRM updates',
  agentTrigger: 'New invoice arrives in S3 bucket',
  agentOwner: 'Finance Operations team',
  systems: [sampleSystem],
  dataNeeds: [
    { dataType: 'Invoices', system: 'SAP', justification: 'Read for processing' },
  ],
  accessAssessment: {
    claimed: [
      { resource: 'HubSpot CRM', accessLevel: 'crm.objects.contacts.write', justification: 'Requested by agent' },
    ],
    actuallyNeeded: [
      { resource: 'HubSpot CRM', accessLevel: 'crm.objects.contacts.read', justification: 'Minimum needed' },
    ],
    excessive: [
      { resource: 'HubSpot CRM', accessLevel: 'crm.objects.contacts.write', justification: 'Write not needed' },
    ],
    missing: [],
  },
  risks: [
    {
      severity: 'high',
      title: 'Excessive CRM write access',
      description: 'Agent has write access to all CRM objects',
      mitigation: 'Restrict to read-only for contacts',
    },
    {
      severity: 'medium',
      title: 'Broad ERP read',
      description: 'Agent reads all SAP modules, only needs POs',
    },
  ],
  recommendations: [
    'Restrict HubSpot to read-only for contacts and deals',
    'Limit SAP access to PO module only',
  ],
  recommendation: 'APPROVE WITH CONDITIONS',
  overallRiskLevel: 'high',
  transcript: [
    { question: 'What is your purpose?', answer: 'I process invoices', category: 'purpose' },
  ],
  metadata: {
    date: '2026-03-30',
    target: 'http://localhost:4444',
    interviewDuration: 30000,
    questionsAsked: 9,
  },
};

describe('report templates', () => {
  it('generates valid markdown with all sections', () => {
    const md = renderMarkdownReport(sampleReport);

    expect(md).toContain('# Agent Access Audit Report');
    expect(md).toContain('## Executive Summary');
    expect(md).toContain('## Agent Profile');
    expect(md).toContain('## Systems & Access');
    expect(md).toContain('## Findings');
    expect(md).toContain('## Verdict & Recommendations');
    expect(md).toContain('## Interview Transcript');
  });

  it('includes risk level in header', () => {
    const md = renderMarkdownReport(sampleReport);
    expect(md).toContain('HIGH');
  });

  it('renders per-system cards with scopes', () => {
    const md = renderMarkdownReport(sampleReport);
    expect(md).toContain('### HubSpot CRM, REST API via OAuth2');
    expect(md).toContain('crm.objects.contacts.read');
    expect(md).toContain('crm.objects.contacts.write');
  });

  it('renders blast radius per system', () => {
    const md = renderMarkdownReport(sampleReport);
    expect(md).toContain('org-wide');
  });

  it('renders data sensitivity per system', () => {
    const md = renderMarkdownReport(sampleReport);
    expect(md).toContain('PII');
  });

  it('renders write operations in system card', () => {
    const md = renderMarkdownReport(sampleReport);
    expect(md).toContain('Update invoice status');
    expect(md).toContain('reversible');
  });

  it('renders permissions delta in verdict', () => {
    const md = renderMarkdownReport(sampleReport);
    expect(md).toContain('Excessive');
    expect(md).toContain('crm.objects.contacts.write');
  });

  it('renders recommendation verdict', () => {
    const md = renderMarkdownReport(sampleReport);
    expect(md).toContain('APPROVE WITH CONDITIONS');
  });

  it('renders risks sorted by severity', () => {
    const md = renderMarkdownReport(sampleReport);
    const highPos = md.indexOf('HIGH');
    const mediumPos = md.indexOf('MEDIUM');
    // HIGH should appear in the risk section before MEDIUM
    expect(highPos).toBeLessThan(mediumPos);
  });

  it('renders agent profile with trigger and owner', () => {
    const md = renderMarkdownReport(sampleReport);
    expect(md).toContain('New invoice arrives in S3 bucket');
    expect(md).toContain('Finance Operations team');
  });

  it('includes self-report disclaimer in footer', () => {
    const md = renderMarkdownReport(sampleReport);
    expect(md).toContain('self-report');
    expect(md).toContain('compliance certification');
  });

  it('includes Heron attribution in footer', () => {
    const md = renderMarkdownReport(sampleReport);
    expect(md).toContain('Heron');
    expect(md).toContain('github.com/theonaai/Heron');
  });

  it('handles empty systems gracefully', () => {
    const emptyReport: AuditReport = {
      ...sampleReport,
      systems: [],
    };
    const md = renderMarkdownReport(emptyReport);
    expect(md).toContain('No systems were identified');
  });

  it('handles empty write operations in system card', () => {
    const noWritesReport: AuditReport = {
      ...sampleReport,
      systems: [{
        ...sampleSystem,
        writeOperations: [],
      }],
    };
    const md = renderMarkdownReport(noWritesReport);
    // System card should still render without writes line
    expect(md).toContain('### HubSpot CRM');
    expect(md).not.toContain('**Writes**');
  });

  it('renders data quality badge when provided', () => {
    const reportWithDQ: AuditReport = {
      ...sampleReport,
      dataQuality: {
        score: 71,
        uniqueAnswers: 8,
        totalQuestions: 9,
        fieldsProvided: ['systemId', 'scopesRequested', 'writeOperations'],
        fieldsMissing: ['blastRadius', 'reversibility'],
        repeatedAnswers: 1,
      },
    };
    const md = renderMarkdownReport(reportWithDQ);
    expect(md).toContain('Data Quality');
    expect(md).toContain('71/100');
    expect(md).toContain('systemId');
    expect(md).toContain('NOT PROVIDED');
  });
});

// ─── AAP-31: AuditReport.compliance shape assertions ────────────────────────

describe('AuditReport shape — AAP-31 StructuredCompliance', () => {
  const compliance = mapFindingsToRiskCategories({
    systems: [sampleSystem],
    transcript: [{ question: 'What is your purpose?', answer: 'I process invoices', category: 'purpose' }],
    makesDecisionsAboutPeople: false,
  });

  const reportWithCompliance: AuditReport = {
    ...sampleReport,
    compliance,
  };

  it('report.compliance exists and has mandatory/voluntary/all/mappingVersion', () => {
    expect(reportWithCompliance.compliance).toBeDefined();
    expect(reportWithCompliance.compliance!.mandatory).toBeDefined();
    expect(reportWithCompliance.compliance!.voluntary).toBeDefined();
    expect(Array.isArray(reportWithCompliance.compliance!.all)).toBe(true);
    expect(typeof reportWithCompliance.compliance!.mappingVersion).toBe('string');
  });

  it('report does NOT carry the legacy {eu, us, uk} regulatory field', () => {
    // AAP-31: the old jurisdictional shape is gone. AAP-69: `regulatoryCompliance`
    // is now intentionally populated as a writer-side alias of `compliance`,
    // so it is NOT checked for absence here.
    expect((reportWithCompliance as Record<string, unknown>).regulatory).toBeUndefined();
  });

  it('templates render compliance section when compliance is provided', () => {
    const md = renderMarkdownReport(reportWithCompliance);
    expect(md).toContain('## Regulatory Compliance');
    expect(md).toContain('Mandatory Law');
    expect(md).toContain('Voluntary Frameworks');
    // AAP-31: Jurisdictional Appendix removed in favour of Methodology + tiered structure
    expect(md).not.toContain('Jurisdictional Appendix');
  });

  it('compliance.all items have mandatoryIn array for jurisdictional filtering', () => {
    for (const flag of reportWithCompliance.compliance!.all) {
      expect(Array.isArray(flag.mandatoryIn)).toBe(true);
    }
  });
});
