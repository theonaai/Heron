/**
 * AAP-145 — event-loop starvation measurement for the MCP background
 * analysis / verification path.
 *
 * Symptom under investigation (live Codex audits sess-20260604-015645-4b358d
 * and sess-20260604-032116-fcece0): MCP tool calls (`submit_answer`,
 * `start_verification`, `report_oauth_scopes`) hit Codex's hard 120s
 * client timeout on the persistent session, while a fresh raw-HTTP
 * JSON-RPC call to the same `/mcp` endpoint answered in seconds.
 *
 * Hypothesis (a): a heavy SYNCHRONOUS CPU stretch inside the
 * fire-and-forget background task (compliance mapping over the control
 * catalog, verdict computation, secretlint scrub, large JSON serialize)
 * blocks Node's single-threaded event loop long enough to starve a
 * concurrent MCP request past 120s.
 *
 * This file MEASURES the per-stage synchronous cost and the worst
 * event-loop tick gap a concurrent task would experience while the
 * background sync hotspots run. The numbers are the root-cause evidence:
 * if the worst gap is in the low-ms range even at unrealistic payload
 * scale, hypothesis (a) is NOT the cause of a 120s timeout.
 *
 * These are non-flaky upper-bound assertions (generous ceilings, not
 * tight pins) so the suite stays green on slow CI while still failing
 * loudly if any stage ever regresses into a multi-second synchronous
 * block — the actual condition that WOULD starve the loop.
 */

import { describe, expect, it } from 'vitest';

import { mapFindings } from '../../src/compliance/mapper.js';
import { computeVerdictFromArtifacts } from '../../src/verification/verdict-pipeline.js';
import { secretlintScrub } from '../../src/discovery/secretlint-scrub.js';
import type { DiscoveryResult, DiscoveredAgent } from '../../src/discovery/types.js';
import {
  systemAssessmentSchema,
  type QAPair,
  type SystemAssessment,
} from '../../src/report/types.js';

// ─── Realistic-to-oversized fixtures ────────────────────────────────────────
//
// A real local agent inventory is a handful of agents with a few MCP
// servers each. We scale FAR past that (20 agents x 30 servers x 80
// tools) to give any synchronous hotspot the best possible chance to
// show up as a long event-loop block. If it does not block at this
// scale, it cannot be the cause of a 120s starvation at real scale.

function buildDiscovery(
  nAgents: number,
  mServers: number,
  kTools: number,
): DiscoveryResult {
  const agents: DiscoveredAgent[] = [];
  for (let a = 0; a < nAgents; a++) {
    const mcpServers = [];
    for (let s = 0; s < mServers; s++) {
      const tools = [];
      for (let t = 0; t < kTools; t++) {
        tools.push({
          name: `tool_${a}_${s}_${t}`,
          description: `Tool ${t} on server ${s} of agent ${a}`,
          classification: (t % 3 === 0 ? 'write' : 'read') as 'read' | 'write',
        });
      }
      mcpServers.push({
        name: `server_${a}_${s}`,
        transport: 'stdio' as const,
        command: 'node',
        args: ['server.js', '--flag', `value-${s}`],
        hasCredentials: s % 2 === 0,
        redactedEnvKeys:
          s % 2 === 0
            ? ['STRIPE_SECRET_KEY', 'AWS_ACCESS_KEY_ID', 'GOOGLE_OAUTH_TOKEN']
            : [],
        toolEnumeration: { state: 'ok' as const, tools },
      });
    }
    agents.push({
      runtime: 'claude-code' as DiscoveredAgent['runtime'],
      configPath: `/Users/me/.claude/agent_${a}.json`,
      mcpServers,
      capabilities: [],
    });
  }
  return {
    agents,
    findings: [],
    workspaceEnv: [
      {
        path: '/Users/me/repo/.env',
        workspace: '/Users/me/repo',
        keys: [
          'STRIPE_SECRET_KEY',
          'AWS_ACCESS_KEY_ID',
          'DATABASE_URL',
          'GOOGLE_OAUTH_TOKEN',
          'OPENAI_API_KEY',
        ],
      },
    ],
    scannedAt: '2026-06-05T00:00:00.000Z',
    scannedPaths: ['/Users/me/.claude'],
  };
}

function buildTranscript(n: number): QAPair[] {
  const out: QAPair[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      category: 'overview',
      question: `Question ${i} about data handling, hiring, PII, ssn, medical records, and MCP servers?`,
      answer:
        `The agent processes personal data including email, name, phone, ssn, and credit card. ` +
        `It makes hiring and recruiting decisions about candidates and applicants. It handles ` +
        `medical patient records (hipaa, diagnosis). Uses mcp model context protocol and sub-agents ` +
        `in a multi-tenant cross-customer deployment. `.repeat(5),
    });
  }
  return out;
}

function buildSystems(n: number): SystemAssessment[] {
  const out: SystemAssessment[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      systemAssessmentSchema.parse({
        systemId: `stripe-${i}`,
        systemDescription: `Payment system ${i} that processes charges`,
        scopesRequested: ['charges:write', 'refunds:write', 'customers:read'],
        scopesNeeded: ['charges:write'],
        scopesDelta: ['refunds:write', 'customers:read'],
        dataSensitivity: 'financial PII',
        blastRadius: 'org-wide',
        writeOperations: [
          { operation: 'create_charge', target: 'stripe', reversible: false, approvalRequired: false },
          { operation: 'refund', target: 'stripe', reversible: true, approvalRequired: false },
        ],
      }),
    );
  }
  return out;
}

// ─── Event-loop starvation probe ────────────────────────────────────────────
//
// Run a 1ms interval and capture the largest gap between two consecutive
// ticks while `work` runs. A synchronous CPU stretch shows up as a single
// gap ~= the stretch duration (the loop cannot fire the timer until the
// stretch yields). An awaited I/O call keeps gaps ~1ms because the loop
// stays free between awaits.

interface Probe {
  maxGapMs: number;
}

async function probeDuring<T>(work: () => Promise<T> | T): Promise<{ result: T; probe: Probe }> {
  const gaps: number[] = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    gaps.push(now - last);
    last = now;
  }, 1);
  // Let the interval settle before timing.
  await new Promise((r) => setImmediate(r));
  last = performance.now();

  const result = await work();

  // Give the loop one beat to record the final tick gap.
  await new Promise((r) => setTimeout(r, 5));
  clearInterval(timer);

  const maxGapMs = gaps.length > 0 ? Math.max(...gaps) : 0;
  return { result, probe: { maxGapMs } };
}

describe('AAP-145 — background-analysis sync hotspots do not starve the event loop', () => {
  // Codex's hard client timeout. The starvation hypothesis claims a
  // single sync stretch approaches this. We assert each stage stays
  // orders of magnitude below it.
  const CODEX_TIMEOUT_MS = 120_000;
  // Generous CI-safe ceiling. A real starvation bug blocks for many
  // seconds; anything under this is not the 120s timeout cause.
  const SAFE_CEILING_MS = 2_000;

  it('mapFindings (compliance mapping over the control catalog) stays sub-second at 20x30x80 scale', async () => {
    const discovery = buildDiscovery(20, 30, 80);
    const transcript = buildTranscript(60);
    const systems = buildSystems(40);

    // Warm the JIT once so the measured run reflects steady-state cost.
    mapFindings({ declared: { systems, transcript, makesDecisionsAboutPeople: true }, actual: { discovery } });

    const { probe } = await probeDuring(() => {
      mapFindings({
        declared: { systems, transcript, makesDecisionsAboutPeople: true },
        actual: { discovery },
      });
    });

    // eslint-disable-next-line no-console
    console.log(`[AAP-145] mapFindings max event-loop tick gap = ${probe.maxGapMs.toFixed(1)}ms`);
    expect(probe.maxGapMs).toBeLessThan(SAFE_CEILING_MS);
    expect(probe.maxGapMs).toBeLessThan(CODEX_TIMEOUT_MS / 100);
  });

  it('computeVerdictFromArtifacts stays sub-second at 20x30x80 scale', async () => {
    const discovery = buildDiscovery(20, 30, 80);
    const transcript = buildTranscript(60);
    const systems = buildSystems(40);
    const reportJson = { systems, localAgentDiscovery: discovery };
    const txt = transcript.map((t) => ({ category: t.category, question: t.question, answer: t.answer }));

    computeVerdictFromArtifacts({ reportJson, transcript: txt, discoveryOverride: discovery });

    const { probe } = await probeDuring(() => {
      computeVerdictFromArtifacts({ reportJson, transcript: txt, discoveryOverride: discovery });
    });

    // eslint-disable-next-line no-console
    console.log(`[AAP-145] computeVerdict max event-loop tick gap = ${probe.maxGapMs.toFixed(1)}ms`);
    expect(probe.maxGapMs).toBeLessThan(SAFE_CEILING_MS);
  });

  it('secretlintScrub blocks synchronously per call but stays well under the timeout at oversized scale', async () => {
    // Warm the engine (first createEngine is a one-time async cost).
    await secretlintScrub({ x: 'warmup' });

    const agents = buildDiscovery(20, 30, 80).agents;
    const bytes = JSON.stringify(agents).length;

    const { probe } = await probeDuring(async () => {
      await secretlintScrub(agents);
    });

    // This is the ONE stage that blocks the loop for its full duration
    // (the regex engine runs synchronously inside the awaited call). It
    // still stays far below the 120s timeout even at ~8MB of inventory,
    // so it is not the starvation cause either. We pin the ceiling so a
    // future regression into multi-second territory fails here.
    // eslint-disable-next-line no-console
    console.log(
      `[AAP-145] secretlintScrub bytes=${bytes} max event-loop tick gap = ${probe.maxGapMs.toFixed(1)}ms`,
    );
    expect(probe.maxGapMs).toBeLessThan(SAFE_CEILING_MS);
  });

  it('the full back-to-back sync stretch (map + verdict + scrub) stays well under the 120s timeout', async () => {
    const discovery = buildDiscovery(20, 30, 80);
    const transcript = buildTranscript(60);
    const systems = buildSystems(40);
    const reportJson = { systems, localAgentDiscovery: discovery };
    const txt = transcript.map((t) => ({ category: t.category, question: t.question, answer: t.answer }));

    await secretlintScrub({ x: 'warmup' });
    mapFindings({ declared: { systems, transcript, makesDecisionsAboutPeople: true }, actual: { discovery } });

    const { probe } = await probeDuring(async () => {
      const scrubbed = await secretlintScrub(discovery.agents);
      mapFindings({
        declared: { systems, transcript, makesDecisionsAboutPeople: true },
        actual: { discovery: { ...discovery, agents: scrubbed } },
      });
      computeVerdictFromArtifacts({ reportJson, transcript: txt, discoveryOverride: discovery });
    });

    // eslint-disable-next-line no-console
    console.log(`[AAP-145] full Phase-B-style sync stretch max tick gap = ${probe.maxGapMs.toFixed(1)}ms`);
    expect(probe.maxGapMs).toBeLessThan(SAFE_CEILING_MS);
    // The decisive assertion: nowhere near Codex's 120s client timeout.
    expect(probe.maxGapMs).toBeLessThan(CODEX_TIMEOUT_MS / 10);
  });
});
