import { describe, it, expect, vi } from 'vitest';
import { analyzeTranscript } from '../../src/analysis/analyzer.js';
import type { LLMClient } from '../../src/llm/client.js';
import type { QAPair } from '../../src/report/types.js';

// AAP-109 end-to-end: a nuanced "partly reversible / no automatic rollback"
// answer must survive the analyzer as reversible:false (not flattened to true).
// Harness mirrors tests/analysis/analyzer.test.ts: a single chat() mock that
// returns the structured JSON.

const transcript: QAPair[] = [
  { question: 'What is your purpose?', answer: 'I publish lessons to Wellkid', category: 'purpose' },
  { question: 'Are those writes reversible?', answer: 'Partly; no automatic rollback', category: 'data' },
];

function buildJSON(writeOperations: unknown[]): string {
  return JSON.stringify({
    summary: 'Content pipeline agent that publishes lessons',
    agentPurpose: 'Publishes lessons to Wellkid',
    agentTrigger: 'operator starts a batch',
    systems: [
      {
        systemId: 'wellkid',
        scopesRequested: ['content.write', 'content.publish'],
        scopesNeeded: ['content.write', 'content.publish'],
        scopesDelta: [],
        dataSensitivity: 'Confidential course/platform data',
        blastRadius: 'team-scope',
        frequencyAndVolume: 'tens to ~100/run',
        writeOperations,
      },
    ],
    risks: [],
    recommendations: [],
    overallRiskLevel: 'medium',
  });
}

describe('analyzeTranscript reversibility (AAP-109)', () => {
  it('does not flatten "partly reversible / no automatic rollback" to reversible=true', async () => {
    const mockLLM: LLMClient = {
      chat: vi.fn().mockResolvedValue(buildJSON([
        {
          operation: 'bulk publish',
          target: 'Wellkid',
          reversible: true, // model wrongly says true...
          reversibilityNote: 'Partly reversible manually/API; script does not implement rollback',
        },
      ])),
    };
    const outcome = await analyzeTranscript(mockLLM, transcript);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const write = outcome.result.systems[0].writeOperations[0];
    expect(write.reversible).toBe(false);
    expect(write.reversibilityNote).toMatch(/rollback|partly|partial/i);
  });

  it('downgrades when the nuance lives only in the operation text', async () => {
    const mockLLM: LLMClient = {
      chat: vi.fn().mockResolvedValue(buildJSON([
        { operation: 'Publish article (no automatic rollback)', target: 'Wellkid', reversible: true },
      ])),
    };
    const outcome = await analyzeTranscript(mockLLM, transcript);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.systems[0].writeOperations[0].reversible).toBe(false);
  });

  it('keeps a genuinely fully-reversible write as reversible=true', async () => {
    const mockLLM: LLMClient = {
      chat: vi.fn().mockResolvedValue(buildJSON([
        {
          operation: 'create draft',
          target: 'Wellkid',
          reversible: true,
          reversibilityNote: 'Fully reversible; drafts can be deleted with one click',
        },
      ])),
    };
    const outcome = await analyzeTranscript(mockLLM, transcript);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.systems[0].writeOperations[0].reversible).toBe(true);
  });

  it('marks every wellkid write irreversible for a no-bulk-rollback answer', async () => {
    const mockLLM: LLMClient = {
      chat: vi.fn().mockResolvedValue(buildJSON([
        { operation: 'Create/reuse catalogs', target: 'Wellkid', reversible: true, reversibilityNote: 'Partly reversible; no transaction or bulk rollback workflow' },
        { operation: 'Upload files', target: 'Wellkid', reversible: true, reversibilityNote: 'Wellkid publication are not fully reversible' },
        { operation: 'Create/update metadata', target: 'Wellkid', reversible: true, reversibilityNote: 'no automatic rollback' },
      ])),
    };
    const outcome = await analyzeTranscript(mockLLM, transcript);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.systems[0].writeOperations.every((w: any) => w.reversible === false)).toBe(true);
  });
});
