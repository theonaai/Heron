/**
 * AAP-92 — `interviewDuration` is non-zero on MCP-driven reports.
 *
 * Pre-AAP-92, `sampling-factory.analyzeAndRenderReport` constructed the
 * synthesised `InterviewSession` with both `startedAt` and `completedAt`
 * stamped at analyze time (`new Date()` for both). The report generator's
 * `completedAt.getTime() - startedAt.getTime()` arithmetic therefore
 * always produced 0, and every MCP-driven report rendered `Duration: 0s`
 * in the banner — even after an 11-minute audit.
 *
 * Post-AAP-92, the factory reads `meta.createdAt` from the on-disk
 * session and uses it as `startedAt`. `completedAt` stays `new Date()`
 * — the moment analysis finished, which is the right wall-clock boundary
 * for the operator-facing "interview duration" banner.
 *
 * The unit test below builds a session via `createSession()`, sleeps
 * briefly so the createdAt timestamp is observably in the past, then
 * runs the factory's `analyzeAndRenderReport` with a stubbed LLM client.
 * The assertion is `metadata.interviewDuration > 0`. The exact value
 * varies with sleep duration, so the test asserts the contract (non-zero)
 * rather than a specific magnitude.
 */

import { describe, it, expect } from 'vitest';
import { buildSamplingDeps } from '../../src/server/sampling-factory.js';
import { createSession } from '../../src/storage/sessions.js';
import type { LLMClient } from '../../src/llm/client.js';
import type { QAPair } from '../../src/report/types.js';

const STUB_ANALYZER_JSON = JSON.stringify({
  summary: 'AAP-92 duration test stub. Single low-risk system.',
  agentPurpose: 'Stub purpose for AAP-92 duration propagation test.',
  systems: [
    {
      systemId: 'duration-test-system',
      scopesRequested: ['read'],
      scopesNeeded: ['read'],
      scopesDelta: [],
      dataSensitivity: 'non-sensitive',
      blastRadius: 'single record',
      frequencyAndVolume: '1 per day, batch of 1',
      writeOperations: [],
    },
  ],
  risks: [],
  recommendations: [],
  recommendation: 'APPROVE',
  overallRiskLevel: 'low',
  makesDecisionsAboutPeople: false,
});

function stubLLMClient(): LLMClient {
  return {
    chat: async () => STUB_ANALYZER_JSON,
  };
}

describe('AAP-92 — interviewDuration is non-zero for MCP-driven reports', () => {
  it('analyzeAndRenderReport uses session.createdAt as startedAt so duration > 0', async () => {
    // Real on-disk session — tests/setup.ts points HERON_SESSIONS_DIR at
    // a per-process temp dir so this never touches the user's real
    // ~/.heron/sessions/.
    const { id: sessionId } = await createSession({ agentName: 'aap-92-duration' });

    // Sleep just long enough that the difference between createdAt and
    // `new Date()` at analyze time is observably non-zero. 25ms is small
    // enough to keep the suite fast but well above clock resolution.
    await new Promise((resolve) => setTimeout(resolve, 25));

    const { analyzeAndRenderReport } = await buildSamplingDeps({
      llmClient: stubLLMClient(),
    });

    const transcript: QAPair[] = [
      {
        question: 'What is your purpose?',
        answer: 'Process invoices, low risk.',
        category: 'purpose',
      },
    ];

    const result = await analyzeAndRenderReport({
      sessionId,
      transcript,
      agentName: 'aap-92-duration',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow for TS

    const json = result.json as { metadata: { interviewDuration: number } };
    expect(json.metadata.interviewDuration).toBeGreaterThan(0);
  });

  it('falls back to a 0 duration when the session id does not exist (storage read miss)', async () => {
    // Defensive path: the factory tolerates a missing on-disk session
    // and renders with startedAt === completedAt rather than crashing.
    // The legacy "0s" banner is preferable to an unhandled analyzer
    // exception when storage is misconfigured.
    const { analyzeAndRenderReport } = await buildSamplingDeps({
      llmClient: stubLLMClient(),
    });

    const transcript: QAPair[] = [
      {
        question: 'What is your purpose?',
        answer: 'Anything.',
        category: 'purpose',
      },
    ];

    const result = await analyzeAndRenderReport({
      sessionId: 'sess-20260101-000000-deadbe',
      transcript,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const json = result.json as { metadata: { interviewDuration: number } };
    // Either 0 (missing-session fallback) or a sub-millisecond positive
    // number from clock jitter — both are acceptable; the contract is
    // "no crash, finite number".
    expect(typeof json.metadata.interviewDuration).toBe('number');
    expect(Number.isFinite(json.metadata.interviewDuration)).toBe(true);
    expect(json.metadata.interviewDuration).toBeGreaterThanOrEqual(0);
  });
});
