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

    const outcome = await analyzeTranscript(mockLLM, sampleTranscript);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.result.agentPurpose).toBe('Process invoices and update CRM');
    expect(outcome.result.systems.length).toBe(2);
    // AAP-65: prose systemId ("SAP ERP, REST API via service account") is
    // reshaped by the sanitization pass into a kebab-case short identifier.
    // The full prose is preserved on `systemDescription`.
    expect(outcome.result.systems[0].systemId).toContain('sap');
    expect(outcome.result.systems[0].systemDescription).toContain('SAP ERP');
    expect(outcome.result.systems[1].blastRadius).toBe('org-wide');
    expect(outcome.result.risks.length).toBe(1);
    // AAP-63 — `overallRiskLevel` remains the analyzer's self-reported
    // risk-level output. It is NO LONGER used directly as the session's
    // `riskLevel` field — the verdict pipeline (computeVerdict) consumes
    // the underlying `risks[]` to derive `interviewRiskLevel`, while
    // Surface 2 evidence drives the primary risk badge. The analyzer
    // itself is unaffected by AAP-63; only its downstream consumers are.
    expect(outcome.result.overallRiskLevel).toBe('high');
  });

  // AAP-116 — when an AI runtime (Codex / Claude Code) DRIVES the audit, the
  // foundation-model question makes the agent self-declare its OWN runtime as
  // a system of the audited deployment ("Foundation model powering this Codex
  // session"). The analyzer must drop that driver row so it never reaches
  // report.systems → the rendered wedge claim or systems-risk posture.
  it('drops the audit driver\'s own runtime self-declared as a system', async () => {
    const driverLeakJSON = JSON.stringify({
      summary: 'Education content agent audited via a Codex-driven session.',
      agentPurpose: 'Generate and sync educational content',
      agentTrigger: 'Manual',
      systems: [
        {
          systemId: 'google-sheets',
          systemDescription: 'Google Sheets API v4 the agent reads lesson rows from.',
          scopesRequested: [],
          scopesNeeded: [],
          scopesDelta: [],
          dataSensitivity: 'Lesson content rows.',
          dataSensitivityTier: 'T1',
          blastRadius: 'single-user',
          writeOperations: [],
        },
        {
          // The audit DRIVER leaking in via the foundation-model question.
          systemId: 'openai-codex',
          systemDescription:
            'Foundation model powering this Codex session: OpenAI GPT-5-class Codex model. ' +
            'Data sent includes user prompts, prior answers, and tool responses for the task.',
          scopesRequested: [],
          scopesNeeded: [],
          scopesDelta: [],
          dataSensitivity:
            'Confidential project metadata may be included in prompts for this Codex session.',
          dataSensitivityTier: 'T1',
          blastRadius: 'single-user',
          writeOperations: [],
        },
      ],
      risks: [],
      recommendations: [],
      recommendation: 'APPROVE WITH CONDITIONS',
      overallRiskLevel: 'low',
    });

    const mockLLM: LLMClient = {
      chat: vi.fn().mockResolvedValue(driverLeakJSON),
    };

    const outcome = await analyzeTranscript(mockLLM, sampleTranscript);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const ids = outcome.result.systems.map((s) => s.systemId);
    // The driver runtime is gone; the real audited system survives.
    expect(ids).toContain('google-sheets');
    expect(ids).not.toContain('openai-codex');
    expect(outcome.result.systems).toHaveLength(1);
  });

  it('keeps an OpenAI/Codex backend the audited deployment actually calls', async () => {
    // Same systemId, but the prose describes a real backend of the audited
    // deployment (no "this Codex session" self-reference) — it must survive.
    const realBackendJSON = JSON.stringify({
      summary: 'Code-review agent that calls an OpenAI backend.',
      agentPurpose: 'Generate PR review comments',
      agentTrigger: 'New pull request',
      systems: [
        {
          systemId: 'openai-codex',
          systemDescription:
            'OpenAI Codex API the production deployment calls to draft code-review ' +
            'comments. Auth via the team OpenAI API key.',
          scopesRequested: [],
          scopesNeeded: [],
          scopesDelta: [],
          dataSensitivity: 'Source diffs and PR metadata are sent to the model.',
          dataSensitivityTier: 'T2',
          blastRadius: 'team-scope',
          writeOperations: [],
        },
      ],
      risks: [],
      recommendations: [],
      recommendation: 'APPROVE WITH CONDITIONS',
      overallRiskLevel: 'low',
    });

    const mockLLM: LLMClient = {
      chat: vi.fn().mockResolvedValue(realBackendJSON),
    };

    const outcome = await analyzeTranscript(mockLLM, sampleTranscript);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.systems.map((s) => s.systemId)).toContain('openai-codex');
  });

  it('strips markdown fences from LLM response', async () => {
    const mockLLM: LLMClient = {
      chat: vi.fn().mockResolvedValue('```json\n' + validAnalysisJSON + '\n```'),
    };

    const outcome = await analyzeTranscript(mockLLM, sampleTranscript);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.agentPurpose).toBe('Process invoices and update CRM');
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

    const outcome = await analyzeTranscript(mockLLM, sampleTranscript);
    expect(callCount).toBe(2);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.agentPurpose).toBe('Process invoices and update CRM');
  });

  // AAP-56: previously returned a "clean-looking" fake report on double parse
  // failure (LOW RISK badge, APPROVE WITH CONDITIONS, no findings). That was
  // misleading — strategy v3.0 says no verdict without verification. We now
  // return an explicit failure outcome and the caller surfaces a red banner.
  it('returns failure outcome on double parse failure (no fake clean result)', async () => {
    const mockLLM: LLMClient = {
      chat: vi.fn().mockResolvedValue('not json at all'),
    };

    const outcome = await analyzeTranscript(mockLLM, sampleTranscript);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('parse_failure');
    expect(outcome.attemptCount).toBe(2);
    expect(typeof outcome.lastErrorMessage).toBe('string');
    expect((outcome.lastErrorMessage ?? '').length).toBeGreaterThan(0);

    // Ensure NOTHING resembling a fake-clean FullAnalysisResult escapes.
    const json = JSON.stringify(outcome);
    expect(json).not.toMatch(/APPROVE WITH CONDITIONS/);
    expect(json).not.toMatch(/No risks identified/);
  });

  it('returns failure outcome when LLM throws (network / 502 / timeout)', async () => {
    const mockLLM: LLMClient = {
      chat: vi.fn().mockRejectedValue(new Error('502 status code (no body)')),
    };

    const outcome = await analyzeTranscript(mockLLM, sampleTranscript);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('llm_unreachable');
    expect(outcome.attemptCount).toBe(2);
    expect(outcome.lastErrorMessage).toContain('502');
  });

  it('returns failure outcome when LLM returns Zod-invalid structure', async () => {
    // Missing required fields → JSON parses but Zod rejects → parse_failure.
    const invalid = JSON.stringify({
      summary: 'Test',
      agentPurpose: 'Test',
      // missing: systems, risks, recommendations, overallRiskLevel
    });

    const mockLLM: LLMClient = {
      chat: vi.fn().mockResolvedValue(invalid),
    };

    const outcome = await analyzeTranscript(mockLLM, sampleTranscript);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('parse_failure');
  });

  it('derives legacy accessAssessment from per-system data', async () => {
    const mockLLM: LLMClient = {
      chat: vi.fn().mockResolvedValue(validAnalysisJSON),
    };

    const outcome = await analyzeTranscript(mockLLM, sampleTranscript);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.result.accessAssessment).toBeDefined();
    expect(outcome.result.accessAssessment.claimed.length).toBeGreaterThan(0);
    expect(outcome.result.accessAssessment.excessive.length).toBeGreaterThan(0);
    expect(outcome.result.dataNeeds.length).toBeGreaterThan(0);
  });

  it('enriches dataNeeds from systems dataSensitivity', async () => {
    const mockLLM: LLMClient = {
      chat: vi.fn().mockResolvedValue(validAnalysisJSON),
    };

    const outcome = await analyzeTranscript(mockLLM, sampleTranscript);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // AAP-65: system identifiers are now kebab-case post-sanitization.
    expect(outcome.result.dataNeeds.some(d => d.system.includes('sap'))).toBe(true);
    expect(outcome.result.dataNeeds.some(d => d.system.includes('hubspot'))).toBe(true);
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

    const outcome = await analyzeTranscript(mockLLM, sampleTranscript);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const result = outcome.result;

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

  // ── AAP-137 (B14): self-attested secrets finding → credential-exposure ──────
  //
  // The LLM types the analyzer's self-attested secrets finding ("Plain
  // workspace secrets and inactive credentials increase operational exposure",
  // renders as SLF-002) as `sensitive-data`, which maps (via CONTROL_MAPPINGS)
  // to EU Art 50(1) / GDPR Art 6 / AIUC A001 — controls that do not fit a
  // credential-hygiene gap. The analyzer post-processing must reclassify it to
  // `credential-exposure` (→ GDPR Art 32 only), the analyzer-emitted sibling of
  // AAP-132's deterministic `.env` detector fix. A genuine personal-data
  // self-attested finding must stay `sensitive-data`.
  describe('AAP-137 — self-attested secrets findingType reclassification', () => {
    const analysisWithRisk = (risk: Record<string, unknown>): string =>
      JSON.stringify({
        summary: 'Workspace agent',
        agentPurpose: 'Do work',
        agentTrigger: 'manual',
        systems: [],
        risks: [risk],
        recommendations: [],
        overallRiskLevel: 'medium',
      });

    it('retypes a sensitive-data secrets finding to credential-exposure', async () => {
      const mockLLM: LLMClient = {
        chat: vi.fn().mockResolvedValue(
          analysisWithRisk({
            severity: 'medium',
            title:
              'Plain workspace secrets and inactive credentials increase operational exposure',
            description:
              'API keys and tokens sit in plaintext .env files; inactive credentials are never rotated.',
            mitigation: 'Move secrets to a vault and rotate inactive keys.',
            findingType: 'sensitive-data',
          }),
        ),
      };

      const outcome = await analyzeTranscript(mockLLM, sampleTranscript);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      expect(outcome.result.risks.length).toBe(1);
      // Reclassified → maps to GDPR Art 32 only, NOT Art 50(1) / Art 6 / A001.
      expect(outcome.result.risks[0].findingType).toBe('credential-exposure');
      // Still self-attested — only the type changed.
      expect(outcome.result.risks[0].evidenceSource).toBe('SLF');
    });

    it('keeps a genuine personal-data finding as sensitive-data', async () => {
      const mockLLM: LLMClient = {
        chat: vi.fn().mockResolvedValue(
          analysisWithRisk({
            severity: 'high',
            title: 'Agent processes customer health records',
            description:
              'The agent reads patient names, diagnoses, and medical history from the EHR.',
            mitigation: 'Apply a lawful basis and minimise the health data accessed.',
            findingType: 'sensitive-data',
          }),
        ),
      };

      const outcome = await analyzeTranscript(mockLLM, sampleTranscript);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      expect(outcome.result.risks.length).toBe(1);
      // No secrets vocabulary → unchanged; keeps its data-protection controls.
      expect(outcome.result.risks[0].findingType).toBe('sensitive-data');
    });

    it('does NOT retype a broad-OAuth finding that mentions credentials in passing', async () => {
      // OAuth-scope findings legitimately contain the word "credentials"
      // ("OAuth user credentials with drive scope"); they are about access
      // scope, not secrets-at-rest, and must keep their LLM-chosen type.
      const mockLLM: LLMClient = {
        chat: vi.fn().mockResolvedValue(
          analysisWithRisk({
            severity: 'medium',
            title: 'Broad Google OAuth access exceeds the stated workflow',
            description:
              'OAuth user credentials grant full drive scope beyond the folder/sheet workflow.',
            mitigation: 'Narrow the OAuth scope to drive.file.',
            findingType: 'sensitive-data',
          }),
        ),
      };

      const outcome = await analyzeTranscript(mockLLM, sampleTranscript);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      expect(outcome.result.risks.length).toBe(1);
      // OAuth-scope guard wins → not retyped to credential-exposure.
      expect(outcome.result.risks[0].findingType).not.toBe('credential-exposure');
      expect(outcome.result.risks[0].findingType).toBe('sensitive-data');
    });
  });
});
