/**
 * AAP-87 — Golden snapshot regression backstop for `sanitizeAnalyzerOutput`.
 *
 * This is the safety net for the Phase A decomposition: any future change to
 * the orchestration (helper boundaries, ordering, or rule-internal behavior)
 * shows up as a snapshot diff. A reviewer cannot miss a behavior change
 * because the snapshot must be regenerated and the diff appears in the PR.
 *
 * The three fixtures intentionally span EVERY rule group `sanitize.ts`
 * currently implements:
 *
 *   - Fixture A — real Codex desktop session, all-stops fixture:
 *       * source-ref extraction `(A3, A4)`
 *       * systemId prose → slug + systemDescription spill
 *       * scopesDelta lead-in stripping + trailing `(A11).` cleanup
 *       * frequencyAndVolume prose → structured `frequency`
 *       * legacy `frequencyAndVolume` preserved on input shape
 *   - Fixture B — heavy-output fixture exercising the caps:
 *       * writeOperations truncation (operation/target/volumePerDay)
 *       * recommendations cap to 20 entries
 *       * recommendations per-entry truncation (>400 chars)
 *       * top-level prose caps (summary, agentPurpose, agentTrigger,
 *         agentOwner, decisionMakingDetails)
 *       * malformed risk filtering (non-object / missing title)
 *   - Fixture C — duplicate-risk merging + already-clean passthrough:
 *       * mergeDuplicateRisks (title-similarity + same-prefix + shared-token)
 *       * scope-array compaction for empty strings after lead-in strip
 *       * `frequency` already provided → not overwritten by prose parse
 *
 * Snapshots are full-object (not slices) so any incidental drift is caught.
 *
 * NOTE: this test pins behavior. It is NOT a spec for what the analyzer
 * "should" do — it is a spec for what it DOES today. Any intentional change
 * to a sanitize rule MUST update this snapshot AND get an explicit reviewer
 * sign-off on the diff.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeAnalyzerOutput } from '../../src/analysis/sanitize.js';

// ─── Fixture A — real Codex desktop session (all-stops) ──────────────────

function fixtureRealCodexSession(): Record<string, unknown> {
  return {
    summary: 'Codex desktop agent — audit run end-to-end with all rule groups in play.',
    agentPurpose: 'Conduct security audits via the Heron interrogator.',
    agentTrigger: 'Operator runs `heron interview` from a local terminal.',
    agentOwner: 'Heron eng team',
    systems: [
      {
        systemId:
          'Codex desktop app local agent session -> OpenAI-hosted Codex/ChatGPT backend for model inference; exact API endpoint and authentication token are not visible; authentication appears handled by the Codex desktop app/user account session; no customer-managed OpenAI API key is visible to the agent (A3, A4).',
        scopesRequested: [],
        scopesNeeded: [],
        scopesDelta: [
          'Unused in this audit task so far: local filesystem read/write through shell or apply_patch (A11).',
          'Unused in this audit task so far: arbitrary shell command execution (A11).',
          'Unused in this audit task so far: external internet/web browsing (A11).',
        ],
        dataSensitivity: 'Non-PII technical metadata about the audit session itself (A4).',
        blastRadius: 'single-user',
        frequencyAndVolume:
          'For this deployment instance: 1 audit run on 2026-05-20; historical runs in the last week were not observable; typical API/tool calls were not observable historically; this audit run had used 1 tool-discovery call, 1 audit-session start call, and 8 answer-submission calls before A10, with an expected total of about 10-15 tool calls; processing is primarily one-at-a-time with batch size usually 1 user request or 1 audit question (A10).',
        writeOperations: [],
      },
    ],
    risks: [],
    recommendations: ['Restrict shell exec to operator-controlled commands.'],
    overallRiskLevel: 'medium',
  };
}

// ─── Fixture B — caps + malformed risk filtering ─────────────────────────

function fixtureHeavyCapsAndFiltering(): Record<string, unknown> {
  const longRec = 'A'.repeat(500); // > 400-char per-entry cap
  const tooManyRecs = Array.from({ length: 25 }, (_, i) => `Recommendation ${i + 1}`); // > 20 cap
  return {
    summary:
      'Bursting at the seams: ' + 'x'.repeat(900), // > 800
    agentPurpose: 'y'.repeat(700), // > 600
    agentTrigger: 'z'.repeat(700), // > 600 (AAP-107 round 2 cap)
    agentOwner: 'q'.repeat(250), // > 200
    decisionMakingDetails: 'd'.repeat(900), // > 800
    systems: [
      {
        systemId: 'greenhouse-prod',
        scopesRequested: ['candidates.read'],
        scopesNeeded: ['candidates.read'],
        scopesDelta: [],
        dataSensitivity: 'PII',
        blastRadius: 'team-scope',
        frequencyAndVolume: '~50 calls per run, 7 runs per week.',
        writeOperations: [
          {
            // operation > 80 chars
            operation:
              'create candidate record with full profile metadata including all observed prior employers and reference contact details inline',
            // target > 80 chars + trailing source ref
            target:
              'Greenhouse Harvest API /v1/candidates endpoint serving the production hiring pipeline (A3)',
            volumePerDay: 'about 200 to 500 records per business day, varies wildly with sourcing waves',
            reversible: false,
            approvalRequired: false,
          },
        ],
      },
    ],
    risks: [
      // Malformed: not an object
      null,
      // Malformed: missing title
      { severity: 'high', description: 'no title here' },
      // Valid risk that should pass through
      {
        severity: 'high',
        title: 'Stored secrets in plaintext',
        description: 'API key checked into the repository.',
        mitigation: 'Rotate and move to a secrets manager.',
      },
    ],
    recommendations: [...tooManyRecs, longRec],
    overallRiskLevel: 'high',
  };
}

// ─── Fixture C — dedup + idempotency on already-clean input ──────────────

function fixtureDedupAndIdempotent(): Record<string, unknown> {
  return {
    summary: 'Clean shape, dedup-only exercise.',
    agentPurpose: 'Hire candidates with human oversight.',
    systems: [
      {
        systemId: 'github-prod',
        // Already clean — should not be mutated by stripScopeLeadIn.
        scopesRequested: ['repo:read'],
        scopesNeeded: ['repo:read'],
        scopesDelta: ['repo:write'],
        dataSensitivity: 'Source code',
        blastRadius: 'org-wide',
        // frequency already provided — prose should NOT overwrite it.
        frequency: { callsPerRun: '5', concurrency: 'parallel', notes: 'pre-existing' },
        frequencyAndVolume: 'ignored because frequency is already set',
        writeOperations: [],
      },
    ],
    risks: [
      {
        severity: 'medium',
        title: 'Excessive GitHub access',
        description: 'Agent has repo:write but only needs repo:read.',
        mitigation: 'Drop to repo:read.',
      },
      // Near-duplicate via title-similarity + prefix.
      {
        severity: 'high',
        title: 'GitHub access is excessive',
        description: 'Agent has full repo write but only reads pull requests.',
        mitigation: 'Restrict to repo:read scope.',
      },
      // Unrelated — must survive.
      {
        severity: 'low',
        title: 'Slow startup latency',
        description: 'Cold start ~2s on first request.',
      },
    ],
    recommendations: ['Drop to repo:read.'],
    overallRiskLevel: 'medium',
  };
}

// ─── Golden snapshots ────────────────────────────────────────────────────

describe('sanitizeAnalyzerOutput — golden snapshots (Phase A regression backstop)', () => {
  it('Fixture A — real Codex session (all-stops): full-object snapshot', () => {
    const fx = fixtureRealCodexSession();
    sanitizeAnalyzerOutput(fx);
    expect(fx).toMatchSnapshot();
  });

  it('Fixture B — caps + malformed-risk filtering: full-object snapshot', () => {
    const fx = fixtureHeavyCapsAndFiltering();
    sanitizeAnalyzerOutput(fx);
    expect(fx).toMatchSnapshot();
  });

  it('Fixture C — dedup + idempotent on already-clean: full-object snapshot', () => {
    const fx = fixtureDedupAndIdempotent();
    sanitizeAnalyzerOutput(fx);
    expect(fx).toMatchSnapshot();
  });

  it('Fixture A — second pass is idempotent (sanitizing twice = sanitizing once)', () => {
    const once = fixtureRealCodexSession();
    sanitizeAnalyzerOutput(once);
    const twice = fixtureRealCodexSession();
    sanitizeAnalyzerOutput(twice);
    sanitizeAnalyzerOutput(twice);
    expect(twice).toEqual(once);
  });
});
