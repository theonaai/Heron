import { describe, it, expect, vi } from 'vitest';
import { analyzeTranscript } from '../../src/analysis/analyzer.js';
import type { LLMClient } from '../../src/llm/client.js';
import type { QAPair } from '../../src/report/types.js';

const sampleTranscript: QAPair[] = [
  { question: 'What is your purpose?', answer: 'I process invoices', category: 'purpose' },
  { question: 'What systems do you access?', answer: 'SAP ERP and HubSpot CRM', category: 'data' },
  { question: 'What permissions do you have?', answer: 'Full read on SAP, admin on HubSpot', category: 'access' },
];

const validAnalysisJSON = JSON.stringify({
  summary: 'Invoice processing agent with excessive access',
  agentPurpose: 'Process invoices and update CRM',
  agentTrigger: 'New invoice in S3',
  systems: [{
    systemId: 'SAP ERP, REST API via service account',
    scopesRequested: ['full-read'],
    scopesNeeded: ['po-module-read'],
    scopesDelta: ['full-read'],
    dataSensitivity: 'Financial data — invoice amounts, vendor banking details',
    blastRadius: 'team-scope',
    frequencyAndVolume: '50 lookups/day',
    writeOperations: [],
  }, {
    systemId: 'HubSpot CRM, REST API via OAuth2',
    scopesRequested: ['crm.objects.all.write'],
    scopesNeeded: ['crm.objects.invoices.write'],
    scopesDelta: ['crm.objects.contacts.write', 'crm.objects.deals.write'],
    dataSensitivity: 'PII — customer names, emails',
    blastRadius: 'org-wide',
    frequencyAndVolume: '150 updates/day',
    writeOperations: [{
      operation: 'Update invoice status',
      target: 'Invoice records',
      reversible: true,
      approvalRequired: false,
      volumePerDay: '150',
    }],
  }],
  risks: [
    { severity: 'high', title: 'Excessive CRM access', description: 'Admin access to all objects', mitigation: 'Restrict to invoices only' },
  ],
  recommendations: ['Restrict HubSpot to Invoice objects only'],
  recommendation: 'APPROVE WITH CONDITIONS',
  overallRiskLevel: 'high',
});

describe('analyzer', () => {
  it('parses valid LLM JSON response with Zod validation', async () => {
    const mockLLM: LLMClient = {
      chat: vi.fn().mockResolvedValue(validAnalysisJSON),
    };

    const result = await analyzeTranscript(mockLLM, sampleTranscript);

    expect(result.agentPurpose).toBe('Process invoices and update CRM');
    expect(result.systems.length).toBe(2);
    expect(result.systems[0].systemId).toContain('SAP');
    expect(result.systems[1].blastRadius).toBe('org-wide');
    expect(result.risks.length).toBe(1);
    expect(result.overallRiskLevel).toBe('high');
  });

  it('strips markdown fences from LLM response', async () => {
    const mockLLM: LLMClient = {
      chat: vi.fn().mockResolvedValue('```json\n' + validAnalysisJSON + '\n```'),
    };

    const result = await analyzeTranscript(mockLLM, sampleTranscript);
    expect(result.agentPurpose).toBe('Process invoices and update CRM');
  });

  it('retries on first parse failure', async () => {
    let callCount = 0;
    const mockLLM: LLMClient = {
      chat: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return 'invalid json garbage';
        return validAnalysisJSON;
      }),
    };

    const result = await analyzeTranscript(mockLLM, sampleTranscript);
    expect(callCount).toBe(2);
    expect(result.agentPurpose).toBe('Process invoices and update CRM');
  });

  it('returns partial fallback on double parse failure', async () => {
    const mockLLM: LLMClient = {
      chat: vi.fn().mockResolvedValue('not json at all'),
    };

    const result = await analyzeTranscript(mockLLM, sampleTranscript);

    expect(result.summary).toContain('analysis failed');
    expect(result.systems.length).toBe(0); // no fake systems in fallback
  });

  it('falls back when LLM returns Zod-invalid structure', async () => {
    // Missing required fields
    const invalid = JSON.stringify({
      summary: 'Test',
      agentPurpose: 'Test',
      // missing: systems, risks, recommendations, overallRiskLevel
    });

    const mockLLM: LLMClient = {
      chat: vi.fn().mockResolvedValue(invalid),
    };

    const result = await analyzeTranscript(mockLLM, sampleTranscript);
    // Should hit fallback since Zod validation fails
    expect(result.summary).toContain('analysis failed');
  });

  it('derives legacy accessAssessment from per-system data', async () => {
    const mockLLM: LLMClient = {
      chat: vi.fn().mockResolvedValue(validAnalysisJSON),
    };

    const result = await analyzeTranscript(mockLLM, sampleTranscript);

    // Should have legacy flat fields derived from systems
    expect(result.accessAssessment).toBeDefined();
    expect(result.accessAssessment.claimed.length).toBeGreaterThan(0);
    expect(result.accessAssessment.excessive.length).toBeGreaterThan(0);
    expect(result.dataNeeds.length).toBeGreaterThan(0);
  });

  it('enriches dataNeeds from systems dataSensitivity', async () => {
    const mockLLM: LLMClient = {
      chat: vi.fn().mockResolvedValue(validAnalysisJSON),
    };

    const result = await analyzeTranscript(mockLLM, sampleTranscript);

    expect(result.dataNeeds.some(d => d.system.includes('SAP'))).toBe(true);
    expect(result.dataNeeds.some(d => d.system.includes('HubSpot'))).toBe(true);
  });

  // AAP-43 post-merge regression (2026-04-25):
  // The "NOT PROVIDED" scrub used to set `arr[i] = undefined` inside
  // string-typed arrays (e.g. systems[].scopesRequested), which Zod
  // rejected with `invalid_type expected string received undefined`,
  // tipping the analyzer into the "Automated analysis failed" fallback.
  // Reproduced verbatim against copy-prod logs from sess_36ee1b23d481e4ca.
  it('compacts NOT PROVIDED out of string arrays instead of producing [undefined]', async () => {
    const llmResponse = JSON.stringify({
      summary: 'Lead-scanning agent',
      agentPurpose: 'LinkedIn ICP matcher',
      agentTrigger: 'manual',
      systems: [
        {
          systemId: 'LinkedIn (via Apify) → REST API → API key',
          // The exact shape that broke parsing on copy-prod:
          scopesRequested: ['NOT PROVIDED'],
          scopesNeeded: ['NOT PROVIDED'],
          scopesDelta: [],
          dataSensitivity: 'PII (public LinkedIn profile data)',
          blastRadius: 'single-user',
          frequencyAndVolume: '500 profiles per run',
          writeOperations: [],
        },
        {
          systemId: 'Google Sheets, REST API via OAuth2',
          scopesRequested: ['https://www.googleapis.com/auth/spreadsheets', 'NOT PROVIDED'],
          scopesNeeded: ['drive.file', 'NOT PROVIDED', 'NOT PROVIDED'],
          scopesDelta: ['spreadsheets'],
          dataSensitivity: 'PII (names, profile URLs)',
          blastRadius: 'single-user',
          frequencyAndVolume: '~100 calls per run',
          writeOperations: [],
        },
      ],
      risks: [
        { severity: 'medium', title: 'Broad scope', description: 'Google Sheets scope exceeds need', mitigation: 'Switch to drive.file' },
      ],
      recommendations: ['Narrow Google Sheets scope to drive.file'],
      recommendation: 'APPROVE WITH CONDITIONS',
      overallRiskLevel: 'medium',
    });

    const mockLLM: LLMClient = {
      chat: vi.fn().mockResolvedValue(llmResponse),
    };

    const result = await analyzeTranscript(mockLLM, sampleTranscript);

    // Must NOT fall back — analysis must succeed.
    expect(result.summary).not.toContain('analysis failed');
    expect(result.systems.length).toBe(2);

    // Pure-NOT-PROVIDED arrays compact to empty.
    expect(result.systems[0].scopesRequested).toEqual([]);
    expect(result.systems[0].scopesNeeded).toEqual([]);

    // Mixed arrays keep only the real strings.
    expect(result.systems[1].scopesRequested).toEqual([
      'https://www.googleapis.com/auth/spreadsheets',
    ]);
    expect(result.systems[1].scopesNeeded).toEqual(['drive.file']);
    expect(result.systems[1].scopesDelta).toEqual(['spreadsheets']);

    // Result must contain no `undefined` slots in any string array.
    for (const sys of result.systems) {
      for (const arr of [sys.scopesRequested, sys.scopesNeeded, sys.scopesDelta]) {
        for (const v of arr) {
          expect(typeof v).toBe('string');
        }
      }
    }
  });
});
