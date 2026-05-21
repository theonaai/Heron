/**
 * AAP-69 — writer-side `regulatoryCompliance` alias.
 *
 * The dashboard's ReportView (`components/heron-v1/dashboard/ReportView.tsx`)
 * and the diff route (`app/api/audit/sessions/[id]/diff/route.ts`) both read
 * `regulatoryCompliance`, but the report writer historically only emitted
 * `compliance`. Result: the entire CategorizedComplianceView block never
 * rendered.
 *
 * Fix (AAP-69, minimum surface area): keep `compliance` as the canonical
 * field, AND emit a `regulatoryCompliance` alias carrying the same payload.
 * Markdown templates + CLI continue reading `compliance` and the dashboard
 * starts rendering. No rename churn, no risk to existing call sites.
 *
 * These tests pin the alias propagation through the report generator and
 * through the in-memory CLI session path so the bug cannot regress
 * silently.
 */

import { describe, it, expect } from 'vitest';
import { generateReportOutcome } from '../../src/report/generator.js';
import type { LLMClient } from '../../src/llm/client.js';
import type { InterviewSession } from '../../src/interview/interviewer.js';

/** Minimal valid analyzer JSON the LLM client stub returns. */
const STUB_ANALYZER_JSON = JSON.stringify({
  summary: 'AAP-69 alias test stub. Agent handles HR candidate data.',
  agentPurpose: 'Stub purpose for AAP-69 alias propagation test.',
  systems: [
    {
      systemId: 'greenhouse-prod',
      scopesRequested: ['applications.read', 'applications.write'],
      scopesNeeded: ['applications.read'],
      scopesDelta: ['applications.write'],
      dataSensitivity: 'PII — candidate names, emails',
      blastRadius: 'org-wide',
      frequencyAndVolume: '50 per day, batch of 1',
      writeOperations: [
        {
          operation: 'reject candidate',
          target: 'applications.stage',
          reversible: false,
          approvalRequired: false,
          volumePerDay: '50',
        },
      ],
    },
  ],
  risks: [
    {
      severity: 'high',
      title: 'Autonomous candidate rejection',
      description: 'Agent rejects candidates without human review.',
      mitigation: 'Require human approval before rejection.',
    },
  ],
  recommendations: ['Add human-in-the-loop on rejection writes.'],
  recommendation: 'DENY',
  overallRiskLevel: 'high',
  makesDecisionsAboutPeople: true,
  decisionMakingDetails: 'Rejection decisions on hiring applications.',
});

function stubLLMClient(): LLMClient {
  return {
    chat: async () => STUB_ANALYZER_JSON,
  };
}

function buildSession(): InterviewSession {
  const now = new Date('2026-05-21T09:14:14Z');
  return {
    id: 'sess-aap69-alias-test',
    transcript: [
      {
        question: 'What is your purpose?',
        answer: 'I score and reject HR candidates.',
        category: 'purpose',
      },
      {
        question: 'What scopes do you request?',
        answer: 'applications.read and applications.write.',
        category: 'access',
      },
    ],
    startedAt: now,
    completedAt: new Date(now.getTime() + 30_000),
    questionsAsked: 2,
  };
}

describe('AAP-69 — regulatoryCompliance alias', () => {
  it('generateReportOutcome populates BOTH compliance and regulatoryCompliance with identical payload', async () => {
    const outcome = await generateReportOutcome(
      buildSession(),
      stubLLMClient(),
      { target: 'aap-69-alias-test', format: 'markdown' },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return; // narrow for TS
    const json = outcome.reportJson;

    // Both keys exist on the emitted JSON.
    expect(json.compliance).toBeDefined();
    expect(json.regulatoryCompliance).toBeDefined();

    // Same object reference — guarantees there is no drift between the
    // two fields and that no extra copy or stale snapshot can sneak in.
    expect(json.regulatoryCompliance).toBe(json.compliance);

    // The CategorizedComplianceView block in ReportView keys off
    // `euAiActClassification` / `mandatory` / `voluntary` — make sure
    // those survive the alias.
    const rc = json.regulatoryCompliance as Record<string, unknown>;
    expect(rc.mandatory).toBeDefined();
    expect(rc.voluntary).toBeDefined();
    expect(rc.euAiActClassification).toBeDefined();
  });

  it('JSON.stringify of the emitted report carries the alias on the wire', async () => {
    const outcome = await generateReportOutcome(
      buildSession(),
      stubLLMClient(),
      { target: 'aap-69-alias-test', format: 'markdown' },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const serialised = JSON.stringify(outcome.reportJson);
    // The dashboard reads `json.regulatoryCompliance` from the persisted
    // report.json. If the alias is dropped on serialisation, the UI block
    // silently never renders. Pin both keys to the on-the-wire output.
    expect(serialised).toContain('"compliance"');
    expect(serialised).toContain('"regulatoryCompliance"');
  });
});
